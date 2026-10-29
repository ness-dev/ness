import { describe, it, expect } from 'vitest'
import {
  initialReviews,
  reviewsReducer,
  type ReviewComment,
  type ReviewSubmission,
  type ReviewsState
} from './reviews'

const WT = '/wt'

function comment(id: string, over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id,
    filePath: 'src/a.ts',
    side: 'new',
    line: 10,
    anchoredSha: 'sha1',
    anchor: { commitSha: 'sha1', line: 10, snippet: 'const x = 1' },
    author: { kind: 'human' },
    status: 'open',
    body: 'hi',
    createdAt: 1,
    ...over
  }
}

function submission(id: string, over: Partial<ReviewSubmission> = {}): ReviewSubmission {
  return {
    id,
    author: { kind: 'agent', tabId: 'reviewer', label: 'Reviewer' },
    verdict: 'changes-requested',
    summary: 'needs work',
    commentIds: ['a'],
    createdAt: 2,
    state: 'draft',
    targetTabId: 'author',
    ...over
  }
}

function seeded(...comments: ReviewComment[]): ReviewsState {
  return { byPath: { [WT]: { comments } } }
}

describe('reviewsReducer', () => {
  it('reviews/commentAdded appends to the worktree and ignores duplicate ids', () => {
    const s1 = reviewsReducer(initialReviews, {
      type: 'reviews/commentAdded',
      payload: { worktreePath: WT, comment: comment('a') }
    })
    expect(s1.byPath[WT].comments.map((c) => c.id)).toEqual(['a'])
    const s2 = reviewsReducer(s1, {
      type: 'reviews/commentAdded',
      payload: { worktreePath: WT, comment: comment('a') }
    })
    expect(s2).toBe(s1)
  })

  it('reviews/commentDeleted removes the comment and drops an emptied worktree', () => {
    const s = seeded(comment('a'), comment('b'))
    const s1 = reviewsReducer(s, {
      type: 'reviews/commentDeleted',
      payload: { worktreePath: WT, id: 'a' }
    })
    expect(s1.byPath[WT].comments.map((c) => c.id)).toEqual(['b'])
    expect(s1.byPath[WT].comments[0]).toBe(s.byPath[WT].comments[1])
    const s2 = reviewsReducer(s1, {
      type: 'reviews/commentDeleted',
      payload: { worktreePath: WT, id: 'b' }
    })
    expect(s2.byPath).toEqual({})
    expect(
      reviewsReducer(s2, { type: 'reviews/commentDeleted', payload: { worktreePath: WT, id: 'b' } })
    ).toBe(s2)
  })

  it('reviews/commentStatusChanged patches one comment and keeps identity on no-op', () => {
    const s = seeded(comment('a'), comment('b'))
    const s1 = reviewsReducer(s, {
      type: 'reviews/commentStatusChanged',
      payload: { worktreePath: WT, id: 'b', status: 'resolved' }
    })
    expect(s1.byPath[WT].comments[1].status).toBe('resolved')
    expect(s1.byPath[WT].comments[0]).toBe(s.byPath[WT].comments[0])
    const s2 = reviewsReducer(s1, {
      type: 'reviews/commentStatusChanged',
      payload: { worktreePath: WT, id: 'b', status: 'resolved' }
    })
    expect(s2).toBe(s1)
    const s3 = reviewsReducer(s1, {
      type: 'reviews/commentStatusChanged',
      payload: { worktreePath: WT, id: 'missing', status: 'open' }
    })
    expect(s3).toBe(s1)
  })

  it('reviews/replyAdded appends a reply with its own author', () => {
    const s = seeded(comment('a'))
    const reply = {
      id: 'r1',
      author: { kind: 'agent' as const, tabId: 't1', label: 'Reviewer' },
      body: 'done',
      createdAt: 2
    }
    const s1 = reviewsReducer(s, {
      type: 'reviews/replyAdded',
      payload: { worktreePath: WT, commentId: 'a', reply }
    })
    expect(s1.byPath[WT].comments[0].replies).toEqual([reply])
    const s2 = reviewsReducer(s1, {
      type: 'reviews/replyAdded',
      payload: { worktreePath: WT, commentId: 'a', reply }
    })
    expect(s2).toBe(s1)
  })

  it('reviews/anchorsUpdated moves lines / statuses and is a no-op when nothing changed', () => {
    const s = seeded(comment('a'), comment('b'))
    const s1 = reviewsReducer(s, {
      type: 'reviews/anchorsUpdated',
      payload: {
        worktreePath: WT,
        updates: [{ id: 'a', line: 14, anchoredSha: 'sha2', status: 'outdated' }]
      }
    })
    expect(s1.byPath[WT].comments[0]).toMatchObject({
      line: 14,
      anchoredSha: 'sha2',
      status: 'outdated'
    })
    expect(s1.byPath[WT].comments[0].anchor.line).toBe(10)
    expect(s1.byPath[WT].comments[1]).toBe(s.byPath[WT].comments[1])
    const s2 = reviewsReducer(s1, {
      type: 'reviews/anchorsUpdated',
      payload: {
        worktreePath: WT,
        updates: [{ id: 'a', line: 14, anchoredSha: 'sha2', status: 'outdated' }]
      }
    })
    expect(s2).toBe(s1)
  })

  it('reviews/worktreeRemoved drops the worktree entry', () => {
    const s = seeded(comment('a'))
    const s1 = reviewsReducer(s, {
      type: 'reviews/worktreeRemoved',
      payload: { worktreePath: WT }
    })
    expect(s1.byPath).toEqual({})
    expect(
      reviewsReducer(s1, { type: 'reviews/worktreeRemoved', payload: { worktreePath: WT } })
    ).toBe(s1)
  })

  it('reviews/commentEdited replaces the body and keeps identity on a no-op', () => {
    const s = seeded(comment('a'), comment('b'))
    const s1 = reviewsReducer(s, {
      type: 'reviews/commentEdited',
      payload: { worktreePath: WT, id: 'a', body: 'reworded' }
    })
    expect(s1.byPath[WT].comments[0].body).toBe('reworded')
    expect(s1.byPath[WT].comments[1]).toBe(s.byPath[WT].comments[1])
    expect(
      reviewsReducer(s1, {
        type: 'reviews/commentEdited',
        payload: { worktreePath: WT, id: 'a', body: 'reworded' }
      })
    ).toBe(s1)
    expect(
      reviewsReducer(s1, {
        type: 'reviews/commentEdited',
        payload: { worktreePath: WT, id: 'zzz', body: 'x' }
      })
    ).toBe(s1)
  })

  it('reviews/submissionAdded appends, ignores duplicates, and creates an entry without comments', () => {
    const s1 = reviewsReducer(initialReviews, {
      type: 'reviews/submissionAdded',
      payload: { worktreePath: WT, submission: submission('s1') }
    })
    expect(s1.byPath[WT]).toEqual({ comments: [], submissions: [submission('s1')] })
    expect(
      reviewsReducer(s1, {
        type: 'reviews/submissionAdded',
        payload: { worktreePath: WT, submission: submission('s1') }
      })
    ).toBe(s1)
  })

  it('keeps a worktree entry alive while it still has submissions', () => {
    const s = {
      byPath: { [WT]: { comments: [comment('a')], submissions: [submission('s1')] } }
    }
    const s1 = reviewsReducer(s, {
      type: 'reviews/commentDeleted',
      payload: { worktreePath: WT, id: 'a' }
    })
    expect(s1.byPath[WT].comments).toEqual([])
    expect(s1.byPath[WT].submissions).toBe(s.byPath[WT].submissions)
  })

  it('reviews/submissionEdited changes summary and verdict only when they differ', () => {
    const s = {
      byPath: { [WT]: { comments: [comment('a')], submissions: [submission('s1'), submission('s2')] } }
    }
    const s1 = reviewsReducer(s, {
      type: 'reviews/submissionEdited',
      payload: { worktreePath: WT, id: 's1', summary: 'tidy', verdict: 'approve' }
    })
    expect(s1.byPath[WT].submissions![0]).toMatchObject({ summary: 'tidy', verdict: 'approve' })
    expect(s1.byPath[WT].submissions![1]).toBe(s.byPath[WT].submissions[1])
    expect(s1.byPath[WT].comments).toBe(s.byPath[WT].comments)
    expect(
      reviewsReducer(s1, {
        type: 'reviews/submissionEdited',
        payload: { worktreePath: WT, id: 's1', summary: 'tidy', verdict: 'approve' }
      })
    ).toBe(s1)
  })

  it('reviews/submissionDelivered records success and failure', () => {
    const s = { byPath: { [WT]: { comments: [], submissions: [submission('s1')] } } }
    const failed = reviewsReducer(s, {
      type: 'reviews/submissionDelivered',
      payload: { worktreePath: WT, id: 's1', state: 'failed', targetTabId: null, at: 5, error: 'nope' }
    })
    expect(failed.byPath[WT].submissions![0]).toMatchObject({
      state: 'failed',
      error: 'nope',
      targetTabId: 'author'
    })
    const sent = reviewsReducer(failed, {
      type: 'reviews/submissionDelivered',
      payload: { worktreePath: WT, id: 's1', state: 'sent', targetTabId: 'other', at: 9 }
    })
    expect(sent.byPath[WT].submissions![0]).toMatchObject({
      state: 'sent',
      sentAt: 9,
      targetTabId: 'other'
    })
    expect(sent.byPath[WT].submissions![0].error).toBeUndefined()
    const queued = reviewsReducer(failed, {
      type: 'reviews/submissionDelivered',
      payload: { worktreePath: WT, id: 's1', state: 'queued', targetTabId: 'term', at: 7 }
    })
    expect(queued.byPath[WT].submissions![0]).toMatchObject({ state: 'queued', targetTabId: 'term' })
    expect(queued.byPath[WT].submissions![0].error).toBeUndefined()
    expect(
      reviewsReducer(sent, {
        type: 'reviews/submissionDelivered',
        payload: { worktreePath: WT, id: 'missing', state: 'sent', targetTabId: null, at: 1 }
      })
    ).toBe(sent)
  })

  it('reviews/submissionDeleted removes one and drops an emptied worktree', () => {
    const s = { byPath: { [WT]: { comments: [], submissions: [submission('s1'), submission('s2')] } } }
    const s1 = reviewsReducer(s, {
      type: 'reviews/submissionDeleted',
      payload: { worktreePath: WT, id: 's1' }
    })
    expect(s1.byPath[WT].submissions!.map((x) => x.id)).toEqual(['s2'])
    expect(s1.byPath[WT].submissions![0]).toBe(s.byPath[WT].submissions[1])
    const s2 = reviewsReducer(s1, {
      type: 'reviews/submissionDeleted',
      payload: { worktreePath: WT, id: 's2' }
    })
    expect(s2.byPath).toEqual({})
    expect(
      reviewsReducer(s2, { type: 'reviews/submissionDeleted', payload: { worktreePath: WT, id: 's2' } })
    ).toBe(s2)
  })
})
