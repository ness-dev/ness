import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, RefreshCw, Loader2, SquareTerminal, FileText, FileDiff, Globe, X, ExternalLink, PanelRightOpen, PanelRightClose, Layers, Rows3, Sparkles, Plus } from 'lucide-react'
import { useWorktrees, usePanes, useTerminals, usePrs, useSettings, useAliases } from '../store'
import { useBackend } from '../backend'
import { getLeaves } from '../../shared/state/terminals'
import type { AgentKind, PtyStatus, TerminalTab, Worktree } from '../types'
import type { ForkSource } from '../../shared/state/worktrees'
import { WorktreeList } from './WorktreeList'
import { NewWorktreeScreen } from './NewWorktreeScreen'
import { useWorktreeCollapse } from '../hooks/useWorktreeCollapse'
import { useWorktreeListModel } from '../hooks/useWorktreeListModel'
import { MobileTerminal } from './MobileTerminal'
import { MobileRightPanel } from './MobileRightPanel'
import { JsonModeChat } from './JsonModeChat'
import { CopyDraftOverlay } from './CopyDraftOverlay'
import { AgentIcon } from './AgentIcon'
import { randomUUID } from '../uuid'
import { HotkeysProvider } from './Tooltip'
import { resolveHotkeys } from '../hotkeys'

type RunnableTab = TerminalTab & { type: 'agent' | 'shell' | 'json-claude' }

const STATUS_DOT: Record<PtyStatus, string> = {
  idle: 'bg-faint',
  processing: 'bg-success',
  waiting: 'bg-warning',
  'needs-approval': 'bg-danger'
}

function flatTabs(panes: ReturnType<typeof usePanes>, wtPath: string): TerminalTab[] {
  const tree = panes[wtPath]
  if (!tree) return []
  return getLeaves(tree).flatMap((l) => l.tabs)
}

function isRunnable(tab: TerminalTab): tab is RunnableTab {
  return tab.type === 'agent' || tab.type === 'shell' || tab.type === 'json-claude'
}

function pickInitialTab(tabs: TerminalTab[]): string | null {
  return (
    tabs.find((t) => t.type === 'agent')?.id ??
    tabs.find((t) => t.type === 'shell')?.id ??
    tabs[0]?.id ??
    null
  )
}

/** Mobile has no CreatingWorktreeScreen to drop onto, so a failed creation is
 *  surfaced as a thrown error that NewWorktreeScreen renders in its inline
 *  error box. The picker can dismiss the leftover pending entry, but reading
 *  the setup log or retrying still needs the desktop. */
function describeCreateFailure(
  result:
    | { outcome: 'setup-failed'; createdPath: string }
    | { outcome: 'error'; error: string }
): string {
  if (result.outcome === 'setup-failed') {
    const name = result.createdPath.split('/').pop() || result.createdPath
    return `Created ${name}, but its setup script failed. Open this repo in the desktop app to read the setup log and continue anyway.`
  }
  return `${result.error} — open the desktop app to retry or dismiss it.`
}

