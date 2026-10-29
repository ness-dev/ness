import { randomUUID } from 'crypto'
import type { Store } from './store'
import type { AppState } from '../shared/state'
import type {
  ReviewAuthor,
  ReviewComment,
  ReviewCommentStatus,
  ReviewSubmission,
  ReviewVerdict
} from '../shared/state/reviews'
import { getLeaves } from '../shared/state/terminals'
import { tabLabel, type AgentTabInfo } from '../shared/agent-tabs'
import { formatReviewSubmission } from '../shared/review-format'
import { wrapAutomatedMessage } from '../shared/state/json-claude'
import { describeTabDeliveryFailure, type TabDeliveryResult } from './chat-delivery'
import type { TerminalSettled } from './terminal-delivery'
import { addReviewReply, refreshReviewAnchors } from './review-comments'

export interface ReviewServiceDeps {
  store: Store
  listAgentTabs: (worktreePath: string) => AgentTabInfo[]
  deliver: (
    worktreePath: string,
    tabId: string,
    message: string,
    onSettled?: (result: TerminalSettled) => void
  ) => TabDeliveryResult
}

export type ReviewSendResult =
  | { ok: true; tabId: string; woke: boolean; queued?: boolean }
  | { ok: false; error: string; tabId?: string }

/** Author record for a comment, reply or review written from `tabId`.
 *  The label is the tab's name as the user sees it in the tab strip. */
export function agentAuthor(state: AppState, worktreePath: string, tabId: string): ReviewAuthor {
  const tree = state.terminals.panes[worktreePath]
  if (tree) {
    for (const leaf of getLeaves(tree)) {
      const tab = leaf.tabs.find((t) => t.id === tabId)
      if (tab) return { kind: 'agent', tabId, label: tabLabel(tab) }
    }
  }
  return { kind: 'agent', tabId }
}

const MIN_ID_PREFIX = 6

/** Look up a comment by full id or by the short id printed in review
 *  messages. A prefix must be unambiguous. */
export function findReviewComment(
  comments: ReviewComment[],
  idOrPrefix: string
): ReviewComment | { error: string } {
  const q = idOrPrefix.trim().replace(/^\[|\]$/g, '')
  if (!q) return { error: 'comment id required' }
  const exact = comments.find((c) => c.id === q)
  if (exact) return exact
  if (q.length >= MIN_ID_PREFIX) {
    const matches = comments.filter((c) => c.id.startsWith(q))
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) {
      return { error: `"${q}" matches ${matches.length} comments — pass more of the id` }
    }
  }
  return { error: `no review comment with id "${q}" in this worktree` }
}

/** The tab a review goes to: the most recently active agent tab that
 *  isn't the reviewer's own. This is the fallback; once reviewer tabs are
 *  spawned by Ness they'll carry an explicit link to the tab they review,
 *  and that link should win here. */
export function pickReviewTarget(
  tabs: AgentTabInfo[],
  reviewerTabId: string | null
): string | null {
  return tabs.find((t) => t.id !== reviewerTabId)?.id ?? null
}

export interface ListReviewCommentsFilter {
  status?: ReviewCommentStatus
  file?: string
}

/** Comments re-anchored against HEAD first, so the line numbers an agent
 *  reads match the code it will open. */
export async function listReviewComments(
  store: Store,
  worktreePath: string,
  filter: ListReviewCommentsFilter = {}
): Promise<ReviewComment[]> {
  await refreshReviewAnchors(store, worktreePath)
  const comments = store.getSnapshot().state.reviews.byPath[worktreePath]?.comments ?? []
  return comments.filter(
    (c) =>
      (!filter.status || c.status === filter.status) &&
      (!filter.file || c.filePath === filter.file)
  )
}

export function setReviewCommentResolved(
  store: Store,
  worktreePath: string,
  idOrPrefix: string,
  resolved: boolean
): { comment: ReviewComment } | { error: string } {
  const comments = store.getSnapshot().state.reviews.byPath[worktreePath]?.comments ?? []
  const found = findReviewComment(comments, idOrPrefix)
  if ('error' in found) return found
  // Reopening goes back to 'open'; the next anchor refresh re-outdates it
  // if its line is gone.
  const status: ReviewCommentStatus = resolved ? 'resolved' : 'open'
  store.dispatch({
    type: 'reviews/commentStatusChanged',
    payload: { worktreePath, id: found.id, status }
  })
  return { comment: { ...found, status } }
}

export function replyToReviewComment(
  store: Store,
  worktreePath: string,
  idOrPrefix: string,
  author: ReviewAuthor,
  body: string
): { comment: ReviewComment } | { error: string } {
  if (!body.trim()) return { error: 'reply body is empty' }
  const comments = store.getSnapshot().state.reviews.byPath[worktreePath]?.comments ?? []
  const found = findReviewComment(comments, idOrPrefix)
  if ('error' in found) return found
  if (!addReviewReply(store, worktreePath, found.id, author, body)) {
    return { error: 'comment was deleted' }
  }
  const updated = store
    .getSnapshot()
    .state.reviews.byPath[worktreePath]?.comments.find((c) => c.id === found.id)
  return { comment: updated ?? found }
}

