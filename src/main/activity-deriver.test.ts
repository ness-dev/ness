import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./debug', () => ({
  log: () => {}
}))
vi.mock('./activity', async (importActual) => ({
  ...(await importActual<typeof import('./activity')>()),
  recordActivity: vi.fn()
}))

import { Store } from './store'
import { ActivityDeriver } from './activity-deriver'
import { initialState, type AppState, type StateEvent } from '../shared/state'
import type { PaneNode, TerminalsState } from '../shared/state/terminals'
import { recordActivity } from './activity'

const A = '/wt/a'
const B = '/wt/b'
const C = '/wt/c'

function leaf(id: string, tabIds: string[]): PaneNode {
  return {
    type: 'leaf',
    id,
    tabs: tabIds.map((tid) => ({ id: tid, type: 'shell' as const, label: tid })),
    activeTabId: tabIds[0] ?? ''
  }
}

function makeState(): AppState {
  const terminals: TerminalsState = {
    ...initialState.terminals,
    panes: {
      [A]: leaf('pa', ['ta1']),
      [B]: leaf('pb', ['tb1']),
      [C]: leaf('pc', ['tc1'])
    }
  }
  return { ...initialState, terminals }
}

function collectLastActive(store: Store): string[] {
  const seen: string[] = []
  store.subscribe((event: StateEvent) => {
    if (event.type === 'terminals/lastActiveChanged') {
      seen.push(event.payload.worktreePath)
    }
  })
  return seen
}

function recordedPaths(): string[] {
  return (recordActivity as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
    (c) => c[0] as string
  )
}

describe('ActivityDeriver scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('scopes terminals/panesForWorktreeChanged to the payload worktree', () => {
    const store = new Store(makeState())
    const deriver = new ActivityDeriver(store)
    deriver.start()
    const lastActive = collectLastActive(store)

    store.dispatch({
      type: 'terminals/panesForWorktreeChanged',
      payload: { worktreePath: A, panes: leaf('pa2', ['ta1']) }
    })

    expect(recordedPaths()).toEqual([A])

    vi.advanceTimersByTime(30000)
    expect(lastActive).toEqual([A])
    deriver.stop()
  })

  it('scopes terminals/panesForWorktreeCleared to the payload worktree', () => {
    const store = new Store(makeState())
    const deriver = new ActivityDeriver(store)
    deriver.start()
    const lastActive = collectLastActive(store)

    store.dispatch({
      type: 'terminals/panesForWorktreeCleared',
      payload: A
    })

    expect(recordedPaths()).toEqual([A])

    vi.advanceTimersByTime(30000)
    expect(lastActive).toEqual([A])
    deriver.stop()
  })

  it('scopes prs/statusChanged to the payload path', () => {
    const store = new Store(makeState())
    const deriver = new ActivityDeriver(store)
    deriver.start()
    const lastActive = collectLastActive(store)

    store.dispatch({
      type: 'prs/statusChanged',
      payload: { path: A, status: null }
    })

    expect(recordedPaths()).toEqual([A])

    vi.advanceTimersByTime(30000)
    expect(lastActive).toEqual([A])
    deriver.stop()
  })

  it('scopes prs/bulkStatusChanged to only the paths in the payload', () => {
    const store = new Store(makeState())
    const deriver = new ActivityDeriver(store)
    deriver.start()
    const lastActive = collectLastActive(store)

    store.dispatch({
      type: 'prs/bulkStatusChanged',
      payload: { [A]: null, [C]: null }
    })

    const recorded = recordedPaths()
    expect(recorded).toContain(A)
    expect(recorded).toContain(C)
    expect(recorded).not.toContain(B)

    vi.advanceTimersByTime(30000)
    expect(lastActive.sort()).toEqual([A, C].sort())
    deriver.stop()
  })

  it('terminals/panesReplaced still sweeps every worktree', () => {
    const store = new Store(makeState())
    const deriver = new ActivityDeriver(store)
    deriver.start()
    const lastActive = collectLastActive(store)

    store.dispatch({
      type: 'terminals/panesReplaced',
      payload: {
        [A]: leaf('pa', ['ta1']),
        [B]: leaf('pb', ['tb1']),
        [C]: leaf('pc', ['tc1'])
      }
    })

    const recorded = recordedPaths()
    expect(recorded.sort()).toEqual([A, B, C].sort())

    vi.advanceTimersByTime(30000)
    expect(lastActive.sort()).toEqual([A, B, C].sort())
    deriver.stop()
  })

  it('dedups recordActivity when the effective state has not changed', () => {
    const store = new Store(makeState())
    const deriver = new ActivityDeriver(store)
    deriver.start()

    store.dispatch({
      type: 'terminals/panesForWorktreeChanged',
      payload: { worktreePath: A, panes: leaf('pa2', ['ta1']) }
    })
    store.dispatch({
      type: 'terminals/panesForWorktreeChanged',
      payload: { worktreePath: A, panes: leaf('pa3', ['ta1']) }
    })

    expect(recordedPaths()).toEqual([A])
    deriver.stop()
  })
})

describe('ActivityDeriver auto-unsnooze', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function snoozedState(): AppState {
    const base = makeState()
    return {
      ...base,
      snooze: {
        byPath: {
          [A]: { path: A, snoozedAt: 0, wakeAt: 9_999_999_999_999 }
        }
      }
    }
  }

  function clearedPaths(store: Store): string[] {
    const seen: string[] = []
    store.subscribe((event: StateEvent) => {
      if (event.type === 'snooze/clear') seen.push(event.payload)
    })
    return seen
  }

  it('clears the snooze when transitioning to processing', () => {
    const store = new Store(snoozedState())
    const deriver = new ActivityDeriver(store)
    deriver.start()
    const cleared = clearedPaths(store)

    store.dispatch({
      type: 'terminals/statusChanged',
      payload: { id: 'ta1', status: 'processing', pendingTool: null }
    })

    expect(cleared).toEqual([A])
    deriver.stop()
  })

  it('does not clear on idle / waiting transitions', () => {
    const store = new Store(snoozedState())
    const deriver = new ActivityDeriver(store)
    deriver.start()
    const cleared = clearedPaths(store)

    store.dispatch({
      type: 'terminals/statusChanged',
      payload: { id: 'ta1', status: 'waiting', pendingTool: null }
    })
    store.dispatch({
      type: 'terminals/statusChanged',
      payload: { id: 'ta1', status: 'idle', pendingTool: null }
    })

    expect(cleared).toEqual([])
    deriver.stop()
  })

  it('does not clear when the path is not snoozed', () => {
    const store = new Store(makeState())
    const deriver = new ActivityDeriver(store)
    deriver.start()
    const cleared = clearedPaths(store)

    store.dispatch({
      type: 'terminals/statusChanged',
      payload: { id: 'ta1', status: 'processing', pendingTool: null }
    })

    expect(cleared).toEqual([])
    deriver.stop()
  })
})
