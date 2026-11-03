// Merges every backend's worktree data into the single set of inputs
// `buildWorktreeListModel` already takes. Pure apart from the module-level
// caches, so the owner maps every routing decision depends on are
// testable without React.
//
// The alternative — build one model per backend and concatenate — looks
// tidier but doesn't work: WorktreeListModel carries four
// `Record<worktreePath, …>` maps beside its sections, and concatenating
// models would need those merged anyway. Merging the inputs once is the
// same work without the intermediate.
//
// Two costs are deliberately kept off the per-event path:
//
//   - Walking pane trees (`getLeaves` over every worktree) happens in a
//     per-backend SegmentedSelector keyed ONLY on that backend's `panes`.
//     A status or shell-activity flip — which lands on every hook
//     transition — must not re-walk a single pane tree. The first version
//     of this did exactly that: CLAUDE.md anti-pattern #1 inside a memo.
//   - The merge result is cached once at module level on its three
//     inputs. `useMergedWorktrees` is called from App AND from
//     `useWorktreeListModel`; without the shared cache each caller ran
//     its own identical merge per change.
//
// The collision this does NOT solve: two backends with the SAME absolute
// worktree path still overwrite each other in the path-keyed maps,
// because a path is only unique within a backend. Last-writer-wins, and
// it warns. Fixing it properly means keying every map by (backendId,
// path) — the deferred WorktreeRef work.

import type { AppState } from '../shared/state'
import { getLeaves } from '../shared/state/terminals'
import type { TerminalTab } from './types'
import type { Worktree } from '../shared/state/worktrees'
import type { FleetViewMode } from './fleet-view'
import { SegmentedSelector } from './backend-segments'

export interface BackendStateLike {
  backendId: string
  label: string
  kind: 'local' | 'remote'
  state: AppState
}

export interface MergedWorktree {
  backendId: string
  /** Connection label, for the origin badge on non-local rows. */
  backendLabel: string
  backendKind: 'local' | 'remote'
  worktree: Worktree
}

export interface MergedWorktreeData {
  /** Flat list across all backends, in registry order (local first). */
  worktrees: MergedWorktree[]
  /** Just the worktrees, for the inputs that want the raw array. */
  flatWorktrees: Worktree[]
  repoRoots: string[]
  pendingWorktrees: AppState['worktrees']['pending']
  pendingDeletions: NonNullable<AppState['worktrees']['pendingDeletions']>
  tabsByWorktree: Record<string, TerminalTab[]>
  statuses: AppState['terminals']['statuses']
  pendingTools: AppState['terminals']['pendingTools']
  shellActivity: AppState['terminals']['shellActivity']
  prStatuses: AppState['prs']['byPath']
  mergedPaths: AppState['prs']['mergedByPath']
  snoozeByPath: AppState['snooze']['byPath']
  pinnedPaths: AppState['pinned']['byPath']
  aliases: AppState['aliases']['byPath']
  assignedPRsByRepo: AppState['assignedPRs']['byRepo']
  /** Which backend owns each worktree path — what `BackendScope` needs
   *  when rendering a row's workspace. Last-writer-wins on a cross-host
   *  path collision; see the module header. */
  pathBackendId: Record<string, string>
  /** Which backend hosts each repo root. Keyed by absolute path, so two
   *  hosts' checkouts of one repo are distinct entries; the new-worktree
   *  screen offers one pill per entry, and creation routes on the picked
   *  root. */
  repoBackendId: Record<string, string>
  /** Normalized origin URL per repo root, merged across backends. The
   *  cross-host repo identity for section merging. */
  repoRemotes: Record<string, string | null>
  /** Display metadata per backend id, for labelling rows by origin. */
  backendMeta: Record<string, { label: string; kind: 'local' | 'remote' }>
  /** Which backend each pending-creation entry lives on, keyed by pending
   *  id. Creation can target a remote, so retry/dismiss must follow the
   *  entry rather than assuming the active backend owns it. */
  pendingBackendId: Record<string, string>
  /** Pane trees, merged. Keyed by worktree path like the slice itself. */
  panes: AppState['terminals']['panes']
}

/** Single-host view is the SAME pipeline restricted to the active
 *  backend — not a separate code path. Every owner map, routing decision
 *  and render loop downstream behaves identically in both modes; single
 *  mode just sees one backend's slice, which reproduces the pre-merge
 *  sidebar exactly. */
