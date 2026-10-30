import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./debug', () => ({ log: () => {} }))

import { Store } from './store'
import { CiNotifier, buildCiFailureMessage } from './ci-notifier'
import { initialState, type AppState } from '../shared/state'
import type { PRStatus, CheckStatus } from '../shared/state/prs'
import type { JsonClaudeSession } from '../shared/state/json-claude'
import type { PaneNode } from '../shared/state/terminals'
import { parseAutomatedMessage } from '../shared/state/json-claude'

const A = '/wt/a'
const B = '/wt/b'

/** Delivery is deferred via setImmediate so it lands outside the store's
 *  dispatch fan-out. Tests must flush that queue before asserting. */
const flush = () => new Promise((resolve) => setImmediate(resolve))

function check(name: string, state: CheckStatus['state']): CheckStatus {
  return { name, state, description: `${name} said no` }
}

function pr(overrides: Partial<PRStatus> = {}): PRStatus {
  return {
    number: 7,
    title: 'Add a thing',
    state: 'open',
    url: 'https://github.com/o/r/pull/7',
    branch: 'feat/thing',
    headSha: 'abc123',
    author: null,
    checks: [check('build', 'failure'), check('lint', 'success')],
    checksOverall: 'failure',
    hasConflict: false,
    reviews: [],
    reviewDecision: 'none',
    baseBranch: 'main',
    isDefaultBase: true,
    assignees: [],
    linkedIssues: [],
    labels: [],
    ...overrides
  }
}

function session(
  worktreePath: string,
  lastTs: number
): JsonClaudeSession {
  return {
    sessionId: 'ignored',
    worktreePath,
    state: 'running',
    exitCode: null,
    exitReason: null,
    entries: [{ entryId: 'e1', kind: 'user', timestamp: lastTs }],
    entriesHydrated: true,
    busy: false,
    permissionMode: 'acceptEdits',
    slashCommands: [],
    autoApprovedDecisions: {},
    backgroundAgents: {},
    sessionToolApprovals: [],
    sessionAllowedDecisions: {}
  }
}

/** A pane tree with one leaf holding the given json-claude tabs. */
function panes(
  tabs: Array<{ id: string; mode?: 'awake' | 'asleep' }>,
  activeTabId = tabs[0]?.id ?? ''
): PaneNode {
  return {
    type: 'leaf',
    id: 'p1',
    tabs: tabs.map((t) => ({
      id: t.id,
      type: 'json-claude' as const,
      label: 'Chat',
      ...(t.mode ? { mode: t.mode } : {})
    })),
    activeTabId
  }
}

function makeState(
  sessions: Record<string, JsonClaudeSession>,
  opts: {
    globalDefault?: boolean
    overrides?: Record<string, boolean>
    panes?: Record<string, PaneNode>
  } = {}
): AppState {
  return {
    ...initialState,
    settings: {
      ...initialState.settings,
      notifyChatOnCiFailure: opts.globalDefault ?? true
    },
    ciNotify: { byPath: { ...(opts.overrides ?? {}) } },
    jsonClaude: { ...initialState.jsonClaude, sessions },
    terminals: { ...initialState.terminals, panes: { ...(opts.panes ?? {}) } }
  }
}

function setup(
  state: AppState,
  liveSessionIds: string[] = Object.keys(state.jsonClaude.sessions)
) {
  const store = new Store(state)
  const live = new Set(liveSessionIds)
  const send = vi.fn()
  // Mirrors panesFSM.wakeJsonClaudeTab: only asleep tabs wake, and the
  // subprocess is live by the time it returns.
  const wake = vi.fn((_wt: string, tabId: string) => {
    live.add(tabId)
  })
  const notifier = new CiNotifier(store, {
    send,
    hasSession: (id) => live.has(id),
    wake,
    respawn: () => {}
  })
  notifier.start()
  return { store, send, wake, notifier }
}

async function bulk(
  store: Store,
  payload: Record<string, PRStatus | null>
): Promise<void> {
  store.dispatch({ type: 'prs/bulkStatusChanged', payload })
  await flush()
}

