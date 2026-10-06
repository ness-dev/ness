import { useCallback, useMemo } from 'react'
import type { Worktree, PRStatus, PaneNode, TerminalTab } from '../types'
import { getLeaves, findLeaf } from '../../shared/state/terminals'
import { resolveHotkeys, isEditableTarget, type Action, type HotkeyBinding } from '../hotkeys'
import { useHotkeys } from './useHotkeys'
import { useDoubleTapShift } from './useDoubleTapShift'
import { groupWorktrees, getGroupKey, type GroupKey } from '../../shared/worktree-sort'
import { focusTerminalById } from '../components/XTerminal'
import {
  useConnections,
  getBackendsRegistry,
  useSettings,
  useSnooze,
  usePinned,
  useJsonClaudePendingApprovals
} from '../store'
import { useBackend } from '../backend'
import { SCALES } from '../../shared/state/settings'
import { QUESTION_TOOL_NAME } from '../../shared/state/json-claude'
import { advancePreventSleep, PREVENT_SLEEP_META, PREVENT_SLEEP_TOAST_KEY } from '../prevent-sleep'
import { showToast } from '../toast'

interface UseHotkeyHandlersArgs {
  worktrees: Worktree[]
  repoRoots: string[]
  unifiedRepos: boolean
  prStatuses: Record<string, PRStatus | null>
  mergedPaths: Record<string, boolean>
  collapsedRepos: Record<string, boolean>
  setCollapsedRepos: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  setCollapsedGroups: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  isGroupCollapsed: (scope: string, key: GroupKey) => boolean
  activeWorktreeId: string | null
  setActiveWorktreeId: React.Dispatch<React.SetStateAction<string | null>>
  panes: Record<string, PaneNode>
  activePaneId: Record<string, string>
  terminalTabs: Record<string, TerminalTab[]>
  activeTabId: Record<string, string>
  hotkeyOverrides: Record<string, string> | undefined
  setSidebarVisible: React.Dispatch<React.SetStateAction<boolean>>
  setRightColumnHidden: React.Dispatch<React.SetStateAction<boolean>>
  setSingleScreenMode: React.Dispatch<React.SetStateAction<boolean>>
  setShowNewWorktree: React.Dispatch<React.SetStateAction<boolean>>
  setShowCommandCenter: React.Dispatch<React.SetStateAction<boolean>>
  setShowCommandPalette: React.Dispatch<React.SetStateAction<boolean>>
  setCommandPaletteMode: React.Dispatch<React.SetStateAction<'root' | 'files'>>
  setShowPerfMonitor: React.Dispatch<React.SetStateAction<boolean>>
  setShowHotkeyCheatsheet: React.Dispatch<React.SetStateAction<boolean>>
  setShowQuakeTerminal: React.Dispatch<React.SetStateAction<boolean>>
  /** False when a full-content view is hiding the workspace tab bar; the Quake
   * terminal toggle is a no-op then. */
  quakeTerminalAllowed: boolean
  // Imperative hooks into other handlers — passed in to avoid this hook
  // depending on useTabHandlers + useWorktreeHandlers directly.
  handleAddTerminalTab: (worktreePath: string, paneId?: string) => void
  handleOpenPR: (worktreePath: string, url: string) => void
  handleCloseTab: (worktreePath: string, tabId: string) => void
  handleSelectTab: (worktreePath: string, paneId: string, tabId: string) => void
  handleSplitPane: (worktreePath: string, fromPaneId: string, direction?: 'horizontal' | 'vertical') => void
  handleRefreshWorktrees: () => void
  setShowSettings: React.Dispatch<React.SetStateAction<boolean>>
  onStartAliasEdit: (path: string) => void
}

/** Sidebar-aware hotkey handler block. Computes the visible/ordered
 * worktree lists, the cycle helpers, and the action map; subscribes to
 * keystrokes via useHotkeys; returns the action map (for tooltip
 * dispatch) and the resolved binding map (for the HotkeysProvider). */
