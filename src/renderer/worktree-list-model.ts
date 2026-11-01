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
  isPinned: boolean
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

/** One checkout contributing to a section. Sections usually have exactly
 *  one; a section merged across hosts (same repo open on several backends
 *  in fleet view) carries one entry per host. */
export interface SectionRepoRoot {
  /** null when the caller supplied no backend info (single-backend
   *  callers, older tests) — treated as "unknown, don't merge". */
  backendId: string | null
  repoRoot: string
}

export interface WorktreeRepoSectionModel {
  /** Primary checkout — the local backend's root when the section spans
   *  hosts, else the only root. Kept as a plain string because most
   *  consumers (new-worktree default, editor open) want one sensible
   *  path, not the full list. */
  repoRoot: string
  /** Every checkout in this section. Length > 1 only for a section merged
   *  across hosts; operations that act on "the repo" (remove) must act on
   *  each entry via its own backend. */
  repoRoots: SectionRepoRoot[]
  /** Collapse-state scope key. The repoRoot for ordinary sections, the
   *  shared repo key for merged ones — so a merged section keeps one
   *  collapse state no matter which host's root came first. */
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
  /** Which backend hosts each repo root. When present, roots on DIFFERENT
   *  backends sharing a repo key merge into one section (fleet view's
   *  "same repo, one section"). Roots on the same backend never merge —
   *  two local checkouts named `api` are different repos. Absent → no
   *  merging, exactly the historical behavior. */
  repoBackendId?: Record<string, string>
  /** Normalized origin URL per repo root (null = no usable origin). The
   *  cross-host identity: roots whose remotes match are one repo. Roots
   *  with no remote fall back to folder name. */
  repoRemotes?: Record<string, string | null>
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
  pinnedPaths: Record<string, true>
  aliases: Record<string, string>
  viewerLogin?: string | null
  assignedPRsByRepo?: Record<string, AssignedPR[]>
  unifiedRepos: boolean
  collapsedRepos: Record<string, boolean>
  isGroupCollapsed: (scope: string, key: GroupKey) => boolean
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

export function buildWorktreeListModel(input: WorktreeListModelInput): WorktreeListModel {
  const {
    worktrees,
    repoRoots,
    repoBackendId,
    repoRemotes,
    pendingWorktrees,
    pendingDeletions,
    tabsByWorktree,
    statuses,
    pendingTools,
    shellActivity,
    prStatuses,
    mergedPaths,
    snoozeByPath,
    pinnedPaths,
    aliases,
    viewerLogin,
    assignedPRsByRepo,
    unifiedRepos,
    collapsedRepos,
    isGroupCollapsed,
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
  interface Bucket {
    repoRoot: string
    repoRoots: SectionRepoRoot[]
    scope: string
    worktrees: Worktree[]
    assignedPRs: AssignedPR[]
  }
  const buckets: Bucket[] = []
  if (unified) {
    buckets.push({
      repoRoot: UNIFIED_REPO_ROOT,
      repoRoots: [],
      scope: UNIFIED_REPO_ROOT,
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
    // Combine roots that are the same repo on different hosts. Merge rule:
    // every root in a key-group must sit on a DISTINCT, KNOWN backend —
    // one host holding two checkouts with the same folder name is two
    // repos (and callers with no backend info get no merging at all, so
    // single-backend behavior is untouched). The key-group walk preserves
    // the user's repo order via first appearance.
    const keyGroups = new Map<string, string[]>()
    for (const root of map.keys()) {
      const key = repoKeyFor(root, repoRemotes?.[root])
      const group = keyGroups.get(key)
      if (group) group.push(root)
      else keyGroups.set(key, [root])
    }
    for (const [key, roots] of keyGroups) {
      const owners = roots.map((root) => repoBackendId?.[root] ?? null)
      const allKnown = owners.every((o) => o !== null)
      const allDistinct = new Set(owners).size === owners.length
      if (roots.length > 1 && allKnown && allDistinct) {
        // The local backend's checkout is the primary: it's the cheapest
        // default for anything that needs "one path" (new-worktree
        // preselect, open-in-editor on the header).
        const localIdx = owners.indexOf('local')
        const primary = localIdx >= 0 ? roots[localIdx] : roots[0]
        buckets.push({
          repoRoot: primary,
          repoRoots: roots.map((root, i) => ({ backendId: owners[i], repoRoot: root })),
          scope: `repo:${key}`,
          worktrees: roots.flatMap((root) => map.get(root) ?? []),
          assignedPRs: roots.flatMap((root) => assignedPRsByRepo?.[root] ?? [])
        })
      } else {
        for (let i = 0; i < roots.length; i++) {
          buckets.push({
            repoRoot: roots[i],
            repoRoots: [{ backendId: owners[i], repoRoot: roots[i] }],
            scope: roots[i],
            worktrees: map.get(roots[i]) ?? [],
            assignedPRs: assignedPRsByRepo?.[roots[i]] ?? []
          })
        }
      }
    }
  }

  const sections: WorktreeRepoSectionModel[] = buckets.map((bucket) => {
    const groups = groupWorktrees(
      bucket.worktrees,
      prStatuses,
      mergedPaths,
      snoozedPaths,
      viewerLogin,
      bucket.assignedPRs,
      pinnedPaths
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
          isPinned: pinnedPaths[wt.path] === true,
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
        collapsed: isGroupCollapsed(bucket.scope, group.key)
      }
    })

    const memberRoots = new Set(bucket.repoRoots.map((r) => r.repoRoot))
    return {
      repoRoot: bucket.repoRoot,
      repoRoots: bucket.repoRoots,
      scope: bucket.scope,
      repoName: bucket.repoRoot === UNIFIED_REPO_ROOT ? 'All repos' : repoLabelFor(bucket.repoRoot),
      unified: bucket.repoRoot === UNIFIED_REPO_ROOT,
      collapsed: collapsedRepos[bucket.scope] === true,
      groups,
      pending:
        bucket.repoRoot === UNIFIED_REPO_ROOT
          ? pendingWorktrees
          : pendingWorktrees.filter((p) => memberRoots.has(p.repoRoot)),
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

/** The identity used to decide that checkouts on different hosts are the
 *  same repo.
 *
 *  Primary: the normalized `origin` URL (shared/git-remote.ts), so
 *  `git@github.com:org/repo.git` on one host and
 *  `https://github.com/org/repo` on another are one repo, while two
 *  unrelated repos that both happen to be called `api` are not. A fork and
 *  its upstream have different owners and therefore stay separate — that
 *  was the trade-off: folder-name matching merged them, but also merged
 *  anything sharing a generic name, and a wrong merge can detach the
 *  wrong repo, which is the worse error.
 *
 *  Fallback: folder name, case-normalized, only when a root has no usable
 *  origin. The two namespaces are prefixed so a remote-less `api` can't
 *  accidentally match a remote-bearing one.
 *
 *  Refinements (manual pin/split, extra remotes) belong HERE and nowhere
 *  else. */
export function repoKeyFor(repoRoot: string, remote?: string | null): string {
  if (remote) return `remote:${remote}`
  return `folder:${(repoRoot.split('/').pop() || repoRoot).toLowerCase()}`
}
