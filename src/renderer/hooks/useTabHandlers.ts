import { useCallback } from 'react'
import type { AgentKind, TerminalTab, PaneNode } from '../types'
import { getLeaves, findLeaf, findLeafByTabId } from '../../shared/state/terminals'
import { agentDisplayName, getAgentInfo } from '../../shared/agent-registry'
import { focusTerminalById, markTerminalClosing } from '../components/XTerminal'
import { useBackend } from '../backend'
import { randomUUID } from '../uuid'
import { useSettings } from '../store'

function makeTerminalId(prefix: string, worktreePath: string): string {
  const safe = worktreePath.replace(/[/\\]/g, '-').replace(/^-+/, '').replace(/-+/g, '-')
  return `${prefix}-${safe}`
}

interface UseTabHandlersArgs {
  panes: Record<string, PaneNode>
  activePaneId: Record<string, string>
  setActivePaneId: React.Dispatch<React.SetStateAction<Record<string, string>>>
  activeWorktreeId: string | null
  setActiveWorktreeId: React.Dispatch<React.SetStateAction<string | null>>
}

/** Pane / tab orchestration handlers. Every operation dispatches an IPC
 * method to main (which owns the pane state) and updates the per-client
 * activePaneId focus map locally. */
export function useTabHandlers({
  panes,
  activePaneId,
  setActivePaneId,
  activeWorktreeId,
  setActiveWorktreeId
}: UseTabHandlersArgs) {
  const backend = useBackend()
  const openPrInBrowserTab = useSettings().openPrInBrowserTab
  const appendTabToPane = useCallback(
    (worktreePath: string, tab: TerminalTab, paneId?: string) => {
      const tree = panes[worktreePath]
      const leaves = tree ? getLeaves(tree) : []
      const targetId = paneId || activePaneId[worktreePath] || leaves[0]?.id
      void backend.panesAddTab(worktreePath, tab, targetId)
      if (targetId) {
        setActivePaneId((prev) => ({ ...prev, [worktreePath]: targetId }))
      }
    },
    [activePaneId, panes, setActivePaneId]
  )

  const handleAddTerminalTab = useCallback(
    (worktreePath: string, paneId?: string) => {
      const id = `shell-${Date.now()}`
      appendTabToPane(worktreePath, { id, type: 'shell', label: 'Shell' }, paneId)
    },
    [appendTabToPane]
  )

  const handleAddAgentTab = useCallback(
    (worktreePath: string, agentKind: AgentKind = 'claude', paneId?: string) => {
      const label = agentDisplayName(agentKind)
      const info = getAgentInfo(agentKind)
      const id = `${makeTerminalId('agent', worktreePath)}-${Date.now()}`
      appendTabToPane(
        worktreePath,
        { id, type: 'agent', agentKind, label, sessionId: info.assignsSessionId ? randomUUID() : undefined },
        paneId
      )
    },
    [appendTabToPane]
  )

  const handleAddBrowserTab = useCallback(
    (worktreePath: string, paneId?: string, initialUrl?: string) => {
      const id = `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      appendTabToPane(
        worktreePath,
        {
          id,
          type: 'browser',
          label: 'Browser',
          url: initialUrl && initialUrl.trim() ? initialUrl : 'about:blank'
        },
        paneId
      )
    },
    [appendTabToPane]
  )

  const handleAddJsonClaudeTab = useCallback(
    (worktreePath: string, paneId?: string) => {
      // Chat (json-claude) tabs use a UUID for both tab id and session id
      // — the manager passes it to `claude --session-id` directly so the
      // session jsonl reuses the same identifier and survives a reload.
      const sessionId = randomUUID()
      appendTabToPane(
        worktreePath,
        {
          id: sessionId,
          type: 'json-claude',
          label: 'Chat',
          sessionId
        },
        paneId
      )
    },
    [appendTabToPane]
  )

  const handleCloseTab = useCallback(
    (worktreePath: string, tabId: string) => {
      // PanesFSM is the authoritative path for json-claude/agent/shell
      // teardown — its closeTab kills the subprocess via killJsonClaude
      // or killTabPty. The PTY-side notification here is purely an
      // optimistic UX hint for xterm-hosted tabs (so the prompt grays out
      // before the IPC round-trip lands), so we keep it for those and
      // let main handle json-claude on its own.
      if (
        !tabId.startsWith('diff-') &&
        !tabId.startsWith('file-') &&
        !tabId.startsWith('browser-')
      ) {
        markTerminalClosing(tabId)
        backend.killTerminal(tabId)
      }
      void backend.panesCloseTab(worktreePath, tabId)
    },
    []
  )

  const handleRestartAgentTab = useCallback(
    (worktreePath: string, tabId: string) => {
      // json-claude tabs aren't backed by a PTY — restart is a kill +
      // start of the subprocess against the same sessionId, which
      // resumes from the on-disk transcript via --resume. The slice
      // entries get re-seeded from the jsonl on the next start.
      const tree = panes[worktreePath]
      let kind: 'agent' | 'json-claude' | 'shell' | 'other' = 'other'
      if (tree) {
        for (const leaf of getLeaves(tree)) {
          const t = leaf.tabs.find((x) => x.id === tabId)
          if (t) {
            kind =
              t.type === 'agent'
                ? 'agent'
                : t.type === 'json-claude'
                  ? 'json-claude'
                  : t.type === 'shell'
                    ? 'shell'
                    : 'other'
            break
          }
        }
      }
      if (kind === 'json-claude') {
        void (async (): Promise<void> => {
          await backend.killJsonClaude(tabId)
          await backend.startJsonClaude(tabId, worktreePath)
        })()
        return
      }
      markTerminalClosing(tabId)
      backend.killTerminal(tabId)
      backend.clearTerminalHistory(tabId)
      const newId = `${makeTerminalId('agent', worktreePath)}-${Date.now()}`
      void backend.panesRestartAgentTab(worktreePath, tabId, newId)
    },
    [panes]
  )

  const handleRestartAllAgentTabs = useCallback(() => {
    for (const [worktreePath, tree] of Object.entries(panes)) {
      for (const leaf of getLeaves(tree)) {
        for (const tab of leaf.tabs) {
          if (tab.type === 'agent' || tab.type === 'json-claude') {
            handleRestartAgentTab(worktreePath, tab.id)
          }
        }
      }
    }
  }, [panes, handleRestartAgentTab])

  const handleConvertTabType = useCallback(
    (worktreePath: string, tabId: string, newType: 'agent' | 'json-claude') => {
      // Tear down + flip happens in main (panes-fsm.convertTabType).
      // The renderer just routes the user's intent — XTerminal /
      // JsonModeChat will mount on the new tab type and self-spawn the
      // matching backend with the carried sessionId.
      void backend.panesConvertTabType(worktreePath, tabId, newType)
    },
    []
  )

  const handleSelectTab = useCallback(
    (worktreePath: string, paneId: string, tabId: string) => {
      void backend.panesSelectTab(worktreePath, paneId, tabId)
      setActivePaneId((prev) => ({ ...prev, [worktreePath]: paneId }))
      // Wake-on-focus is handled in WorkspaceView via a rising-edge
      // effect on leaf.activeTabId, so we don't fire panesWakeTab from
      // here. That keeps a single source of truth and means right-click
      // → Sleep doesn't get re-woken when the slept tab stays focused.
    },
    [setActivePaneId]
  )

  // Every "open the PR" affordance — ⌘⇧G, the #number pill, the PR title,
  // the collapsed panel's PR button — routes through here so the
  // openPrInBrowserTab setting can't apply to some of them and not others.
  const handleOpenPR = useCallback(
    (worktreePath: string, url: string) => {
      if (!openPrInBrowserTab) {
        backend.openExternal(url)
        return
      }
      const tree = panes[worktreePath]
      for (const leaf of tree ? getLeaves(tree) : []) {
        const existing = leaf.tabs.find((t) => t.type === 'browser' && t.url === url)
        if (existing) {
          handleSelectTab(worktreePath, leaf.id, existing.id)
          return
        }
      }
      handleAddBrowserTab(worktreePath, undefined, url)
    },
    [openPrInBrowserTab, panes, handleSelectTab, handleAddBrowserTab]
  )

  const handleSleepTab = useCallback(
    (worktreePath: string, tabId: string) => {
      void backend.panesSleepTab(worktreePath, tabId)
    },
    []
  )

  const handleOpenCommit = useCallback(
    (hash: string, shortHash: string, subject: string) => {
      if (!activeWorktreeId) return
      const tabId = `diff-commit-${shortHash}`
      const tree = panes[activeWorktreeId]
      const existingLeaf = tree ? findLeafByTabId(tree, tabId) : null
      if (existingLeaf) {
        handleSelectTab(activeWorktreeId, existingLeaf.id, tabId)
        return
      }
      const tab: TerminalTab = {
        id: tabId,
        type: 'diff',
        label: `${shortHash} ${subject}`,
        commitHash: hash
      }
      appendTabToPane(activeWorktreeId, tab)
    },
    [activeWorktreeId, panes, handleSelectTab, appendTabToPane]
  )

  // One file's slice of a commit (<hash>^ … <hash>), as opposed to
  // handleOpenCommit's whole-commit text view. Distinct tab id prefix so
  // both can be open for the same commit at once.
  const handleOpenCommitFileDiff = useCallback(
    (commitHash: string, shortHash: string, filePath: string) => {
      if (!activeWorktreeId) return
      const tabId = `diff-commit-${shortHash}-${filePath}`
      const tree = panes[activeWorktreeId]
      const existingLeaf = tree ? findLeafByTabId(tree, tabId) : null
      if (existingLeaf) {
        handleSelectTab(activeWorktreeId, existingLeaf.id, tabId)
        return
      }
      const fileName = filePath.split('/').pop() || filePath
      const tab: TerminalTab = {
        id: tabId,
        type: 'diff',
        label: `${fileName} @ ${shortHash}`,
        filePath,
        commitHash
      }
      appendTabToPane(activeWorktreeId, tab)
    },
    [activeWorktreeId, panes, handleSelectTab, appendTabToPane]
  )

  const handleReorderTabs = useCallback(
    (worktreePath: string, paneId: string, fromId: string, toId: string) => {
      if (fromId === toId) return
      void backend.panesReorderTabs(worktreePath, paneId, fromId, toId)
    },
    []
  )

  const handleMoveTabToPane = useCallback(
    (worktreePath: string, tabId: string, toPaneId: string, toIndex?: number) => {
      void backend.panesMoveTabToPane(worktreePath, tabId, toPaneId, toIndex)
      setActivePaneId((prev) => ({ ...prev, [worktreePath]: toPaneId }))
    },
    [setActivePaneId]
  )

  const handleSplitPane = useCallback(
    async (
      worktreePath: string,
      fromPaneId: string,
      direction?: 'horizontal' | 'vertical'
    ) => {
      const newPane = await backend.panesSplitPane(worktreePath, fromPaneId, direction)
      if (newPane) {
        setActivePaneId((prev) => ({ ...prev, [worktreePath]: newPane.id }))
      }
    },
    [setActivePaneId]
  )

  const handleSendToAgent = useCallback(
    (worktreePath: string, text: string) => {
      const tree = panes[worktreePath]
      const leaves = tree ? getLeaves(tree) : []
      // Both 'agent' (xterm) and 'json-claude' tabs accept dispatched
      // messages — they just take different mechanisms (bracketed
      // paste over PTY stdin vs. sendJsonClaudeMessage IPC).
      const isSendable = (t: { type?: string }): boolean =>
        t.type === 'agent' || t.type === 'json-claude'
      let targetPaneId: string | undefined
      let targetTab: { id: string; type?: string } | undefined
      for (const leaf of leaves) {
        const active = leaf.tabs.find((t) => t.id === leaf.activeTabId)
        if (active && isSendable(active)) {
          targetPaneId = leaf.id
          targetTab = active
          break
        }
      }
      if (!targetTab) {
        for (const leaf of leaves) {
          const c = leaf.tabs.find(isSendable)
          if (c) {
            targetPaneId = leaf.id
            targetTab = c
            break
          }
        }
      }
      if (!targetPaneId || !targetTab) return
      setActiveWorktreeId(worktreePath)
      handleSelectTab(worktreePath, targetPaneId, targetTab.id)
      const id = targetTab.id
      const isJsonClaude = targetTab.type === 'json-claude'
      requestAnimationFrame(() => {
        if (isJsonClaude) {
          backend.sendJsonClaudeMessage(id, text)
        } else {
          backend.writeTerminal(id, '\x1b[200~' + text + '\x1b[201~')
          focusTerminalById(id)
        }
      })
    },
    [panes, handleSelectTab, setActiveWorktreeId]
  )

  const handleOpenFile = useCallback(
    (filePath: string) => {
      if (!activeWorktreeId) return
      const tabId = `file-${filePath}`
      const tree = panes[activeWorktreeId]
      const existingLeaf = tree ? findLeafByTabId(tree, tabId) : null
      if (existingLeaf) {
        handleSelectTab(activeWorktreeId, existingLeaf.id, tabId)
        return
      }
      const fileName = filePath.split('/').pop() || filePath
      const tab: TerminalTab = {
        id: tabId,
        type: 'file',
        label: fileName,
        filePath
      }
      appendTabToPane(activeWorktreeId, tab)
    },
    [activeWorktreeId, panes, handleSelectTab, appendTabToPane]
  )

  const handleOpenDiff = useCallback(
    (filePath: string, staged: boolean, mode: 'working' | 'branch' = 'working') => {
      if (!activeWorktreeId) return
      const branchDiff = mode === 'branch'
      const kind = branchDiff ? 'branch' : staged ? 'staged' : 'unstaged'
      const tabId = `diff-${kind}-${filePath}`
      const tree = panes[activeWorktreeId]
      const existingLeaf = tree ? findLeafByTabId(tree, tabId) : null
      if (existingLeaf) {
        handleSelectTab(activeWorktreeId, existingLeaf.id, tabId)
        return
      }
      const fileName = filePath.split('/').pop() || filePath
      const tab: TerminalTab = {
        id: tabId,
        type: 'diff',
        label: fileName,
        filePath,
        staged,
        branchDiff
      }
      appendTabToPane(activeWorktreeId, tab)
    },
    [activeWorktreeId, panes, handleSelectTab, appendTabToPane]
  )

  return {
    appendTabToPane,
    handleAddTerminalTab,
    handleAddAgentTab,
    handleAddBrowserTab,
    handleAddJsonClaudeTab,
    handleConvertTabType,
    handleCloseTab,
    handleRestartAgentTab,
    handleRestartAllAgentTabs,
    handleSelectTab,
    handleSleepTab,
    handleOpenPR,
    handleOpenCommit,
    handleOpenCommitFileDiff,
    handleReorderTabs,
    handleMoveTabToPane,
    handleSplitPane,
    handleSendToAgent,
    handleOpenFile,
    handleOpenDiff
  }
}
