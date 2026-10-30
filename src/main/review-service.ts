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
import { getLeaves, type AgentKind, type TerminalTab } from '../shared/state/terminals'
import { tabLabel, type ChatTabInfo } from '../shared/agent-tabs'
import { formatReviewSubmission } from '../shared/review-format'
import { wrapAutomatedMessage } from '../shared/state/json-claude'
import { describeTabDeliveryFailure, type TabDeliveryResult } from './chat-delivery'
import { addReviewReply, refreshReviewAnchors } from './review-comments'

export interface ReviewServiceDeps {
  store: Store
  listChatTabs: (worktreePath: string) => ChatTabInfo[]
  deliver: (worktreePath: string, tabId: string, message: string) => TabDeliveryResult
  /** Open (or reuse) the reviewer Chat tab for a requester and hand it the
   *  request as its first turn. */
  openReviewer: (
    worktreePath: string,
    requesterTabId: string,
    prompt: string,
    opts?: { agentKind?: AgentKind; label?: string }
  ) => { tabId: string; reused: boolean }
}

export type ReviewSendResult =
  | { ok: true; tabId: string; woke: boolean }
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

function findTab(state: AppState, worktreePath: string, tabId: string): TerminalTab | null {
  const tree = state.terminals.panes[worktreePath]
  if (!tree) return null
  for (const leaf of getLeaves(tree)) {
    const tab = leaf.tabs.find((t) => t.id === tabId)
    if (tab) return tab
  }
  return null
}

/** The tab that asked this reviewer for a review, when it is still open.
 *  An explicit link beats any heuristic, so this is checked first. */
export function reviewRequester(
  state: AppState,
  worktreePath: string,
  reviewerTabId: string | null
): string | null {
  if (!reviewerTabId) return null
  const requesterId = findTab(state, worktreePath, reviewerTabId)?.reviewOf
  if (!requesterId) return null
  return findTab(state, worktreePath, requesterId) ? requesterId : null
}

/** The tab a review goes to: the most recently active Chat tab that
 *  isn't the reviewer's own. This is the fallback; once reviewer tabs are
 *  spawned by Ness they'll carry an explicit link to the tab they review,
 *  and that link should win here. */
export function pickReviewTarget(
  tabs: ChatTabInfo[],
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
  const reviewerTabId = submission.author.kind === 'agent' ? submission.author.tabId : null
  const target =
    targetTabId ??
    submission.targetTabId ??
    reviewRequester(state, worktreePath, reviewerTabId) ??
    pickReviewTarget(deps.listChatTabs(worktreePath), reviewerTabId)

  const record = (result: ReviewSendResult): ReviewSendResult => {
    deps.store.dispatch({
      type: 'reviews/submissionDelivered',
      payload: {
        worktreePath,
        id: submissionId,
        state: result.ok ? 'sent' : 'failed',
        targetTabId: target,
        at: Date.now(),
        error: result.ok ? undefined : result.error
      }
    })
    return result
  }

  if (!target) return record({ ok: false, error: 'No other Chat tab in this worktree to send it to' })
  if (target === reviewerTabId) {
    return record({ ok: false, error: "A review can't be sent to the tab that wrote it", tabId: target })
  }
  const comments = state.reviews.byPath[worktreePath]?.comments ?? []
  const message = wrapAutomatedMessage('review', formatReviewSubmission(submission, comments), {
    from: submission.author.kind === 'agent' ? submission.author.label : undefined
  })
  const result = deps.deliver(worktreePath, target, message)
  if (!result.ok) {
    return record({ ok: false, error: describeTabDeliveryFailure(result.reason), tabId: target })
  }
  return record({ ok: true, tabId: result.tabId, woke: result.woke })
}

/** Prompt handed to a reviewer tab as its first turn. The guidance
 *  footer wrapAutomatedMessage appends tells it how to use the tools and
 *  that submit_review is what sends the review back. */
export function buildReviewRequest(
  requesterLabel: string,
  context: string,
  opts?: { reRequest?: boolean }
): string {
  const body = [
    opts?.reRequest
      ? `${requesterLabel} has pushed changes and is asking for another look at this branch.`
      : `${requesterLabel} has finished a piece of work on this branch and is asking you to review it.`,
    '',
    context.trim()
  ].join('\n')
  return wrapAutomatedMessage('review-request', body, { from: requesterLabel })
}

export type RequestReviewResult =
  | { ok: true; reviewerTabId: string; reused: boolean }
  | { ok: false; error: string }

/** Open a reviewer for `requesterTabId` and hand it the request. The
 *  reviewer's submitted review comes back to the requester, because
 *  openReviewer records the link on the new tab. */
export function requestReview(
  deps: ReviewServiceDeps,
  worktreePath: string,
  requesterTabId: string,
  context: string
): RequestReviewResult {
  const state = deps.store.getSnapshot().state
  const requester = findTab(state, worktreePath, requesterTabId)
  if (!requester) return { ok: false, error: 'caller tab is not in this worktree' }
  if (requester.type !== 'json-claude') {
    return {
      ok: false,
      error:
        'only a Chat tab can request a review — a submitted review is delivered back to the requester, and Ness can only deliver into Chat tabs. Ask the user to switch this tab to Chat mode, or to open the Review tab and review the branch themselves.'
    }
  }
  if (requester.reviewOf) {
    return {
      ok: false,
      error:
        'you are the reviewer for this branch — submit your review with submit_review rather than requesting another one.'
    }
  }
  const reRequest = hasReviewer(state, worktreePath, requesterTabId)
  const opened = deps.openReviewer(
    worktreePath,
    requesterTabId,
    buildReviewRequest(tabLabel(requester), context, { reRequest }),
    { agentKind: requester.agentKind }
  )
  return { ok: true, reviewerTabId: opened.tabId, reused: opened.reused }
}

/** Whether a reviewer tab for this requester is already open — the
 *  request then reads as "another look", not a first review. */
function hasReviewer(state: AppState, worktreePath: string, requesterTabId: string): boolean {
  const tree = state.terminals.panes[worktreePath]
  if (!tree) return false
  for (const leaf of getLeaves(tree)) {
    for (const tab of leaf.tabs) {
      if (tab.type === 'json-claude' && tab.reviewOf === requesterTabId) return true
    }
  }
  return false
}

export interface SubmitReviewInput {
  verdict: ReviewVerdict
  summary: string
  /** Explicit author tab. Must be a Chat tab in the worktree other than
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
  const tabs = deps.listChatTabs(worktreePath)
  if (input.targetTabId) {
    if (input.targetTabId === reviewerTabId) {
      return { error: "you can't send a review to your own tab — pick the author's tab" }
    }
    if (!tabs.some((t) => t.id === input.targetTabId)) {
      return {
        error: `no Chat tab "${input.targetTabId}" in this worktree — reviews only go to Chat tabs, not terminal tabs; call list_tabs`
      }
    }
  }
  const sameAuthor = (a: ReviewAuthor): boolean =>
    a.kind === author.kind && (a.kind === 'human' || a.tabId === reviewerTabId)
  const commentIds = (state.reviews.byPath[worktreePath]?.comments ?? [])
    .filter((c) => c.status === 'open' && sameAuthor(c.author))
    .map((c) => c.id)
  // An explicit `tab` wins, then the tab that requested this review, then
  // the most recent other Chat tab.
  const targetTabId =
    input.targetTabId ??
    reviewRequester(state, worktreePath, reviewerTabId) ??
    pickReviewTarget(tabs, reviewerTabId) ??
    undefined
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
