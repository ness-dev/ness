import type {
  Worktree,
  PtyStatus,
  PendingTool,
  PRStatus,
  PendingWorktree,
  PendingDeletion,
  TerminalTab
} from './types'
import type { SnoozeEntry } from '../shared/state'
import type { AssignedPR } from '../shared/state/assigned-prs'
import type { ProjectSortMode } from '../shared/state/settings'
import { groupWorktrees, type GroupKey } from '../shared/worktree-sort'
import type { DisplayStatus } from './worktree-row-style'

/** THE single derivation of "what does the worktree list look like right now".
 *
 *  Both the desktop sidebar and the touch worktree picker render from this
 *  model, so a field that exists here can never be present on one platform
 *  and missing on the other — which is exactly how the two lists drifted
 *  apart before (mobile silently dropped phantom PRs, pendingTool,
 *  shellActive, isMerged and per-repo grouping).
 *
 *  Kept pure and React-free so the grouping/aggregation logic is unit
 *  testable without a renderer. `useWorktreeListModel` is the thin hook
 *  that feeds it from the store. */

/** Sentinel repoRoot for the single synthetic section used when the user has
 *  merged all repos into one list. */
export const UNIFIED_REPO_ROOT = '__unified__'

/** Highest Cmd+N switch ordinal the sidebar binds. */
const MAX_ORDINALS = 9

export interface WorktreeRowModel {
  worktree: Worktree
  path: string
  /** Worst pty status across every tab in this worktree. */
  status: PtyStatus
  /** `status`, except merged worktrees read as 'merged' for the status dot. */
  displayStatus: DisplayStatus
  /** The tool awaiting approval, when `status === 'needs-approval'`. */
  pendingTool: PendingTool | null
  /** True when any shell tab in this worktree is running something. */
  shellActive: boolean
  prStatus: PRStatus | null
  isMerged: boolean
  isSnoozed: boolean
  snoozeWakeAt?: number
  alias?: string
  /** Repo hint shown on the row. Only set in unified-repo mode, where two
   *  branches with the same name would otherwise be indistinguishable. */
  repoLabel?: string
  /** 1-based Cmd+1..9 switch position, or undefined when out of range. */
  cmdOrdinal?: number
  /** Deletion is in flight — render inert with a spinner. */
  deleting: boolean
}

export interface WorktreeListGroupModel {
  key: GroupKey
  label: string
  rows: WorktreeRowModel[]
  /** Review-requested PRs with no worktree yet. Only ever non-empty on the
   *  `reviewing` group. */
  phantomPRs: AssignedPR[]
  /** rows + phantoms — what the group header badge shows. */
  count: number
  collapsed: boolean
}

export interface WorktreeRepoSectionModel {
  repoRoot: string
  /** Collapse-state scope key. Equal to repoRoot (including the unified
   *  sentinel), so each repo remembers its own group collapse state. */
  scope: string
  repoName: string
  unified: boolean
  collapsed: boolean
  groups: WorktreeListGroupModel[]
  pending: PendingWorktree[]
  count: number
}

export interface WorktreeListModel {
  sections: WorktreeRepoSectionModel[]
  showRepoHeaders: boolean
  showRepoLabels: boolean
  /** Per-worktree-path aggregates, exposed so callers that need the raw maps
   *  (command center, command palette, hotkeys) share this derivation instead
   *  of recomputing their own. */
  statusByPath: Record<string, PtyStatus>
  pendingToolByPath: Record<string, PendingTool | null>
  shellActiveByPath: Record<string, boolean>
  snoozedPaths: Record<string, true>
  totalWorktrees: number
}

export interface WorktreeListModelInput {
  worktrees: Worktree[]
  repoRoots: string[]
  pendingWorktrees: PendingWorktree[]
  pendingDeletions: PendingDeletion[]
  /** Flattened tabs per worktree path (pane tree already walked). */
  tabsByWorktree: Record<string, TerminalTab[]>
  /** Keyed by terminal/tab id. */
  statuses: Record<string, PtyStatus>
  pendingTools: Record<string, PendingTool | null>
  shellActivity: Record<string, { active: boolean; processName?: string }>
  prStatuses: Record<string, PRStatus | null>
  mergedPaths: Record<string, boolean>
  snoozeByPath: Record<string, SnoozeEntry>
  aliases: Record<string, string>
  viewerLogin?: string | null
  assignedPRsByRepo?: Record<string, AssignedPR[]>
  unifiedRepos: boolean
  collapsedRepos: Record<string, boolean>
  isGroupCollapsed: (scope: string, key: GroupKey) => boolean
  /** Defaults to 'manual' — i.e. render `repoRoots` in the stored order. */
  projectSort?: ProjectSortMode
  /** Per-worktree-path human/agent recency, used by the two recency sorts.
   *  A repo's recency is the newest of its worktrees'. */
  lastHumanActive?: Record<string, number>
  lastAgentActive?: Record<string, number>
  /** Touch surfaces don't bind Cmd+N, so they skip ordinal assignment. */
  assignOrdinals?: boolean
}

