// Opening a file / diff from a panel adds a shared tab to the worktree's
// panes, exactly as the desktop's handleOpenFile / handleOpenDiff /
// handleOpenCommitFileDiff do (renderer/hooks/useTabHandlers.ts): same ids,
// labels and fields, so a tab opened on the phone is the desktop's tab and
// vice versa, and opening one that's already there just selects it.
import { useEffect, useSyncExternalStore } from 'react'
import type { PaneNode, TerminalTab } from '../../../src/shared/state/terminals'
import type { NessClient } from '../ness'
import { rememberTab } from '../navState'
import { firstLeafId } from '../tabs'

const baseName = (p: string) => p.split('/').pop() || p

export function fileTab(filePath: string): TerminalTab {
  return { id: `file-${filePath}`, type: 'file', label: baseName(filePath), filePath }
}

export function diffTab(filePath: string, staged: boolean, mode: 'working' | 'branch'): TerminalTab {
  const branchDiff = mode === 'branch'
  const kind = branchDiff ? 'branch' : staged ? 'staged' : 'unstaged'
  return { id: `diff-${kind}-${filePath}`, type: 'diff', label: baseName(filePath), filePath, staged, branchDiff }
}

export function commitFileDiffTab(commitHash: string, shortHash: string, filePath: string): TerminalTab {
  return {
    id: `diff-commit-${shortHash}-${filePath}`,
    type: 'diff',
    label: `${baseName(filePath)} @ ${shortHash}`,
    filePath,
    commitHash
  }
}

/** Select `tab` on the phone, adding it to the worktree's first pane if it
 *  isn't open yet (the phone has no pane focus; handleAddChat uses the same
 *  pane). Selection is remembered before the tab reaches the mirror, and
 *  useSelectedTabId picks it up as soon as it lands. */
export function openViewerTab(
  client: NessClient,
  worktreePath: string,
  openTabs: readonly TerminalTab[],
  tree: PaneNode | undefined,
  tab: TerminalTab
): void {
  if (!openTabs.some((t) => t.id === tab.id)) {
    void client.api.panesAddTab(worktreePath, tab, tree ? firstLeafId(tree) : undefined)
  }
  rememberTab(worktreePath, tab.id)
}

// A review tab's id is minted by main (PanesFSM.openReviewTab, one per
// worktree), so the phone can't remember it up front. It remembers that it
// asked, and the worktree screen selects the tab once it lands.
const awaitingReview = new Set<string>()
const reviewListeners = new Set<() => void>()
let reviewVersion = 0

/** The desktop's "Review changes": select the worktree's review tab,
 *  opening one if there isn't one yet. */
export function openReviewTab(client: NessClient, worktreePath: string, openTabs: readonly TerminalTab[]): void {
  const existing = openTabs.find((t) => t.type === 'review')
  if (existing) {
    rememberTab(worktreePath, existing.id)
    return
  }
  awaitingReview.add(worktreePath)
  reviewVersion++
  reviewListeners.forEach((l) => l())
  void client.api.panesOpenReview(worktreePath)
}

/** Selects the review tab openReviewTab asked for, once it's in `tabs`. */
export function useFollowOpenedReview(worktreePath: string | null, tabs: readonly TerminalTab[]): void {
  const version = useSyncExternalStore(
    (l) => {
      reviewListeners.add(l)
      return () => reviewListeners.delete(l)
    },
    () => reviewVersion
  )
  useEffect(() => {
    if (!worktreePath || !awaitingReview.has(worktreePath)) return
    const review = tabs.find((t) => t.type === 'review')
    if (!review) return
    awaitingReview.delete(worktreePath)
    rememberTab(worktreePath, review.id)
  }, [worktreePath, tabs, version])
}
