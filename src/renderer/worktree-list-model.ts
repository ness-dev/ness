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
import { ATTENTION_STATUS_RANK, ROLLUP_STATUS_RANK } from '../shared/status-rollup'
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
  /** Rolled-up pty status across every tab in this worktree (see `aggregate`). */
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
  /** Set only on a repo's main worktree. The sidebar renders it as the
   *  project row itself: clicking the project opens its main workspace,
   *  where work gets planned and spun off into worktrees. */
  home?: ProjectHomeModel
}

export interface ProjectHomeModel {
  /** Show the branch on the project row. Only when main isn't sitting on a
   *  base branch — "main" on the main checkout says nothing. */
  showBranch: boolean
}

/** Archive groups folded into one collapsed line at the bottom of a section. */
const TAIL_KEYS: readonly GroupKey[] = ['snoozed', 'merged']

/** Branches that read as "the repo's base" without any PR to tell us so. */
const COMMON_BASE_BRANCHES = ['main', 'master', 'develop', 'trunk']

/** Merged + Snoozed, rendered as a single fold so archives don't compete
 *  with live work for attention. */
export interface WorktreeTailModel {
  groups: WorktreeListGroupModel[]
  count: number
  /** True only when every tail group is collapsed; expanding the fold
   *  shows all of them. */
  collapsed: boolean
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
  /** Pinned-open / group-collapse scope key. The repoRoot for ordinary sections, the
   *  shared repo key for merged ones — so a merged section keeps one
   *  collapse state no matter which host's root came first. */
  scope: string
  repoName: string
  unified: boolean
  /** Only the project row shows. True when the project neither holds the
   *  active worktree nor is pinned open. */
  collapsed: boolean
  /** The user pinned this project open so it stays expanded anywhere. */
  pinnedOpen: boolean
  /** Holds the active worktree (or pending creation). */
  holdsActive: boolean
  /** Most urgent status across the project's live worktrees, main
   *  included (merged and snoozed ones left out). A collapsed project's row
   *  shows this so an agent waiting on you elsewhere still surfaces.
   *  Selection-independent, so it lives in the base build. */
  worstStatus: PtyStatus
  /** Every worktree grouped by status, main included. Whole-list
   *  consumers (hotkey navigation) read this; the sidebar renders the
   *  homes / workGroups / tail split below instead. */
  groups: WorktreeListGroupModel[]
  /** Main worktrees, pulled out of the groups. One per repo, primary host
   *  first; several in unified mode, where every project's row stacks at
   *  the top. */
  homes: WorktreeRowModel[]
  /** `groups` minus the homes and the tail, empty groups dropped. */
  workGroups: WorktreeListGroupModel[]
  tail: WorktreeTailModel | null
  pending: PendingWorktree[]
  count: number
}

export interface WorktreeListModel {
  sections: WorktreeRepoSectionModel[]
  showRepoLabels: boolean
  /** Per-worktree-path aggregates, exposed so callers that need the raw maps
   *  (command palette, hotkeys) share this derivation instead
   *  of recomputing their own. */
  statusByPath: Record<string, PtyStatus>
  pendingToolByPath: Record<string, PendingTool | null>
  shellActiveByPath: Record<string, boolean>
  snoozedPaths: Record<string, true>
  totalWorktrees: number
  /** Every worktree path in sidebar display order (homes first), collapsed
   *  or not — prev/next navigation walks this. */
  orderedPaths: string[]
  /** The paths Cmd+1..9 indexes, in order. Deliberately independent of the
   *  project accordion: it skips collapsed status groups and the folded
   *  tail, but counts a collapsed project's work as if it were open, so the
   *  numbers don't shift every time you cross projects. Jumping into a
   *  collapsed project opens it. */
  numberedPaths: string[]
  /** repoRoot of the active worktree, or null. Set by the accordion pass;
   *  lets unified mode mark the project row you're working under. */
  activeRepoRoot: string | null
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
  /** Project scopes kept expanded regardless of where you are. */
  pinnedOpenRepos: Record<string, boolean>
  /** The selected worktree (or pending creation). Its project expands; the
   *  others collapse to their project row unless pinned open. Absent →
   *  nothing collapses. Applied by `applyProjectAccordion`, a separate
   *  cheap pass, so switching worktrees doesn't rebuild every row. */
  activeWorktreeId?: string | null
  isGroupCollapsed: (scope: string, key: GroupKey) => boolean
  /** Touch surfaces don't bind Cmd+N, so they skip ordinal assignment. */
  assignOrdinals?: boolean
  /** The user's dragged project order, as section scope keys
   *  (`settings.sidebarProjectOrder`). See `applyProjectOrder`. */
  projectOrder?: readonly string[]
}

