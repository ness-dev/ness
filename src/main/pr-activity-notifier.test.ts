import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./debug', () => ({ log: () => {} }))

import { Store } from './store'
import {
  PrCommentNotifier,
  MergeConflictNotifier,
  buildPrFeedbackMessage,
  feedbackItems
} from './pr-activity-notifier'
import { initialState, type AppState } from '../shared/state'
import type { PRComment, PRReview, PRStatus } from '../shared/state/prs'
import type { JsonClaudeSession } from '../shared/state/json-claude'
import { parseAutomatedMessage } from '../shared/state/json-claude'
import type { PrNotifyOverrides } from '../shared/state/pr-notify'

const A = '/wt/a'

const flush = () => new Promise((resolve) => setImmediate(resolve))

function comment(user: string, at: string, body = `${user} says hi`): PRComment {
  return { user, avatarUrl: '', body, createdAt: at, htmlUrl: `https://github.com/o/r/pull/7#c-${at}` }
}

function review(
  user: string,
  at: string,
  state: PRReview['state'] = 'COMMENTED',
  extra: Partial<PRReview> = {}
): PRReview {
  return {
    user,
    avatarUrl: '',
    state,
    body: `${user} reviewed`,
    submittedAt: at,
    htmlUrl: `https://github.com/o/r/pull/7#r-${at}`,
    ...extra
  }
}

function pr(overrides: Partial<PRStatus> = {}): PRStatus {
  return {
    number: 7,
    title: 'Add a thing',
    state: 'open',
    url: 'https://github.com/o/r/pull/7',
    branch: 'feat/thing',
    headSha: 'abc123',
    author: { login: 'me', avatarUrl: '' },
    checks: [],
    checksOverall: 'success',
    hasConflict: false,
    reviews: [],
    comments: [],
    reviewDecision: 'none',
    baseBranch: 'main',
    isDefaultBase: true,
    assignees: [],
    linkedIssues: [],
    labels: [],
    ...overrides
  }
}

