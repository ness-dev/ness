import { describe, it, expect, vi } from 'vitest'

vi.mock('./debug', () => ({
  log: () => {}
}))

import { Store } from './store'
import { CopyDraftBroker } from './copy-draft-broker'
import { initialState } from '../shared/state'

function setup(chatSessions: string[] = []): {
  store: Store
  broker: CopyDraftBroker
  openTabs: Set<string>
} {
  const store = new Store(initialState)
  const openTabs = new Set(['term-1'])
  const broker = new CopyDraftBroker(
    store,
    (id) => chatSessions.includes(id),
    (id) => openTabs.has(id)
  )
  broker.start()
  return { store, broker, openTabs }
}

const input = { terminalId: 'term-1', worktreePath: '/wt', draft: 'Get started now!', title: 'Headline' }

describe('CopyDraftBroker', () => {
  it('publishes the draft and settles the waiter with the human answer', async () => {
    const { store, broker } = setup()
    const { id, result } = broker.request(input)
    expect(store.getSnapshot().state.copyDrafts.pending[id]).toMatchObject(input)

    expect(broker.resolve(id, { kind: 'submitted', text: 'Start here' })).toBe(true)
    await expect(result).resolves.toEqual({ kind: 'submitted', text: 'Start here' })
    expect(store.getSnapshot().state.copyDrafts.pending[id]).toBeUndefined()
  })

  it('only the first answer wins', async () => {
    const { broker } = setup()
    const { id, result } = broker.request(input)
    broker.cancel(id)
    expect(broker.resolve(id, { kind: 'submitted', text: 'late' })).toBe(false)
    await expect(result).resolves.toEqual({ kind: 'cancelled' })
  })

  it('keeps an edited withdrawn draft until the user clears it', () => {
    const { store, broker } = setup()
    const { id } = broker.request(input)
    broker.markEdited(id)
    broker.cancel(id)
    const drafts = (): typeof initialState.copyDrafts => store.getSnapshot().state.copyDrafts
    expect(drafts().pending[id]).toBeUndefined()
    expect(drafts().withdrawn[id]).toMatchObject(input)

    expect(broker.clearWithdrawn(id)).toBe(true)
    expect(drafts().withdrawn[id]).toBeUndefined()
    expect(broker.clearWithdrawn(id)).toBe(false)
  })

  it('drops the draft outright when its tab closed, since nobody would see the notice', () => {
    const { store, broker, openTabs } = setup()
    const { id } = broker.request(input)
    broker.markEdited(id)
    openTabs.delete('term-1')
    broker.cancel(id)
    expect(store.getSnapshot().state.copyDrafts.withdrawn[id]).toBeUndefined()
    expect(store.getSnapshot().state.copyDrafts.pending[id]).toBeUndefined()
  })

  it('drops a withdrawn draft nobody edited instead of leaving a notice', () => {
    const { store, broker } = setup()
    const { id } = broker.request(input)
    broker.cancel(id)
    expect(store.getSnapshot().state.copyDrafts.withdrawn[id]).toBeUndefined()
    expect(store.getSnapshot().state.copyDrafts.pending[id]).toBeUndefined()
  })

  it('clears a withdrawn draft once its tab is closed', () => {
    const { store, broker, openTabs } = setup()
    const { id } = broker.request(input)
    broker.markEdited(id)
    broker.cancel(id)
    expect(store.getSnapshot().state.copyDrafts.withdrawn[id]).toBeDefined()

    openTabs.delete('term-1')
    store.dispatch({ type: 'terminals/panesForWorktreeCleared', payload: '/wt' })
    expect(store.getSnapshot().state.copyDrafts.withdrawn[id]).toBeUndefined()
  })

  it('hands a Terminal tab back to waiting, not processing, when the agent stops waiting', () => {
    // An Esc in the TUI ends the turn with no further hook event, so a
    // processing dot would spin until the next prompt.
    const { store, broker } = setup()
    const { id } = broker.request(input)
    broker.cancel(id)
    expect(store.getSnapshot().state.terminals.statuses['term-1']).toBe('waiting')
  })

  it('flags a terminal tab as needs-approval until the human answers', () => {
    const { store, broker } = setup()
    const { id } = broker.request(input)
    const terminals = (): typeof initialState.terminals => store.getSnapshot().state.terminals
    expect(terminals().statuses['term-1']).toBe('needs-approval')
    expect(terminals().pendingTools['term-1']?.name).toBe('edit_copy')

    broker.resolve(id, { kind: 'dismissed' })
    expect(terminals().statuses['term-1']).toBe('processing')
  })

  it('leaves Chat-tab status to the json-claude deriver', () => {
    const { store, broker } = setup(['term-1'])
    broker.request(input)
    expect(store.getSnapshot().state.terminals.statuses['term-1']).toBeUndefined()
  })
})
