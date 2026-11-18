import { describe, it, expect, vi } from 'vitest'

vi.mock('./debug', () => ({ log: () => {} }))

import { Store } from './store'
import { NotificationBus } from './notification-bus'
import {
  SubscriptionNotifier,
  describePrChanges,
  pruneForRemovedWorktrees,
  recordWorktreeOrigin,
  reportProgress,
  subscribeToWorktree,
  unsubscribeFromWorktree
} from './worktree-subscriptions'
import { initialState, type AppState } from '../shared/state'
import type { PRStatus } from '../shared/state/prs'
import type { PaneNode } from '../shared/state/terminals'
import type { WorktreeInfo } from './worktree'
import { parseAutomatedMessage, parseUserTurn } from '../shared/state/json-claude'
import { subscribersOf, subscriptionsOfTab } from '../shared/subscribers'

const PARENT = '/wt/parent'
const CHILD = '/wt/child'
const PARENT_TAB = 'parent-tab'
const CHILD_TAB = 'child-tab'

const flush = () => new Promise((resolve) => setImmediate(resolve))

function pr(over: Partial<PRStatus> = {}): PRStatus {
  return {
    number: 7,
    title: 'Add a thing',
    state: 'open',
    url: 'https://github.com/o/r/pull/7',
    branch: 'feat/thing',
    headSha: 'aaaaaaa1',
    author: null,
    checks: [],
    checksOverall: 'pending',
    hasConflict: false,
    reviews: [],
    reviewDecision: 'none',
    baseBranch: 'main',
    isDefaultBase: true,
    assignees: [],
    linkedIssues: [],
    labels: [],
    ...over
  }
}

function leaf(tabId: string): PaneNode {
  return {
    type: 'leaf',
    id: `p-${tabId}`,
    tabs: [{ id: tabId, type: 'json-claude', label: 'Chat' }],
    activeTabId: tabId
  }
}

function worktree(path: string, branch: string): WorktreeInfo {
  return { path, branch, head: 'x', isMain: false, isBare: false, repoRoot: '/repo' } as WorktreeInfo
}

function setup(over: Partial<AppState> = {}) {
  const store = new Store({
    ...initialState,
    worktrees: {
      ...initialState.worktrees,
      list: [worktree(PARENT, 'parent'), worktree(CHILD, 'child')]
    },
    terminals: {
      ...initialState.terminals,
      panes: { [PARENT]: leaf(PARENT_TAB), [CHILD]: leaf(CHILD_TAB) }
    },
    ...over
  })
  const live = new Set([PARENT_TAB, CHILD_TAB])
  const send = vi.fn<(sessionId: string, text: string) => void>()
  store.dispatch({ type: 'jsonClaude/sessionStarted', payload: { sessionId: PARENT_TAB, worktreePath: PARENT } })
  store.dispatch({ type: 'jsonClaude/sessionStarted', payload: { sessionId: CHILD_TAB, worktreePath: CHILD } })
  const delivery = new NotificationBus(
    store,
    { send, hasSession: (id: string) => live.has(id), wake: () => {}, respawn: () => {} },
    async () => true
  )
  return { store, send, delivery }
}