function findSubmission(
  state: AppState,
  worktreePath: string,
  id: string
): ReviewSubmission | null {
  return state.reviews.byPath[worktreePath]?.submissions?.find((s) => s.id === id) ?? null
}

/** Deliver a submission to its author tab and record the outcome on it.
 *  `targetTabId` overrides the target picked at submit time. */
export function sendReviewSubmission(
  deps: ReviewServiceDeps,
  worktreePath: string,
  submissionId: string,
  targetTabId?: string
): ReviewSendResult {
  const state = deps.store.getSnapshot().state
  const submission = findSubmission(state, worktreePath, submissionId)
  if (!submission) return { ok: false, error: 'Review not found' }
  if (submission.state === 'queued') {
    return { ok: false, error: 'Already queued — it goes in when that tab is idle' }
  }
  const reviewerTabId = submission.author.kind === 'agent' ? submission.author.tabId : null
  const target =
    targetTabId ??
    submission.targetTabId ??
    pickReviewTarget(deps.listAgentTabs(worktreePath), reviewerTabId)

  const record = (result: ReviewSendResult): ReviewSendResult => {
    deps.store.dispatch({
      type: 'reviews/submissionDelivered',
      payload: {
        worktreePath,
        id: submissionId,
        state: !result.ok ? 'failed' : result.queued ? 'queued' : 'sent',
        targetTabId: target,
        at: Date.now(),
        error: result.ok ? undefined : result.error
      }
    })
    return result
  }

  if (!target) return record({ ok: false, error: 'No other agent tab in this worktree to send it to' })
  if (target === reviewerTabId) {
    return record({ ok: false, error: "A review can't be sent to the tab that wrote it", tabId: target })
  }
  const comments = state.reviews.byPath[worktreePath]?.comments ?? []
  const message = wrapAutomatedMessage('review', formatReviewSubmission(submission, comments), {
    from: submission.author.kind === 'agent' ? submission.author.label : undefined
  })
  const result = deps.deliver(worktreePath, target, message, (settled) => {
    record(
      settled.ok
        ? { ok: true, tabId: target, woke: false }
        : { ok: false, error: describeTabDeliveryFailure(settled.reason), tabId: target }
    )
  })
  if (!result.ok) {
    return record({ ok: false, error: describeTabDeliveryFailure(result.reason), tabId: target })
  }
  return record({ ok: true, tabId: result.tabId, woke: result.woke, queued: result.queued })
}

export interface SubmitReviewInput {
  verdict: ReviewVerdict
  summary: string
  /** Explicit author tab. Must be an agent tab in the worktree other than
   *  the reviewer's. */
  targetTabId?: string
  /** Deliver now instead of holding a draft. */
  autoSend: boolean
}

export type SubmitReviewResult =
  | { submission: ReviewSubmission; delivery: ReviewSendResult | null }
  | { error: string }

export function submitReview(
  deps: ReviewServiceDeps,
  worktreePath: string,
  author: ReviewAuthor,
  input: SubmitReviewInput
): SubmitReviewResult {
  const state = deps.store.getSnapshot().state
  const reviewerTabId = author.kind === 'agent' ? author.tabId : null
  const tabs = deps.listAgentTabs(worktreePath)
  if (input.targetTabId) {
    if (input.targetTabId === reviewerTabId) {
      return { error: "you can't send a review to your own tab — pick the author's tab" }
    }
    if (!tabs.some((t) => t.id === input.targetTabId)) {
      return { error: `no agent tab "${input.targetTabId}" in this worktree — call list_tabs` }
    }
  }
  const sameAuthor = (a: ReviewAuthor): boolean =>
    a.kind === author.kind && (a.kind === 'human' || a.tabId === reviewerTabId)
  const commentIds = (state.reviews.byPath[worktreePath]?.comments ?? [])
    .filter((c) => c.status === 'open' && sameAuthor(c.author))
    .map((c) => c.id)
  const targetTabId = input.targetTabId ?? pickReviewTarget(tabs, reviewerTabId) ?? undefined
  const submission: ReviewSubmission = {
    id: randomUUID(),
    author,
    verdict: input.verdict,
    summary: input.summary.trim(),
    commentIds,
    createdAt: Date.now(),
    state: 'draft',
    ...(targetTabId ? { targetTabId } : {})
  }
  deps.store.dispatch({ type: 'reviews/submissionAdded', payload: { worktreePath, submission } })
  if (!input.autoSend) return { submission, delivery: null }
  const delivery = sendReviewSubmission(deps, worktreePath, submission.id)
  const latest = findSubmission(deps.store.getSnapshot().state, worktreePath, submission.id)
  return { submission: latest ?? submission, delivery }
}
