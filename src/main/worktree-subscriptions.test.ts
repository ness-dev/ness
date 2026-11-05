import { describe, it, expect, vi } from 'vitest'

vi.mock('./debug', () => ({ log: () => {} }))

import { Store } from './store'
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
  const delivery = {
    send,
    hasSession: (id: string) => live.has(id),
    wake: () => {},
    respawn: () => {}
  }
  return { store, send, delivery }
}

describe('describePrChanges', () => {
  it('baselines an unobserved target instead of reporting it', () => {
    expect(describePrChanges(undefined, pr())).toEqual([])
  })

  it('reports a PR opening as routine', () => {
    expect(describePrChanges(null, pr())).toEqual([
      { text: 'Opened PR #7: "Add a thing"', urgent: false }
    ])
  })

  it('reports a new commit that fails CI as urgent, naming the checks', () => {
    const next = pr({
      headSha: 'bbbbbbb2',
      checksOverall: 'failure',
      checks: [{ name: 'build', state: 'failure', description: '' }]
    })
    expect(describePrChanges(pr(), next)).toEqual([
      { text: 'New commit pushed (bbbbbbb)', urgent: false },
      { text: 'CI failing (build)', urgent: true }
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
      { text: 'PR merged', urgent: true },
      { text: 'Changes requested by octo', urgent: true },
      { text: 'PR now has merge conflicts with its base', urgent: true }
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
    pruneForRemovedWorktrees(store)
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
