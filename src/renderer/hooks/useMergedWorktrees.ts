// Merges every backend's worktree data into the single set of inputs
// `buildWorktreeListModel` already takes.
//
// The alternative — build one model per backend and concatenate — looks
// tidier but doesn't work: WorktreeListModel carries four
// `Record<worktreePath, …>` maps (statusByPath, pendingToolByPath,
// shellActiveByPath, snoozedPaths) alongside its sections, and
// concatenating models would need those merged anyway. Merging the inputs
// once is the same work without the intermediate.
//
// Sections fall out for free: the model groups by repoRoot, and two
// backends are two different machines with their own repo paths, so each
// backend's repos become their own sections without any grouping change.
//
// The collision this does NOT solve: two backends with the SAME absolute
// worktree path (same repo checked out at the same path on both machines)
// still overwrite each other in these maps, because a path is only unique
// within a backend. `pathBackendId` below records last-writer-wins so the
// rest of the UI at least routes consistently. Fixing it properly means
// keying every map by (backendId, path), which is the deferred
// WorktreeRef work — see the step-1 commit message.

import { useMemo } from 'react'
import { useActiveBackend, useAllBackendStates, type BackendStateEntry } from '../store'
import { useFleetViewMode } from '../fleet-view'
import { getLeaves } from '../../shared/state/terminals'
import type { TerminalTab } from '../types'
import type { Worktree } from '../../shared/state/worktrees'

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
  pendingWorktrees: BackendStateEntry['state']['worktrees']['pending']
  pendingDeletions: NonNullable<BackendStateEntry['state']['worktrees']['pendingDeletions']>
  tabsByWorktree: Record<string, TerminalTab[]>
  statuses: BackendStateEntry['state']['terminals']['statuses']
  pendingTools: BackendStateEntry['state']['terminals']['pendingTools']
  shellActivity: BackendStateEntry['state']['terminals']['shellActivity']
  prStatuses: BackendStateEntry['state']['prs']['byPath']
  mergedPaths: BackendStateEntry['state']['prs']['mergedByPath']
  snoozeByPath: BackendStateEntry['state']['snooze']['byPath']
  pinnedPaths: BackendStateEntry['state']['pinned']['byPath']
  aliases: BackendStateEntry['state']['aliases']['byPath']
  assignedPRsByRepo: BackendStateEntry['state']['assignedPRs']['byRepo']
  /** Which backend owns each worktree path — what `BackendScope` needs
   *  when rendering a row's workspace. */
  pathBackendId: Record<string, string>
  /** Which backend owns each repo root. Worktree creation targets a repo,
   *  and a repo lives on exactly one backend, so the repo choice is what
   *  decides where a new worktree is created. */
  repoBackendId: Record<string, string>
  /** Display metadata per backend id, for labelling rows by origin. */
  backendMeta: Record<string, { label: string; kind: 'local' | 'remote' }>
  /** Which backend each pending-creation entry lives on, keyed by pending
   *  id. Creation can now target a remote, so retry/dismiss must follow the
   *  entry rather than assuming the active backend owns it. */
  pendingBackendId: Record<string, string>
  /** Pane trees, merged. Keyed by worktree path like the slice itself. */
  panes: BackendStateEntry['state']['terminals']['panes']
}

export function useMergedWorktrees(): MergedWorktreeData {
  const allBackends = useAllBackendStates()
  const viewMode = useFleetViewMode()
  const activeId = useActiveBackend().id
  // Single-host view is the SAME pipeline restricted to the active
  // backend — not a separate code path. That's what makes the view
  // toggle cheap to trust: every owner map, routing decision and render
  // loop downstream behaves identically in both modes, single mode just
  // sees one backend's slice of it, which reproduces the pre-merge
  // sidebar exactly.
  const backends = useMemo(
    () =>
      viewMode === 'merged'
        ? allBackends
        : allBackends.filter((b) => b.backendId === activeId),
    [allBackends, viewMode, activeId]
  )
  return useMemo(() => {
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
      backendMeta: {},
      pendingBackendId: {},
      panes: {}
    }

    for (const entry of backends) {
      const { backendId, label, kind, state } = entry

      for (const worktree of state.worktrees.list) {
        merged.worktrees.push({
          backendId,
          backendLabel: label,
          backendKind: kind,
          worktree
        })
        merged.flatWorktrees.push(worktree)
        if (
          merged.pathBackendId[worktree.path] !== undefined &&
          merged.pathBackendId[worktree.path] !== backendId
        ) {
          // The documented composite-identity gap, actually happening:
          // identical absolute worktree paths on two hosts. Everything
          // path-keyed (routing, panes, selection) is last-writer-wins
          // from here, so say so loudly instead of failing quietly.
          // eslint-disable-next-line no-console
          console.warn(
            `[fleet] worktree path exists on two backends — routing is unreliable for it: ${worktree.path} (${merged.pathBackendId[worktree.path]} vs ${backendId})`
          )
        }
        merged.pathBackendId[worktree.path] = backendId
      }

      merged.backendMeta[backendId] = { label, kind }
      for (const root of state.worktrees.repoRoots) merged.repoBackendId[root] = backendId
      merged.repoRoots.push(...state.worktrees.repoRoots)
      for (const pending of state.worktrees.pending) {
        merged.pendingBackendId[pending.id] = backendId
      }
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
      for (const [path, tree] of Object.entries(state.terminals.panes)) {
        merged.tabsByWorktree[path] = getLeaves(tree).flatMap((leaf) => leaf.tabs)
      }

      Object.assign(merged.prStatuses, state.prs.byPath)
      Object.assign(merged.mergedPaths, state.prs.mergedByPath)
      Object.assign(merged.snoozeByPath, state.snooze.byPath)
      Object.assign(merged.pinnedPaths, state.pinned.byPath)
      Object.assign(merged.aliases, state.aliases.byPath)
      Object.assign(merged.assignedPRsByRepo, state.assignedPRs.byRepo)
    }

    return merged
  }, [backends])
}