export function useHotkeyHandlers(args: UseHotkeyHandlersArgs): {
  hotkeyActions: Partial<Record<Action, () => void>>
  resolvedHotkeys: Record<Action, HotkeyBinding>
} {
  const {
    worktrees,
    repoRoots,
    unifiedRepos,
    prStatuses,
    mergedPaths,
    collapsedRepos,
    setCollapsedRepos,
    setCollapsedGroups,
    isGroupCollapsed,
    activeWorktreeId,
    setActiveWorktreeId,
    panes,
    activePaneId,
    terminalTabs,
    activeTabId,
    hotkeyOverrides,
    setSidebarVisible,
    setRightColumnHidden,
    setSingleScreenMode,
    setShowNewWorktree,
    setShowCommandCenter,
    setShowCommandPalette,
    setCommandPaletteMode,
    setShowPerfMonitor,
    setShowHotkeyCheatsheet,
    setShowQuakeTerminal,
    quakeTerminalAllowed,
    handleAddTerminalTab,
    handleOpenPR,
    handleCloseTab,
    handleSelectTab,
    handleSplitPane,
    handleRefreshWorktrees,
    setShowSettings,
    onStartAliasEdit
  } = args

  // Mirror the sidebar's grouping/rendering order so hotkey navigation
  // matches what's on screen.
  const allSettings = useSettings()
  const viewerLogin = allSettings.viewerLogin
  const uiScale = allSettings.uiScale
  const preventSleepMode = allSettings.preventSleepMode
  const preventSleepUntil = allSettings.preventSleepUntil
  const snoozeByPath = useSnooze().byPath
  const snoozedPaths = useMemo(() => {
    const m: Record<string, true> = {}
    for (const p of Object.keys(snoozeByPath)) m[p] = true
    return m
  }, [snoozeByPath])
  const pinnedPaths = usePinned().byPath
  const byRepoGroups = useMemo(() => {
    if (unifiedRepos && repoRoots.length > 1) {
      return [{ repoRoot: '__unified__', groups: groupWorktrees(worktrees, prStatuses, mergedPaths, snoozedPaths, viewerLogin, undefined, pinnedPaths) }]
    }
    const map = new Map<string, Worktree[]>()
    for (const root of repoRoots) map.set(root, [])
    for (const wt of worktrees) {
      if (!map.has(wt.repoRoot)) map.set(wt.repoRoot, [])
      map.get(wt.repoRoot)!.push(wt)
    }
    return Array.from(map.entries()).map(([repoRoot, wts]) => ({
      repoRoot,
      groups: groupWorktrees(wts, prStatuses, mergedPaths, snoozedPaths, viewerLogin, undefined, pinnedPaths)
    }))
  }, [unifiedRepos, repoRoots, worktrees, prStatuses, mergedPaths, snoozedPaths, viewerLogin, pinnedPaths])

  const allOrderedWorktrees = useMemo(() => {
    const out: Worktree[] = []
    for (const { groups } of byRepoGroups) {
      for (const group of groups) out.push(...group.worktrees)
    }
    return out
  }, [byRepoGroups])

  const visibleWorktrees = useMemo(() => {
    const out: Worktree[] = []
    for (const { repoRoot, groups } of byRepoGroups) {
      if (collapsedRepos[repoRoot]) continue
      for (const group of groups) {
        if (isGroupCollapsed(repoRoot, group.key)) continue
        out.push(...group.worktrees)
      }
    }
    return out
  }, [byRepoGroups, collapsedRepos, isGroupCollapsed])

  const scopeForWorktree = useCallback(
    (wt: Worktree): string =>
      unifiedRepos && repoRoots.length > 1 ? '__unified__' : wt.repoRoot,
    [unifiedRepos, repoRoots]
  )

  const ensureWorktreeVisible = useCallback(
    (wt: Worktree) => {
      const scope = scopeForWorktree(wt)
      const key = getGroupKey(wt, prStatuses[wt.path], mergedPaths?.[wt.path])
      if (isGroupCollapsed(scope, key)) {
        setCollapsedGroups((prev) => ({ ...prev, [`${scope}:${key}`]: false }))
      }
      if (scope !== '__unified__' && collapsedRepos[scope]) {
        setCollapsedRepos((prev) => ({ ...prev, [scope]: false }))
      }
    },
    [scopeForWorktree, prStatuses, mergedPaths, isGroupCollapsed, collapsedRepos, setCollapsedGroups, setCollapsedRepos]
  )

  const switchToWorktreeByIndex = useCallback(
    (index: number) => {
      if (index < visibleWorktrees.length) {
        setActiveWorktreeId(visibleWorktrees[index].path)
      }
    },
    [visibleWorktrees, setActiveWorktreeId]
  )

  // Backend switcher (multi-backend Tier 1, design §F). Cmd+Shift+1..9
  // jumps to backend N (1-indexed in the chip strip's render order).
  // The connections list always starts with Local at index 0; Cmd+Shift+1
  // is "back to local".
  const connections = useConnections()
  const backend = useBackend()
  const switchToBackendByIndex = useCallback(
    (index: number) => {
      const target = connections[index]
      if (!target) return
      const registry = getBackendsRegistry()
      if (registry.getActiveId() === target.id) return
      registry.setActive(target.id)
      void backend.connectionsSetActive(target.id)
      void backend.connectionsSetLastConnected(target.id)
    },
    [connections, backend]
  )

  const cycleWorktree = useCallback(
    (delta: number) => {
      if (allOrderedWorktrees.length === 0) return
      const currentIdx = allOrderedWorktrees.findIndex((w) => w.path === activeWorktreeId)
      const nextIdx =
        (currentIdx + delta + allOrderedWorktrees.length) % allOrderedWorktrees.length
      const next = allOrderedWorktrees[nextIdx]
      ensureWorktreeVisible(next)
      setActiveWorktreeId(next.path)
    },
    [allOrderedWorktrees, activeWorktreeId, ensureWorktreeVisible, setActiveWorktreeId]
  )

  // Head-of-queue pending approval for the *currently active* json-claude
  // tab. Returns null when the active center pane isn't json-claude or
  // when the session has no pending approvals — the hotkey handler is a
  // silent no-op in either case. The map contains approvals for every
  // json-claude session across all worktrees; we filter down to just this
  // session and pick the oldest by arrival timestamp so repeated hotkeys
  // walk the queue front-to-back.
  const pendingApprovalsMap = useJsonClaudePendingApprovals()
  const activeApproval = useMemo(() => {
    if (!activeWorktreeId) return null
    const tree = panes[activeWorktreeId]
    if (!tree) return null
    const leaves = getLeaves(tree)
    if (leaves.length === 0) return null
    const focusedId = activePaneId[activeWorktreeId] || leaves[0]?.id
    const leaf = findLeaf(tree, focusedId) || leaves[0]
    if (!leaf) return null
    const currentTabId = leaf.activeTabId
    if (!currentTabId) return null
    const tab = leaf.tabs.find((t) => t.id === currentTabId)
    if (tab?.type !== 'json-claude') return null
    // For json-claude, tab.id is the session id.
    const sessionId = tab.id
    let head: typeof pendingApprovalsMap[string] | null = null
    for (const a of Object.values(pendingApprovalsMap)) {
      if (a.sessionId !== sessionId) continue
      if (!head || a.timestamp < head.timestamp) head = a
    }
    return head
  }, [activeWorktreeId, panes, activePaneId, pendingApprovalsMap])

  const cycleTab = useCallback(
    (delta: number) => {
      if (!activeWorktreeId) return
      const tree = panes[activeWorktreeId]
      if (!tree) return
      const leaves = getLeaves(tree)
      if (leaves.length === 0) return
      const paneId = activePaneId[activeWorktreeId] || leaves[0].id
      const leaf = findLeaf(tree, paneId) || leaves[0]
      if (leaf.tabs.length === 0) return
      const currentIdx = leaf.tabs.findIndex((t) => t.id === leaf.activeTabId)
      const nextIdx = (currentIdx + delta + leaf.tabs.length) % leaf.tabs.length
      handleSelectTab(activeWorktreeId, leaf.id, leaf.tabs[nextIdx].id)
    },
    [activeWorktreeId, panes, activePaneId, handleSelectTab]
  )

  const hotkeyActions = useMemo<Partial<Record<Action, () => void>>>(
    () => ({
      nextWorktree: () => cycleWorktree(1),
      prevWorktree: () => cycleWorktree(-1),
      worktree1: () => switchToWorktreeByIndex(0),
      worktree2: () => switchToWorktreeByIndex(1),
      worktree3: () => switchToWorktreeByIndex(2),
      worktree4: () => switchToWorktreeByIndex(3),
      worktree5: () => switchToWorktreeByIndex(4),
      worktree6: () => switchToWorktreeByIndex(5),
      worktree7: () => switchToWorktreeByIndex(6),
      worktree8: () => switchToWorktreeByIndex(7),
      worktree9: () => switchToWorktreeByIndex(8),
      backend1: () => switchToBackendByIndex(0),
      backend2: () => switchToBackendByIndex(1),
      backend3: () => switchToBackendByIndex(2),
      backend4: () => switchToBackendByIndex(3),
      backend5: () => switchToBackendByIndex(4),
      backend6: () => switchToBackendByIndex(5),
      backend7: () => switchToBackendByIndex(6),
      backend8: () => switchToBackendByIndex(7),
      backend9: () => switchToBackendByIndex(8),
      newShellTab: () => {
        if (activeWorktreeId) handleAddTerminalTab(activeWorktreeId)
      },
      closeTab: () => {
        if (!activeWorktreeId) return
        const tree = panes[activeWorktreeId]
        if (!tree) return
        const leaves = getLeaves(tree)
        const focusedId = activePaneId[activeWorktreeId] || leaves[0]?.id
        const leaf = findLeaf(tree, focusedId) || leaves[0]
        if (!leaf) return
        const currentTabId = leaf.activeTabId
        if (!currentTabId) return
        if (leaf.tabs.length === 1 && leaves.length === 1) return
        handleCloseTab(activeWorktreeId, currentTabId)
      },
      nextTab: () => cycleTab(1),
      prevTab: () => cycleTab(-1),
      renameTab: () => {
        if (!activeWorktreeId) return
        const tabId = activeTabId[activeWorktreeId]
        if (!tabId) return
        window.dispatchEvent(
          new CustomEvent('harness:rename-tab', { detail: { tabId } })
        )
      },
      newWorktree: () => setShowNewWorktree(true),
      refreshWorktrees: handleRefreshWorktrees,
      focusTerminal: () => {
        if (!activeWorktreeId) return
        const currentTabId = activeTabId[activeWorktreeId]
        if (currentTabId) focusTerminalById(currentTabId)
      },
      toggleSidebar: () => setSidebarVisible((v) => !v),
      toggleRightColumn: () => setRightColumnHidden((v) => !v),
      openSettings: () => setShowSettings((v) => !v),
      toggleSingleScreen: () => setSingleScreenMode((v) => !v),
      openPR: () => {
        if (!activeWorktreeId) return
        const pr = prStatuses[activeWorktreeId]
        if (pr?.url) handleOpenPR(activeWorktreeId, pr.url)
      },
      openInEditor: () => {
        if (!activeWorktreeId) return
        backend.openInEditor(activeWorktreeId)
      },
      toggleCommandCenter: () => setShowCommandCenter((v) => !v),
      commandPalette: () => {
        setShowHotkeyCheatsheet(false)
        setCommandPaletteMode('root')
        setShowCommandPalette((v) => !v)
      },
      fileQuickOpen: () => {
        setShowHotkeyCheatsheet(false)
        setCommandPaletteMode('files')
        setShowCommandPalette(true)
      },
      splitPaneRight: () => {
        if (!activeWorktreeId) return
        const tree = panes[activeWorktreeId]
        if (!tree) return
        const leaves = getLeaves(tree)
        if (leaves.length === 0) return
        const stored = activePaneId[activeWorktreeId]
        const fromPaneId = leaves.some((l) => l.id === stored) ? stored : leaves[leaves.length - 1].id
        handleSplitPane(activeWorktreeId, fromPaneId, 'horizontal')
      },
      splitPaneDown: () => {
        if (!activeWorktreeId) return
        const tree = panes[activeWorktreeId]
        if (!tree) return
        const leaves = getLeaves(tree)
        if (leaves.length === 0) return
        const stored = activePaneId[activeWorktreeId]
        const fromPaneId = leaves.some((l) => l.id === stored) ? stored : leaves[leaves.length - 1].id
        handleSplitPane(activeWorktreeId, fromPaneId, 'vertical')
      },
      togglePerfMonitor: () => setShowPerfMonitor((v) => !v),
      hotkeyCheatsheet: () => setShowHotkeyCheatsheet((v) => !v),
      openReview: () => {
        if (activeWorktreeId) void backend.panesOpenReview(activeWorktreeId)
      },
      toggleQuakeTerminal: () => {
        // Read live keyboard focus: only open when it's inside a workspace
        // tab/agent (xterm terminal or Chat) — not the sidebar, panels, or
        // other chrome. Closing is always allowed (the open overlay itself
        // holds focus, which isn't a workspace tab).
        const inTab = !!document.activeElement?.closest('[data-tab-content]')
        setShowQuakeTerminal((open) => (open ? false : quakeTerminalAllowed && inTab))
      },
      uiScaleUp: () => {
        const i = SCALES.findIndex((s) => s.id === uiScale)
        const next = SCALES[Math.min(i < 0 ? 0 : i + 1, SCALES.length - 1)]
        if (next && next.id !== uiScale) void backend.setUiScale(next.id)
      },
      uiScaleDown: () => {
        const i = SCALES.findIndex((s) => s.id === uiScale)
        const next = SCALES[Math.max(i < 0 ? 0 : i - 1, 0)]
        if (next && next.id !== uiScale) void backend.setUiScale(next.id)
      },
      uiScaleReset: () => {
        if (uiScale !== 'small') void backend.setUiScale('small')
      },
      aliasWorktree: () => {
        if (!activeWorktreeId) return
        if (activeWorktreeId.startsWith('pending:')) return
        onStartAliasEdit(activeWorktreeId)
      },
      approveToolUse: () => {
        if (!activeApproval) return
        // Approving a question without answers resolves it as "the user
        // did not answer" — the question card owns this interaction.
        if (activeApproval.toolName === QUESTION_TOOL_NAME) return
        // Scroll first so the resolved card is visible for the split
        // second it's still mounted — otherwise the state update drops
        // it from the DOM before scrollIntoView can find the node.
        document
          .getElementById(activeApproval.requestId)
          ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
        void backend.resolveJsonClaudeApproval(activeApproval.requestId, {
          behavior: 'allow',
          updatedInput: activeApproval.input
        })
      },
      denyToolUse: () => {
        if (!activeApproval) return
        if (activeApproval.toolName === QUESTION_TOOL_NAME) return
        document
          .getElementById(activeApproval.requestId)
          ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
        void backend.resolveJsonClaudeApproval(activeApproval.requestId, {
          behavior: 'deny',
          message: 'user denied'
        })
      },
      cyclePreventSleep: () => {
        const next = advancePreventSleep(
          preventSleepMode,
          preventSleepUntil,
          Date.now(),
          backend
        )
        showToast(PREVENT_SLEEP_META[next].toast, next, PREVENT_SLEEP_TOAST_KEY)
      }
    }),
    [
      cycleWorktree,
      switchToWorktreeByIndex,
      switchToBackendByIndex,
      cycleTab,
      activeWorktreeId,
      terminalTabs,
      activeTabId,
      handleAddTerminalTab,
      handleOpenPR,
      handleCloseTab,
      handleRefreshWorktrees,
      prStatuses,
      panes,
      activePaneId,
      handleSplitPane,
      setSidebarVisible,
      setRightColumnHidden,
      setSingleScreenMode,
      setShowNewWorktree,
      setShowCommandCenter,
      setShowCommandPalette,
      setCommandPaletteMode,
      setShowPerfMonitor,
      setShowHotkeyCheatsheet,
      setShowQuakeTerminal,
      quakeTerminalAllowed,
      setShowSettings,
      backend,
      uiScale,
      onStartAliasEdit,
      activeApproval,
      preventSleepMode,
      preventSleepUntil
    ]
  )

  useHotkeys(hotkeyActions, hotkeyOverrides)

  // focusTerminal is a gesture, not a key chord: double-tap Shift to jump
  // focus to the active worktree's current tab. Skip when focus is in an
  // editable field (palette search, rename input, settings, …) so the gesture
  // doesn't yank focus mid-typing — xterm's own hidden textarea counts as
  // editable too, but firing there is a harmless no-op (already focused).
  useDoubleTapShift(
    useCallback(() => {
      if (isEditableTarget(document.activeElement as HTMLElement | null)) return
      hotkeyActions.focusTerminal?.()
    }, [hotkeyActions])
  )

  const resolvedHotkeys = useMemo(() => resolveHotkeys(hotkeyOverrides), [hotkeyOverrides])

  return { hotkeyActions, resolvedHotkeys }
}