export function selectVisibleBackends<T extends { backendId: string }>(
  entries: readonly T[],
  viewMode: FleetViewMode,
  activeId: string
): readonly T[] {
  return viewMode === 'merged' ? entries : entries.filter((b) => b.backendId === activeId)
}

export function tabsFromPanes(panes: AppState['terminals']['panes']): Record<string, TerminalTab[]> {
  const out: Record<string, TerminalTab[]> = {}
  for (const [path, tree] of Object.entries(panes)) {
    out[path] = getLeaves(tree).flatMap((leaf) => leaf.tabs)
  }
  return out
}

export interface MergeOptions {
  viewMode: FleetViewMode
  activeId: string
  /** Per-backend flattened tabs. Injected so the pane-tree walk can be
   *  memoized on `panes` alone (see `getMergedWorktrees`) and so tests
   *  can supply it directly. */
  tabsFor: (backendId: string, state: AppState) => Record<string, TerminalTab[]>
  /** Where to report a cross-host path collision. Defaults to the
   *  console; injected so the behaviour is testable. */
  warn?: (message: string) => void
}

export function mergeBackendStates(
  entries: readonly BackendStateLike[],
  opts: MergeOptions
): MergedWorktreeData {
  const warn = opts.warn ?? ((m: string) => console.warn(m)) // eslint-disable-line no-console
  const merged: MergedWorktreeData = {
    worktrees: [],
    flatWorktrees: [],
    repoRoots: [],
    pendingWorktrees: [],
    pendingDeletions: [],
    tabsByWorktree: {},
    statuses: {},
    pendingTools: {},
    shellActivity: {},
    prStatuses: {},
    mergedPaths: {},
    snoozeByPath: {},
    pinnedPaths: {},
    aliases: {},
    assignedPRsByRepo: {},
    pathBackendId: {},
    repoBackendId: {},
    repoRemotes: {},
    backendMeta: {},
    pendingBackendId: {},
    panes: {}
  }

  for (const entry of selectVisibleBackends(entries, opts.viewMode, opts.activeId)) {
    const { backendId, label, kind, state } = entry

    for (const worktree of state.worktrees.list) {
      merged.worktrees.push({ backendId, backendLabel: label, backendKind: kind, worktree })
      merged.flatWorktrees.push(worktree)
      const prior = merged.pathBackendId[worktree.path]
      if (prior !== undefined && prior !== backendId) {
        warn(
          `[fleet] worktree path exists on two backends — routing is unreliable for it: ${worktree.path} (${prior} vs ${backendId})`
        )
      }
      merged.pathBackendId[worktree.path] = backendId
    }

    merged.backendMeta[backendId] = { label, kind }
    for (const root of state.worktrees.repoRoots) merged.repoBackendId[root] = backendId
    merged.repoRoots.push(...state.worktrees.repoRoots)
    Object.assign(merged.repoRemotes, state.worktrees.repoRemotes)
    for (const pending of state.worktrees.pending) merged.pendingBackendId[pending.id] = backendId
    merged.pendingWorktrees.push(...state.worktrees.pending)
    merged.pendingDeletions.push(...(state.worktrees.pendingDeletions ?? []))

    // Terminal-keyed maps are safe to merge flat: terminal ids embed a
    // timestamp and the worktree path, and each backend mints its own,
    // so cross-backend collision isn't a practical concern the way
    // identical worktree paths are.
    Object.assign(merged.statuses, state.terminals.statuses)
    Object.assign(merged.pendingTools, state.terminals.pendingTools)
    Object.assign(merged.shellActivity, state.terminals.shellActivity)
    Object.assign(merged.panes, state.terminals.panes)
    Object.assign(merged.tabsByWorktree, opts.tabsFor(backendId, state))

    Object.assign(merged.prStatuses, state.prs.byPath)
    Object.assign(merged.mergedPaths, state.prs.mergedByPath)
    Object.assign(merged.snoozeByPath, state.snooze.byPath)
    Object.assign(merged.pinnedPaths, state.pinned.byPath)
    Object.assign(merged.aliases, state.aliases.byPath)
    Object.assign(merged.assignedPRsByRepo, state.assignedPRs.byRepo)
  }

  return merged
}

