import type { ReviewVerdict, WorktreeReview } from './state/reviews'

export type ReviewStatusKind = 'none' | 'reviewing' | ReviewVerdict

export interface ReviewStatus {
  kind: ReviewStatusKind
  /** The latest review hasn't reached its author: a draft, or a failed send. */
  unsent: boolean
  /** Reviewer working on the open request, when `kind` is 'reviewing'. */
  reviewerTabId: string | null
}

const NONE: ReviewStatus = { kind: 'none', unsent: false, reviewerTabId: null }

/** Where a worktree's agent review stands: whichever is newer of the last
 *  request and the last agent-submitted review. A request newer than every
 *  review means a round is in progress, so it supersedes the old verdict,
 *  unless its reviewer tab has since been closed: that round will never
 *  finish, so the previous verdict stands. The user's own reviews don't
 *  count. */
export function latestAgentReviewStatus(
  review: WorktreeReview | undefined,
  isTabOpen: (tabId: string) => boolean = () => true
): ReviewStatus {
  if (!review) return NONE
  const request = review.requests?.at(-1)
  let submission = undefined
  for (let i = (review.submissions?.length ?? 0) - 1; i >= 0; i--) {
    const s = review.submissions![i]
    if (s.author.kind === 'agent') {
      submission = s
      break
    }
  }
  const reviewerTabId = request?.reviewer.kind === 'agent' ? request.reviewer.tabId : null
  if (
    request &&
    (!submission || request.createdAt > submission.createdAt) &&
    (!reviewerTabId || isTabOpen(reviewerTabId))
  ) {
    return { kind: 'reviewing', unsent: false, reviewerTabId }
  }
  if (!submission) return NONE
  return { kind: submission.verdict, unsent: submission.state !== 'sent', reviewerTabId: null }
}
