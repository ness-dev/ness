export interface CheckStatus {
  name: string
  state: 'success' | 'failure' | 'pending' | 'neutral' | 'skipped' | 'error'
  description: string
  /** Longer failure summary from the check's output (markdown, may be multi-line) */
  summary?: string
  /** External URL to the check's log / details page */
  detailsUrl?: string
  /** ISO timestamp when the check started. Optional — only used for
   * ordering checks within a status group. */
  startedAt?: string
}

export interface PRReview {
  user: string
  avatarUrl: string
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'
  body: string
  submittedAt: string
  htmlUrl: string
  /** Line comments attached to this review. Undefined on statuses cached
   *  by an older build. */
  inlineCommentCount?: number
}

/** A top-level comment on the PR's conversation tab (not a review). */
export interface PRComment {
  user: string
  avatarUrl: string
  body: string
  createdAt: string
  htmlUrl: string
}

export interface PRStatus {
  number: number
  title: string
  state: 'open' | 'draft' | 'merged' | 'closed'
  url: string
  branch: string
  /** SHA of the PR's head commit. Undefined on statuses cached by an older
   *  Ness build. The CI notifier keys its dedup on this so a failing
   *  build notifies once per commit rather than once per poll. */
  headSha?: string
  /** Author of the PR. null when GitHub redacts (rare) or pre-Reviewing-grouping data. */
  author: { login: string; avatarUrl: string } | null
  checks: CheckStatus[]
  checksOverall: 'success' | 'failure' | 'pending' | 'none'
  /** true = has conflicts with base, false = mergeable, null = still computing */
  hasConflict: boolean | null
  reviews: PRReview[]
  /** Most recent conversation comments, oldest first. Undefined on
   *  statuses cached by an older build. */
  comments?: PRComment[]
  reviewDecision: 'approved' | 'changes_requested' | 'review_required' | 'none'
  additions?: number
  deletions?: number
  baseBranch: string
  isDefaultBase: boolean
  milestone?: { title: string; url: string; state: 'open' | 'closed' } | null
  assignees: { login: string; avatarUrl: string }[]
  /** 1-indexed position in the merge queue. Present only when the PR is
   * currently enqueued; 1 = head of queue. */
  queuePosition?: number
  /** GitHub's estimated seconds until this entry merges. Optional —
   * GitHub returns null until it has enough signal to estimate. */
  queueEstimatedSeconds?: number
  /** Commits in the base branch not in this PR's head — i.e. how far
   * behind the target branch the PR is. Undefined when GitHub's compare
   * endpoint fails or isn't applicable. */
  behindBy?: number
  /** Issues this PR will close on merge (from `Closes #N` style refs
   * or GitHub's "Link an issue" UI). Empty when none or when the
   * extras fetch failed. */
  linkedIssues: { number: number; title: string; state: 'open' | 'closed'; url: string }[]
  /** GitHub labels attached to the PR. Color is a 6-char hex without
   * the leading '#'. */
  labels: { name: string; color: string; description?: string }[]
  /** For merged PRs: the earliest tag (by version-sort) that contains the
   * merge commit in the local worktree. Undefined for unmerged PRs, or
   * when no tag yet contains the merge — i.e. unreleased. */
  firstReleaseTag?: string
  /** True if the PR's repo has at least one milestone defined. Undefined
   * when we haven't checked (older cached state). The PR pane uses this
   * to hide the milestone pill entirely on repos that don't use them. */
  hasMilestones?: boolean
}

export interface PRsState {
  /** PR status per worktree path. null = "we looked and there's no PR yet". */
  byPath: Record<string, PRStatus | null>
  /** Locally-merged flag per worktree path. Replaced wholesale on poll. */
  mergedByPath: Record<string, boolean>
  /** True while a full refresh is in flight. */
  loading: boolean
}

export type PRsEvent =
  | { type: 'prs/statusChanged'; payload: { path: string; status: PRStatus | null } }
  | { type: 'prs/bulkStatusChanged'; payload: Record<string, PRStatus | null> }
  | { type: 'prs/mergedChanged'; payload: Record<string, boolean> }
  | { type: 'prs/loadingChanged'; payload: boolean }

export const initialPRs: PRsState = {
  byPath: {},
  mergedByPath: {},
  loading: false
}

/** True if a PR is in a terminal state (merged or closed). Use this any
 * time you need a boolean "is this PR done?" — distinct icon-color sites
 * that need to differentiate merged-vs-closed should still inline. */
export function isPRMerged(pr: PRStatus | null | undefined): boolean {
  return pr?.state === 'merged' || pr?.state === 'closed'
}

/** Canonical "is this worktree merged?" check. A worktree counts as merged
 * if the locally-merged poller flagged it (branch SHA matches a recorded
 * merge SHA — works without a GitHub token), or its PR is in a terminal
 * state. Used by the activity deriver, the cleanup view, and boot-time
 * pane init (sleep-on-boot for merged worktrees). */
export function isWorktreeMerged(prs: PRsState, worktreePath: string): boolean {
  return !!prs.mergedByPath[worktreePath] || isPRMerged(prs.byPath[worktreePath])
}

export function prsReducer(state: PRsState, event: PRsEvent): PRsState {
  switch (event.type) {
    case 'prs/statusChanged':
      return {
        ...state,
        byPath: { ...state.byPath, [event.payload.path]: event.payload.status }
      }
    case 'prs/bulkStatusChanged':
      return { ...state, byPath: event.payload }
    case 'prs/mergedChanged':
      return { ...state, mergedByPath: event.payload }
    case 'prs/loadingChanged':
      return { ...state, loading: event.payload }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}
