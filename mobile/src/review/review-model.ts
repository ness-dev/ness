// Pure logic behind the phone's Review tab: where comments sit in the
// unified diff, what the counters say, and how a review's status maps to
// an icon. No React or RN here, so test/review-model.test.ts covers it.
import { placeComment, splitLines } from '../../../src/shared/review-anchor'
import { REVIEW_VERDICT_LABELS } from '../../../src/shared/review-format'
import { latestAgentReviewStatus, type ReviewStatus } from '../../../src/shared/review-status'
import type { AppState } from '../../../src/shared/state'
import type { ReviewComment, ReviewSubmission } from '../../../src/shared/state/reviews'
import { findLeafByTabId, type PtyStatus, type TerminalTab } from '../../../src/shared/state/terminals'
import type { DiffRow } from '../viewer/diff-model'

export interface CommentPlacement {
  /** Diff row index → the comments drawn under it, in creation order. */
  byRow: Map<number, ReviewComment[]>
  /** Comments not drawn in the diff. `line` is set when the comment sits on
   *  a line of this revision that the hunks don't show (the desktop's
   *  Monaco shows the whole file, the phone only the changed lines); null
   *  when it isn't on any line here (outdated, old side, or gone). */
  unplaced: { comment: ReviewComment; line: number | null }[]
}

/** ReviewDiffPane's placement: by snippet against the shown revision, not
 *  the stored line, so a commit- or range-scoped view still draws each
 *  comment on the code it was written about. New-side comments only, as
 *  on desktop. */
export function placeCommentsInDiff(rows: readonly DiffRow[], modified: string, comments: readonly ReviewComment[]): CommentPlacement {
  const byRow = new Map<number, ReviewComment[]>()
  const unplaced: CommentPlacement['unplaced'] = []
  if (comments.length === 0) return { byRow, unplaced }
  const rowOfNewLine = new Map<number, number>()
  rows.forEach((r, i) => {
    if (r.kind === 'line' && r.newNo !== null) rowOfNewLine.set(r.newNo, i)
  })
  const lines = splitLines(modified)
  const ordered = [...comments].sort((a, b) => a.createdAt - b.createdAt)
  for (const c of ordered) {
    const line = c.side === 'new' ? placeComment(lines, c) : null
    const row = line === null ? undefined : rowOfNewLine.get(line)
    if (row === undefined) {
      unplaced.push({ comment: c, line })
      continue
    }
    const list = byRow.get(row)
    if (list) list.push(c)
    else byRow.set(row, [c])
  }
  return { byRow, unplaced }
}

export interface CommentCounts {
  open: number
  total: number
  /** Open comments on files outside the current selection's file list. */
  openElsewhere: number
}

export function commentCounts(comments: readonly ReviewComment[], filesInView?: ReadonlySet<string>): CommentCounts {
  let open = 0
  let openElsewhere = 0
  for (const c of comments) {
    if (c.status !== 'open') continue
    open++
    if (filesInView && !filesInView.has(c.filePath)) openElsewhere++
  }
  return { open, total: comments.length, openElsewhere }
}

/** Open / total comments per file, for the file list. */
export function perFileCounts(comments: readonly ReviewComment[]): Map<string, { open: number; total: number }> {
  const out = new Map<string, { open: number; total: number }>()
  for (const c of comments) {
    const e = out.get(c.filePath) ?? { open: 0, total: 0 }
    e.total++
    if (c.status === 'open') e.open++
    out.set(c.filePath, e)
  }
  return out
}

const STATUS_ORDER: Record<ReviewComment['status'], number> = { open: 0, outdated: 1, resolved: 2 }

/** The comment list: open first, then by file and line. */
export function sortThreads(comments: readonly ReviewComment[]): ReviewComment[] {
  return [...comments].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      a.filePath.localeCompare(b.filePath) ||
      a.line - b.line ||
      a.createdAt - b.createdAt
  )
}

export type ReviewScope =
  | { kind: 'branch' }
  | { kind: 'commit'; hash: string }
  | { kind: 'range'; from: string; to: string }

/** ReviewPane's selection: both bounds unset is the whole branch, equal
 *  bounds one commit, anything else a range. */
export function reviewScope(tab: Pick<TerminalTab, 'reviewFromCommit' | 'reviewToCommit'>): ReviewScope {
  const from = tab.reviewFromCommit
  const to = tab.reviewToCommit
  if (!from || !to) return { kind: 'branch' }
  if (from === to) return { kind: 'commit', hash: from }
  return { kind: 'range', from, to }
}

export type ReviewIconName = 'Loader2' | 'ListChecks' | 'CircleCheck' | 'CircleAlert' | 'MessageSquare'
export type ReviewTone = 'accent' | 'danger' | 'success' | 'warning' | 'info' | 'dim'

