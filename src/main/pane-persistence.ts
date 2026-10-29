import type { PaneNode, TerminalTab } from '../shared/state/terminals'
import type { PersistedPaneNode, PersistedTab } from './persistence'

const PERSISTED_TAB_TYPES = new Set<TerminalTab['type']>(['agent', 'shell', 'browser', 'json-claude'])

/** The tab fields that survive a restart. Saving and restoring both copy
 *  through here, so a field added here round-trips without a second edit
 *  on the other side. */
export function persistedTabFields(t: PersistedTab | TerminalTab): PersistedTab {
  return {
    id: t.id,
    type: t.type as PersistedTab['type'],
    label: t.label,
    agentKind: t.agentKind,
    sessionId: t.sessionId,
    ...(t.providerSessionId ? { providerSessionId: t.providerSessionId } : {}),
    url: t.url,
    command: t.command,
    cwd: t.cwd,
    model: t.model,
    ...(t.customLabel ? { customLabel: t.customLabel } : {})
  }
}

/** `liveBrowserUrl` supplies where a browser tab has navigated to: the
 *  tab's own `url` is set once at creation, and navigation lands in the
 *  `browser` slice instead of the pane tree. */
export function treeToPersistedNode(
  node: PaneNode,
  liveBrowserUrl: (tabId: string) => string | null
): PersistedPaneNode | null {
  if (node.type === 'leaf') {
    const tabs = node.tabs
      .filter((t) => PERSISTED_TAB_TYPES.has(t.type))
      .map((t) => {
        const tab = persistedTabFields(t)
        const liveUrl = tab.type === 'browser' ? liveBrowserUrl(tab.id) : null
        return liveUrl ? { ...tab, url: liveUrl } : tab
      })
    if (tabs.length === 0) return null
    const validActive = tabs.some((t) => t.id === node.activeTabId) ? node.activeTabId : tabs[0].id
    return { type: 'leaf', id: node.id, tabs, activeTabId: validActive }
  }
  const left = treeToPersistedNode(node.children[0], liveBrowserUrl)
  const right = treeToPersistedNode(node.children[1], liveBrowserUrl)
  if (!left && !right) return null
  if (!left) return right
  if (!right) return left
  return {
    type: 'split',
    id: node.id,
    direction: node.direction,
    children: [left, right],
    ratio: node.ratio
  }
}
