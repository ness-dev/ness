import { describe, it, expect, vi } from 'vitest'

vi.mock('./review-comments', async (orig) => ({
  ...(await orig<typeof import('./review-comments')>()),
  refreshReviewAnchors: vi.fn(async () => {})
}))

import { Store } from './store'
import { initialState, type AppState } from '../shared/state'
import type { PaneLeaf, PaneNode } from '../shared/state/terminals'
import type { ReviewComment } from '../shared/state/reviews'
import { listChatTabs, type ChatTabInfo } from '../shared/agent-tabs'
import { parseAutomatedMessage } from '../shared/state/json-claude'
import {
  agentAuthor,
  findReviewComment,
  listReviewComments,
  pickAuthorTab,
  pickReviewTarget,
  replyToReviewComment,
  requestReview,
  reviewRequester,
  sendReviewSubmission,
  setReviewCommentResolved,
  submitReview,
  type ReviewServiceDeps
} from './review-service'

const WT = '/wt'

const tree: PaneNode = {
  type: 'leaf',
  id: 'p',
  tabs: [
    { id: 'author', type: 'json-claude', label: 'Chat' },
    { id: 'reviewer', type: 'agent', label: 'Claude', customLabel: 'Reviewer' },
    { id: 'term', type: 'agent', label: 'Codex', agentKind: 'codex' },
    { id: 'chat2', type: 'json-claude', label: 'Codex Chat', agentKind: 'codex' },
    { id: 'rev-of-author', type: 'json-claude', label: 'Reviewer', reviewOf: 'author' },
    { id: 'sh', type: 'shell', label: 'zsh' }
  ],
  activeTabId: 'reviewer'
}

function comment(id: string, over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id,
    filePath: 'src/a.ts',
    side: 'new',
    line: 3,
    anchoredSha: 'abcdef1234',
    anchor: { commitSha: 'abcdef1234', line: 3, snippet: 'x' },
    author: { kind: 'agent', tabId: 'reviewer', label: 'Reviewer' },
    status: 'open',
    body: 'rename this',
    createdAt: 0,
    ...over
  }
}

function setup(
  comments: ReviewComment[] = [],
  deliver: ReviewServiceDeps['deliver'] = (_w, tabId) => ({
    ok: true,
    tabId,
    woke: false
  })
): {
  store: Store
  deps: ReviewServiceDeps
  deliver: ReturnType<typeof vi.fn>
  openReviewer: ReturnType<typeof vi.fn>
  reviewDefaults: ReturnType<typeof vi.fn>
} {
  const state: AppState = {
    ...initialState,
    terminals: { ...initialState.terminals, panes: { [WT]: tree } },
    reviews: { byPath: comments.length ? { [WT]: { comments } } : {} }
  }
  const store = new Store(state)
  const deliverFn = vi.fn(deliver)
  const openReviewer = vi.fn(() => ({ tabId: 'new-reviewer', reused: false }))
  const reviewDefaults = vi.fn(() => ({ prompt: 'REVIEW INSTRUCTIONS' }) as ReturnType<ReviewServiceDeps['reviewDefaults']>)
  const deps: ReviewServiceDeps = {
    store,
    listChatTabs: (wt) => listChatTabs(store.getSnapshot().state, wt),
    openReviewer,
    reviewDefaults,
    deliver: deliverFn
  }
  return { store, deps, deliver: deliverFn, openReviewer, reviewDefaults }
}

describe('agentAuthor', () => {
  it('labels the author with the tab name the user sees', () => {
    const { store } = setup()
    expect(agentAuthor(store.getSnapshot().state, WT, 'reviewer')).toEqual({
      kind: 'agent',
      tabId: 'reviewer',
      label: 'Reviewer'
    })
    expect(agentAuthor(store.getSnapshot().state, WT, 'gone')).toEqual({
      kind: 'agent',
      tabId: 'gone'
    })
  })
})

describe('findReviewComment', () => {
  const comments = [comment('abcdef01-1'), comment('abcdef02-2')]
  it('matches a full id or an unambiguous prefix, brackets allowed', () => {
    expect(findReviewComment(comments, 'abcdef01-1')).toBe(comments[0])
    expect(findReviewComment(comments, '[abcdef02]')).toBe(comments[1])
  })
  it('rejects ambiguous, short and unknown ids', () => {
    expect(findReviewComment(comments, 'abcdef')).toEqual({
      error: '"abcdef" matches 2 comments — pass more of the id'
    })
    expect(findReviewComment(comments, 'abc')).toHaveProperty('error')
    expect(findReviewComment(comments, 'zzzzzzzz')).toHaveProperty('error')
  })
})