/** Per-backend flattened tabs, recomputed only when THAT backend's pane
 *  trees change. Keyed on `panes` alone, so the stream of status events
 *  never touches a pane tree. */
const tabsSelector = new SegmentedSelector<AppState, Record<string, TerminalTab[]>>(
  (state) => [state.terminals.panes],
  (state) => tabsFromPanes(state.terminals.panes)
)

interface MergeCache {
  entries: readonly BackendStateLike[]
  activeId: string
  result: MergedWorktreeData
}

/** One entry per view mode. App reads the visible view for the sidebar and
 *  the full fleet for what stays mounted, both on every render; a single
 *  shared slot would evict one with the other each time and hand back a
 *  new object per read, which useSyncExternalStore treats as a change. */
const caches: Record<FleetViewMode, MergeCache | null> = { single: null, merged: null }

/** The shared, reference-stable merge. Same three inputs → same object,
 *  across every caller — so App and useWorktreeListModel pay for one
 *  merge per change between them rather than one each. */
export function getMergedWorktrees(
  entries: readonly BackendStateLike[],
  viewMode: FleetViewMode,
  activeId: string
): MergedWorktreeData {
  const cache = caches[viewMode]
  if (cache && cache.entries === entries && cache.activeId === activeId) {
    return cache.result
  }
  // All entries, not just the visible ones, so flipping view mode never
  // evicts a backend's cached tab walk.
  const segments = tabsSelector.select(entries.map((e) => ({ id: e.backendId, state: e.state })))
  const tabsById = new Map(segments.map((s) => [s.backendId, s.value]))
  const fresh = mergeBackendStates(entries, {
    viewMode,
    activeId,
    tabsFor: (backendId) => tabsById.get(backendId) ?? {}
  })
  const result = cache ? reuseUnchanged(cache.result, fresh) : fresh
  caches[viewMode] = { entries, activeId, result }
  return result
}

/** The cache key above is each backend's whole AppState, which is a new
 *  object after every event on that backend — a streamed token included.
 *  So the merge reruns constantly, and before this every output was a new
 *  array or map each time even when its contents were identical. Anything
 *  keyed on one of them re-fired per event: the Cleanup modal's dirty sweep
 *  re-queued a `git status` for every worktree on every token, which buried
 *  a remote host under thousands of queued reads and stalled tab switching
 *  behind them. Each field keeps its previous reference unless its contents
 *  actually changed, and the whole result does too when no field did. */
function reuseUnchanged(prev: MergedWorktreeData, next: MergedWorktreeData): MergedWorktreeData {
  let changed = false
  const out = {} as Record<keyof MergedWorktreeData, unknown>
  for (const key of Object.keys(next) as (keyof MergedWorktreeData)[]) {
    if (sameContents(prev[key], next[key])) {
      out[key] = prev[key]
    } else {
      out[key] = next[key]
      changed = true
    }
  }
  return changed ? (out as unknown as MergedWorktreeData) : prev
}

function sameContents(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!sameEntry(a[i], b[i])) return false
    return true
  }
  if (!isRecord(a) || !isRecord(b)) return false
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  for (const k of aKeys) {
    if (!(k in b) || !sameEntry(a[k], b[k])) return false
  }
  return true
}

/** One level deeper than reference equality, for the small wrappers the
 *  merge allocates per element (`MergedWorktree`, `backendMeta` values).
 *  Their fields are slice values the reducers already keep stable. */
function sameEntry(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (!isRecord(a) || !isRecord(b) || Array.isArray(a) || Array.isArray(b)) return false
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  for (const k of aKeys) if (a[k] !== b[k]) return false
  return true
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** Test-only: forget the shared cache between cases. */
export function resetMergedWorktreesCache(): void {
  caches.single = null
  caches.merged = null
}

const worktreeListsSelector = new SegmentedSelector<AppState, Worktree[]>(
  (state) => [state.worktrees.list],
  (state) => state.worktrees.list
)

/** Each backend's worktree list, visible or not. Same array back until
 *  some backend's list actually changes, so App can watch the fleet for
 *  deletions without re-rendering on every other event. */
export function getFleetWorktreeLists(
  entries: readonly BackendStateLike[]
): readonly { backendId: string; value: Worktree[] }[] {
  return worktreeListsSelector.select(entries.map((e) => ({ id: e.backendId, state: e.state })))
}