/** Worst-status-wins aggregation across a worktree's tabs, plus the pending
 *  tool belonging to whichever tab is actually blocking on approval. */
function aggregate(
  tabs: TerminalTab[],
  statuses: Record<string, PtyStatus>,
  pendingTools: Record<string, PendingTool | null>
): { status: PtyStatus; pendingTool: PendingTool | null } {
  let status: PtyStatus = 'idle'
  for (const tab of tabs) {
    const s = statuses[tab.id]
    if (s === 'needs-approval') {
      return { status: 'needs-approval', pendingTool: pendingTools[tab.id] || null }
    }
    if (s === 'waiting') status = 'waiting'
    if (s === 'processing' && status === 'idle') status = 'processing'
  }
  return { status, pendingTool: null }
}

/** Reorder repo sections in place per the user's sort mode. 'manual' is the
 *  identity — `repoRoots` already carries the order the user dragged into.
 *  A repo with no activity for the chosen actor sorts to the bottom rather
 *  than the top, so untouched repos don't outrank ones you worked in
 *  yesterday. Ties (and the whole never-touched tail) break alphabetically
 *  so the order is stable instead of dependent on iteration order. */
function sortRepoBuckets(
  buckets: { repoRoot: string; worktrees: Worktree[] }[],
  mode: ProjectSortMode,
  recencyMaps: Partial<Record<ProjectSortMode, Record<string, number> | undefined>>
): void {
  if (mode === 'manual') return
  const byName = (a: { repoRoot: string }, b: { repoRoot: string }): number =>
    repoLabelFor(a.repoRoot).localeCompare(repoLabelFor(b.repoRoot), undefined, {
      sensitivity: 'base'
    })
  if (mode === 'alphabetical') {
    buckets.sort(byName)
    return
  }
  const byPath = recencyMaps[mode] ?? {}
  const recency = new Map<string, number>()
  for (const bucket of buckets) {
    let newest = 0
    for (const wt of bucket.worktrees) {
      const ts = byPath[wt.path]
      if (typeof ts === 'number' && ts > newest) newest = ts
    }
    recency.set(bucket.repoRoot, newest)
  }
  buckets.sort((a, b) => {
    const diff = (recency.get(b.repoRoot) ?? 0) - (recency.get(a.repoRoot) ?? 0)
    return diff !== 0 ? diff : byName(a, b)
  })
}