describe('pickReviewTarget', () => {
  it('lists only Chat tabs, so terminal tabs are never picked', () => {
    const { store } = setup()
    const tabs = listChatTabs(store.getSnapshot().state, WT)
    expect(tabs.map((t) => t.id)).toEqual(['author', 'chat2', 'rev-of-author'])
    expect(tabs[1]).toMatchObject({ label: 'Codex Chat', agentKind: 'codex' })
  })

  it('takes the most recently active Chat tab other than the reviewer', () => {
    const tab = (id: string, lastActiveAt: number): ChatTabInfo => ({
      id,
      label: id,
      agentKind: 'claude',
      lastActiveAt,
      asleep: false
    })
    expect(pickReviewTarget([tab('rev', 50), tab('b', 40), tab('a', 0)], 'rev')).toBe('b')
    expect(pickReviewTarget([tab('rev', 50)], 'rev')).toBeNull()
  })
})

describe('pickAuthorTab', () => {
  it('skips reviewer tabs and terminal tabs', () => {
    const { store } = setup()
    // 'reviewer' and 'term' are terminal tabs, 'rev-of-author' is a
    // reviewer; 'author' is the only plain Chat tab before 'chat2'.
    expect(pickAuthorTab(store.getSnapshot().state, WT)).toBe('author')
  })

  it('prefers the most recently active tab', () => {
    const { store } = setup()
    const state = store.getSnapshot().state
    const withEntries: AppState = {
      ...state,
      jsonClaude: {
        ...state.jsonClaude,
        sessions: {
          author: { entries: [{ entryId: 'e', kind: 'user', timestamp: 10 }] },
          chat2: { entries: [{ entryId: 'e', kind: 'user', timestamp: 50 }] }
        } as unknown as AppState['jsonClaude']['sessions']
      }
    }
    expect(pickAuthorTab(withEntries, WT)).toBe('chat2')
  })

  it("breaks a tie on the pane's focused tab, then pane order", () => {
    const { store } = setup()
    const state = store.getSnapshot().state
    // No transcripts, so every tab ties at 0. 'chat2' is focused.
    const focused: AppState = {
      ...state,
      terminals: {
        ...state.terminals,
        panes: { [WT]: { ...(state.terminals.panes[WT] as PaneLeaf), activeTabId: 'chat2' } }
      }
    }
    expect(pickAuthorTab(focused, WT)).toBe('chat2')
  })

  it('returns null when the worktree has no eligible Chat tab', () => {
    const { store } = setup()
    const state = store.getSnapshot().state
    expect(pickAuthorTab(state, '/nope')).toBeNull()
    const reviewersOnly: AppState = {
      ...state,
      terminals: {
        ...state.terminals,
        panes: {
          [WT]: {
            type: 'leaf',
            id: 'p',
            tabs: [{ id: 'rev', type: 'json-claude', label: 'Reviewer', reviewOf: 'gone' }],
            activeTabId: 'rev'
          }
        }
      }
    }
    expect(pickAuthorTab(reviewersOnly, WT)).toBeNull()
  })
})

describe('listReviewComments', () => {
  it('filters by status and file', async () => {
    const { store } = setup([
      comment('a'),
      comment('b', { status: 'resolved' }),
      comment('c', { filePath: 'src/b.ts' })
    ])
    expect((await listReviewComments(store, WT)).map((c) => c.id)).toEqual(['a', 'b', 'c'])
    expect((await listReviewComments(store, WT, { status: 'open' })).map((c) => c.id)).toEqual([
      'a',
      'c'
    ])
    expect((await listReviewComments(store, WT, { file: 'src/b.ts' })).map((c) => c.id)).toEqual([
      'c'
    ])
  })
})

describe('setReviewCommentResolved', () => {
  it('resolves and reopens by short id', () => {
    const { store } = setup([comment('abcdef0123')])
    expect(setReviewCommentResolved(store, WT, 'abcdef01', true)).toMatchObject({
      comment: { status: 'resolved' }
    })
    expect(store.getSnapshot().state.reviews.byPath[WT].comments[0].status).toBe('resolved')
    setReviewCommentResolved(store, WT, 'abcdef01', false)
    expect(store.getSnapshot().state.reviews.byPath[WT].comments[0].status).toBe('open')
  })
})

