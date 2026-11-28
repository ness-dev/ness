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
// asked, and the worktree screen selects the tab once it lands. The ask
// expires (or is dropped when the request fails) so a review tab opened
// later from desktop doesn't pull the phone off what it's showing.
const AWAIT_REVIEW_MS = 10_000
const awaitingReview = new Map<string, number>()
const reviewListeners = new Set<() => void>()
let reviewVersion = 0
const bumpReview = () => {
  reviewVersion++
  reviewListeners.forEach((l) => l())
}
const subscribeReview = (l: () => void) => {
  reviewListeners.add(l)
  return () => {
    reviewListeners.delete(l)
  }
}
const getReviewVersion = () => reviewVersion
const awaitKey = (clientId: string, worktreePath: string) => `${clientId}::${worktreePath}`

/** The desktop's "Review changes": select the worktree's review tab,
 *  opening one if there isn't one yet. */
export function openReviewTab(client: NessClient, worktreePath: string, openTabs: readonly TerminalTab[]): void {
  const existing = openTabs.find((t) => t.type === 'review')
  if (existing) {
    rememberTab(worktreePath, existing.id)
    return
  }
  const key = awaitKey(client.id, worktreePath)
  awaitingReview.set(key, Date.now())
  bumpReview()
  client.api.panesOpenReview(worktreePath).then(
    (ok) => {
      if (ok) return
      awaitingReview.delete(key)
      bumpReview()
    },
    () => {
      awaitingReview.delete(key)
      bumpReview()
    }
  )
}

/** Selects the review tab openReviewTab asked this backend for, once it's
 *  in `tabs`. */
export function useFollowOpenedReview(clientId: string | null, worktreePath: string | null, tabs: readonly TerminalTab[]): void {
  const version = useSyncExternalStore(subscribeReview, getReviewVersion)
  useEffect(() => {
    if (!clientId || !worktreePath) return
    const key = awaitKey(clientId, worktreePath)
    const askedAt = awaitingReview.get(key)
    if (askedAt === undefined) return
    if (Date.now() - askedAt > AWAIT_REVIEW_MS) {
      awaitingReview.delete(key)
      return
    }
    const review = tabs.find((t) => t.type === 'review')
    if (!review) return
    awaitingReview.delete(key)
    rememberTab(worktreePath, review.id)
  }, [clientId, worktreePath, tabs, version])
}