describe('describePrChanges', () => {
  it('baselines an unobserved target instead of reporting it', () => {
    expect(describePrChanges(undefined, pr())).toEqual([])
  })

  it('reports a PR opening as routine', () => {
    expect(describePrChanges(null, pr())).toEqual([
      { kind: 'opened', text: 'Opened PR #7: "Add a thing"', urgent: false }
    ])
  })

  it('reports a new commit that fails CI as urgent, naming the checks', () => {
    const next = pr({
      headSha: 'bbbbbbb2',
      checksOverall: 'failure',
      checks: [{ name: 'build', state: 'failure', description: '' }]
    })
    expect(describePrChanges(pr(), next)).toEqual([
      { kind: 'commit', text: 'New commit pushed (bbbbbbb)', urgent: false },
      { kind: 'ci', text: 'CI failing\n  - build', urgent: true }
    ])
  })

  it('reports merges, change requests and conflicts as urgent', () => {
    const changes = describePrChanges(
      pr(),
      pr({
        state: 'merged',
        reviewDecision: 'changes_requested',
        hasConflict: true,
        reviews: [
          { user: 'octo', avatarUrl: '', state: 'CHANGES_REQUESTED', body: '', submittedAt: '', htmlUrl: '' }
        ]
      })
    )
    expect(changes).toEqual([
      { kind: 'state', text: 'PR merged', urgent: true },
      { kind: 'review', text: 'Changes requested by octo', urgent: true },
      { kind: 'conflict', text: 'PR now has merge conflicts with its base', urgent: true }
    ])
  })

  it('reports the CI result a PR opens with', () => {
    expect(describePrChanges(null, pr({ checksOverall: 'failure' })).map((c) => c.kind)).toEqual([
      'opened',
      'ci'
    ])
  })

  it('says nothing when a poll changes nothing', () => {
    expect(describePrChanges(pr(), pr())).toEqual([])
  })
})

describe('implicit subscriptions', () => {
  it('a recorded origin makes the creator follow the worktree, silently, with nothing stored', () => {
    const { store } = setup()
    recordWorktreeOrigin(store, CHILD, { worktreePath: PARENT, tabId: PARENT_TAB })
    const state = store.getSnapshot().state
    expect(state.subscriptions.list).toEqual([])
    expect(subscribersOf(state, CHILD)).toMatchObject([
      { subscriberTabId: PARENT_TAB, kind: 'implicit', reason: 'created-worktree', mode: 'silent' }
    ])
    expect(subscriptionsOfTab(state, PARENT_TAB).map((s) => s.targetPath)).toEqual([CHILD])
  })

  it('cannot be unsubscribed from, and an explicit subscription shadows it', () => {
    const { store, delivery } = setup()
    recordWorktreeOrigin(store, CHILD, { worktreePath: PARENT, tabId: PARENT_TAB })
    expect(unsubscribeFromWorktree(store, PARENT_TAB, CHILD)).toBe('implicit')
    subscribeToWorktree(store, delivery, {
      subscriberPath: PARENT,
      subscriberTabId: PARENT_TAB,
      targetPath: CHILD,
      mode: 'interrupt'
    })
    expect(subscribersOf(store.getSnapshot().state, CHILD)).toMatchObject([
      { kind: 'explicit', mode: 'interrupt' }
    ])
    expect(unsubscribeFromWorktree(store, PARENT_TAB, CHILD)).toBe('removed')
    expect(subscribersOf(store.getSnapshot().state, CHILD)).toMatchObject([{ kind: 'implicit' }])
  })

  it('goes away with the worktree, because its origin does', () => {
    const { store } = setup()
    recordWorktreeOrigin(store, CHILD, { worktreePath: PARENT, tabId: PARENT_TAB })
    store.dispatch({ type: 'worktrees/listChanged', payload: [worktree(PARENT, 'parent')] })
    pruneForRemovedWorktrees(store, new Set([CHILD]))
    expect(subscribersOf(store.getSnapshot().state, CHILD)).toEqual([])
  })
})

describe('subscribeToWorktree', () => {
  it('stores the subscription and briefs the target agent', () => {
    const { store, send, delivery } = setup()
    const r = subscribeToWorktree(store, delivery, {
      subscriberPath: PARENT,
      subscriberTabId: PARENT_TAB,
      targetPath: CHILD,
      note: 'tell me when the API lands'
    })
    expect(r).toMatchObject({ created: true, mode: 'interrupt', targetNotified: true })
    expect(send).toHaveBeenCalledTimes(1)
    const [tab, wire] = send.mock.calls[0]
    expect(tab).toBe(CHILD_TAB)
    const parsed = parseAutomatedMessage(wire)
    expect(parsed?.source).toBe('subscription-started')
    expect(parsed?.body).toContain('tell me when the API lands')
  })
})