/** Rolls a worktree's tabs up by `ROLLUP_STATUS_RANK`, plus the pending tool
 *  belonging to whichever tab is actually blocking on approval. A processing
 *  tab masks a waiting one, so a busy reviewer beside a waiting chat shows
 *  green, not yellow. */
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
    if (s && ROLLUP_STATUS_RANK[s] > ROLLUP_STATUS_RANK[status]) status = s
  }
  return { status, pendingTool: null }
}

/** Full model in one call — the base build plus the accordion pass. The
 *  renderer memoises the two halves separately (see useWorktreeListModel);
 *  this composition is for tests and one-shot callers. */
export function buildWorktreeListModel(input: WorktreeListModelInput): WorktreeListModel {
  return applyProjectAccordion(
    buildWorktreeListBase(input),
    input.activeWorktreeId ?? null,
    input.pinnedOpenRepos
  )
}

/** Everything that doesn't depend on which worktree is selected: grouping,
 *  rows, ordinals. Row objects are allocated here, so this must not re-run
 *  on a plain worktree switch — WorktreeTab memoises on row identity. */
export function buildWorktreeListBase(
  input: Omit<WorktreeListModelInput, 'activeWorktreeId' | 'pinnedOpenRepos'>
): WorktreeListModel {
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
    isGroupCollapsed,
    assignOrdinals = true,
    projectOrder = EMPTY_ORDER
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

  const orderedBuckets = applyProjectOrder(buckets, projectOrder)

  // Per repo: a PR into `release` in one repo says nothing about another.
  const repoOfPath = new Map(worktrees.map((w) => [w.path, w.repoRoot]))
  const baseBranchesByRepo = new Map<string, Set<string>>()
  for (const [path, pr] of Object.entries(prStatuses)) {
    const repo = repoOfPath.get(path)
    if (!pr?.baseBranch || repo === undefined) continue
    let set = baseBranchesByRepo.get(repo)
    if (!set) baseBranchesByRepo.set(repo, (set = new Set()))
    set.add(pr.baseBranch)
  }
  const isBaseBranch = (repoRoot: string, branch: string): boolean =>
    COMMON_BASE_BRANCHES.includes(branch) || (baseBranchesByRepo.get(repoRoot)?.has(branch) ?? false)

  const sections: WorktreeRepoSectionModel[] = orderedBuckets.map((bucket) => {
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

    const homes: WorktreeRowModel[] = []
    const workGroups: WorktreeListGroupModel[] = []
    const tailGroups: WorktreeListGroupModel[] = []
    for (const group of groups) {
      const isTail = TAIL_KEYS.includes(group.key)
      const rest: WorktreeRowModel[] = []
      for (const row of group.rows) {
        if (row.worktree.isMain) {
          homes.push(row)
          continue
        }
        rest.push(row)
      }
      const split =
        rest.length === group.rows.length
          ? group
          : { ...group, rows: rest, count: rest.length + group.phantomPRs.length }
      if (split.count === 0) continue
      ;(isTail ? tailGroups : workGroups).push(split)
    }
    // Unified mode's single bucket collects mains in group order; restore the
    // user's repo order so the stacked project rows don't reshuffle on status
    // changes. A dragged order wins over the repoRoots order. Each root is
    // ranked as it would be in split mode: by the merged `repo:<key>` scope
    // when one was saved, else by the root itself.
    const repoOrder = new Map(
      applyProjectOrder(
        repoRoots.map((root) => ({
          scope: `repo:${repoKeyFor(root, repoRemotes?.[root])}`,
          repoRoots: [{ repoRoot: root }]
        })),
        projectOrder
      ).map((b, i) => [b.repoRoots[0].repoRoot, i])
    )
    homes.sort(
      (a, b) =>
        (repoOrder.get(a.worktree.repoRoot) ?? Infinity) - (repoOrder.get(b.worktree.repoRoot) ?? Infinity)
    )
    // A section spanning hosts has one main per host. The section's own
    // root (the local checkout's, when there is one) is the project row, so
    // it goes first; the rest render as ordinary rows beneath it.
    if (bucket.repoRoot !== UNIFIED_REPO_ROOT) {
      const primaryIdx = homes.findIndex((h) => h.worktree.repoRoot === bucket.repoRoot)
      if (primaryIdx > 0) homes.unshift(...homes.splice(primaryIdx, 1))
    }
    for (const row of homes) {
      row.home = { showBranch: !isBaseBranch(row.worktree.repoRoot, row.worktree.branch) }
    }
    const tail: WorktreeTailModel | null =
      tailGroups.length === 0
        ? null
        : {
            groups: tailGroups,
            count: tailGroups.reduce((n, g) => n + g.count, 0),
            collapsed: tailGroups.every((g) => g.collapsed)
          }

    const memberRoots = new Set(bucket.repoRoots.map((r) => r.repoRoot))
    const sectionPending =
      bucket.repoRoot === UNIFIED_REPO_ROOT
        ? pendingWorktrees
        : pendingWorktrees.filter((p) => memberRoots.has(p.repoRoot))
    return {
      repoRoot: bucket.repoRoot,
      repoRoots: bucket.repoRoots,
      scope: bucket.scope,
      repoName: bucket.repoRoot === UNIFIED_REPO_ROOT ? 'All repos' : repoLabelFor(bucket.repoRoot),
      unified: bucket.repoRoot === UNIFIED_REPO_ROOT,
      // Filled in by applyProjectAccordion.
      collapsed: false,
      pinnedOpen: false,
      holdsActive: false,
      worstStatus: worstOf([...homes, ...workGroups.flatMap((g) => g.rows)]),
      groups,
      homes,
      workGroups,
      tail,
      pending: sectionPending,
      count: groups.reduce((n, g) => n + g.count, 0)
    }
  })

  // Sidebar display order: project homes, then live work, then the tail
  // fold. Cmd+1..9 numbers rows in that order, skipping collapsed status
  // groups and the folded tail — but NOT a collapsed project: the
  // accordion follows the selection, and numbering that followed it too
  // would reshuffle on every project switch. The hotkey handlers read these
  // lists rather than re-deriving the order.
  const orderedPaths: string[] = []
  const numberedRows: WorktreeRowModel[] = []
  for (const section of sections) {
    for (const row of section.homes) {
      orderedPaths.push(row.path)
      numberedRows.push(row)
    }
    for (const group of section.workGroups) {
      for (const row of group.rows) {
        orderedPaths.push(row.path)
        if (!group.collapsed) numberedRows.push(row)
      }
    }
    for (const group of section.tail?.groups ?? []) {
      for (const row of group.rows) {
        orderedPaths.push(row.path)
        if (!section.tail!.collapsed) numberedRows.push(row)
      }
    }
  }
  if (assignOrdinals) {
    numberedRows.slice(0, MAX_ORDINALS).forEach((row, i) => {
      row.cmdOrdinal = i + 1
    })
  }

  return {
    sections,
    showRepoLabels,
    statusByPath,
    pendingToolByPath,
    shellActiveByPath,
    snoozedPaths,
    totalWorktrees: worktrees.length,
    orderedPaths,
    numberedPaths: numberedRows.map((row) => row.path),
    activeRepoRoot: null
  }
}