export function MobileApp(): JSX.Element {
  const backend = useBackend()
  const wtState = useWorktrees()
  const panes = usePanes()
  const terminals = useTerminals()
  const prs = usePrs()
  const worktrees = wtState.list
  const [activeWorktreeId, setActiveWorktreeId] = useState<string | null>(
    () => worktrees[0]?.path ?? null
  )
  // Mobile's own per-worktree tab focus. Independent of the desktop
  // pane-level activeTabId: changing the mobile selection shouldn't
  // yank another client's split pane around.
  const [selectedTabByWorktree, setSelectedTabByWorktree] = useState<Record<string, string>>({})
  const [pickerOpen, setPickerOpen] = useState(false)
  // Fullscreen takeover that surfaces the desktop right panel (PR status,
  // branch commits, cost). Per-client UI focus → renderer-local state, not
  // a slice (see CLAUDE.md workflow #5).
  const [rightPanelOpen, setRightPanelOpen] = useState(false)
  const [newWorktreeRepo, setNewWorktreeRepo] = useState<string | undefined>(undefined)
  const [showNewWorktree, setShowNewWorktree] = useState(false)
  const [newWorktreeFocusPath, setNewWorktreeFocusPath] = useState<string | null>(null)

  useEffect(() => {
    if (!activeWorktreeId) return
    if (worktrees.some((w) => w.path === activeWorktreeId)) return
    setActiveWorktreeId(worktrees[0]?.path ?? null)
  }, [activeWorktreeId, worktrees])

  // Focus a freshly-created worktree only once it actually lands in the list.
  // State events reach the renderer before the create IPC resolves, so
  // switching straight off the await lets the reroute effect above bounce
  // focus to worktrees[0] (issue #164). Same deal as useWorktreeHandlers.
  useEffect(() => {
    if (!newWorktreeFocusPath) return
    if (!worktrees.some((w) => w.path === newWorktreeFocusPath)) return
    setActiveWorktreeId(newWorktreeFocusPath)
    setShowNewWorktree(false)
    setNewWorktreeFocusPath(null)
  }, [newWorktreeFocusPath, worktrees])

  useEffect(() => {
    if (!activeWorktreeId) return
    void backend.panesEnsureInitialized(activeWorktreeId)
  }, [activeWorktreeId])

  useEffect(() => {
    void backend.refreshWorktreesList()
    void backend.refreshPRsAllIfStale()
  }, [])

  const activeWorktree = useMemo(
    () => worktrees.find((w) => w.path === activeWorktreeId) ?? null,
    [worktrees, activeWorktreeId]
  )

  const tabs = useMemo(
    () => (activeWorktree ? flatTabs(panes, activeWorktree.path) : []),
    [panes, activeWorktree]
  )

  // If the current mobile selection vanished (tab closed on desktop,
  // worktree switched), fall back to the first sensible tab.
  const selectedTabId = useMemo(() => {
    if (!activeWorktree) return null
    const claimed = selectedTabByWorktree[activeWorktree.path]
    if (claimed && tabs.some((t) => t.id === claimed)) return claimed
    return pickInitialTab(tabs)
  }, [activeWorktree, selectedTabByWorktree, tabs])

  const selectedTab = useMemo(
    () => tabs.find((t) => t.id === selectedTabId) ?? null,
    [tabs, selectedTabId]
  )

  // Rising-edge wake, mirroring the equivalent effect in WorkspaceView.
  // PanesFSM hydrates every persisted json-claude/shell tab as 'asleep',
  // and JsonModeChat skips both the subprocess spawn and the history
  // fetch while slept — so without this a chat that hasn't been focused
  // on desktop since launch renders permanently blank on mobile. Only
  // fires when the selection changes, so a tab slept from another client
  // stays slept.
  const prevSelectedTabRef = useRef<string | null>(null)
  useEffect(() => {
    const prev = prevSelectedTabRef.current
    prevSelectedTabRef.current = selectedTabId
    if (prev === selectedTabId) return
    if (!activeWorktree || !selectedTab) return
    if (selectedTab.type !== 'json-claude' && selectedTab.type !== 'shell') return
    if ((selectedTab.mode ?? 'awake') !== 'asleep') return
    void backend.panesWakeTab(activeWorktree.path, selectedTab.id)
  }, [activeWorktree, selectedTab, selectedTabId])

  const handleSelectWorktree = useCallback((wtPath: string) => {
    setActiveWorktreeId(wtPath)
    setPickerOpen(false)
  }, [])

  const handleSelectTab = useCallback(
    (tabId: string) => {
      if (!activeWorktree) return
      setSelectedTabByWorktree((prev) => ({ ...prev, [activeWorktree.path]: tabId }))
      setPickerOpen(false)
    },
    [activeWorktree]
  )

  const handleAddTab = useCallback(
    (type: 'json-claude' | 'shell') => {
      if (!activeWorktree) return
      const wtPath = activeWorktree.path
      const tree = panes[wtPath]
      const paneId = tree ? getLeaves(tree)[0]?.id : undefined
      // Chat tabs reuse one UUID as both tab id and session id so the
      // session jsonl survives a reload — same as useTabHandlers.
      const sessionId = randomUUID()
      const tab: TerminalTab =
        type === 'json-claude'
          ? { id: sessionId, type: 'json-claude', label: 'Chat', sessionId }
          : { id: `shell-${Date.now()}`, type: 'shell', label: 'Shell' }
      void backend.panesAddTab(wtPath, tab, paneId)
      setSelectedTabByWorktree((prev) => ({ ...prev, [wtPath]: tab.id }))
      setPickerOpen(false)
    },
    [activeWorktree, panes]
  )

  const handleConvertTabType = useCallback(
    (tabId: string, newType: 'agent' | 'json-claude') => {
      if (!activeWorktree) return
      void backend.panesConvertTabType(activeWorktree.path, tabId, newType)
    },
    [activeWorktree]
  )

  const handleOpenNewWorktree = useCallback((repoRoot?: string) => {
    setNewWorktreeRepo(repoRoot)
    setShowNewWorktree(true)
    setPickerOpen(false)
  }, [])

  const handleDismissPendingWorktree = useCallback((id: string) => {
    void backend.dismissPendingWorktree(id)
    setActiveWorktreeId((prev) => (prev === id ? null : prev))
  }, [])

  const handleSubmitNewWorktree = useCallback(
    async (
      repoRoot: string,
      branchName: string,
      initialPrompt: string,
      teleportSessionId?: string,
      agentKind?: AgentKind,
      model?: string,
      checkoutExisting?: boolean,
      baseRef?: string,
      forkSource?: ForkSource
    ) => {
      const result = await backend.runPendingWorktree({
        id: `pending:${randomUUID()}`,
        repoRoot,
        branchName,
        initialPrompt: initialPrompt || undefined,
        teleportSessionId,
        agentKind,
        model,
        forkSource,
        checkoutExisting,
        baseRef
      })
      if (result.outcome !== 'success') throw new Error(describeCreateFailure(result))
      setNewWorktreeFocusPath(result.createdPath)
    },
    []
  )

  const handleSubmitNewPRWorktree = useCallback(
    async (
      repoRoot: string,
      prNumber: number,
      initialPrompt: string,
      agentKind?: AgentKind,
      model?: string
    ) => {
      const result = await backend.runPendingPRWorktree({
        id: `pending:${randomUUID()}`,
        repoRoot,
        prNumber,
        initialPrompt: initialPrompt || undefined,
        agentKind,
        model
      })
      if (result.outcome !== 'success') throw new Error(describeCreateFailure(result))
      setNewWorktreeFocusPath(result.createdPath)
    },
    []
  )

  // HotkeysProvider here is only for its embedded Radix TooltipProvider —
  // shared desktop panels we render on mobile (PR status, merge, etc.)
  // use <Tooltip> which throws without a provider in scope. Bindings
  // don't actually drive any hotkey behavior on mobile.
  return (
    <HotkeysProvider bindings={resolveHotkeys(undefined)}>
    <div
      className="flex flex-col bg-app text-fg overflow-hidden"
      style={{
        // 100dvh = the usable viewport height (without viewport-fit=cover
        // iOS reserves the notch / home-indicator areas for us, so we
        // don't need env(safe-area-inset-*) paddings and our layout
        // fits flush top-to-bottom with no voids). --viewport-h is set
        // by MobileTerminal while the textarea has focus so the
        // toolbar rides above the soft keyboard.
        height: 'var(--viewport-h, 100dvh)'
      }}
    >
      <Header
        worktree={activeWorktree}
        tabs={tabs}
        selectedTabId={selectedTabId}
        statuses={terminals.statuses}
        shellActivity={terminals.shellActivity}
        pickerOpen={pickerOpen}
        onTogglePicker={() => setPickerOpen((v) => !v)}
        onSelectTab={handleSelectTab}
        onAddTab={handleAddTab}
        onConvertTabType={handleConvertTabType}
        rightPanelOpen={rightPanelOpen}
        onToggleRightPanel={activeWorktree ? () => setRightPanelOpen((v) => !v) : undefined}
      />

      <div className="flex-1 min-h-0 relative">
        {activeWorktree && selectedTab && isRunnable(selectedTab) && (
          selectedTab.type === 'json-claude' ? (
            <JsonModeChat
              sessionId={selectedTab.id}
              worktreePath={activeWorktree.path}
              mode={selectedTab.mode ?? 'awake'}
            />
          ) : (
            <MobileTerminal
              worktreePath={activeWorktree.path}
              tab={selectedTab as TerminalTab & { type: 'agent' | 'shell' }}
            />
          )
        )}
        {activeWorktree && selectedTab && (selectedTab.type === 'agent' || selectedTab.type === 'json-claude') && (
          <CopyDraftOverlay terminalId={selectedTab.id} />
        )}
        {activeWorktree && selectedTab && !isRunnable(selectedTab) && (
          <NonRunnableTabPlaceholder tab={selectedTab} />
        )}
        {activeWorktree && !selectedTab && (
          <EmptyScreen message="This worktree has no tabs yet. Open it on desktop to spawn one." />
        )}
        {!activeWorktree && worktrees.length === 0 && (
          <EmptyScreen
            message="No worktrees yet."
            action={{ label: 'New worktree', onClick: () => handleOpenNewWorktree() }}
          />
        )}
        {!activeWorktree && worktrees.length > 0 && (
          <EmptyScreen message="Pick a worktree above to open it." />
        )}

        {pickerOpen && (
          <WorktreePickerSheet
            loading={prs.loading}
            activeWorktreeId={activeWorktreeId}
            onSelect={handleSelectWorktree}
            onClose={() => setPickerOpen(false)}
            onRefresh={() => void backend.refreshPRsAll()}
            onNewWorktree={handleOpenNewWorktree}
            onDismissPendingWorktree={handleDismissPendingWorktree}
          />
        )}

        {showNewWorktree && (
          <div className="absolute inset-0 z-50 flex flex-col bg-app">
            <NewWorktreeScreen
              onSubmit={handleSubmitNewWorktree}
              onPRSubmit={handleSubmitNewPRWorktree}
              onCancel={() => setShowNewWorktree(false)}
              repoRoots={wtState.repoRoots}
              defaultRepoRoot={newWorktreeRepo ?? activeWorktree?.repoRoot}
            />
          </div>
        )}

        {rightPanelOpen && (
          <MobileRightPanel
            activeWorktree={activeWorktree}
            prStatuses={prs.byPath}
            prLoading={prs.loading}
            onClose={() => setRightPanelOpen(false)}
          />
        )}
      </div>
    </div>
    </HotkeysProvider>
  )
}