describe('reportProgress', () => {
  it('interrupts an interrupt-mode follower and holds for a silent one', () => {
    const { store, send, delivery } = setup()
    recordWorktreeOrigin(store, CHILD, { worktreePath: PARENT, tabId: PARENT_TAB })
    const r = reportProgress(store, delivery, CHILD, CHILD_TAB, 'tests pass', false)
    expect(r.delivered).toEqual([{ worktreePath: PARENT, tabId: PARENT_TAB, delivery: 'held' }])
    expect(send).not.toHaveBeenCalled()
    const held = store.getSnapshot().state.notifications.pendingByTab[PARENT_TAB]
    expect(held).toHaveLength(1)
    expect(parseAutomatedMessage(held[0].wire)?.body).toBe('tests pass')
  })

  it('urgent overrides a silent follower', () => {
    const { store, send, delivery } = setup()
    recordWorktreeOrigin(store, CHILD, { worktreePath: PARENT, tabId: PARENT_TAB })
    reportProgress(store, delivery, CHILD, CHILD_TAB, 'blocked on a decision', true)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toBe(PARENT_TAB)
  })

  it('drops an explicit subscription whose tab is gone', () => {
    const { store, delivery } = setup()
    subscribeToWorktree(store, delivery, {
      subscriberPath: PARENT,
      subscriberTabId: 'closed-tab',
      targetPath: CHILD
    })
    const r = reportProgress(store, delivery, CHILD, CHILD_TAB, 'hi', false)
    expect(r.failed).toMatchObject([{ tabId: 'closed-tab', reason: 'no-tab' }])
    expect(store.getSnapshot().state.subscriptions.list).toEqual([])
  })
})

describe('SubscriptionNotifier', () => {
  it('stays quiet on the baseline poll, then reports a CI failure as an interrupt', async () => {
    const { store, send, delivery } = setup()
    recordWorktreeOrigin(store, CHILD, { worktreePath: PARENT, tabId: PARENT_TAB })
    const notifier = new SubscriptionNotifier(store, delivery, () => true)
    notifier.start()

    store.dispatch({ type: 'prs/bulkStatusChanged', payload: { [CHILD]: pr() } })
    await flush()
    expect(send).not.toHaveBeenCalled()

    store.dispatch({
      type: 'prs/statusChanged',
      payload: { path: CHILD, status: pr({ checksOverall: 'failure' }) }
    })
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    const [tab, wire] = send.mock.calls[0]
    expect(tab).toBe(PARENT_TAB)
    expect(parseAutomatedMessage(wire)?.source).toBe('subscription-update')
    notifier.stop()
  })

  it('holds routine updates for a silent follower until its next turn', async () => {
    const { store, send, delivery } = setup()
    recordWorktreeOrigin(store, CHILD, { worktreePath: PARENT, tabId: PARENT_TAB })
    const notifier = new SubscriptionNotifier(store, delivery, () => true)
    notifier.start()
    store.dispatch({ type: 'prs/bulkStatusChanged', payload: { [CHILD]: null } })
    store.dispatch({ type: 'prs/statusChanged', payload: { path: CHILD, status: pr() } })
    await flush()
    expect(send).not.toHaveBeenCalled()
    const held = store.getSnapshot().state.notifications.pendingByTab[PARENT_TAB]
    expect(held).toHaveLength(1)
    expect(parseUserTurn(held[0].wire).text).toContain('Opened PR #7')
    notifier.stop()
  })

  it('does nothing while messaging is disabled', async () => {
    const { store, send, delivery } = setup()
    recordWorktreeOrigin(store, CHILD, { worktreePath: PARENT, tabId: PARENT_TAB })
    const notifier = new SubscriptionNotifier(store, delivery, () => false)
    notifier.start()
    store.dispatch({ type: 'prs/bulkStatusChanged', payload: { [CHILD]: pr() } })
    store.dispatch({
      type: 'prs/statusChanged',
      payload: { path: CHILD, status: pr({ state: 'merged' }) }
    })
    await flush()
    expect(send).not.toHaveBeenCalled()
    expect(store.getSnapshot().state.notifications.pendingByTab).toEqual({})
    notifier.stop()
  })
})

