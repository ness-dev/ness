import { describe, it, expect, vi } from 'vitest'
import { Store } from './store'
import { initialState, type AppState } from '../shared/state'
import type { PaneNode, PtyStatus } from '../shared/state/terminals'
import { TerminalDeliveryQueue, sanitizeForPaste } from './terminal-delivery'

const WT = '/wt'
const TAB = 'term'

const tree: PaneNode = {
  type: 'leaf',
  id: 'p',
  tabs: [{ id: TAB, type: 'agent', label: 'Claude', agentKind: 'claude' }],
  activeTabId: TAB
}

function setup(opts: { status?: PtyStatus; hooks?: boolean; pty?: boolean } = {}) {
  const state: AppState = {
    ...initialState,
    terminals: {
      ...initialState.terminals,
      panes: { [WT]: tree },
      statuses: opts.status ? { [TAB]: opts.status } : {}
    }
  }
  const store = new Store(state)
  const writes: string[] = []
  const timers: Array<() => void> = []
  let sessionStart: ((id: string) => void) | null = null
  const queue = new TerminalDeliveryQueue(store, {
    hasPty: () => opts.pty !== false,
    write: (_id, data) => writes.push(data),
    hooksEnabled: () => opts.hooks !== false,
    onSessionStart: (fn) => {
      sessionStart = fn
      return () => {}
    },
    schedule: (fn) => timers.push(fn)
  })
  queue.start()
  const runTimers = (): void => {
    while (timers.length) timers.shift()!()
  }
  const setStatus = async (status: PtyStatus): Promise<void> => {
    store.dispatch({ type: 'terminals/statusChanged', payload: { id: TAB, status, pendingTool: null } })
    await Promise.resolve()
  }
  return { store, queue, writes, runTimers, setStatus, fireSessionStart: () => sessionStart!(TAB) }
}

const PASTE = (m: string): string => '\x1b[200~' + m + '\x1b[201~'

describe('TerminalDeliveryQueue', () => {
  it('types a message straight in when the agent is waiting at its prompt', () => {
    const { queue, writes, runTimers } = setup({ status: 'waiting' })
    expect(queue.deliver(WT, TAB, 'hello')).toEqual({ state: 'delivered' })
    expect(writes).toEqual([PASTE('hello')])
    runTimers()
    expect(writes).toEqual([PASTE('hello'), '\r'])
  })

  it('holds a message while the agent is working and types it in when it stops', async () => {
    const { queue, writes, setStatus } = setup({ status: 'processing' })
    const settled = vi.fn()
    expect(queue.deliver(WT, TAB, 'review', settled)).toEqual({ state: 'queued' })
    expect(writes).toEqual([])
    await setStatus('waiting')
    expect(writes).toEqual([PASTE('review')])
    expect(settled).toHaveBeenCalledWith({ ok: true })
  })

  it('never types into a permission prompt', async () => {
    const { queue, writes, setStatus } = setup({ status: 'needs-approval' })
    queue.deliver(WT, TAB, 'review')
    await setStatus('needs-approval')
    await setStatus('processing')
    expect(writes).toEqual([])
    await setStatus('waiting')
    expect(writes).toEqual([PASTE('review')])
  })

  it('sends queued messages one per idle window, in order', async () => {
    const { queue, writes, setStatus } = setup({ status: 'processing' })
    queue.deliver(WT, TAB, 'first')
    queue.deliver(WT, TAB, 'second')
    await setStatus('waiting')
    expect(writes).toEqual([PASTE('first')])
    await setStatus('processing')
    await setStatus('waiting')
    expect(writes).toEqual([PASTE('first'), PASTE('second')])
  })

  it('does not paste twice before the first message has registered as a turn', () => {
    const { queue, writes } = setup({ status: 'waiting' })
    expect(queue.deliver(WT, TAB, 'a')).toEqual({ state: 'delivered' })
    // The status is still the pre-paste 'waiting'.
    expect(queue.deliver(WT, TAB, 'b')).toEqual({ state: 'queued' })
    expect(writes).toEqual([PASTE('a')])
  })

  it('treats SessionStart as ready, after a settle delay', () => {
    const { queue, writes, runTimers, fireSessionStart } = setup()
    expect(queue.deliver(WT, TAB, 'hi')).toEqual({ state: 'queued' })
    fireSessionStart()
    expect(writes).toEqual([])
    runTimers()
    expect(writes[0]).toBe(PASTE('hi'))
  })

  it('waits for the PTY to be running', async () => {
    const { queue, writes, setStatus } = setup({ status: 'waiting', pty: false })
    expect(queue.deliver(WT, TAB, 'hi')).toEqual({ state: 'queued' })
    await setStatus('waiting')
    expect(writes).toEqual([])
  })

  it('refuses when status hooks are not installed', () => {
    const { queue } = setup({ status: 'waiting', hooks: false })
    expect(queue.deliver(WT, TAB, 'hi')).toEqual({ state: 'failed', reason: 'no-hooks' })
  })

  it('fails queued messages when their tab is closed', async () => {
    const { store, queue } = setup({ status: 'processing' })
    const settled = vi.fn()
    queue.deliver(WT, TAB, 'hi', settled)
    store.dispatch({
      type: 'terminals/panesForWorktreeChanged',
      payload: { worktreePath: WT, panes: { ...tree, tabs: [] } as PaneNode }
    })
    await Promise.resolve()
    expect(settled).toHaveBeenCalledWith({ ok: false, reason: 'tab-closed' })
  })

  it('strips escape bytes so a message cannot break out of the paste', () => {
    expect(sanitizeForPaste('a\x1b[201~\x03b\r\nc\td')).toBe('a[201~b\nc\td')
  })
})
