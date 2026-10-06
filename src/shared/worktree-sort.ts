import type { Worktree } from './state/worktrees'
import type { PRStatus } from './state/prs'
import { isPRMerged } from './state/prs'
import type { AssignedPR } from './state/assigned-prs'

export type GroupKey = 'pinned' | 'needs-attention' | 'reviewing' | 'active' | 'no-pr' | 'snoozed' | 'merged'

export interface WorktreeGroup {
  key: GroupKey
  label: string
  worktrees: Worktree[]
  /** PRs the viewer is a requested reviewer on that DON'T yet have a
   *  worktree in the sidebar. Only ever populated on the `reviewing`
   *  group. Rendered after the group's worktrees as phantom rows —
   *  clicking one opens the "new worktree from PR" screen pre-selected. */
  phantomPRs?: AssignedPR[]
}

export function getGroupKey(
  wt: Worktree,
  pr: PRStatus | null | undefined,
  locallyMerged?: boolean,
  isSnoozed?: boolean,
  viewerLogin?: string | null,
  isPinned?: boolean
): GroupKey {
  void wt
  // Pinned is an explicit user override, so it outranks every derived
  // signal — a pinned worktree appears only in the Pinned section.
  if (isPinned) return 'pinned'
  if (isSnoozed) return 'snoozed'
  if (locallyMerged) return 'merged'
  if (!pr) return 'no-pr'
  if (isPRMerged(pr)) return 'merged'
  // PR is open: if we know the viewer's login and this PR was authored
  // by somebody else, it's something we're reviewing. The 'needs-attention'
  // signals (failing checks, conflicts, changes requested) apply to PRs
  // we own — for reviews the user doesn't have to fix anything.
  if (viewerLogin && pr.author && pr.author.login !== viewerLogin) return 'reviewing'
  if (pr.checksOverall === 'failure' || pr.hasConflict === true || pr.reviewDecision === 'changes_requested') return 'needs-attention'
  return 'active'
}

export const GROUP_ORDER: GroupKey[] = ['pinned', 'needs-attention', 'reviewing', 'active', 'no-pr', 'snoozed', 'merged']

export const GROUP_LABELS: Record<GroupKey, string> = {
  pinned: 'Pinned',
  'needs-attention': 'Needs Attention',
  reviewing: 'Reviewing',
  active: 'Open PRs',
  'no-pr': 'Active',
  merged: 'Merged / Closed',
  snoozed: 'Snoozed'
}

/** Sort worktrees within a group by creation time (newest first). Main worktree pinned to top. */
function sortByCreatedAt(worktrees: Worktree[]): Worktree[] {
  return [...worktrees].sort((a, b) => {
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1
    return (b.createdAt || 0) - (a.createdAt || 0)
  })
}

/** Sort the no-PR / Active group: main first, then any worktree whose
 *  branch is being targeted by an open PR (merge points like
 *  develop/integration/release), then everything else by createdAt desc. */
function sortNoPRGroup(worktrees: Worktree[], baseBranches: Set<string>): Worktree[] {
  return [...worktrees].sort((a, b) => {
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1
    const aBase = baseBranches.has(a.branch) ? 1 : 0
    const bBase = baseBranches.has(b.branch) ? 1 : 0
    if (aBase !== bBase) return bBase - aBase
    return (b.createdAt || 0) - (a.createdAt || 0)
  })
}

function collectBaseBranches(prStatuses: Record<string, PRStatus | null>): Set<string> {
  const out = new Set<string>()
  for (const status of Object.values(prStatuses)) {
    if (status?.baseBranch) out.add(status.baseBranch)
  }
  return out
}

/** Group worktrees by PR status, sorted by creation time within each group.
 *
 *  `assignedPRs` (optional) injects phantom entries into the Reviewing
 *  group for PRs where the viewer is a requested reviewer but no worktree
 *  yet exists. Dedup key is `repoRoot + PR number` — if a worktree already
 *  points at PR #42 in the same repo it's suppressed so the phantom
 *  doesn't shadow the real entry. */
export function groupWorktrees(
  worktrees: Worktree[],
  prStatuses: Record<string, PRStatus | null>,
  mergedPaths?: Record<string, boolean>,
  snoozedPaths?: Record<string, true>,
  viewerLogin?: string | null,
  assignedPRs?: AssignedPR[],
  pinnedPaths?: Record<string, true>
): WorktreeGroup[] {
  const grouped: Record<GroupKey, Worktree[]> = {
    pinned: [],
    'needs-attention': [],
    reviewing: [],
    active: [],
    'no-pr': [],
    merged: [],
    snoozed: []
  }

  for (const wt of worktrees) {
    const key = getGroupKey(
      wt,
      prStatuses[wt.path],
      mergedPaths?.[wt.path],
      snoozedPaths?.[wt.path],
      viewerLogin,
      pinnedPaths?.[wt.path]
    )
    grouped[key].push(wt)
  }

  const phantoms = dedupPhantomPRs(assignedPRs ?? [], worktrees, prStatuses)

  const baseBranches = collectBaseBranches(prStatuses)
  const groups: WorktreeGroup[] = []
  for (const key of GROUP_ORDER) {
    const wts = grouped[key]
    const groupPhantoms = key === 'reviewing' ? phantoms : []
    if (wts.length === 0 && groupPhantoms.length === 0) continue
    groups.push({
      key,
      label: GROUP_LABELS[key],
      worktrees:
        key === 'no-pr'
          ? sortNoPRGroup(wts, baseBranches)
          : sortByCreatedAt(wts),
      phantomPRs: groupPhantoms.length > 0 ? groupPhantoms : undefined
    })
  }
  return groups
}

/** Filter out any assigned PR that already has a worktree in the sidebar
 *  (same repoRoot + PR number). Sort by updatedAt descending so the
 *  freshest review request lands on top. */
function dedupPhantomPRs(
  assignedPRs: AssignedPR[],
  worktrees: Worktree[],
  prStatuses: Record<string, PRStatus | null>
): AssignedPR[] {
  if (assignedPRs.length === 0) return assignedPRs
  const existing = new Set<string>()
  for (const wt of worktrees) {
    const pr = prStatuses[wt.path]
    if (pr) existing.add(`${wt.repoRoot}#${pr.number}`)
  }
  const filtered = assignedPRs.filter((pr) => !existing.has(`${pr.repoRoot}#${pr.number}`))
  return [...filtered].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
}

/** Flatten grouped worktrees into a single ordered list (matching sidebar display order) */
export function sortedWorktrees(
  worktrees: Worktree[],
  prStatuses: Record<string, PRStatus | null>,
  mergedPaths?: Record<string, boolean>,
  snoozedPaths?: Record<string, true>,
  viewerLogin?: string | null,
  pinnedPaths?: Record<string, true>
): Worktree[] {
  return groupWorktrees(
    worktrees,
    prStatuses,
    mergedPaths,
    snoozedPaths,
    viewerLogin,
    undefined,
    pinnedPaths
  ).flatMap((g) => g.worktrees)
}
