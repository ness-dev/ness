import type {
  ReviewAuthor,
  ReviewComment,
  ReviewReply,
  ReviewRequest,
  ReviewSubmission
} from '../shared/state/reviews'

export interface TimelineCommit {
  hash: string
  shortHash: string
  subject: string
  /** Seconds since the epoch, as git prints `%at`. */
  timestamp: number
}

export type TimelineEntry =
  | { kind: 'request'; at: number; request: ReviewRequest }
  | {
      kind: 'review'
      at: number
      submission: ReviewSubmission
      comments: ReviewComment[]
      /** commentIds whose comment has since been deleted. */
      missing: number
    }
  | { kind: 'comment'; at: number; comment: ReviewComment }
  | { kind: 'reply'; at: number; comment: ReviewComment; reply: ReviewReply }
  | { kind: 'resolved'; at: number; comment: ReviewComment; by?: ReviewAuthor }
  | { kind: 'commit'; at: number; commit: TimelineCommit }

export interface TimelineRound {
  /** 1-based. 0 is activity before the first request or review. */
  index: number
  entries: TimelineEntry[]
}

/** What kind of actor an author is, from the reviewer links on record:
 *  a tab is a reviewer when it was asked to review or submitted one. */
export type ActorRole = 'human' | 'implementer' | 'reviewer'

export function reviewerTabIds(
  requests: ReviewRequest[],
  submissions: ReviewSubmission[],
  linkedReviewers: Iterable<string> = []
): Set<string> {
  const out = new Set(linkedReviewers)
  for (const r of requests) if (r.reviewer.kind === 'agent') out.add(r.reviewer.tabId)
  for (const s of submissions) if (s.author.kind === 'agent') out.add(s.author.tabId)
  return out
}

export function actorRole(author: ReviewAuthor, reviewers: Set<string>): ActorRole {
  if (author.kind === 'human') return 'human'
  return reviewers.has(author.tabId) ? 'reviewer' : 'implementer'
}

/** Order of entries that share a timestamp: what caused a thing sorts
 *  before the thing. */
const KIND_ORDER: Record<TimelineEntry['kind'], number> = {
  commit: 0,
  request: 1,
  comment: 2,
  review: 3,
  reply: 4,
  resolved: 5
}

/** Merge a worktree's review records and branch commits into rounds. A
 *  round opens at each request, and at a review that no open request is
 *  waiting on; everything else falls into the round it happened in. */
export function buildReviewTimeline(input: {
  requests: ReviewRequest[]
  submissions: ReviewSubmission[]
  comments: ReviewComment[]
  commits: TimelineCommit[]
}): TimelineRound[] {
  const { requests, submissions, comments, commits } = input
  if (requests.length === 0 && submissions.length === 0 && comments.length === 0) return []

  const byId = new Map(comments.map((c) => [c.id, c]))
  const inSubmission = new Set<string>()
  const entries: TimelineEntry[] = []

  for (const r of requests) entries.push({ kind: 'request', at: r.createdAt, request: r })
  for (const s of submissions) {
    const nested: ReviewComment[] = []
    let missing = 0
    for (const id of s.commentIds) {
      const c = byId.get(id)
      if (!c) missing++
      else if (!inSubmission.has(id)) {
        inSubmission.add(id)
        nested.push(c)
      }
    }
    entries.push({ kind: 'review', at: s.createdAt, submission: s, comments: nested, missing })
  }
  for (const c of comments) {
    if (!inSubmission.has(c.id)) entries.push({ kind: 'comment', at: c.createdAt, comment: c })
    for (const reply of c.replies ?? []) {
      entries.push({ kind: 'reply', at: reply.createdAt, comment: c, reply })
    }
    if (c.status === 'resolved' && c.resolvedAt !== undefined) {
      entries.push({ kind: 'resolved', at: c.resolvedAt, comment: c, by: c.resolvedBy })
    }
  }
  for (const commit of commits) {
    entries.push({ kind: 'commit', at: commit.timestamp * 1000, commit })
  }
  entries.sort((a, b) => a.at - b.at || KIND_ORDER[a.kind] - KIND_ORDER[b.kind])

  const rounds: TimelineRound[] = []
  let current: TimelineRound = { index: 0, entries: [] }
  // Whether the open round is a request still waiting for its review.
  let awaitingReview = false
  const open = (): void => {
    if (current.entries.length > 0) rounds.push(current)
    current = { index: (rounds.at(-1)?.index ?? 0) + 1, entries: [] }
  }
  for (const e of entries) {
    if (e.kind === 'request') {
      open()
      awaitingReview = true
    } else if (e.kind === 'review') {
      if (!awaitingReview) open()
      awaitingReview = false
    }
    current.entries.push(e)
  }
  if (current.entries.length > 0) rounds.push(current)
  return rounds
}