describe('replyToReviewComment', () => {
  it('threads a reply under the comment', () => {
    const { store } = setup([comment('abcdef0123')])
    const author = { kind: 'agent' as const, tabId: 'author', label: 'Chat' }
    const r = replyToReviewComment(store, WT, 'abcdef01', author, ' done ')
    expect(r).toMatchObject({ comment: { replies: [{ author, body: 'done' }] } })
    expect(replyToReviewComment(store, WT, 'abcdef01', author, '  ')).toHaveProperty('error')
    expect(replyToReviewComment(store, WT, 'nope-nope', author, 'x')).toHaveProperty('error')
  })
})

describe('submitReview', () => {
  const author = { kind: 'agent' as const, tabId: 'reviewer', label: 'Reviewer' }

  it("holds a draft over the reviewer's open comments, aimed at the most recent other tab", () => {
    const { store, deps, deliver } = setup([
      comment('mine'),
      comment('done', { status: 'resolved' }),
      comment('human', { author: { kind: 'human' } })
    ])
    const result = submitReview(deps, WT, author, {
      verdict: 'changes-requested',
      summary: ' fix it ',
      holdAsDraft: true
    })
    if ('error' in result) throw new Error(result.error)
    expect(result.delivery).toBeNull()
    expect(deliver).not.toHaveBeenCalled()
    expect(store.getSnapshot().state.reviews.byPath[WT].submissions).toEqual([
      expect.objectContaining({
        commentIds: ['mine'],
        summary: 'fix it',
        state: 'draft',
        targetTabId: 'author'
      })
    ])
  })

  it('auto-sends a wrapped review message and records it as sent', () => {
    const { store, deps, deliver } = setup([comment('mine')])
    const result = submitReview(deps, WT, author, {
      verdict: 'approve',
      summary: 'lgtm',
      holdAsDraft: false
    })
    if ('error' in result) throw new Error(result.error)
    expect(result.delivery).toEqual({ ok: true, tabId: 'author', woke: false })
    expect(result.submission.state).toBe('sent')
    const [wt, tab, msg] = deliver.mock.calls[0]
    expect([wt, tab]).toEqual([WT, 'author'])
    const parsed = parseAutomatedMessage(msg)
    expect(parsed).toMatchObject({ source: 'review', from: 'Reviewer' })
    expect(parsed?.body).toContain('Verdict: Approved')
    expect(parsed?.body).toContain('[mine] — rename this')
    expect(store.getSnapshot().state.reviews.byPath[WT].submissions![0].state).toBe('sent')
  })

  it('records a failed delivery with a readable reason', () => {
    const { store, deps } = setup([comment('mine')], () => ({
      ok: false,
      reason: 'wake-failed'
    }))
    const result = submitReview(deps, WT, author, {
      verdict: 'comment',
      summary: '',
      targetTabId: 'chat2',
      holdAsDraft: false
    })
    if ('error' in result) throw new Error(result.error)
    expect(result.delivery).toMatchObject({ ok: false, tabId: 'chat2' })
    const sub = store.getSnapshot().state.reviews.byPath[WT].submissions![0]
    expect(sub.state).toBe('failed')
    expect(sub.error).toMatch(/failed to start/)
  })

  it('rejects a terminal tab as the target', () => {
    const { deps } = setup()
    const r = submitReview(deps, WT, author, {
      verdict: 'comment',
      summary: '',
      targetTabId: 'term',
      holdAsDraft: true
    })
    expect(r).toEqual({ error: expect.stringMatching(/only go to Chat tabs/) })
  })

  it('rejects targeting its own tab or a tab that is not an agent tab', () => {
    const { deps } = setup()
    expect(
      submitReview(deps, WT, author, {
        verdict: 'comment',
        summary: '',
        targetTabId: 'reviewer',
        holdAsDraft: true
      })
    ).toHaveProperty('error')
    expect(
      submitReview(deps, WT, author, {
        verdict: 'comment',
        summary: '',
        targetTabId: 'sh',
        holdAsDraft: true
      })
    ).toHaveProperty('error')
  })
})