describe('review follow-ups', () => {
  it('a closed creator tab stops following, with nothing to clean up', () => {
    const { store, send, delivery } = setup()
    recordWorktreeOrigin(store, CHILD, { worktreePath: PARENT, tabId: PARENT_TAB })
    store.dispatch({
      type: 'terminals/panesForWorktreeChanged',
      payload: { worktreePath: PARENT, panes: { type: 'leaf', id: 'p', tabs: [], activeTabId: '' } }
    })
    const r = reportProgress(store, delivery, CHILD, CHILD_TAB, 'hi', false)
    expect(r).toEqual({ delivered: [], failed: [] })
    expect(send).not.toHaveBeenCalled()
  })

  it('changing only the mode does not re-brief the target agent', () => {
    const { store, send, delivery } = setup()
    const sub = { subscriberPath: PARENT, subscriberTabId: PARENT_TAB, targetPath: CHILD, note: 'n' }
    subscribeToWorktree(store, delivery, sub)
    expect(send).toHaveBeenCalledTimes(1)
    const r = subscribeToWorktree(store, delivery, { ...sub, mode: 'silent' })
    expect(r).toMatchObject({ created: false, mode: 'silent', targetNotified: false })
    expect(send).toHaveBeenCalledTimes(1)
    subscribeToWorktree(store, delivery, { ...sub, note: 'new note', mode: 'silent' })
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('subscribing to a worktree you already follow implicitly does not re-brief it', () => {
    const { store, send, delivery } = setup()
    recordWorktreeOrigin(store, CHILD, { worktreePath: PARENT, tabId: PARENT_TAB })
    subscribeToWorktree(store, delivery, {
      subscriberPath: PARENT,
      subscriberTabId: PARENT_TAB,
      targetPath: CHILD,
      mode: 'interrupt'
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('prune only touches the paths it is told left the list', () => {
    const { store } = setup()
    recordWorktreeOrigin(store, '/wt/brand-new', { worktreePath: PARENT, tabId: PARENT_TAB })
    pruneForRemovedWorktrees(store, new Set(['/wt/something-else']))
    expect(store.getSnapshot().state.origins.byPath['/wt/brand-new']).toBeDefined()
  })

  it('unsubscribe → PR changes → resubscribe stays quiet', async () => {
    const { store, send, delivery } = setup()
    const notifier = new SubscriptionNotifier(store, delivery, () => true)
    notifier.start()
    const sub = { subscriberPath: PARENT, subscriberTabId: PARENT_TAB, targetPath: CHILD }
    store.dispatch({ type: 'prs/bulkStatusChanged', payload: { [CHILD]: pr() } })
    subscribeToWorktree(store, delivery, sub)
    unsubscribeFromWorktree(store, PARENT_TAB, CHILD)
    store.dispatch({
      type: 'prs/bulkStatusChanged',
      payload: { [CHILD]: pr({ headSha: 'ccccccc3', checksOverall: 'success', reviewDecision: 'approved' }) }
    })
    await flush()
    send.mockClear()
    subscribeToWorktree(store, delivery, sub)
    send.mockClear()
    store.dispatch({
      type: 'prs/bulkStatusChanged',
      payload: { [CHILD]: pr({ headSha: 'ccccccc3', checksOverall: 'success', reviewDecision: 'approved' }) }
    })
    await flush()
    expect(send).not.toHaveBeenCalled()
    notifier.stop()
  })
})

describe('own-worktree PR notifications', () => {
  function withCiNotify(on: boolean) {
    const s = setup({
      settings: { ...initialState.settings, notifyChatOnCiFailure: on }
    })
    return s
  }

  it('a CI failure on its own PR interrupts the worktree agent with a pr-update', async () => {
    const { store, send, delivery } = withCiNotify(true)
    const notifier = new SubscriptionNotifier(store, delivery, () => false)
    notifier.start()
    store.dispatch({ type: 'prs/bulkStatusChanged', payload: { [CHILD]: pr() } })
    store.dispatch({
      type: 'prs/statusChanged',
      payload: {
        path: CHILD,
        status: pr({
          checksOverall: 'failure',
          checks: [{ name: 'build', state: 'failure', description: 'tsc', detailsUrl: 'https://ci/1' }]
        })
      }
    })
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    const [tab, wire] = send.mock.calls[0]
    expect(tab).toBe(CHILD_TAB)
    const parsed = parseAutomatedMessage(wire)
    expect(parsed?.source).toBe('pr-update')
    expect(parsed?.body).toContain('Your PR #7')
    expect(parsed?.body).toContain('build: tsc — https://ci/1')
    notifier.stop()
  })

  it('reports a flapping check once per commit', async () => {
    const { store, send, delivery } = withCiNotify(true)
    const notifier = new SubscriptionNotifier(store, delivery, () => false)
    notifier.start()
    store.dispatch({ type: 'prs/bulkStatusChanged', payload: { [CHILD]: pr() } })
    for (const checksOverall of ['failure', 'pending', 'failure'] as const) {
      store.dispatch({ type: 'prs/statusChanged', payload: { path: CHILD, status: pr({ checksOverall }) } })
    }
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    notifier.stop()
  })

  it('holds routine updates for its next turn and says nothing when the setting is off', async () => {
    const on = withCiNotify(true)
    const notifier = new SubscriptionNotifier(on.store, on.delivery, () => false)
    notifier.start()
    on.store.dispatch({ type: 'prs/bulkStatusChanged', payload: { [CHILD]: pr() } })
    on.store.dispatch({ type: 'prs/statusChanged', payload: { path: CHILD, status: pr({ checksOverall: 'success' }) } })
    await flush()
    expect(on.send).not.toHaveBeenCalled()
    expect(on.store.getSnapshot().state.notifications.pendingByTab[CHILD_TAB]).toHaveLength(1)
    notifier.stop()

    const off = withCiNotify(false)
    const n2 = new SubscriptionNotifier(off.store, off.delivery, () => false)
    n2.start()
    off.store.dispatch({ type: 'prs/bulkStatusChanged', payload: { [CHILD]: pr() } })
    off.store.dispatch({ type: 'prs/statusChanged', payload: { path: CHILD, status: pr({ checksOverall: 'failure' }) } })
    await flush()
    expect(off.send).not.toHaveBeenCalled()
    expect(off.store.getSnapshot().state.notifications.pendingByTab).toEqual({})
    n2.stop()
  })
})

describe('own-worktree PR notifications: delivery edge cases', () => {
  /** Like setup(), but the bus's delivery can be made to fail, the way a
   *  tab that can't be woken does. */
  function ownSetup(opts: { global?: boolean; override?: boolean; childLive?: boolean } = {}) {
    const store = new Store({
      ...initialState,
      settings: { ...initialState.settings, notifyChatOnCiFailure: opts.global ?? true },
      ciNotify: { byPath: opts.override === undefined ? {} : { [CHILD]: opts.override } },
      worktrees: { ...initialState.worktrees, list: [worktree(PARENT, 'parent'), worktree(CHILD, 'child')] },
      terminals: { ...initialState.terminals, panes: { [PARENT]: leaf(PARENT_TAB), [CHILD]: leaf(CHILD_TAB) } }
    })
    const live = new Set(opts.childLive === false ? [] : [CHILD_TAB])
    const send = vi.fn<(sessionId: string, text: string) => void>()
    const wake = vi.fn((_wt: string, tabId: string) => {
      if (canWake.value) live.add(tabId)
    })
    const canWake = { value: true }
    const bus = new NotificationBus(
      store,
      { send, hasSession: (id) => live.has(id), wake, respawn: (wt, id) => wake(wt, id) },
      async () => true
    )
    const notifier = new SubscriptionNotifier(store, bus, () => false)
    notifier.start()
    store.dispatch({ type: 'prs/bulkStatusChanged', payload: { [CHILD]: pr() } })
    return { store, send, wake, canWake, notifier }
  }
  const red = (over: Partial<PRStatus> = {}) => pr({ checksOverall: 'failure', ...over })

  it('retries a CI failure whose delivery failed, on the next poll of the same commit', async () => {
    const t = ownSetup({ childLive: false })
    t.canWake.value = false
    t.store.dispatch({ type: 'prs/statusChanged', payload: { path: CHILD, status: red() } })
    await flush()
    expect(t.send).not.toHaveBeenCalled()

    t.canWake.value = true
    t.store.dispatch({ type: 'prs/statusChanged', payload: { path: CHILD, status: red() } })
    await flush()
    expect(t.send).toHaveBeenCalledTimes(1)
    expect(parseAutomatedMessage(t.send.mock.calls[0][1])?.body).toContain('CI failing')
    t.notifier.stop()
  })

  it('wakes a slept tab to deliver an urgent update', async () => {
    const t = ownSetup({ childLive: false })
    t.store.dispatch({ type: 'prs/statusChanged', payload: { path: CHILD, status: red() } })
    await flush()
    expect(t.wake).toHaveBeenCalled()
    expect(t.send).toHaveBeenCalledTimes(1)
    t.notifier.stop()
  })

  it('reports a failure that landed while the worktree had no Chat tab, once one opens', async () => {
    const t = ownSetup()
    t.store.dispatch({
      type: 'terminals/panesForWorktreeChanged',
      payload: { worktreePath: CHILD, panes: { type: 'leaf', id: 'p', tabs: [], activeTabId: '' } }
    })
    t.store.dispatch({ type: 'prs/statusChanged', payload: { path: CHILD, status: red() } })
    await flush()
    expect(t.send).not.toHaveBeenCalled()

    t.store.dispatch({ type: 'terminals/panesForWorktreeChanged', payload: { worktreePath: CHILD, panes: leaf(CHILD_TAB) } })
    t.store.dispatch({ type: 'prs/statusChanged', payload: { path: CHILD, status: red() } })
    await flush()
    expect(t.send).toHaveBeenCalledTimes(1)
    t.notifier.stop()
  })

  it('a per-worktree override beats the global setting, both ways', async () => {
    const offHere = ownSetup({ global: true, override: false })
    offHere.store.dispatch({ type: 'prs/statusChanged', payload: { path: CHILD, status: red() } })
    await flush()
    expect(offHere.send).not.toHaveBeenCalled()
    offHere.notifier.stop()

    const onHere = ownSetup({ global: false, override: true })
    onHere.store.dispatch({ type: 'prs/statusChanged', payload: { path: CHILD, status: red() } })
    await flush()
    expect(onHere.send).toHaveBeenCalledTimes(1)
    onHere.notifier.stop()
  })

  it('works for statuses cached without a headSha', async () => {
    const t = ownSetup()
    t.store.dispatch({ type: 'prs/bulkStatusChanged', payload: { [CHILD]: pr({ headSha: undefined }) } })
    for (const checksOverall of ['failure', 'pending', 'failure'] as const) {
      t.store.dispatch({
        type: 'prs/statusChanged',
        payload: { path: CHILD, status: pr({ headSha: undefined, checksOverall }) }
      })
    }
    await flush()
    expect(t.send).toHaveBeenCalledTimes(1)
    t.notifier.stop()
  })

  it("leaves out what the agent already knows: its own new commits and opening the PR", async () => {
    const t = ownSetup()
    t.store.dispatch({ type: 'prs/statusChanged', payload: { path: CHILD, status: pr({ headSha: 'bbbbbbb2' }) } })
    await flush()
    expect(t.send).not.toHaveBeenCalled()
    expect(t.store.getSnapshot().state.notifications.pendingByTab).toEqual({})
    t.notifier.stop()
  })
})
