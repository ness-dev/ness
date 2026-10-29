export type ReviewAuthor = { kind: 'human' } | { kind: 'agent'; tabId: string; label?: string }

export type ReviewCommentStatus = 'open' | 'resolved' | 'outdated'

export type ReviewSide = 'old' | 'new'

export interface ReviewReply {
  id: string
  author: ReviewAuthor
  body: string
  createdAt: number
}

export interface ReviewAnchor {
  /** Commit whose content the comment was written against. Review diffs
   *  only ever show committed content (whole-branch is merge-base..HEAD),
   *  so this is always a real SHA — HEAD or the selected tip for the new
   *  side, the diff base for the old side. */
  commitSha: string
  /** Line in `commitSha`'s version of the file. Never changes. */
  line: number
  /** Trimmed text of the anchored line at `commitSha`. Compared against
   *  newer revisions to relocate or outdate the comment. */
  snippet: string
}

export interface ReviewComment {
  id: string
  filePath: string
  side: ReviewSide
  /** Current line, valid for `anchoredSha`. Starts equal to `anchor.line`
   *  and follows the snippet as new commits land. */
  line: number
  /** Commit `line` was last verified against. Lets the anchor refresh
   *  skip comments that are already current without touching git. */
  anchoredSha: string
  anchor: ReviewAnchor
  author: ReviewAuthor
  status: ReviewCommentStatus
  body: string
  createdAt: number
  replies?: ReviewReply[]
}

export interface WorktreeReview {
  comments: ReviewComment[]
}

export interface ReviewsState {
  /** Keyed by worktree path. Absent ⇒ no comments. */
  byPath: Record<string, WorktreeReview>
}

export interface ReviewAnchorUpdate {
  id: string
  line: number
  anchoredSha: string
  status: ReviewCommentStatus
}

export type ReviewsEvent =
  | { type: 'reviews/commentAdded'; payload: { worktreePath: string; comment: ReviewComment } }
  | { type: 'reviews/commentDeleted'; payload: { worktreePath: string; id: string } }
  | {
      type: 'reviews/commentStatusChanged'
      payload: { worktreePath: string; id: string; status: ReviewCommentStatus }
    }
  | {
      type: 'reviews/replyAdded'
      payload: { worktreePath: string; commentId: string; reply: ReviewReply }
    }
  | {
      type: 'reviews/anchorsUpdated'
      payload: { worktreePath: string; updates: ReviewAnchorUpdate[] }
    }
  | { type: 'reviews/worktreeRemoved'; payload: { worktreePath: string } }

export const initialReviews: ReviewsState = {
  byPath: {}
}

export const EMPTY_REVIEW_COMMENTS: ReviewComment[] = []

function withComments(
  state: ReviewsState,
  worktreePath: string,
  comments: ReviewComment[]
): ReviewsState {
  const byPath = { ...state.byPath }
  if (comments.length === 0) delete byPath[worktreePath]
  else byPath[worktreePath] = { ...state.byPath[worktreePath], comments }
  return { ...state, byPath }
}

function patchComment(
  state: ReviewsState,
  worktreePath: string,
  id: string,
  patch: (c: ReviewComment) => ReviewComment
): ReviewsState {
  const comments = state.byPath[worktreePath]?.comments
  if (!comments) return state
  const i = comments.findIndex((c) => c.id === id)
  if (i === -1) return state
  const next = patch(comments[i])
  if (next === comments[i]) return state
  return withComments(state, worktreePath, [
    ...comments.slice(0, i),
    next,
    ...comments.slice(i + 1)
  ])
}

export function reviewsReducer(state: ReviewsState, event: ReviewsEvent): ReviewsState {
  switch (event.type) {
    case 'reviews/commentAdded': {
      const { worktreePath, comment } = event.payload
      const existing = state.byPath[worktreePath]?.comments ?? EMPTY_REVIEW_COMMENTS
      if (existing.some((c) => c.id === comment.id)) return state
      return withComments(state, worktreePath, [...existing, comment])
    }
    case 'reviews/commentDeleted': {
      const { worktreePath, id } = event.payload
      const comments = state.byPath[worktreePath]?.comments
      if (!comments) return state
      const i = comments.findIndex((c) => c.id === id)
      if (i === -1) return state
      return withComments(state, worktreePath, [
        ...comments.slice(0, i),
        ...comments.slice(i + 1)
      ])
    }
    case 'reviews/commentStatusChanged': {
      const { worktreePath, id, status } = event.payload
      return patchComment(state, worktreePath, id, (c) =>
        c.status === status ? c : { ...c, status }
      )
    }
    case 'reviews/replyAdded': {
      const { worktreePath, commentId, reply } = event.payload
      return patchComment(state, worktreePath, commentId, (c) =>
        c.replies?.some((r) => r.id === reply.id)
          ? c
          : { ...c, replies: [...(c.replies ?? []), reply] }
      )
    }
    case 'reviews/anchorsUpdated': {
      const { worktreePath, updates } = event.payload
      const comments = state.byPath[worktreePath]?.comments
      if (!comments || updates.length === 0) return state
      const byId = new Map(updates.map((u) => [u.id, u]))
      let changed = false
      const next = comments.map((c) => {
        const u = byId.get(c.id)
        if (!u) return c
        if (c.line === u.line && c.anchoredSha === u.anchoredSha && c.status === u.status) {
          return c
        }
        changed = true
        return { ...c, line: u.line, anchoredSha: u.anchoredSha, status: u.status }
      })
      return changed ? withComments(state, worktreePath, next) : state
    }
    case 'reviews/worktreeRemoved': {
      const { worktreePath } = event.payload
      if (!(worktreePath in state.byPath)) return state
      const byPath = { ...state.byPath }
      delete byPath[worktreePath]
      return { ...state, byPath }
    }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}