describe('sendReviewSubmission', () => {
  it('lets the sender override the target and only sends comments still open', () => {
    const { store, deps, deliver } = setup([comment('a'), comment('b')])
    const result = submitReview(
      deps,
      WT,
      { kind: 'agent', tabId: 'reviewer', label: 'Reviewer' },
      { verdict: 'comment', summary: '', holdAsDraft: true }
    )
    if ('error' in result) throw new Error(result.error)
    store.dispatch({
      type: 'reviews/commentDeleted',
      payload: { worktreePath: WT, id: 'b' }
    })
    expect(sendReviewSubmission(deps, WT, result.submission.id, 'chat2')).toEqual({
      ok: true,
      tabId: 'chat2',
      woke: false
    })
    const msg = deliver.mock.calls[0][2] as string
    expect(msg).toContain('[a]')
    expect(msg).not.toContain('[b]')
    expect(store.getSnapshot().state.reviews.byPath[WT].submissions![0]).toMatchObject({
      state: 'sent',
      targetTabId: 'chat2'
    })
  })

  it('fails cleanly when there is no other agent tab', () => {
    const { store, deps } = setup()
    store.dispatch({
      type: 'reviews/submissionAdded',
      payload: {
        worktreePath: WT,
        submission: {
          id: 's',
          author: { kind: 'agent', tabId: 'reviewer' },
          verdict: 'comment',
          summary: '',
          commentIds: [],
          createdAt: 0,
          state: 'draft',
          targetTabId: 'reviewer'
        }
      }
    })
    expect(sendReviewSubmission(deps, WT, 's')).toMatchObject({ ok: false })
    expect(sendReviewSubmission(deps, WT, 'missing')).toEqual({
      ok: false,
      error: 'Review not found'
    })
  })
})

describe('requestReview', () => {
  it('opens a reviewer for the caller and tells it who asked', () => {
    const { deps, openReviewer } = setup()
    // 'chat2' has no reviewer yet, so this is a first review.
    const r = requestReview(deps, WT, 'chat2', '  Added div with a zero guard.  ')
    expect(r).toEqual({ ok: true, reviewerTabId: 'new-reviewer', reused: false })
    const [wt, requester, prompt] = openReviewer.mock.calls[0] as unknown as [
      string,
      string,
      string
    ]
    expect([wt, requester]).toEqual([WT, 'chat2'])
    const parsed = parseAutomatedMessage(prompt)
    expect(parsed).toMatchObject({ source: 'review-request', from: 'Codex Chat' })
    expect(parsed?.body).toContain('Codex Chat has finished a piece of work')
    expect(parsed?.body).toContain('Added div with a zero guard.')
    expect(parsed?.body).toContain('REVIEW INSTRUCTIONS')
  })

  it('uses the configured reviewer agent and model instead of inheriting', () => {
    const { deps, openReviewer, reviewDefaults } = setup()
    reviewDefaults.mockReturnValue({ agentKind: 'codex', model: 'gpt-5-codex', prompt: 'be thorough' })
    requestReview(deps, WT, 'author', 'please review')
    expect(openReviewer.mock.calls[0][3]).toEqual({ agentKind: 'codex', model: 'gpt-5-codex' })
    expect(parseAutomatedMessage(openReviewer.mock.calls[0][2] as unknown as string)?.body).toContain(
      'be thorough'
    )
  })

  it("drops a model pin the reviewer's agent wouldn't understand", () => {
    const { deps, openReviewer, reviewDefaults } = setup()
    // An opus pin left behind after switching the reviewer to Codex, or
    // typed into config.json by hand: passing it through would fail at
    // spawn, so the agent's own default wins.
    reviewDefaults.mockReturnValue({ agentKind: 'codex', model: 'opus', prompt: 'p' })
    requestReview(deps, WT, 'author', 'please review')
    expect(openReviewer.mock.calls[0][3]).toEqual({ agentKind: 'codex', model: undefined })
  })

  it('keeps a model pin that matches the inherited agent', () => {
    const { deps, openReviewer, reviewDefaults } = setup()
    reviewDefaults.mockReturnValue({ model: 'opus', prompt: 'p' })
    // 'author' is a Claude chat tab, and opus is a Claude model.
    requestReview(deps, WT, 'author', 'please review')
    expect(openReviewer.mock.calls[0][3]).toEqual({ agentKind: 'claude', model: 'opus' })
  })

  it('reads as another look when that tab already has a reviewer', () => {
    const { deps, openReviewer } = setup()
    requestReview(deps, WT, 'author', 'round two')
    // 'rev-of-author' is already open for this requester.
    const prompt = openReviewer.mock.calls[0][2] as unknown as string
    expect(parseAutomatedMessage(prompt)?.body).toContain('pushed changes and is asking for another look')
  })

  it('inherits the requester’s agent when the setting is "same as the requester"', () => {
    const { deps, openReviewer } = setup()
    requestReview(deps, WT, 'chat2', 'please review')
    expect(openReviewer.mock.calls[0][3]).toEqual({ agentKind: 'codex', model: undefined })
  })

  it('refuses a terminal tab, since the review could not be delivered back', () => {
    const { deps, openReviewer } = setup()
    const r = requestReview(deps, WT, 'term', 'please review')
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/only a Chat tab/) })
    expect(openReviewer).not.toHaveBeenCalled()
  })

  it('refuses a reviewer asking for a review of the review', () => {
    const { deps, openReviewer } = setup()
    const r = requestReview(deps, WT, 'rev-of-author', 'please review')
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/you are the reviewer/) })
    expect(openReviewer).not.toHaveBeenCalled()
  })

  it('refuses a caller that is not in this worktree', () => {
    const { deps } = setup()
    expect(requestReview(deps, WT, 'nope', 'x')).toEqual({
      ok: false,
      error: 'caller tab is not in this worktree'
    })
  })
})

