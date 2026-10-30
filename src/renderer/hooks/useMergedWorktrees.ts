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
import { useAllBackendStates, type BackendStateEntry } from '../store'
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
  /** Pane trees, merged. Keyed by worktree path like the slice itself. */
  panes: BackendStateEntry['state']['terminals']['panes']
}

export function useMergedWorktrees(): MergedWorktreeData {
  const backends = useAllBackendStates()
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
        merged.pathBackendId[worktree.path] = backendId
      }

      merged.repoRoots.push(...state.worktrees.repoRoots)
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
