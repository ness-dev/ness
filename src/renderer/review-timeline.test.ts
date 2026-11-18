import { describe, it, expect } from 'vitest'
import { actorRole, buildReviewTimeline, reviewerTabIds } from './review-timeline'
import type {
  ReviewComment,
  ReviewRequest,
  ReviewSubmission
} from '../shared/state/reviews'

const impl = { kind: 'agent' as const, tabId: 'impl', label: 'Impl' }
const rev = { kind: 'agent' as const, tabId: 'rev', label: 'Rev' }

function request(id: string, at: number): ReviewRequest {
  return { id, requester: impl, reviewer: rev, context: 'c', source: 'agent', reused: false, createdAt: at }
}

function submission(id: string, at: number, commentIds: string[] = []): ReviewSubmission {
  return {
    id,
    author: rev,
    verdict: 'comment',
    summary: '',
    commentIds,
    createdAt: at,
    state: 'sent'
  }
}

function comment(id: string, at: number, over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id,
    filePath: 'a.ts',
    side: 'new',
    line: 1,
    anchoredSha: 's',
    anchor: { commitSha: 's', line: 1, snippet: 'x' },
    author: rev,
    status: 'open',
    body: 'b',
    createdAt: at,
    ...over
  }
}

const kinds = (r: { entries: { kind: string }[] }): string[] => r.entries.map((e) => e.kind)

describe('buildReviewTimeline', () => {
  it('is empty without any review records, even with commits', () => {
    expect(
      buildReviewTimeline({
        requests: [],
        submissions: [],
        comments: [],
        commits: [{ hash: 'h', shortHash: 'h', subject: 's', timestamp: 1 }]
      })
    ).toEqual([])
  })

  it('splits rounds at requests and nests a review’s comments under it', () => {
    const rounds = buildReviewTimeline({
      requests: [request('r1', 1000), request('r2', 5000)],
      submissions: [submission('s1', 2000, ['c1', 'gone']), submission('s2', 6000)],
      comments: [
        comment('c1', 1500, {
          replies: [{ id: 'p', author: impl, body: 'ok', createdAt: 3000 }],
          status: 'resolved',
          resolvedBy: impl,
          resolvedAt: 3100
        }),
        comment('c2', 7000, { author: { kind: 'human' } })
      ],
      commits: [
        { hash: 'a', shortHash: 'a', subject: 'before', timestamp: 0 },
        { hash: 'b', shortHash: 'b', subject: 'fix', timestamp: 4 }
      ]
    })
    expect(rounds.map((r) => r.index)).toEqual([0, 1, 2])
    expect(kinds(rounds[0])).toEqual(['commit'])
    expect(kinds(rounds[1])).toEqual(['request', 'review', 'commit'])
    expect(kinds(rounds[2])).toEqual(['request', 'review', 'comment'])
    const review = rounds[1].entries[1]
    expect(review.kind === 'review' && review.threads.map((t) => t.comment.id)).toEqual(['c1'])
    expect(review.kind === 'review' && review.missing).toBe(1)
  })

  it('folds same-round replies into the thread and lists later ones in their own round', () => {
    const early = { id: 'p1', author: impl, body: 'fixed', createdAt: 3000 }
    const late = { id: 'p2', author: rev, body: 'thanks', createdAt: 6000 }
    const rounds = buildReviewTimeline({
      requests: [request('r1', 1000), request('r2', 5000)],
      submissions: [submission('s1', 2000, ['c1'])],
      comments: [
        comment('c1', 1500, {
          replies: [early, late],
          status: 'resolved',
          resolvedBy: rev,
          resolvedAt: 6100
        })
      ],
      commits: []
    })
    const review = rounds[0].entries[1]
    expect(review.kind === 'review' && review.threads[0]).toMatchObject({
      replies: [early],
      resolved: false
    })
    expect(rounds[1].entries.map((e) => [e.kind, e.kind === 'reply' ? e.reply.id : null])).toEqual([
      ['request', null],
      ['reply', 'p2'],
      ['resolved', null]
    ])
  })

  it('folds a reply and resolution into a standalone comment in the same round', () => {
    const rounds = buildReviewTimeline({
      requests: [],
      submissions: [],
      comments: [
        comment('c', 1, {
          replies: [{ id: 'p', author: impl, body: 'ok', createdAt: 2 }],
          status: 'resolved',
          resolvedAt: 3
        })
      ],
      commits: []
    })
    expect(kinds(rounds[0])).toEqual(['comment'])
    const e = rounds[0].entries[0]
    expect(e.kind === 'comment' && e.thread).toMatchObject({ replies: [{ id: 'p' }], resolved: true })
  })

  it('opens a round for an unrequested review and for a second review of one request', () => {
    const rounds = buildReviewTimeline({
      requests: [request('r1', 1000)],
      submissions: [submission('s0', 500), submission('s1', 2000), submission('s2', 3000)],
      comments: [],
      commits: []
    })
    expect(rounds.map((r) => [r.index, kinds(r)])).toEqual([
      [1, ['review']],
      [2, ['request', 'review']],
      [3, ['review']]
    ])
  })

  it('skips a resolution with no recorded time', () => {
    const rounds = buildReviewTimeline({
      requests: [],
      submissions: [],
      comments: [comment('c', 1, { status: 'resolved' })],
      commits: []
    })
    expect(kinds(rounds[0])).toEqual(['comment'])
  })
})

describe('actorRole', () => {
  it('treats requested reviewers and submitters as reviewers', () => {
    const reviewers = reviewerTabIds([request('r', 1)], [], ['linked'])
    expect(actorRole(rev, reviewers)).toBe('reviewer')
    expect(actorRole({ kind: 'agent', tabId: 'linked' }, reviewers)).toBe('reviewer')
    expect(actorRole(impl, reviewers)).toBe('implementer')
    expect(actorRole({ kind: 'human' }, reviewers)).toBe('human')
  })
})
