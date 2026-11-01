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
    expect(kinds(rounds[1])).toEqual(['request', 'review', 'reply', 'resolved', 'commit'])
    expect(kinds(rounds[2])).toEqual(['request', 'review', 'comment'])
    const review = rounds[1].entries[1]
    expect(review.kind === 'review' && review.comments.map((c) => c.id)).toEqual(['c1'])
    expect(review.kind === 'review' && review.missing).toBe(1)
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
