import { describe, it, expect, vi } from 'vitest'

vi.mock('./review-comments', async (orig) => ({
  ...(await orig<typeof import('./review-comments')>()),
  refreshReviewAnchors: vi.fn(async () => {})
}))

import { Store } from './store'
import { initialState, type AppState } from '../shared/state'
import type { PaneNode } from '../shared/state/terminals'
import type { ReviewComment } from '../shared/state/reviews'
import { listAgentTabs } from '../shared/agent-tabs'
import { parseAutomatedMessage } from '../shared/state/json-claude'
import {
  agentAuthor,
  findReviewComment,
  listReviewComments,
  pickReviewTarget,
  replyToReviewComment,
  sendReviewSubmission,
  setReviewCommentResolved,
  submitReview,
  type ReviewServiceDeps
} from './review-service'
import type { TabDeliveryResult } from './chat-delivery'

const WT = '/wt'

const tree: PaneNode = {
  type: 'leaf',
  id: 'p',
  tabs: [
    { id: 'author', type: 'json-claude', label: 'Chat' },
    { id: 'reviewer', type: 'agent', label: 'Claude', customLabel: 'Reviewer' },
    { id: 'term', type: 'agent', label: 'Codex', agentKind: 'codex' },
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
  deliver: (wt: string, tab: string, msg: string) => TabDeliveryResult = (_w, tabId) => ({
    ok: true,
    tabId,
    woke: false
  }),
  activity: Record<string, number> = {}
): { store: Store; deps: ReviewServiceDeps; deliver: ReturnType<typeof vi.fn> } {
  const state: AppState = {
    ...initialState,
    terminals: { ...initialState.terminals, panes: { [WT]: tree } },
    reviews: { byPath: comments.length ? { [WT]: { comments } } : {} }
  }
  const store = new Store(state)
  const deliverFn = vi.fn(deliver)
  const deps: ReviewServiceDeps = {
    store,
    listAgentTabs: (wt) => listAgentTabs(store.getSnapshot().state, wt, (id) => activity[id]),
    deliver: deliverFn
  }
  return { store, deps, deliver: deliverFn }
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
  it('takes the most recently active agent tab other than the reviewer', () => {
    const { store } = setup()
    const tabs = listAgentTabs(store.getSnapshot().state, WT, (id) =>
      ({ reviewer: 50, term: 40 })[id]
    )
    expect(tabs.map((t) => t.id)).toEqual(['reviewer', 'term', 'author'])
    expect(pickReviewTarget(tabs, 'reviewer')).toBe('term')
    expect(pickReviewTarget([], 'reviewer')).toBeNull()
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
      autoSend: false
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
      autoSend: true
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
      reason: 'terminal-unsupported'
    }))
    const result = submitReview(deps, WT, author, {
      verdict: 'comment',
      summary: '',
      targetTabId: 'term',
      autoSend: true
    })
    if ('error' in result) throw new Error(result.error)
    expect(result.delivery).toMatchObject({ ok: false, tabId: 'term' })
    const sub = store.getSnapshot().state.reviews.byPath[WT].submissions![0]
    expect(sub.state).toBe('failed')
    expect(sub.error).toMatch(/terminal agent tabs is not supported yet/)
  })

  it('rejects targeting its own tab or a tab that is not an agent tab', () => {
    const { deps } = setup()
    expect(
      submitReview(deps, WT, author, {
        verdict: 'comment',
        summary: '',
        targetTabId: 'reviewer',
        autoSend: false
      })
    ).toHaveProperty('error')
    expect(
      submitReview(deps, WT, author, {
        verdict: 'comment',
        summary: '',
        targetTabId: 'sh',
        autoSend: false
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
      { verdict: 'comment', summary: '', autoSend: false }
    )
    if ('error' in result) throw new Error(result.error)
    store.dispatch({
      type: 'reviews/commentDeleted',
      payload: { worktreePath: WT, id: 'b' }
    })
    expect(sendReviewSubmission(deps, WT, result.submission.id, 'term')).toEqual({
      ok: true,
      tabId: 'term',
      woke: false
    })
    const msg = deliver.mock.calls[0][2] as string
    expect(msg).toContain('[a]')
    expect(msg).not.toContain('[b]')
    expect(store.getSnapshot().state.reviews.byPath[WT].submissions![0]).toMatchObject({
      state: 'sent',
      targetTabId: 'term'
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