const EMPTY_ORDER: readonly string[] = []

/** Sorts sections by the user's dragged order. A section is placed by its
 *  scope, or failing that by the earliest of its member roots — so a
 *  project that becomes a cross-host merged section (scope `repo:<key>`)
 *  keeps the slot it had as a plain root. Sections the order doesn't
 *  mention (a repo added since the last drag, a backend not shown at the
 *  time) keep their default relative order after every placed one, which
 *  is where a newly added repo lands anyway. Stale keys are ignored. Stable,
 *  and returns the input array when there's nothing to apply. */
export function applyProjectOrder<T extends { scope: string; repoRoots: readonly { repoRoot: string }[] }>(
  sections: readonly T[],
  order: readonly string[]
): T[] {
  if (order.length === 0 || sections.length < 2) return sections as T[]
  const rank = new Map<string, number>()
  order.forEach((key, i) => {
    if (!rank.has(key)) rank.set(key, i)
  })
  const rankOf = (section: T): number => {
    const own = rank.get(section.scope)
    if (own !== undefined) return own
    let best = Infinity
    for (const r of section.repoRoots) best = Math.min(best, rank.get(r.repoRoot) ?? Infinity)
    return best
  }
  return sections
    .map((section, i) => ({ section, i, r: rankOf(section) }))
    .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r - b.r))
    .map((x) => x.section)
}