// -----------------------------------------------------------------------------
// Header: worktree picker button (left) + horizontal flat tab strip (right).
// -----------------------------------------------------------------------------

interface HeaderProps {
  worktree: Worktree | null
  tabs: TerminalTab[]
  selectedTabId: string | null
  statuses: Record<string, PtyStatus>
  shellActivity: Record<string, { active: boolean; processName?: string }>
  pickerOpen: boolean
  onTogglePicker: () => void
  onSelectTab: (tabId: string) => void
  onAddTab: (type: 'json-claude' | 'shell') => void
  /** Tap the active tab to open a Terminal/Chat swap menu. */
  onConvertTabType?: (tabId: string, newType: 'agent' | 'json-claude') => void
  rightPanelOpen: boolean
  onToggleRightPanel?: () => void
}

function Header({ worktree, tabs, selectedTabId, statuses, shellActivity, pickerOpen, onTogglePicker, onSelectTab, onAddTab, onConvertTabType, rightPanelOpen, onToggleRightPanel }: HeaderProps): JSX.Element {
  const aliases = useAliases()
  const repoLabel = worktree ? worktree.repoRoot.split('/').pop() || worktree.repoRoot : null
  return (
    <header className="shrink-0 flex items-stretch border-b border-border bg-panel h-11">
      <button
        onClick={onTogglePicker}
        className={
          'shrink-0 flex items-center gap-1.5 px-3 h-full text-left border-r border-border ' +
          (pickerOpen ? 'bg-surface' : 'hover:bg-panel-raised')
        }
        style={{ maxWidth: '45%' }}
      >
        {worktree ? (
          <>
            <span className="min-w-0 flex flex-col leading-tight">
              <span className="text-xs uppercase tracking-wider text-dim truncate">{repoLabel}</span>
              <span className="text-xs font-medium text-fg-bright truncate">
                {aliases.byPath[worktree.path] ?? (worktree.branch || worktree.path.split('/').pop())}
              </span>
            </span>
            <ChevronDown className={'icon-sm text-dim shrink-0 transition-transform ' + (pickerOpen ? 'rotate-180' : '')} />
          </>
        ) : (
          <span className="inline-flex items-center gap-1 text-sm text-fg">
            Select a worktree
            <ChevronDown className="icon-sm" />
          </span>
        )}
      </button>
      <div className="flex-1 min-w-0 flex items-stretch overflow-x-auto scrollbar-hidden">
        {tabs.map((tab) => {
          const convertible =
            !!onConvertTabType &&
            ((tab.type === 'agent' && tab.agentKind === 'claude') || tab.type === 'json-claude')
          return (
            <TabChip
              key={tab.id}
              tab={tab}
              active={tab.id === selectedTabId}
              status={statuses[tab.id] ?? 'idle'}
              shellActivity={shellActivity[tab.id]}
              onSelect={() => onSelectTab(tab.id)}
              onConvertTabType={
                // With the picker open, a tap on the active tab means
                // "dismiss the picker" — withholding the convert handler
                // makes TabChip fall through to plain select.
                convertible && !pickerOpen
                  ? (newType) => onConvertTabType!(tab.id, newType)
                  : undefined
              }
            />
          )
        })}
        {worktree && (
          <div className="shrink-0 flex items-stretch">
            <button
              onClick={() => onAddTab('json-claude')}
              aria-label="New chat"
              className="shrink-0 inline-flex items-center gap-0.5 px-3 h-full text-dim hover:text-fg hover:bg-panel-raised"
            >
              <AgentIcon kind="claude" className="icon-xs" />
              <Plus className="icon-2xs" />
            </button>
            <button
              onClick={() => onAddTab('shell')}
              aria-label="New shell"
              className="shrink-0 inline-flex items-center gap-0.5 px-3 h-full text-dim hover:text-fg hover:bg-panel-raised"
            >
              <SquareTerminal className="icon-xs" />
              <Plus className="icon-2xs" />
            </button>
          </div>
        )}
      </div>
      {onToggleRightPanel && (
        <button
          onClick={onToggleRightPanel}
          className={
            'shrink-0 inline-flex items-center justify-center w-11 h-full border-l border-border ' +
            (rightPanelOpen ? 'bg-surface text-fg-bright' : 'text-dim hover:text-fg hover:bg-panel-raised')
          }
          aria-label={rightPanelOpen ? 'Close worktree details' : 'Worktree details'}
        >
          {rightPanelOpen ? <PanelRightClose className="icon-base" /> : <PanelRightOpen className="icon-base" />}
        </button>
      )}
    </header>
  )
}

