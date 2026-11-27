// The tools panel — the desktop's right column — for one worktree. Swipe
// back or the close button returns to the worktree.
import { router, useLocalSearchParams } from 'expo-router'
import { useWorkspace } from '../../../workspace'
import { useMerged } from '../../../fleet'
import { rememberTab, useSelectedTabId } from '../../../navState'
import { agentTargetFor } from '../../../tabs'
import { PanelsHost } from '../../../panels/PanelsHost'
import { Empty } from '../../../components/Empty'

export default function ToolsRoute() {
  const { wt } = useLocalSearchParams<{ wt: string }>()
  const { fleet } = useWorkspace()
  const merged = useMerged(fleet)
  const worktree = merged.flatWorktrees.find((w) => w.path === wt)
  const client = worktree ? fleet.client(merged.pathBackendId[wt]) : undefined
  const tabs = merged.tabsByWorktree[wt] ?? []
  const selectedTabId = useSelectedTabId(worktree ? wt : null, tabs)
  if (!worktree || !client) return <Empty message="Connecting…" />

  // "Send to agent" from a panel: the chat gets a message, a terminal agent
  // a bracketed paste; then back to the worktree, showing that tab.
  const sendToAgent = (text: string) => {
    const selected = tabs.find((t) => t.id === selectedTabId)
    const target = agentTargetFor(tabs, merged.panes[wt], selected)
    if (!target) return
    rememberTab(wt, target.id)
    if (target.type === 'json-claude') client.api.sendJsonClaudeMessage(target.id, text)
    else client.api.writeTerminal(target.id, '\x1b[200~' + text + '\x1b[201~')
    router.back()
  }

  return (
    <PanelsHost
      key={`${client.id}:${wt}`}
      client={client}
      worktree={worktree}
      focusedTabId={selectedTabId}
      onSendToAgent={sendToAgent}
      onClose={() => router.back()}
    />
  )
}
