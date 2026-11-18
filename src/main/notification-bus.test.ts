import { describe, it, expect, vi } from 'vitest'

vi.mock('./debug', () => ({ log: () => {} }))

import { Store } from './store'
import { NotificationBus } from './notification-bus'
import { initialState } from '../shared/state'
import { wrapAutomatedMessage } from '../shared/state/json-claude'
import type { PaneNode } from '../shared/state/terminals'

const WT = '/wt/a'

function setup(tabs: Array<{ id: string; type?: 'json-claude' | 'agent' }>) {
  const panes: PaneNode = {
    type: 'leaf',
    id: 'p',
    tabs: tabs.map((t) => ({ id: t.id, type: t.type ?? 'json-claude', label: 'Chat' })),
    activeTabId: tabs[0]?.id ?? ''
  }
  const store = new Store({
    ...initialState,
    terminals: { ...initialState.terminals, panes: { [WT]: panes } }
  })
  const chats = tabs.filter((t) => (t.type ?? 'json-claude') === 'json-claude')
  const live = new Set(chats.map((t) => t.id))
  const send = vi.fn<(sessionId: string, text: string) => void>()
  for (const t of chats) {
    store.dispatch({ type: 'jsonClaude/sessionStarted', payload: { sessionId: t.id, worktreePath: WT } })
  }
  const bus = new NotificationBus(
    store,
    { send, hasSession: (id) => live.has(id), wake: () => {}, respawn: () => {} },
    async () => true
  )
  return { store, send, bus }
}

const wire = wrapAutomatedMessage('review', 'looks good', { from: 'Reviewer' })

describe('NotificationBus', () => {
  it('interrupt delivers to the tab as its own turn', () => {
    const { send, bus } = setup([{ id: 't1' }])
    expect(bus.toTab(WT, 't1', wire)).toEqual({ ok: true, tabId: 't1', woke: false, held: false })
    expect(send).toHaveBeenCalledWith('t1', wire)
  })

  it('silent holds the notice in the slice instead of sending', () => {
    const { store, send, bus } = setup([{ id: 't1' }])
    expect(bus.toTab(WT, 't1', wire, 'silent')).toMatchObject({ ok: true, held: true })
    expect(send).not.toHaveBeenCalled()
    expect(store.getSnapshot().state.notifications.pendingByTab['t1']).toMatchObject([
      { source: 'review', from: 'Reviewer', wire }
    ])
  })

  it('silent to a worktree holds for its author tab', () => {
    const { store, bus } = setup([{ id: 't1' }])
    expect(bus.toWorktree(WT, wire, 'silent')).toMatchObject({ ok: true, sessionId: 't1', held: true })
    expect(store.getSnapshot().state.notifications.pendingByTab['t1']).toHaveLength(1)
  })

  it('falls back to an interrupt for text that is not an automated message', () => {
    const { send, bus } = setup([{ id: 't1' }])
    expect(bus.toTab(WT, 't1', 'plain', 'silent')).toMatchObject({ ok: true, held: false })
    expect(send).toHaveBeenCalledWith('t1', 'plain')
  })

  it('reports why a tab cannot be reached', () => {
    const { bus } = setup([{ id: 'term', type: 'agent' }])
    expect(bus.toTab(WT, 'term', wire)).toEqual({ ok: false, reason: 'terminal-unsupported' })
    expect(bus.toTab(WT, 'gone', wire)).toEqual({ ok: false, reason: 'no-tab' })
  })

  it('startWithPrompt waits for the session, then sends', async () => {
    const { send, bus } = setup([{ id: 't1' }])
    bus.startWithPrompt('t1', WT, 'kickoff')
    expect(send).not.toHaveBeenCalled()
    await new Promise((r) => setImmediate(r))
    expect(send).toHaveBeenCalledWith('t1', 'kickoff')
  })
})