function session(worktreePath: string): JsonClaudeSession {
  return {
    sessionId: 'ignored',
    worktreePath,
    state: 'running',
    exitCode: null,
    exitReason: null,
    entries: [{ entryId: 'e1', kind: 'user', timestamp: 100 }],
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

function makeState(
  opts: {
    comments?: boolean
    conflicts?: boolean
    viewerLogin?: string | null
    overrides?: Record<string, PrNotifyOverrides>
    sessions?: Record<string, JsonClaudeSession>
  } = {}
): AppState {
  return {
    ...initialState,
    settings: {
      ...initialState.settings,
      notifyChatOnPrComments: opts.comments ?? true,
      notifyChatOnMergeConflict: opts.conflicts ?? true,
      viewerLogin: opts.viewerLogin === undefined ? 'me' : opts.viewerLogin
    },
    prNotify: { byPath: { ...(opts.overrides ?? {}) } },
    jsonClaude: { ...initialState.jsonClaude, sessions: opts.sessions ?? { s1: session(A) } }
  }
}

function setup(
  Notifier: typeof PrCommentNotifier | typeof MergeConflictNotifier,
  state: AppState,
  live = true
) {
  const store = new Store(state)
  const send = vi.fn()
  new Notifier(store, { send, hasSession: () => live, wake: () => {} }).start()
  return { store, send }
}

async function poll(store: Store, status: PRStatus | null): Promise<void> {
  store.dispatch({ type: 'prs/bulkStatusChanged', payload: { [A]: status } })
  await flush()
}

describe('PrCommentNotifier', () => {
  beforeEach(() => vi.clearAllMocks())

  it('forwards a new comment from someone else', async () => {
    const { store, send } = setup(PrCommentNotifier, makeState())
    await poll(store, pr({ comments: [comment('alice', '2026-01-01T00:00:00Z')] }))
    expect(send).not.toHaveBeenCalled()
    await poll(
      store,
      pr({
        comments: [
          comment('alice', '2026-01-01T00:00:00Z'),
          comment('bob', '2026-01-02T00:00:00Z', 'please rename foo')
        ]
      })
    )
    expect(send).toHaveBeenCalledTimes(1)
    const text = send.mock.calls[0][1] as string
    expect(text).toContain('@bob commented')
    expect(text).toContain('> please rename foo')
    expect(text).not.toContain('@alice')
  })

  it('stays quiet about comments that existed at the first poll', async () => {
    const { store, send } = setup(PrCommentNotifier, makeState())
    await poll(store, pr({ comments: [comment('bob', '2026-01-02T00:00:00Z')] }))
    await poll(store, pr({ comments: [comment('bob', '2026-01-02T00:00:00Z')] }))
    expect(send).not.toHaveBeenCalled()
  })

  it('skips the viewer’s own comments', async () => {
    const { store, send } = setup(PrCommentNotifier, makeState({ viewerLogin: 'Me' }))
    await poll(store, pr())
    await poll(store, pr({ comments: [comment('me', '2026-01-02T00:00:00Z')] }))
    expect(send).not.toHaveBeenCalled()
  })

  it('falls back to skipping the PR author when the viewer is unknown', async () => {
    const { store, send } = setup(PrCommentNotifier, makeState({ viewerLogin: null }))
    await poll(store, pr())
    await poll(store, pr({ comments: [comment('me', '2026-01-02T00:00:00Z')] }))
    expect(send).not.toHaveBeenCalled()
  })

  it('forwards reviews with their verdict and inline count', async () => {
    const { store, send } = setup(PrCommentNotifier, makeState())
    await poll(store, pr())
    await poll(
      store,
      pr({
        reviews: [
          review('carol', '2026-01-03T00:00:00Z', 'CHANGES_REQUESTED', { inlineCommentCount: 2 })
        ]
      })
    )
    const text = send.mock.calls[0][1] as string
    expect(text).toContain('@carol requested changes with 2 inline comments')
    expect(text).toContain('gh api repos/o/r/pulls/7/comments')
  })

  it('does not notify when disabled, and honours a per-worktree override', async () => {
    const off = setup(PrCommentNotifier, makeState({ comments: false }))
    await poll(off.store, pr())
    await poll(off.store, pr({ comments: [comment('bob', '2026-01-02T00:00:00Z')] }))
    expect(off.send).not.toHaveBeenCalled()

    const on = setup(
      PrCommentNotifier,
      makeState({ comments: false, overrides: { [A]: { comments: true } } })
    )
    await poll(on.store, pr())
    await poll(on.store, pr({ comments: [comment('bob', '2026-01-02T00:00:00Z')] }))
    expect(on.send).toHaveBeenCalledTimes(1)
  })

  it('does not notify on closed or merged PRs', async () => {
    const { store, send } = setup(PrCommentNotifier, makeState())
    await poll(store, pr({ state: 'merged' }))
    await poll(store, pr({ state: 'merged', comments: [comment('bob', '2026-01-02T00:00:00Z')] }))
    expect(send).not.toHaveBeenCalled()
  })

  it('notifies once per comment across repeated polls', async () => {
    const { store, send } = setup(PrCommentNotifier, makeState())
    await poll(store, pr())
    const withBob = pr({ comments: [comment('bob', '2026-01-02T00:00:00Z')] })
    await poll(store, withBob)
    await poll(store, withBob)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('retries on the next poll when there is no chat to deliver to', async () => {
    const state = makeState()
    const store = new Store(state)
    const send = vi.fn()
    let live = false
    new PrCommentNotifier(store, { send, hasSession: () => live, wake: () => {} }).start()
    await poll(store, pr())
    const withBob = pr({ comments: [comment('bob', '2026-01-02T00:00:00Z')] })
    await poll(store, withBob)
    expect(send).not.toHaveBeenCalled()
    live = true
    await poll(store, withBob)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('treats a status without a comments field as no baseline', async () => {
    const { store, send } = setup(PrCommentNotifier, makeState())
    await poll(store, pr())
    await poll(store, pr({ comments: undefined }))
    await poll(store, pr({ comments: [comment('bob', '2026-01-02T00:00:00Z')] }))
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('MergeConflictNotifier', () => {
  beforeEach(() => vi.clearAllMocks())

  it('asks the agent to resolve conflicts when the PR starts conflicting', async () => {
    const { store, send } = setup(MergeConflictNotifier, makeState())
    await poll(store, pr({ hasConflict: false }))
    await poll(store, pr({ hasConflict: true }))
    expect(send).toHaveBeenCalledTimes(1)
    const parsed = parseAutomatedMessage(send.mock.calls[0][1] as string)
    expect(parsed?.source).toBe('merge-conflict-detected')
    expect(parsed?.body).toContain('has merge conflicts with main')
  })

  it('stays quiet when already conflicting at the first poll', async () => {
    const { store, send } = setup(MergeConflictNotifier, makeState())
    await poll(store, pr({ hasConflict: true }))
    await poll(store, pr({ hasConflict: true }))
    expect(send).not.toHaveBeenCalled()
  })

  it('treats "still computing" as no information', async () => {
    const { store, send } = setup(MergeConflictNotifier, makeState())
    await poll(store, pr({ hasConflict: false }))
    await poll(store, pr({ hasConflict: true }))
    await poll(store, pr({ hasConflict: null }))
    await poll(store, pr({ hasConflict: true }))
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('notifies again after the PR was clean in between', async () => {
    const { store, send } = setup(MergeConflictNotifier, makeState())
    await poll(store, pr({ hasConflict: false }))
    await poll(store, pr({ hasConflict: true }))
    await poll(store, pr({ hasConflict: false }))
    await poll(store, pr({ hasConflict: true }))
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('does not notify when disabled', async () => {
    const { store, send } = setup(MergeConflictNotifier, makeState({ conflicts: false }))
    await poll(store, pr({ hasConflict: false }))
    await poll(store, pr({ hasConflict: true }))
    expect(send).not.toHaveBeenCalled()
  })

  it('a per-worktree opt-out wins over the global default', async () => {
    const { store, send } = setup(
      MergeConflictNotifier,
      makeState({ overrides: { [A]: { conflicts: false } } })
    )
    await poll(store, pr({ hasConflict: false }))
    await poll(store, pr({ hasConflict: true }))
    expect(send).not.toHaveBeenCalled()
  })
})

describe('buildPrFeedbackMessage', () => {
  it('wraps the feedback as a pr-feedback automated message with guidance', () => {
    const status = pr({ comments: [comment('bob', '2026-01-02T00:00:00Z', 'nit')] })
    const msg = buildPrFeedbackMessage(status, feedbackItems(status))
    const parsed = parseAutomatedMessage(msg)
    expect(parsed?.source).toBe('pr-feedback')
    expect(parsed?.body).toContain('New feedback on PR #7')
    expect(msg).toContain('not by the user')
  })

  it('lists items oldest first', () => {
    const status = pr({
      comments: [comment('late', '2026-01-03T00:00:00Z')],
      reviews: [review('early', '2026-01-01T00:00:00Z', 'APPROVED')]
    })
    const msg = buildPrFeedbackMessage(status, feedbackItems(status))
    expect(msg.indexOf('@early approved')).toBeLessThan(msg.indexOf('@late commented'))
  })
})
