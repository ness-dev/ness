import { getLeaves, type PaneNode, type TerminalTab } from '../shared/state/terminals'

export interface WorktreeTabEntry {
  paneId: string
  tab: TerminalTab
}

/** A worktree's tabs in sidebar order — pane by pane (getLeaves order), each
 *  pane's tabs in strip order — with the pane that holds each. Shared by the
 *  desktop's nested tab rows and the phone picker's. */
export function worktreeTabEntries(tree: PaneNode | null | undefined): WorktreeTabEntry[] {
  return tree ? getLeaves(tree).flatMap((leaf) => leaf.tabs.map((tab) => ({ paneId: leaf.id, tab }))) : []
}
