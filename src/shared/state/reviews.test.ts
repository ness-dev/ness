import { describe, it, expect } from 'vitest'
import {
  initialReviews,
  reviewsReducer,
  type ReviewComment,
  type ReviewRequest,
  type ReviewSubmission,
  type ReviewsState,
  type TestRun,
  type TestStep
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

  it('reviews/commentStatusChanged records who resolved it and clears that on reopen', () => {
    const by = { kind: 'agent' as const, tabId: 'author', label: 'Author' }
    const s1 = reviewsReducer(seeded(comment('a')), {
      type: 'reviews/commentStatusChanged',
      payload: { worktreePath: WT, id: 'a', status: 'resolved', by, at: 42 }
    })
    expect(s1.byPath[WT].comments[0]).toMatchObject({ resolvedBy: by, resolvedAt: 42 })
    const s2 = reviewsReducer(s1, {
      type: 'reviews/commentStatusChanged',
      payload: { worktreePath: WT, id: 'a', status: 'open' }
    })
    expect(s2.byPath[WT].comments[0].resolvedBy).toBeUndefined()
    expect(s2.byPath[WT].comments[0].resolvedAt).toBeUndefined()
    const s3 = reviewsReducer(s1, {
      type: 'reviews/commentStatusChanged',
      payload: { worktreePath: WT, id: 'a', status: 'outdated', by, at: 50 }
    })
    expect(s3.byPath[WT].comments[0].resolvedBy).toBeUndefined()
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

  it('reviews/requestRecorded appends, ignores duplicates, and keeps the entry alive alone', () => {
    const request: ReviewRequest = {
      id: 'r1',
      requester: { kind: 'agent', tabId: 'author', label: 'Author' },
      reviewer: { kind: 'agent', tabId: 'reviewer', label: 'Reviewer' },
      context: 'please look',
      source: 'agent',
      reused: false,
      createdAt: 1
    }
    const s1 = reviewsReducer(initialReviews, {
      type: 'reviews/requestRecorded',
      payload: { worktreePath: WT, request }
    })
    expect(s1.byPath[WT]).toEqual({ comments: [], requests: [request] })
    expect(
      reviewsReducer(s1, { type: 'reviews/requestRecorded', payload: { worktreePath: WT, request } })
    ).toBe(s1)
    const s2 = reviewsReducer(s1, {
      type: 'reviews/submissionAdded',
      payload: { worktreePath: WT, submission: submission('s1') }
    })
    expect(s2.byPath[WT].requests).toBe(s1.byPath[WT].requests)
    const s3 = reviewsReducer(s2, {
      type: 'reviews/submissionDeleted',
      payload: { worktreePath: WT, id: 's1' }
    })
    expect(s3.byPath[WT]).toEqual({ comments: [], requests: [request] })
  })

  describe('test runs', () => {
    const run = (over: Partial<TestRun> = {}): TestRun => ({
      id: 't1',
      requester: { kind: 'agent', tabId: 'author' },
      tester: { kind: 'agent', tabId: 'tester' },
      context: 'try it',
      source: 'agent',
      reused: false,
      status: 'running',
      steps: [],
      createdAt: 1,
      ...over
    })
    const step = (id: string, over: Partial<TestStep> = {}): TestStep => ({
      id,
      title: `step ${id}`,
      status: 'running',
      startedAt: 1,
      updatedAt: 1,
      ...over
    })
    const started = reviewsReducer(initialReviews, {
      type: 'reviews/testRunStarted',
      payload: { worktreePath: WT, run: run() }
    })

    it('reviews/testRunStarted appends, ignores duplicates, and keeps the entry alive alone', () => {
      expect(started.byPath[WT]).toEqual({ comments: [], testRuns: [run()] })
      expect(
        reviewsReducer(started, {
          type: 'reviews/testRunStarted',
          payload: { worktreePath: WT, run: run() }
        })
      ).toBe(started)
    })

    it('reviews/testStepReported adds a step, then replaces it by id', () => {
      const s1 = reviewsReducer(started, {
        type: 'reviews/testStepReported',
        payload: { worktreePath: WT, runId: 't1', step: step('a') }
      })
      const s2 = reviewsReducer(s1, {
        type: 'reviews/testStepReported',
        payload: { worktreePath: WT, runId: 't1', step: step('b') }
      })
      const s3 = reviewsReducer(s2, {
        type: 'reviews/testStepReported',
        payload: { worktreePath: WT, runId: 't1', step: step('a', { status: 'passed', updatedAt: 5 }) }
      })
      const steps = s3.byPath[WT].testRuns![0].steps
      expect(steps.map((x) => [x.id, x.status])).toEqual([
        ['a', 'passed'],
        ['b', 'running']
      ])
      expect(steps[1]).toBe(s2.byPath[WT].testRuns![0].steps[1])
      expect(
        reviewsReducer(s3, {
          type: 'reviews/testStepReported',
          payload: { worktreePath: WT, runId: 'nope', step: step('c') }
        })
      ).toBe(s3)
    })

    it('reviews/testRunFinished records the outcome and closes out running steps', () => {
      const s1 = reviewsReducer(started, {
        type: 'reviews/testStepReported',
        payload: { worktreePath: WT, runId: 't1', step: step('a') }
      })
      const s2 = reviewsReducer(s1, {
        type: 'reviews/testRunFinished',
        payload: { worktreePath: WT, runId: 't1', status: 'failed', summary: 'broke', at: 9, headSha: 'abc' }
      })
      expect(s2.byPath[WT].testRuns![0]).toMatchObject({
        status: 'failed',
        summary: 'broke',
        finishedAt: 9,
        headSha: 'abc',
        steps: [{ id: 'a', status: 'skipped', updatedAt: 9 }]
      })
    })

    it('reviews/testRunDelivered records sent and failed deliveries', () => {
      const sent = reviewsReducer(started, {
        type: 'reviews/testRunDelivered',
        payload: { worktreePath: WT, runId: 't1', state: 'sent', targetTabId: 'author', at: 3 }
      })
      expect(sent.byPath[WT].testRuns![0].delivery).toEqual({ state: 'sent', targetTabId: 'author', at: 3 })
      const failed = reviewsReducer(sent, {
        type: 'reviews/testRunDelivered',
        payload: { worktreePath: WT, runId: 't1', state: 'failed', at: 4 }
      })
      expect(failed.byPath[WT].testRuns![0].delivery).toEqual({
        state: 'failed',
        at: 4,
        error: 'Delivery failed'
      })
    })

    it('reviews/testRunDeleted removes the run and drops an empty entry', () => {
      const s1 = reviewsReducer(started, {
        type: 'reviews/testRunDeleted',
        payload: { worktreePath: WT, runId: 't1' }
      })
      expect(s1.byPath).toEqual({})
      expect(
        reviewsReducer(s1, { type: 'reviews/testRunDeleted', payload: { worktreePath: WT, runId: 't1' } })
      ).toBe(s1)
    })
  })
})