/** Where a drop lands: `order` is every section's scope after inserting
 *  `active` before `before` (null = at the end). `line` marks the gap to
 *  draw — on top of `before`, or under the last other section when
 *  dropping at the end — and is null when the drop would change nothing. */
export function planProjectDrop(
  scopes: readonly string[],
  active: string,
  before: string | null
): { order: string[]; line: { scope: string; edge: 'before' | 'after' } | null } {
  const rest = scopes.filter((k) => k !== active)
  const at = before === null ? rest.length : rest.indexOf(before)
  const order = [...rest]
  order.splice(at < 0 ? rest.length : at, 0, active)
  const unchanged = order.every((k, i) => k === scopes[i])
  if (unchanged || rest.length === 0) return { order, line: null }
  return {
    order,
    line: before === null ? { scope: rest[rest.length - 1], edge: 'after' } : { scope: before, edge: 'before' }
  }
}

/** The stored order after the user drags `nextVisible` (every visible
 *  section's scope, top to bottom) into place. Keys for sections not on
 *  screen — another backend's repos outside fleet view — keep their slots,
 *  so reordering one backend's projects doesn't scramble where another's
 *  sit when the views are merged again. */
export function mergeProjectOrder(stored: readonly string[], nextVisible: readonly string[]): string[] {
  const visible = new Set(nextVisible)
  const out: string[] = []
  let i = 0
  for (const key of stored) {
    if (!visible.has(key)) out.push(key)
    else if (i < nextVisible.length) out.push(nextVisible[i++])
  }
  while (i < nextVisible.length) out.push(nextVisible[i++])
  return [...new Set(out)]
}

/** True for a project's main row while the active worktree is anywhere in
 *  that project. Checked per home rather than via the section's
 *  `holdsActive`, which spans every host merged into the section: selecting
 *  a worktree on one host must expand that host's main, not the header's. */
export function homeHoldsActive(model: WorktreeListModel, row: WorktreeRowModel): boolean {
  return !!row.home && model.activeRepoRoot !== null && row.worktree.repoRoot === model.activeRepoRoot
}

/** True for a project's main row whose chats should stay listed under
 *  'selected' tabs expansion: the main of the project you're in, plus every
 *  main of a pinned-open project. Pinning keeps the project expanded, and an
 *  expanded project's header shows its chats.
 *
 *  Unlike `homeHoldsActive`, the pinned case is per section, not per host:
 *  pinning a project merged across hosts lists every host's main, while
 *  being in it without a pin lists only the host you're on. */
