import { useMemo } from 'react'
import { useAppState, usePanes } from '../store'
import { useMergedWorktrees } from './useMergedWorktrees'
import { getLeaves } from '../../shared/state/terminals'
import type { TerminalTab } from '../types'
import { applyProjectAccordion, buildWorktreeListBase, type WorktreeListModel } from '../worktree-list-model'
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
  collapse: Pick<WorktreeCollapseState, 'unifiedRepos' | 'pinnedOpenRepos' | 'isGroupCollapsed'>,
  options: { assignOrdinals?: boolean; activeWorktreeId?: string | null } = {}
): WorktreeListModel {
  const base = useWorktreeListBase(collapse, options)
  return useProjectAccordion(base, options.activeWorktreeId ?? null, collapse.pinnedOpenRepos)
}

/** The selection-independent half of the model. Keep worktree switches
 *  out of its inputs: it allocates every row, and WorktreeTab memoises on
 *  row identity, so re-running it on a switch re-renders the whole list.
 *  Callers that only need order and grouping (hotkeys) can use this
 *  directly and skip the accordion's per-switch churn. */
export function useWorktreeListBase(
  collapse: Pick<WorktreeCollapseState, 'unifiedRepos' | 'isGroupCollapsed'>,
  options: { assignOrdinals?: boolean } = {}
): WorktreeListModel {
  const { assignOrdinals = true } = options
  const merged = useMergedWorktrees()
  const viewerLogin = useAppState((s) => s.settings.viewerLogin)

  const { unifiedRepos, isGroupCollapsed } = collapse

  return useMemo(
    () =>
      buildWorktreeListBase({
        worktrees: merged.flatWorktrees,
        repoRoots: merged.repoRoots,
        repoBackendId: merged.repoBackendId,
        repoRemotes: merged.repoRemotes,
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
        isGroupCollapsed,
        assignOrdinals
      }),
    [merged, viewerLogin, unifiedRepos, isGroupCollapsed, assignOrdinals]
  )
}

/** The cheap per-switch pass: which projects are open. Rows (and unchanged
 *  sections) keep their identity. */
export function useProjectAccordion(
  base: WorktreeListModel,
  activeWorktreeId: string | null,
  pinnedOpenRepos: Record<string, boolean>
): WorktreeListModel {
  return useMemo(
    () => applyProjectAccordion(base, activeWorktreeId, pinnedOpenRepos),
    [base, activeWorktreeId, pinnedOpenRepos]
  )
}