interface TabChipProps {
  tab: TerminalTab
  active: boolean
  status: PtyStatus
  shellActivity?: { active: boolean; processName?: string }
  onSelect: () => void
  /** Tapping the active tab opens a swap menu to convert between
   *  Terminal and Chat. */
  onConvertTabType?: (newType: 'agent' | 'json-claude') => void
}

function TabChip({ tab, active, status, shellActivity, onSelect, onConvertTabType }: TabChipProps): JSX.Element {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('touchstart', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('touchstart', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])
  return (
    <>
      <button
        onClick={(e) => {
          // Tap on the active tab → open the convert menu (mobile
          // equivalent of the desktop right-click). Tap on a
          // background tab just selects it.
          if (active && onConvertTabType) {
            e.stopPropagation()
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
            setMenu({ x: rect.left, y: rect.bottom })
            return
          }
          onSelect()
        }}
        className={
          'shrink-0 flex items-center gap-1.5 px-3 h-full text-xs whitespace-nowrap border-b-2 transition-colors ' +
          (active ? 'border-muted text-fg-bright bg-app' : 'border-transparent text-dim hover:text-fg')
        }
      >
        <TabIcon tab={tab} shellActivity={shellActivity} status={status} />
        <span className="max-w-[140px] truncate">{tab.label}</span>
      </button>
      {menu && onConvertTabType && (
        <div
          className="fixed z-50 bg-panel-raised border border-border-strong rounded shadow-lg text-xs py-1 min-w-[14rem]"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
        >
          {tab.type === 'agent' ? (
            <button
              className="block w-full text-left px-3 py-2 hover:bg-panel text-fg-bright"
              onClick={(e) => {
                e.stopPropagation()
                setMenu(null)
                onConvertTabType('json-claude')
              }}
            >
              Switch to Chat mode
            </button>
          ) : (
            <button
              className="block w-full text-left px-3 py-2 hover:bg-panel text-fg-bright"
              onClick={(e) => {
                e.stopPropagation()
                setMenu(null)
                onConvertTabType('agent')
              }}
            >
              Switch to Terminal mode
            </button>
          )}
        </div>
      )}
    </>
  )
}