export function homeShowsTabs(model: WorktreeListModel, row: WorktreeRowModel): boolean {
  if (!row.home) return false
  if (homeHoldsActive(model, row)) return true
  return model.sections.some((s) => !s.unified && s.pinnedOpen && s.homes.includes(row))
}

/** The project accordion: the project holding the active worktree is open,
 *  others collapse to their row unless pinned open. Cheap and
 *  allocation-light: rows are never copied, so they keep their identity
 *  and a worktree switch only re-renders what moved. Sections are compared
 *  against the base (where nothing is collapsed), so a collapsed section is
 *  a fresh shallow copy each pass — cheap, and the rows inside are shared.
 *
 *  When no project holds the active id (it was just deleted, or belongs to
 *  a backend whose list hasn't loaded) nothing collapses, same as having no
 *  selection — the sidebar shouldn't snap shut on a transient state. */
export function applyProjectAccordion(
  base: WorktreeListModel,
  activeWorktreeId: string | null,
  pinnedOpenRepos: Record<string, boolean>
): WorktreeListModel {
  let activeRepoRoot: string | null = null
  const holds = base.sections.map((section) => {
    if (!activeWorktreeId) return false
    for (const group of section.groups) {
      const row = group.rows.find((r) => r.path === activeWorktreeId)
      if (row) {
        activeRepoRoot = row.worktree.repoRoot
        return true
      }
    }
    const pending = section.pending.find((p) => p.id === activeWorktreeId)
    if (pending) activeRepoRoot = pending.repoRoot
    return !!pending
  })
  const anyHolds = holds.some(Boolean)
  let changed = false
  const sections = base.sections.map((section, i) => {
    const pinnedOpen = pinnedOpenRepos[section.scope] === true
    const holdsActive = holds[i]
    const collapsed = !section.unified && anyHolds && !holdsActive && !pinnedOpen
    if (
      section.collapsed === collapsed &&
      section.pinnedOpen === pinnedOpen &&
      section.holdsActive === holdsActive
    ) {
      return section
    }
    changed = true
    return { ...section, collapsed, pinnedOpen, holdsActive }
  })
  if (!changed && base.activeRepoRoot === activeRepoRoot) return base
  return { ...base, sections, activeRepoRoot }
}

/** Project-level rollup over per-worktree statuses, by attention — see
 *  ATTENTION_STATUS_RANK for why it differs from the per-worktree order. */
function worstOf(rows: WorktreeRowModel[]): PtyStatus {
  let worst: PtyStatus = 'idle'
  for (const row of rows) if (ATTENTION_STATUS_RANK[row.status] > ATTENTION_STATUS_RANK[worst]) worst = row.status
  return worst
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
 *  Three states, deliberately distinct:
 *    - a string: resolved, has an origin → `remote:` key.
 *    - null: resolved, no usable origin → `folder:` fallback, so two
 *      origin-less checkouts can still pair up by name.
 *    - undefined: NOT resolved → a key unique to this root, so it merges
 *      with nothing. Remotes resolve asynchronously after the repo list,
 *      and an older harness-server never sends them at all; treating
 *      either as "no origin" would briefly (or permanently) merge
 *      unrelated same-named repos and bounce sections — and collapse
 *      state — around on first paint. Not merging is the safe direction.
 *
 *  Namespaces are prefixed so a remote-less `api` can't accidentally
 *  match a remote-bearing one. Refinements (manual pin/split, extra
 *  remotes) belong HERE and nowhere else. */
export function repoKeyFor(repoRoot: string, remote: string | null | undefined): string {
  if (remote === undefined) return `path:${repoRoot}`
  if (remote) return `remote:${remote}`
  return `folder:${(repoRoot.split('/').pop() || repoRoot).toLowerCase()}`
}
