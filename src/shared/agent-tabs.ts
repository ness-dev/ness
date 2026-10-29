import type { AppState } from './state'
import { getLeaves, type AgentKind } from './state/terminals'

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
        order: out.length
      })
    }
  }
  out.sort((a, b) => b.lastActiveAt - a.lastActiveAt || a.order - b.order)
  return out.map(({ order: _order, ...info }) => info)
}