export function buildWorktreeListModel(input: WorktreeListModelInput): WorktreeListModel {
  const {
    worktrees,
    repoRoots,
    pendingWorktrees,
    pendingDeletions,
    tabsByWorktree,
    statuses,
    pendingTools,
    shellActivity,
    prStatuses,
    mergedPaths,
    snoozeByPath,
    aliases,
    viewerLogin,
    assignedPRsByRepo,
    unifiedRepos,
    collapsedRepos,
    isGroupCollapsed,
    projectSort = 'manual',
    lastHumanActive,
    lastAgentActive,
    assignOrdinals = true
  } = input

  const statusByPath: Record<string, PtyStatus> = {}
  const pendingToolByPath: Record<string, PendingTool | null> = {}
  const shellActiveByPath: Record<string, boolean> = {}
  for (const wt of worktrees) {
    const tabs = tabsByWorktree[wt.path] || []
    const { status, pendingTool } = aggregate(tabs, statuses, pendingTools)
    statusByPath[wt.path] = status
    pendingToolByPath[wt.path] = pendingTool
    shellActiveByPath[wt.path] = tabs.some(
      (tab) => tab.type === 'shell' && shellActivity[tab.id]?.active
    )
  }

  const snoozedPaths: Record<string, true> = {}
  for (const path of Object.keys(snoozeByPath)) snoozedPaths[path] = true

  const deletingPaths = new Set<string>()
  for (const d of pendingDeletions) deletingPaths.add(d.path)

  const unified = unifiedRepos && repoRoots.length > 1
  const showRepoHeaders = repoRoots.length > 1 && !unified
  const showRepoLabels = repoRoots.length > 1 && unified

  // Bucket worktrees by repo, preserving the user's repo order. Unified mode
  // short-circuits to one synthetic section holding every worktree (and every
  // repo's phantom PRs flattened together).
  const buckets: { repoRoot: string; worktrees: Worktree[]; assignedPRs: AssignedPR[] }[] = []
  if (unified) {
    buckets.push({
      repoRoot: UNIFIED_REPO_ROOT,
      worktrees,
      assignedPRs: assignedPRsByRepo ? Object.values(assignedPRsByRepo).flat() : []
    })
  } else {
    const map = new Map<string, Worktree[]>()
    for (const root of repoRoots) map.set(root, [])
    for (const wt of worktrees) {
      if (!map.has(wt.repoRoot)) map.set(wt.repoRoot, [])
      map.get(wt.repoRoot)!.push(wt)
    }
    for (const [repoRoot, wts] of map) {
      buckets.push({ repoRoot, worktrees: wts, assignedPRs: assignedPRsByRepo?.[repoRoot] ?? [] })
    }
    sortRepoBuckets(buckets, projectSort, {
      'recent-human': lastHumanActive,
      'recent-agent': lastAgentActive
    })
  }

  const sections: WorktreeRepoSectionModel[] = buckets.map((bucket) => {
    const groups = groupWorktrees(
      bucket.worktrees,
      prStatuses,
      mergedPaths,
      snoozedPaths,
      viewerLogin,
      bucket.assignedPRs
    ).map((group): WorktreeListGroupModel => {
      const rows = group.worktrees.map((wt): WorktreeRowModel => {
        const status = statusByPath[wt.path] ?? 'idle'
        const isMerged = group.key === 'merged'
        return {
          worktree: wt,
          path: wt.path,
          status,
          displayStatus: isMerged ? 'merged' : status,
          pendingTool: pendingToolByPath[wt.path] ?? null,
          shellActive: shellActiveByPath[wt.path] ?? false,
          prStatus: prStatuses[wt.path] ?? null,
          isMerged,
          isSnoozed: snoozedPaths[wt.path] === true,
          snoozeWakeAt: snoozeByPath[wt.path]?.wakeAt,
          alias: aliases[wt.path],
          repoLabel: showRepoLabels ? repoLabelFor(wt.repoRoot) : undefined,
          deleting: deletingPaths.has(wt.path)
        }
      })
      const phantomPRs = group.phantomPRs ?? []
      return {
        key: group.key,
        label: group.label,
        rows,
        phantomPRs,
        count: rows.length + phantomPRs.length,
        collapsed: isGroupCollapsed(bucket.repoRoot, group.key)
      }
    })

    return {
      repoRoot: bucket.repoRoot,
      scope: bucket.repoRoot,
      repoName: bucket.repoRoot === UNIFIED_REPO_ROOT ? 'All repos' : repoLabelFor(bucket.repoRoot),
      unified: bucket.repoRoot === UNIFIED_REPO_ROOT,
      collapsed: collapsedRepos[bucket.repoRoot] === true,
      groups,
      pending:
        bucket.repoRoot === UNIFIED_REPO_ROOT
          ? pendingWorktrees
          : pendingWorktrees.filter((p) => p.repoRoot === bucket.repoRoot),
      count: groups.reduce((n, g) => n + g.count, 0)
    }
  })

  // Cmd+1..9 ordinals follow visible display order — skipping collapsed
  // repos and groups — so the badge on a row matches the hotkey that
  // actually switches to it.
  if (assignOrdinals) {
    let n = 1
    outer: for (const section of sections) {
      if (section.collapsed) continue
      for (const group of section.groups) {
        if (group.collapsed) continue
        for (const row of group.rows) {
          if (n > MAX_ORDINALS) break outer
          row.cmdOrdinal = n
          n += 1
        }
      }
    }
  }

  return {
    sections,
    showRepoHeaders,
    showRepoLabels,
    statusByPath,
    pendingToolByPath,
    shellActiveByPath,
    snoozedPaths,
    totalWorktrees: worktrees.length
  }
}

export function repoLabelFor(repoRoot: string): string {
  return repoRoot.split('/').pop() || repoRoot
}