function TabIcon({ tab, shellActivity, status }: { tab: TerminalTab; shellActivity?: { active: boolean; processName?: string }; status: PtyStatus }): JSX.Element {
  if (tab.type === 'agent') {
    return (
      <span className="inline-flex items-center gap-1">
        <AgentIcon kind={tab.agentKind ?? 'claude'} className="icon-xs" />
        <span className={'w-1.5 h-1.5 rounded-full ' + STATUS_DOT[status]} />
      </span>
    )
  }
  if (tab.type === 'shell') {
    return shellActivity?.active ? (
      <Loader2 className="icon-xs animate-spin text-fg-bright" />
    ) : (
      <SquareTerminal className="icon-xs text-dim" />
    )
  }
  if (tab.type === 'json-claude') {
    return (
      <span className="inline-flex items-center gap-1">
        <AgentIcon kind="claude" className="icon-xs" />
        <span className="w-1.5 h-1.5 rounded-full bg-accent" />
      </span>
    )
  }
  if (tab.type === 'diff') return <FileDiff className="icon-xs text-dim" />
  if (tab.type === 'file') return <FileText className="icon-xs text-dim" />
  if (tab.type === 'browser') return <Globe className="icon-xs text-dim" />
  return <span />
}

// -----------------------------------------------------------------------------
// Worktree picker sheet — full-body overlay below the header. The body is the
// shared WorktreeList in its touch variant, so it stays in lockstep with the
// desktop sidebar.
// -----------------------------------------------------------------------------