describe('a requested review ignores the draft setting', () => {
  it('delivers even when the user chose to hold reviews as drafts', () => {
    const { store, deps, deliver } = setup([
      comment('mine', { author: { kind: 'agent', tabId: 'rev-of-author', label: 'Reviewer' } })
    ])
    const result = submitReview(
      deps,
      WT,
      { kind: 'agent', tabId: 'rev-of-author', label: 'Reviewer' },
      { verdict: 'changes-requested', summary: 'one fix', holdAsDraft: true }
    )
    if ('error' in result) throw new Error(result.error)
    // The requester asked for this and is waiting on it, so holding it
    // as a draft would stall that agent until a human noticed.
    expect(deliver.mock.calls[0][1]).toBe('author')
    expect(store.getSnapshot().state.reviews.byPath[WT].submissions![0]).toMatchObject({
      state: 'sent',
      targetTabId: 'author'
    })
  })

  it('still holds a review nobody asked for', () => {
    const { store, deps, deliver } = setup([comment('mine')])
    const result = submitReview(
      deps,
      WT,
      { kind: 'agent', tabId: 'reviewer', label: 'Reviewer' },
      { verdict: 'comment', summary: 'fyi', holdAsDraft: true }
    )
    if ('error' in result) throw new Error(result.error)
    expect(deliver).not.toHaveBeenCalled()
    expect(store.getSnapshot().state.reviews.byPath[WT].submissions![0].state).toBe('draft')
  })
})

describe('reviewRequester', () => {
  it('resolves the link, and ignores it once the requester is gone', () => {
    const { store } = setup()
    const state = store.getSnapshot().state
    expect(reviewRequester(state, WT, 'rev-of-author')).toBe('author')
    expect(reviewRequester(state, WT, 'author')).toBeNull()
    expect(reviewRequester(state, WT, null)).toBeNull()
    const closed: AppState = {
      ...state,
      terminals: {
        ...state.terminals,
        panes: {
          [WT]: {
            type: 'leaf',
            id: 'p',
            tabs: [{ id: 'rev-of-author', type: 'json-claude', label: 'Reviewer', reviewOf: 'author' }],
            activeTabId: 'rev-of-author'
          }
        }
      }
    }
    expect(reviewRequester(closed, WT, 'rev-of-author')).toBeNull()
  })

  it('sends a requested review back to the requester, not the most recent tab', () => {
    const { store, deps, deliver } = setup([
      comment('mine', { author: { kind: 'agent', tabId: 'rev-of-author', label: 'Reviewer' } })
    ])
    const result = submitReview(
      deps,
      WT,
      { kind: 'agent', tabId: 'rev-of-author', label: 'Reviewer' },
      { verdict: 'approve', summary: 'lgtm', holdAsDraft: false }
    )
    if ('error' in result) throw new Error(result.error)
    expect(deliver.mock.calls[0][1]).toBe('author')
    expect(store.getSnapshot().state.reviews.byPath[WT].submissions![0]).toMatchObject({
      state: 'sent',
      targetTabId: 'author'
    })
  })
})
