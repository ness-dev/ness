import { useMemo } from 'react'
import { useAppState, usePanes } from '../store'
import { useMergedWorktrees } from './useMergedWorktrees'
import { getLeaves } from '../../shared/state/terminals'
import type { TerminalTab } from '../types'
import { buildWorktreeListModel, type WorktreeListModel } from '../worktree-list-model'
import type { WorktreeCollapseState } from './useWorktreeCollapse'

/** Flattened tabs per worktree path. Recomputed only when the pane tree
 *  changes — pty output is a side-effect stream, not a state event, so this
 *  doesn't churn on terminal traffic. */
export function useTabsByWorktree(): Record<string, TerminalTab[]> {
  const panes = usePanes()
  return useMemo(() => {
    const out: Record<string, TerminalTab[]> = {}
    for (const [wtPath, tree] of Object.entries(panes)) {
      out[wtPath] = getLeaves(tree).flatMap((l) => l.tabs)
    }
    return out
  }, [panes])
}

/** Reads every store slice the worktree list depends on and derives the
 *  shared list model once, at the list level.
 *
 *  Deliberately hoisted out of the row component: WorktreeTab used to run
 *  `useAppState` / `useAliasForPath` / `useMetaHeld` subscriptions per row,
 *  which is CLAUDE.md anti-pattern #4 (N subscriptions over whole maps) and
 *  would have doubled once mobile started rendering the same rows. */
/** Builds the sidebar model from EVERY registered backend's worktrees, not
 *  just the active one — the point of the whole per-worktree-remotes
 *  change. `viewerLogin` stays active-scoped: it's a fact about whichever
 *  backend resolved a GitHub token, not a property of the merged list.
 *
 *  Inputs are merged upstream in `useMergedWorktrees`; see that file for
 *  why merging inputs beats concatenating per-backend models. */
export function useWorktreeListModel(
  collapse: Pick<WorktreeCollapseState, 'unifiedRepos' | 'collapsedRepos' | 'isGroupCollapsed'>,
  options: { assignOrdinals?: boolean } = {}
): WorktreeListModel {
  const { assignOrdinals = true } = options
  const merged = useMergedWorktrees()
  const viewerLogin = useAppState((s) => s.settings.viewerLogin)

  const { unifiedRepos, collapsedRepos, isGroupCollapsed } = collapse

  return useMemo(
    () =>
      buildWorktreeListModel({
        worktrees: merged.flatWorktrees,
        repoRoots: merged.repoRoots,
        pendingWorktrees: merged.pendingWorktrees,
        pendingDeletions: merged.pendingDeletions,
        tabsByWorktree: merged.tabsByWorktree,
        statuses: merged.statuses,
        pendingTools: merged.pendingTools,
        shellActivity: merged.shellActivity,
        prStatuses: merged.prStatuses,
        mergedPaths: merged.mergedPaths,
        snoozeByPath: merged.snoozeByPath,
        pinnedPaths: merged.pinnedPaths,
        aliases: merged.aliases,
        viewerLogin,
        assignedPRsByRepo: merged.assignedPRsByRepo,
        unifiedRepos,
        collapsedRepos,
        isGroupCollapsed,
        assignOrdinals
      }),
    [
      merged,
      viewerLogin,
      unifiedRepos,
      collapsedRepos,
      isGroupCollapsed,
      assignOrdinals
    ]
  )
}