interface WorktreePickerSheetProps {
  loading: boolean
  activeWorktreeId: string | null
  onSelect: (path: string) => void
  onClose: () => void
  onRefresh: () => void
  onNewWorktree: (repoRoot?: string) => void
  onDismissPendingWorktree: (id: string) => void
}

function WorktreePickerSheet({
  loading,
  activeWorktreeId,
  onSelect,
  onClose,
  onRefresh,
  onNewWorktree,
  onDismissPendingWorktree
}: WorktreePickerSheetProps): JSX.Element {
  const collapse = useWorktreeCollapse()
  // Touch doesn't bind Cmd+N, so the model skips ordinal assignment and no
  // hotkey badges render.
  const model = useWorktreeListModel(collapse, { assignOrdinals: false })
  const snoozeDefaultDays = useSettings().snoozeDefaultDays
  const repoCount = useWorktrees().repoRoots.length
  const [editingAliasPath, setEditingAliasPath] = useState<string | null>(null)

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-app">
      <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-border bg-panel">
        <span className="text-xs uppercase tracking-wider text-dim font-semibold">Worktrees</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => collapse.setUnifiedRepos((v) => !v)}
            disabled={repoCount <= 1}
            className="inline-flex items-center justify-center w-11 h-11 rounded text-dim active:bg-surface disabled:opacity-40 disabled:active:bg-transparent"
            aria-label={collapse.unifiedRepos ? 'Split by repo' : 'Merge repos into one list'}
          >
            {collapse.unifiedRepos ? <Rows3 className="icon-base" /> : <Layers className="icon-base" />}
          </button>
          <button
            onClick={onRefresh}
            className="inline-flex items-center justify-center w-11 h-11 rounded text-dim active:bg-surface"
            aria-label="Refresh"
          >
            {loading ? <Loader2 className="icon-base animate-spin" /> : <RefreshCw className="icon-base" />}
          </button>
          <button
            onClick={onClose}
            className="inline-flex items-center justify-center w-11 h-11 rounded text-dim active:bg-surface"
            aria-label="Close"
          >
            <X className="icon-base" />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        <WorktreeList
          model={model}
          variant="touch"
          activeWorktreeId={activeWorktreeId}
          snoozeDefaultDays={snoozeDefaultDays}
          agentCount={model.totalWorktrees}
          editingAliasPath={editingAliasPath}
          onStartAliasEdit={setEditingAliasPath}
          onEndAliasEdit={() => setEditingAliasPath(null)}
          onSelectWorktree={onSelect}
          onToggleGroup={collapse.toggleGroup}
          onToggleRepo={collapse.toggleRepo}
          onNewWorktree={onNewWorktree}
          onDismissPendingWorktree={onDismissPendingWorktree}
        />
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Fallback body content for non-runnable tabs (diff/file/browser) — mobile
// can't render them meaningfully, so we point the user back to desktop
// with a deep-link affordance where it makes sense.
// -----------------------------------------------------------------------------

function NonRunnableTabPlaceholder({ tab }: { tab: TerminalTab }): JSX.Element {
  const label =
    tab.type === 'diff' ? 'Diff view' :
    tab.type === 'file' ? 'File view' :
    tab.type === 'browser' ? 'Browser tab' : 'This tab'
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="text-sm text-fg-bright">{label} — desktop only</div>
      <div className="text-xs text-dim max-w-xs">
        {tab.label}
      </div>
      {tab.type === 'browser' && tab.url && (
        <a
          href={tab.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-accent underline"
        >
          <ExternalLink className="icon-xs" /> Open URL in browser
        </a>
      )}
    </div>
  )
}

function EmptyScreen({
  message,
  action
}: {
  message: string
  action?: { label: string; onClick: () => void }
}): JSX.Element {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4 px-6 text-center text-dim text-sm">
      {message}
      {action && (
        <button
          onClick={action.onClick}
          className="brand-gradient-bg text-white font-semibold text-sm px-5 min-h-11 rounded-lg inline-flex items-center gap-2 shadow-lg"
        >
          <Sparkles className="icon-sm" />
          {action.label}
        </button>
      )}
    </div>
  )
}
