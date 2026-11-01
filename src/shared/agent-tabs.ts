import type { AppState } from './state'
import { getLeaves, type AgentKind, type TerminalTab } from './state/terminals'

/** A Chat tab that reviews and tab messages can be delivered to. Terminal
 *  agent tabs are deliberately not targets: typing into a running TUI is
 *  too unreliable to do unattended. */
export interface ChatTabInfo {
  id: string
  label: string
  agentKind: AgentKind
  /** Epoch ms of the last transcript entry; 0 when it has none loaded. */
  lastActiveAt: number
  asleep: boolean
  /** Set when this tab is a reviewer: the tab that asked for the review. */
  reviewOf?: string
}

/** The tab with this id *in this worktree*, or null.
 *
 *  Deliberately not `findTabById` from the terminals slice, which scans
 *  every worktree: a tab id that arrives from an agent or a request body
 *  must not resolve to a tab in someone else's worktree, so every caller
 *  that takes an id from outside itself wants this one. */
export function findTabInWorktree(
  state: AppState,
  worktreePath: string,
  tabId: string
): TerminalTab | null {
  const tree = state.terminals.panes[worktreePath]
  if (!tree) return null
  for (const leaf of getLeaves(tree)) {
    const tab = leaf.tabs.find((t) => t.id === tabId)
    if (tab) return tab
  }
  return null
}

/** The reviewer Chat tab opened for `requesterTabId`, if one is open. */
export function findReviewerTab(
  state: AppState,
  worktreePath: string,
  requesterTabId: string
): TerminalTab | null {
  const tree = state.terminals.panes[worktreePath]
  if (!tree) return null
  for (const leaf of getLeaves(tree)) {
    for (const tab of leaf.tabs) {
      if (tab.type === 'json-claude' && tab.reviewOf === requesterTabId) return tab
    }
  }
  return null
}

export function tabLabel(tab: { label: string; customLabel?: string }): string {
  return tab.customLabel?.trim() || tab.label
}

/** The worktree's Chat tabs, most recently active first. Ties keep pane
 *  order, with each pane's focused tab first. */
export function listChatTabs(state: AppState, worktreePath: string): ChatTabInfo[] {
  const tree = state.terminals.panes[worktreePath]
  if (!tree) return []
  const out: Array<ChatTabInfo & { order: number }> = []
  for (const leaf of getLeaves(tree)) {
    const ordered = [...leaf.tabs].sort(
      (a, b) => Number(b.id === leaf.activeTabId) - Number(a.id === leaf.activeTabId)
    )
    for (const tab of ordered) {
      if (tab.type !== 'json-claude') continue
      const entries = state.jsonClaude.sessions[tab.id]?.entries
      out.push({
        id: tab.id,
        label: tabLabel(tab),
        agentKind: tab.agentKind ?? 'claude',
        lastActiveAt: entries?.[entries.length - 1]?.timestamp ?? 0,
        asleep: tab.mode === 'asleep',
        ...(tab.reviewOf ? { reviewOf: tab.reviewOf } : {}),
        order: out.length
      })
    }
  }
  out.sort((a, b) => b.lastActiveAt - a.lastActiveAt || a.order - b.order)
  return out.map(({ order: _order, ...info }) => info)
}
