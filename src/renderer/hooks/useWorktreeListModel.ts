import { useMemo } from 'react'
import {
  useAppState,
  useWorktrees,
  usePanes,
  useTerminals,
  usePrs,
  useSnooze,
  usePinned,
  useAliases,
  useAssignedPRs
} from '../store'
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
export function useWorktreeListModel(
  collapse: Pick<WorktreeCollapseState, 'unifiedRepos' | 'collapsedRepos' | 'isGroupCollapsed'>,
  options: { assignOrdinals?: boolean } = {}
): WorktreeListModel {
  const { assignOrdinals = true } = options
  const wtState = useWorktrees()
  const terminals = useTerminals()
  const prs = usePrs()
  const snooze = useSnooze()
  const pinned = usePinned()
  const aliases = useAliases()
  const assignedPRs = useAssignedPRs()
  const viewerLogin = useAppState((s) => s.settings.viewerLogin)
  const tabsByWorktree = useTabsByWorktree()

  const { unifiedRepos, collapsedRepos, isGroupCollapsed } = collapse

  return useMemo(
    () =>
      buildWorktreeListModel({
        worktrees: wtState.list,
        repoRoots: wtState.repoRoots,
        pendingWorktrees: wtState.pending,
        pendingDeletions: wtState.pendingDeletions ?? [],
        tabsByWorktree,
        statuses: terminals.statuses,
        pendingTools: terminals.pendingTools,
        shellActivity: terminals.shellActivity,
        prStatuses: prs.byPath,
        mergedPaths: prs.mergedByPath,
        snoozeByPath: snooze.byPath,
        pinnedPaths: pinned.byPath,
        aliases: aliases.byPath,
        viewerLogin,
        assignedPRsByRepo: assignedPRs.byRepo,
        unifiedRepos,
        collapsedRepos,
        isGroupCollapsed,
        assignOrdinals
      }),
    [
      wtState.list,
      wtState.repoRoots,
      wtState.pending,
      wtState.pendingDeletions,
      tabsByWorktree,
      terminals.statuses,
      terminals.pendingTools,
      terminals.shellActivity,
      prs.byPath,
      prs.mergedByPath,
      snooze.byPath,
      pinned.byPath,
      aliases.byPath,
      viewerLogin,
      assignedPRs.byRepo,
      unifiedRepos,
      collapsedRepos,
      isGroupCollapsed,
      assignOrdinals
    ]
  )
}