describe('CiNotifier transitions', () => {
  beforeEach(() => vi.clearAllMocks())

  it('notifies when checks transition into failure', async () => {
    const { store, send } = setup(makeState({ s1: session(A, 100) }))
    await bulk(store, { [A]: pr({ checksOverall: 'pending' }) })
    expect(send).not.toHaveBeenCalled()
    await bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toBe('s1')
    expect(send.mock.calls[0][1]).toContain('CI is failing on PR #7')
  })

  it('does not notify on the first poll for an already-failing PR', async () => {
    const { store, send } = setup(makeState({ s1: session(A, 100) }))
    await bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    expect(send).not.toHaveBeenCalled()
  })

  it('seeds from pre-existing store state so a pre-start poll is not a transition', async () => {
    const state = makeState({ s1: session(A, 100) })
    const store = new Store({
      ...state,
      prs: { ...state.prs, byPath: { [A]: pr({ checksOverall: 'failure' }) } }
    })
    const send = vi.fn()
    new CiNotifier(store, { send, hasSession: () => true, wake: () => {}, respawn: () => {} }).start()
    await bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    expect(send).not.toHaveBeenCalled()
  })

  it('does not notify on success or pending', async () => {
    const { store, send } = setup(makeState({ s1: session(A, 100) }))
    await bulk(store, { [A]: pr({ checksOverall: 'pending' }) })
    await bulk(store, { [A]: pr({ checksOverall: 'success' }) })
    expect(send).not.toHaveBeenCalled()
  })

  it('handles prs/statusChanged the same way as a bulk update', async () => {
    const { store, send } = setup(makeState({ s1: session(A, 100) }))
    store.dispatch({
      type: 'prs/statusChanged',
      payload: { path: A, status: pr({ checksOverall: 'success' }) }
    })
    store.dispatch({
      type: 'prs/statusChanged',
      payload: { path: A, status: pr({ checksOverall: 'failure' }) }
    })
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('only notifies the worktree whose checks went red', async () => {
    const { store, send } = setup(
      makeState({ s1: session(A, 100), s2: session(B, 100) })
    )
    await bulk(store, {
      [A]: pr({ checksOverall: 'pending' }),
      [B]: pr({ checksOverall: 'pending' })
    })
    await bulk(store, {
      [A]: pr({ checksOverall: 'failure' }),
      [B]: pr({ checksOverall: 'success' })
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toBe('s1')
  })
})

describe('CiNotifier dedup', () => {
  beforeEach(() => vi.clearAllMocks())

  it('notifies once per head commit even when the failure flaps', async () => {
    const { store, send } = setup(makeState({ s1: session(A, 100) }))
    await bulk(store, { [A]: pr({ checksOverall: 'pending' }) })
    await bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    await bulk(store, { [A]: pr({ checksOverall: 'pending' }) })
    await bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('re-notifies when a new head commit also fails', async () => {
    const { store, send } = setup(makeState({ s1: session(A, 100) }))
    await bulk(store, { [A]: pr({ checksOverall: 'pending' }) })
    await bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    await bulk(store, { [A]: pr({ headSha: 'def456', checksOverall: 'pending' }) })
    await bulk(store, { [A]: pr({ headSha: 'def456', checksOverall: 'failure' }) })
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('re-notifies when a new head commit fails with no non-failure poll in between', async () => {
    // The realistic shape at multi-minute poll intervals: push a fix onto
    // a red PR, CI goes red again, and the poller never happens to catch
    // the pending window. Keying on the head commit rather than on a
    // transition in checksOverall is what makes this fire.
    const { store, send } = setup(makeState({ s1: session(A, 100) }))
    await bulk(store, { [A]: pr({ checksOverall: 'pending' }) })
    await bulk(store, { [A]: pr({ headSha: 'abc123', checksOverall: 'failure' }) })
    await bulk(store, { [A]: pr({ headSha: 'def456', checksOverall: 'failure' }) })
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('repeated failure polls without an intervening state change notify once', async () => {
    const { store, send } = setup(makeState({ s1: session(A, 100) }))
    await bulk(store, { [A]: pr({ checksOverall: 'success' }) })
    for (let i = 0; i < 5; i++) {
      await bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    }
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('claims the commit synchronously so a second poll cannot double-notify', async () => {
    const { store, send } = setup(makeState({ s1: session(A, 100) }))
    store.dispatch({
      type: 'prs/bulkStatusChanged',
      payload: { [A]: pr({ checksOverall: 'pending' }) }
    })
    // Both failure polls land before the deferred delivery runs.
    store.dispatch({
      type: 'prs/bulkStatusChanged',
      payload: { [A]: pr({ checksOverall: 'success' }) }
    })
    store.dispatch({
      type: 'prs/bulkStatusChanged',
      payload: { [A]: pr({ checksOverall: 'failure' }) }
    })
    store.dispatch({
      type: 'prs/bulkStatusChanged',
      payload: { [A]: pr({ checksOverall: 'success' }) }
    })
    store.dispatch({
      type: 'prs/bulkStatusChanged',
      payload: { [A]: pr({ checksOverall: 'failure' }) }
    })
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('falls back to the PR number when headSha is absent', async () => {
    const { store, send } = setup(makeState({ s1: session(A, 100) }))
    await bulk(store, { [A]: pr({ headSha: undefined, checksOverall: 'pending' }) })
    await bulk(store, { [A]: pr({ headSha: undefined, checksOverall: 'failure' }) })
    await bulk(store, { [A]: pr({ headSha: undefined, checksOverall: 'pending' }) })
    await bulk(store, { [A]: pr({ headSha: undefined, checksOverall: 'failure' }) })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('drops caches when a worktree leaves the payload', async () => {
    const { store, send } = setup(makeState({ s1: session(A, 100) }))
    await bulk(store, { [A]: pr({ checksOverall: 'pending' }) })
    await bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    expect(send).toHaveBeenCalledTimes(1)
    await bulk(store, {})
    // Re-appearing is a first observation again — record, don't notify.
    await bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('releases the commit claim when delivery finds nowhere to send', async () => {
    const { store, send, wake } = setup(makeState({}))
    await bulk(store, { [A]: pr({ checksOverall: 'pending' }) })
    await bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    expect(send).not.toHaveBeenCalled()
    expect(wake).not.toHaveBeenCalled()
    // Same commit, but a chat tab exists now — the released claim lets it fire.
    store.dispatch({
      type: 'terminals/panesForWorktreeChanged',
      payload: { worktreePath: A, panes: panes([{ id: 't1', mode: 'asleep' }]) }
    })
    await bulk(store, { [A]: pr({ checksOverall: 'pending' }) })
    await bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('CiNotifier enablement', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does nothing when the global default is off and there is no override', async () => {
    const { store, send } = setup(
      makeState({ s1: session(A, 100) }, { globalDefault: false })
    )
    await bulk(store, { [A]: pr({ checksOverall: 'pending' }) })
    await bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    expect(send).not.toHaveBeenCalled()
  })

  it('a per-worktree true override beats a false global default', async () => {
    const { store, send } = setup(
      makeState(
        { s1: session(A, 100) },
        { globalDefault: false, overrides: { [A]: true } }
      )
    )
    await bulk(store, { [A]: pr({ checksOverall: 'pending' }) })
    await bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('a per-worktree false override beats a true global default', async () => {
    const { store, send } = setup(
      makeState(
        { s1: session(A, 100) },
        { globalDefault: true, overrides: { [A]: false } }
      )
    )
    await bulk(store, { [A]: pr({ checksOverall: 'pending' }) })
    await bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    expect(send).not.toHaveBeenCalled()
  })
})

describe('CiNotifier session selection', () => {
  beforeEach(() => vi.clearAllMocks())

  it('picks the most recently active session when a worktree has several', async () => {
    const { store, send } = setup(
      makeState({ s1: session(A, 100), s2: session(A, 900), s3: session(A, 500) })
    )
    await bulk(store, { [A]: pr({ checksOverall: 'pending' }) })
    await bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toBe('s2')
  })

  it('ignores non-live sessions when picking the most recent', async () => {
    const { store, send } = setup(
      makeState({ s1: session(A, 100), s2: session(A, 900) }),
      ['s1']
    )
    await bulk(store, { [A]: pr({ checksOverall: 'pending' }) })
    await bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    expect(send.mock.calls[0][0]).toBe('s1')
  })
})

describe('CiNotifier waking a slept tab', () => {
  beforeEach(() => vi.clearAllMocks())

  it('wakes a slept chat tab and sends to it', async () => {
    const { store, send, wake } = setup(
      makeState({}, { panes: { [A]: panes([{ id: 't1', mode: 'asleep' }]) } })
    )
    await bulk(store, { [A]: pr({ checksOverall: 'pending' }) })
    await bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    expect(wake).toHaveBeenCalledWith(A, 't1')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toBe('t1')
  })

  it('prefers a live session over waking a slept tab', async () => {
    const { store, send, wake } = setup(
      makeState(
        { s1: session(A, 100) },
        { panes: { [A]: panes([{ id: 't1', mode: 'asleep' }]) } }
      )
    )
    await bulk(store, { [A]: pr({ checksOverall: 'pending' }) })
    await bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    expect(wake).not.toHaveBeenCalled()
    expect(send.mock.calls[0][0]).toBe('s1')
  })

  it("prefers the pane's active tab among several slept tabs", async () => {
    const { store, send } = setup(
      makeState(
        {},
        {
          panes: {
            [A]: panes(
              [
                { id: 't1', mode: 'asleep' },
                { id: 't2', mode: 'asleep' }
              ],
              't2'
            )
          }
        }
      )
    )
    await bulk(store, { [A]: pr({ checksOverall: 'pending' }) })
    await bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    expect(send.mock.calls[0][0]).toBe('t2')
  })

  it('leaves awake-but-dead tabs alone — the renderer respawns those on focus', async () => {
    const { store, send, wake } = setup(
      makeState({}, { panes: { [A]: panes([{ id: 't1', mode: 'awake' }]) } })
    )
    await bulk(store, { [A]: pr({ checksOverall: 'pending' }) })
    await bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    expect(wake).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('does nothing for a worktree with no chat tab at all', async () => {
    const { store, send, wake } = setup(makeState({ s1: session(B, 100) }))
    await bulk(store, { [A]: pr({ checksOverall: 'pending' }) })
    await bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    expect(wake).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('does not send when the wake fails to produce a live session', async () => {
    const store = new Store(
      makeState({}, { panes: { [A]: panes([{ id: 't1', mode: 'asleep' }]) } })
    )
    const send = vi.fn()
    const wake = vi.fn()
    new CiNotifier(store, { send, hasSession: () => false, wake, respawn: () => {} }).start()
    await bulk(store, { [A]: pr({ checksOverall: 'pending' }) })
    await bulk(store, { [A]: pr({ checksOverall: 'failure' }) })
    expect(wake).toHaveBeenCalledWith(A, 't1')
    expect(send).not.toHaveBeenCalled()
  })
})

describe('buildCiFailureMessage', () => {
  it('marks the turn as automated so the model knows nobody typed it', () => {
    const parsed = parseAutomatedMessage(buildCiFailureMessage(pr()))
    expect(parsed?.source).toBe('ci-failure')
    expect(parsed?.body).toContain('CI is failing on PR #7')
  })

  it('lists failing checks with descriptions and detail urls', () => {
    const msg = buildCiFailureMessage(
      pr({
        checks: [
          { name: 'build', state: 'failure', description: 'exit code 1', detailsUrl: 'https://ci/1' },
          { name: 'lint', state: 'success', description: '' },
          { name: 'e2e', state: 'error', description: '', detailsUrl: 'https://ci/2' }
        ]
      })
    )
    expect(msg).toContain('CI is failing on PR #7 (feat/thing)')
    expect(msg).toContain('- build: exit code 1 — https://ci/1')
    expect(msg).toContain('- e2e — https://ci/2')
    expect(msg).not.toContain('lint')
  })

  it('falls back to the PR url when no individual check is failing', () => {
    const msg = buildCiFailureMessage(pr({ checks: [] }))
    expect(msg).toContain('https://github.com/o/r/pull/7')
  })

  it('truncates a very long failing-check list', () => {
    const checks = Array.from({ length: 14 }, (_, i) => check(`c${i}`, 'failure'))
    const msg = buildCiFailureMessage(pr({ checks }))
    expect(msg).toContain('…and 4 more')
  })
})
