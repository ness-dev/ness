import { describe, it, expect } from 'vitest'
import { latestAgentReviewStatus } from './review-status'
import type { ReviewRequest, ReviewSubmission } from './state/reviews'

const rev = { kind: 'agent' as const, tabId: 'rev', label: 'Rev' }

function request(at: number): ReviewRequest {
  return {
    id: `r${at}`,
    requester: { kind: 'agent', tabId: 'impl' },
    reviewer: rev,
    context: '',
    source: 'agent',
    reused: false,
    createdAt: at
  }
}

function submission(at: number, over: Partial<ReviewSubmission> = {}): ReviewSubmission {
  return {
    id: `s${at}`,
    author: rev,
    verdict: 'approve',
    summary: '',
    commentIds: [],
    createdAt: at,
    state: 'sent',
    ...over
  }
}

describe('latestAgentReviewStatus', () => {
  it('is none without any agent review activity', () => {
    expect(latestAgentReviewStatus(undefined).kind).toBe('none')
    expect(
      latestAgentReviewStatus({
        comments: [],
        submissions: [submission(1, { author: { kind: 'human' } })]
      }).kind
    ).toBe('none')
  })

  it('takes the verdict of the latest agent review, ignoring later human ones', () => {
    expect(
      latestAgentReviewStatus({
        comments: [],
        requests: [request(1)],
        submissions: [
          submission(2, { verdict: 'changes-requested' }),
          submission(3, { author: { kind: 'human' }, verdict: 'approve' })
        ]
      })
    ).toEqual({ kind: 'changes-requested', unsent: false, reviewerTabId: null })
  })

  it('flags a draft or failed review as unsent', () => {
    expect(
      latestAgentReviewStatus({ comments: [], submissions: [submission(1, { state: 'draft' })] })
        .unsent
    ).toBe(true)
    expect(
      latestAgentReviewStatus({ comments: [], submissions: [submission(1, { state: 'failed' })] })
        .unsent
    ).toBe(true)
  })

  it('is reviewing when a request is newer than every review', () => {
    expect(
      latestAgentReviewStatus({
        comments: [],
        requests: [request(1), request(5)],
        submissions: [submission(2, { verdict: 'changes-requested' })]
      })
    ).toEqual({ kind: 'reviewing', unsent: false, reviewerTabId: 'rev' })
  })
})
