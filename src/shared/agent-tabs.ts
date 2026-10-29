import type { AppState } from './state'
import { getLeaves, type AgentKind } from './state/terminals'

export interface AgentTabInfo {
  id: string
  label: string
  /** 'chat' is a Ness Chat tab (json-claude); 'terminal' is an xterm
   *  running the agent CLI. */
  kind: 'chat' | 'terminal'
  agentKind: AgentKind
  /** Epoch ms of the tab's last observed activity; 0 when none was seen
   *  since launch. */
  lastActiveAt: number
  asleep: boolean
}

export function tabLabel(tab: { label: string; customLabel?: string }): string {
  return tab.customLabel?.trim() || tab.label
}

/** The worktree's agent tabs (terminal + chat), most recently active
 *  first. Chat tabs are dated by their last transcript entry; terminal
 *  tabs have no transcript in state, so the caller supplies when their
 *  hook status last changed. Ties keep pane order, with each pane's
 *  focused tab first. */
export function listAgentTabs(
  state: AppState,
  worktreePath: string,
  terminalLastActive: (tabId: string) => number | undefined
): AgentTabInfo[] {
  const tree = state.terminals.panes[worktreePath]
  if (!tree) return []
  const out: Array<AgentTabInfo & { order: number }> = []
  for (const leaf of getLeaves(tree)) {
    const ordered = [...leaf.tabs].sort(
      (a, b) => Number(b.id === leaf.activeTabId) - Number(a.id === leaf.activeTabId)
    )
    for (const tab of ordered) {
      if (tab.type !== 'agent' && tab.type !== 'json-claude') continue
      const isChat = tab.type === 'json-claude'
      const entries = isChat ? state.jsonClaude.sessions[tab.id]?.entries : undefined
      const lastActiveAt = isChat
        ? (entries?.[entries.length - 1]?.timestamp ?? 0)
        : (terminalLastActive(tab.id) ?? 0)
      out.push({
        id: tab.id,
        label: tabLabel(tab),
        kind: isChat ? 'chat' : 'terminal',
        agentKind: tab.agentKind ?? 'claude',
        lastActiveAt,
        asleep: tab.mode === 'asleep',
        order: out.length
      })
    }
  }
  out.sort((a, b) => b.lastActiveAt - a.lastActiveAt || a.order - b.order)
  return out.map(({ order: _order, ...info }) => info)
}