export interface ReviewIconSpec {
  icon: ReviewIconName
  tone: ReviewTone
  spin?: boolean
  pulse?: boolean
  /** Rendered at reduced opacity (a requested review whose reviewer idles). */
  faded?: boolean
  /** VoiceOver label; ends in "· not sent" when `unsent`. */
  label: string
  unsent: boolean
}

/** ReviewStatusIcon's mapping (renderer/components/ReviewStatusIcon.tsx),
 *  with the reviewer tab's live status deciding a 'reviewing' icon. Shared
 *  by the tab strip and the worktree picker so both always agree. `none`
 *  is null unless `showNone` (a Review tab still wants its kind icon). */
export function reviewIconSpec(
  status: Pick<ReviewStatus, 'kind' | 'unsent'>,
  reviewerStatus: PtyStatus | undefined,
  showNone = false
): ReviewIconSpec | null {
  let spec: Omit<ReviewIconSpec, 'unsent'>
  switch (status.kind) {
    case 'none':
      if (!showNone) return null
      return { icon: 'ListChecks', tone: 'dim', label: 'No agent review', unsent: false }
    case 'reviewing':
      // A reviewer that went idle without submitting has stalled; a
      // spinner there would never stop.
      if (reviewerStatus === 'processing') spec = { icon: 'Loader2', tone: 'accent', spin: true, label: 'Agent review in progress' }
      else if (reviewerStatus === 'needs-approval') spec = { icon: 'ListChecks', tone: 'danger', pulse: true, label: 'Agent review waiting for approval' }
      else spec = { icon: 'ListChecks', tone: 'accent', faded: true, label: 'Agent review requested, reviewer idle' }
      break
    case 'approve':
      spec = { icon: 'CircleCheck', tone: 'success', label: REVIEW_VERDICT_LABELS.approve }
      break
    case 'changes-requested':
      spec = { icon: 'CircleAlert', tone: 'warning', label: REVIEW_VERDICT_LABELS['changes-requested'] }
      break
    case 'comment':
      spec = { icon: 'MessageSquare', tone: 'info', label: REVIEW_VERDICT_LABELS.comment }
      break
  }
  return { ...spec, label: status.unsent ? `${spec.label} · not sent` : spec.label, unsent: status.unsent }
}

/** A worktree's latest agent review as the sidebar (and its Review tab)
 *  shows it, read straight from a backend's state: the same
 *  useLatestAgentReviewStatus rule, a reviewer counts only while its tab
 *  is open. */
export function worktreeReviewStatus(state: AppState, worktreePath: string): ReviewStatus & { reviewerStatus: PtyStatus | undefined } {
  const tree = state.terminals.panes[worktreePath]
  const status = latestAgentReviewStatus(state.reviews.byPath[worktreePath], (id) => !!tree && !!findLeafByTabId(tree, id))
  return { ...status, reviewerStatus: status.reviewerTabId ? state.terminals.statuses[status.reviewerTabId] : undefined }
}

/** What the reviewer agent is doing, for the Reviews view's status row. */
export function reviewerActivity(reviewerStatus: PtyStatus | undefined): { text: string; tone: ReviewTone; busy: boolean } {
  if (reviewerStatus === 'processing') return { text: 'Reviewer is working', tone: 'accent', busy: true }
  if (reviewerStatus === 'needs-approval') return { text: 'Reviewer needs your approval', tone: 'danger', busy: false }
  return { text: 'Reviewer is idle', tone: 'dim', busy: false }
}

/** SubmissionCard's status line. `labelOf` names a tab by id (null when
 *  it's closed). */
export function submissionStatus(s: ReviewSubmission, labelOf: (tabId: string) => string | null): { text: string; tone: ReviewTone } {
  const target = s.targetTabId ? (labelOf(s.targetTabId) ?? 'a closed tab') : null
  if (s.state === 'sent') return { text: `Sent to ${target ?? 'agent'}`, tone: 'success' }
  if (s.state === 'failed') return { text: `Not sent${target ? ` to ${target}` : ''}`, tone: 'danger' }
  return { text: target ? `Draft · will go to ${target}` : 'Draft · no Chat tab to send to', tone: 'dim' }
}

/** "src/a.ts:12" — or ":12 (old)" for a removed-line comment. */
export function commentLocation(c: Pick<ReviewComment, 'filePath' | 'line' | 'side'>, withPath = true): string {
  const at = `${withPath ? c.filePath : 'L'}${withPath ? ':' : ''}${c.line}`
  return c.side === 'old' ? `${at} (old)` : at
}
