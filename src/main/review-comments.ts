import { randomUUID } from 'crypto'
import type { Store } from './store'
import type {
  ReviewAnchorUpdate,
  ReviewAuthor,
  ReviewComment,
  ReviewCommentStatus,
  ReviewSide
} from '../shared/state/reviews'
import { reanchor, snippetAt, splitLines } from '../shared/review-anchor'
import { getBranchDiffBase, readFileAtCommit, resolveCommitSha } from './worktree'

export interface ReviewView {
  /** Oldest selected commit. Undefined ⇒ whole branch. */
  fromCommit?: string
  /** Newest selected commit. Undefined ⇒ whole branch. */
  toCommit?: string
}

export interface AddReviewCommentInput {
  filePath: string
  line: number
  side: ReviewSide
  body: string
  author: ReviewAuthor
  view?: ReviewView
}

const SHA_RE = /^[0-9a-fA-F]{4,64}$/

/** The commit whose content the given side of the Review diff shows.
 *  Mirrors the ref choice in getFileDiffSides('branch') and
 *  getCommit{,Range}FileDiffSides so the snippet matches what was on screen. */
async function sideCommit(
  worktreePath: string,
  side: ReviewSide,
  view: ReviewView | undefined
): Promise<string | null> {
  const from = view?.fromCommit && SHA_RE.test(view.fromCommit) ? view.fromCommit : undefined
  const to = view?.toCommit && SHA_RE.test(view.toCommit) ? view.toCommit : undefined
  if (side === 'new') return resolveCommitSha(worktreePath, to ?? 'HEAD')
  if (from) return resolveCommitSha(worktreePath, `${from}^`)
  return getBranchDiffBase(worktreePath)
}

export async function addReviewComment(
  store: Store,
  worktreePath: string,
  input: AddReviewCommentInput
): Promise<ReviewComment | { error: string }> {
  const body = input.body.trim()
  if (!body) return { error: 'Comment body is empty' }
  const sha = await sideCommit(worktreePath, input.side, input.view)
  if (!sha) return { error: `Could not resolve the ${input.side} side of the diff` }
  const content = await readFileAtCommit(worktreePath, sha, input.filePath)
  if (content == null) {
    return { error: `${input.filePath} does not exist at ${sha.slice(0, 7)} (${input.side} side)` }
  }
  const lines = splitLines(content)
  const snippet = snippetAt(lines, input.line)
  if (snippet == null) {
    const count = content.endsWith('\n') ? lines.length - 1 : lines.length
    return {
      error: `line ${input.line} is out of range: ${input.filePath} has ${count} lines at ${sha.slice(0, 7)} (${input.side} side)`
    }
  }
  const comment: ReviewComment = {
    id: randomUUID(),
    filePath: input.filePath,
    side: input.side,
    line: input.line,
    anchoredSha: sha,
    anchor: { commitSha: sha, line: input.line, snippet },
    author: input.author,
    status: 'open',
    body,
    createdAt: Date.now()
  }
  store.dispatch({ type: 'reviews/commentAdded', payload: { worktreePath, comment } })
  return comment
}

export function addReviewReply(
  store: Store,
  worktreePath: string,
  commentId: string,
  author: ReviewAuthor,
  body: string
): boolean {
  const trimmed = body.trim()
  if (!trimmed) return false
  const exists = store
    .getSnapshot()
    .state.reviews.byPath[worktreePath]?.comments.some((c) => c.id === commentId)
  if (!exists) return false
  store.dispatch({
    type: 'reviews/replyAdded',
    payload: {
      worktreePath,
      commentId,
      reply: { id: randomUUID(), author, body: trimmed, createdAt: Date.now() }
    }
  })
  return true
}

export function setReviewCommentStatus(
  store: Store,
  worktreePath: string,
  id: string,
  status: ReviewCommentStatus
): void {
  store.dispatch({ type: 'reviews/commentStatusChanged', payload: { worktreePath, id, status } })
}

/** Re-anchor this worktree's new-side comments against HEAD. Called on
 *  demand (Review pane mount, file open, before sending) rather than from
 *  a subscriber: a comment is only touched when HEAD has moved past the
 *  commit it was last checked against, so the steady state is one
 *  rev-parse and zero dispatches. Old-side comments point at the diff
 *  base, which doesn't move as the author commits, so they're left as-is.
 *  Resolved comments are skipped; reopening one re-qualifies it. */
export async function refreshReviewAnchors(
  store: Store,
  worktreePath: string,
  filePath?: string
): Promise<void> {
  const comments = store.getSnapshot().state.reviews.byPath[worktreePath]?.comments
  if (!comments) return
  const candidates = comments.filter(
    (c) => c.side === 'new' && c.status !== 'resolved' && (!filePath || c.filePath === filePath)
  )
  if (candidates.length === 0) return
  const head = await resolveCommitSha(worktreePath, 'HEAD')
  if (!head) return
  const stale = candidates.filter((c) => c.anchoredSha !== head)
  if (stale.length === 0) return

  const linesByFile = new Map<string, string[] | null>()
  for (const c of stale) {
    if (linesByFile.has(c.filePath)) continue
    const content = await readFileAtCommit(worktreePath, head, c.filePath)
    linesByFile.set(c.filePath, content == null ? null : splitLines(content))
  }
  // Re-read after the git awaits: the user may have resolved or deleted a
  // comment meanwhile, and the update must not resurrect its old status.
  const staleIds = new Set(stale.map((c) => c.id))
  const updates: ReviewAnchorUpdate[] = []
  for (const c of store.getSnapshot().state.reviews.byPath[worktreePath]?.comments ?? []) {
    if (!staleIds.has(c.id) || c.status === 'resolved') continue
    const { line, status } = reanchor(linesByFile.get(c.filePath) ?? null, c)
    updates.push({ id: c.id, line, anchoredSha: head, status })
  }
  if (updates.length === 0) return
  store.dispatch({ type: 'reviews/anchorsUpdated', payload: { worktreePath, updates } })
}
