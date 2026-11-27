import { useState, useEffect, useCallback, useRef, useMemo, useOptimistic, startTransition, lazy, Suspense } from 'react'
import { NessMark } from './components/NessMark'
import { pickActiveAnnouncement } from '../shared/announcement-pick'
import { LOCAL_BACKEND_ID, useAppState, useLocalAppState, useActiveBackend, useAllBackendStatesSelector, selectHistoryPromptRepos, useSettings, usePrs, useOnboarding, useHooks, useWorktrees, useTerminals, usePanes, useLastActive, useUpdater, useRepoConfigs, useAnnouncements, useAssignedPRs, useConfigLoadError, useAliasForWorktree } from './store'
import { getBackendFor } from './backend'
import { useGlobalBackend, useBackendForWorktree } from './backend-routing'
import { useTabHandlers } from './hooks/useTabHandlers'
import { useHotkeyHandlers } from './hooks/useHotkeyHandlers'
import { useWorktreeHandlers } from './hooks/useWorktreeHandlers'
import { useTabHistory } from './hooks/useTabHistory'
import { useWorktreeCollapse } from './hooks/useWorktreeCollapse'
import { useProjectAccordion, useTabsByWorktree, useWorktreeListBase } from './hooks/useWorktreeListModel'
import type { Worktree, TerminalTab, PtyStatus, PendingWorktree, UpdaterStatus, RepoConfig, PaneNode, ForkSource, AgentKind } from './types'
import { getLeaves, findLeaf, findLeafByTabId } from '../shared/state/terminals'
import { CheckCircle2, FolderOpen, Loader2 } from 'lucide-react'
import { BUILT_IN_THEMES_BY_MODE } from './themes'
import { SCALES, scaleSpec } from '../shared/state/settings'
import { useActiveTheme } from './hooks/useActiveTheme'
import { useHoldToQuit } from './hooks/useHoldToQuit'
import { applyTheme, effectiveAppBg } from './theme-apply'
import { getBackend } from './backend'
import { HotkeysProvider, Tooltip } from './components/Tooltip'
import { Sidebar } from './components/Sidebar'
import { ResizeHandle } from './components/ResizeHandle'
import { AppTitleSegment } from './components/AppTitleSegment'
import { NewWorktreeScreen, onOpenForkIntoWorktree } from './components/NewWorktreeScreen'
import { CreatingWorktreeScreen } from './components/CreatingWorktreeScreen'
import { DeletingWorktreeScreen } from './components/DeletingWorktreeScreen'
import { FirstRunTour } from './components/FirstRunTour'
import { CenterEmptyState, centerEmptyMode } from './components/CenterEmptyState'
import { pickInitialWorktree } from './initial-worktree'
import { WorkspaceView } from './components/WorkspaceView'
import { QuakeTerminal } from './components/QuakeTerminal'
import { RightColumn } from './components/RightColumn'
import { BackendScope } from './backend-scope'
import { repoKeyFor } from './worktree-list-model'
import { useMergedWorktrees, useFleetWorktrees } from './hooks/useMergedWorktrees'
import { closeTabConfirmReason } from './close-tab-guard'
import { getFleetWorktreeLists } from './merge-backend-states'
import { CollapsedSidebar } from './components/CollapsedSidebar'
import { CollapsedRightPanel } from './components/CollapsedRightPanel'
import { Settings } from './components/Settings'
import { WeeklyWrappedScreen } from './components/WeeklyWrappedScreen'
import { Guide } from './components/Guide'
import { AGENT_REGISTRY, getAgentInfo, supportsChat } from '../shared/agent-registry'
import { defaultSelectedRepoRoots, type DiscoveredWork } from '../shared/work-discovery'
import { ImportWorkStep } from './components/ImportWorkStep'
import { AgentIcon } from './components/AgentIcon'
import { Activity } from './components/Activity'
import { Cleanup } from './components/Cleanup'
// Lazy: React Flow + ELK are only needed once someone opens the graph.
const SubscriptionGraphView = lazy(() => import('./components/SubscriptionGraphView'))
import { CommandPalette } from './components/CommandPalette'
import { HotkeyCheatsheet } from './components/HotkeyCheatsheet'
import { NewProjectScreen } from './components/NewProjectScreen'
import { RemoteFilePicker } from './components/RemoteFilePicker'
import { ResolveRepoModal } from './components/ResolveRepoModal'
import { RepoAddErrorModal } from './components/RepoAddErrorModal'
import { ReportIssueScreen, onOpenReportIssue, type OpenReportIssueDetail } from './components/ReportIssueScreen'
import { AddBackendModal } from './components/AddBackendModal'
import { InvalidConfigModal } from './components/InvalidConfigModal'
import { MonacoWorkerFailedBanner } from './components/MonacoWorkerFailedBanner'
import { HistoryTrackingExplainer } from './components/HistoryTrackingExplainer'
import { PerfMonitorHUD } from './components/PerfMonitorHUD'
import { GitHubApiLogPanel } from './components/GitHubApiLogPanel'
import { HoldToQuitOverlay } from './components/HoldToQuitOverlay'
import { ConfirmCloseTabModal } from './components/ConfirmCloseTabModal'
import { Toasts } from './components/Toasts'
import { focusTerminalById } from './components/XTerminal'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useViewport } from './hooks/useViewport'
import { MobileApp } from './components/MobileApp'
import { harnessReleaseNotesUrl } from '../shared/constants'
import { windowControlsKind } from './window-controls'
import { setNotchInset } from './notch'

function isPendingId(id: string | null | undefined): id is string {
  return typeof id === 'string' && id.startsWith('pending:')
}

// Distance from the window's left edge to the start of the workspace
// top-bar content — clears the macOS traffic lights. Also the left edge of
// the "Ness" title segment when it sits above the sidebar.
const TITLE_LEADING_PX = 80

const WINDOW_CONTROLS = windowControlsKind()

// Set at module load — before first paint — by both the Electron and the
// web-client entry, which share only App. Drives the titlebar clearance
// overrides in styles.css.
if (typeof document !== 'undefined') {
  document.documentElement.dataset.windowControls = WINDOW_CONTROLS
}

// Static cap for the sidebar's resizable width. The title segment above the
// sidebar fills whatever width is chosen, so the cap is a pure UX choice,
// not an architectural one.
const SIDEBAR_MAX_PX = 400

// Top-level dispatcher. The desktop tree is large and stateful — we keep
// it isolated in `DesktopApp` so a viewport flip (mobile↔desktop) doesn't
// change React's hook order on this outer component. Theme application
// lives here (not inside DesktopApp) so the mobile branch honors the
// user's theme choice too — the setting is shared state driven from
// main, so we only need one subscriber.
export default function App(): JSX.Element {
  const { isMobile } = useViewport()
  const active = useActiveTheme()
  // Narrow selector, not useSettings() — App re-rendering re-renders the
  // whole tree beneath it (DesktopApp is not memoized), so it must not
  // subscribe to the entire settings slice. useActiveTheme above narrows
  // for the same reason; before it did, it subscribed to the whole slice
  // and this selector saved nothing.
  //
  // Local rather than active: nessieColor is client-owned (see
  // CLIENT_OWNED_SETTING_KEYS), so it must not change when the user
  // switches to a remote backend.
  const nessieColor = useLocalAppState((s) => s.settings.nessieColor)
  useEffect(() => {
    applyTheme(active, nessieColor)
    getBackend().setLastEffectiveAppBg(effectiveAppBg(active))
  }, [active, nessieColor])
  if (isMobile) return <MobileApp />
  return <DesktopApp />
}

function DesktopApp(): JSX.Element {
  // Multi-backend RPC surface — routes through the active backend's
  // transport (local IPC handle for local, WS direct for remotes).
  //
  // Narrowed: App renders above every BackendScope, so this handle must not
  // be able to reach worktree-scoped methods. Those go through
  // `backendFor(path)` below. See backend-routing.ts.
  const backend = useGlobalBackend()
  // Which backend the mounted worktree subtrees belong to. Every row in
  // `worktrees` below was read out of this backend's store, so this is the
  // id their panes must route through — see the BackendScope in the
  // worktree map.
  const activeBackendId = useActiveBackend().id
  // Worktrees from every registered backend, each tagged with its owner.
  // The sidebar model is built from the same merged inputs (see
  // useWorktreeListModel), so rows and mounted workspaces can't disagree
  // about which backends exist.
  const mergedData = useMergedWorktrees()
  const fleetData = useFleetWorktrees()
  // Routes a per-worktree call to the backend hosting that worktree.
  // App has no ambient handle that can reach these methods — see
  // backend-routing.ts for why.
  const backendFor = useBackendForWorktree(fleetData.pathBackendId)
  // Backend label per worktree path, for rows that aren't on this machine.
  // Local ones are deliberately absent — badging the common case is noise,
  // and the badge's job is to make "this acts on another machine" obvious
  // before you act, not to annotate everything.
  // Host label per repo root for the new-worktree picker — in fleet view
  // the same repo can be open on several hosts, and picking the pill is
  // picking the host.
  const hostLabelByRoot = useMemo(() => {
    const out: Record<string, string> = {}
    for (const [root, backendId] of Object.entries(mergedData.repoBackendId)) {
      out[root] = mergedData.backendMeta[backendId]?.label ?? backendId
    }
    return out
  }, [mergedData.repoBackendId, mergedData.backendMeta])
  const repoKeyByRoot = useMemo(() => {
    const out: Record<string, string> = {}
    for (const root of mergedData.repoRoots) out[root] = repoKeyFor(root, mergedData.repoRemotes[root])
    return out
  }, [mergedData.repoRoots, mergedData.repoRemotes])
  const originByPath = useMemo(() => {
    const out: Record<string, string> = {}
    for (const { backendId, backendLabel, worktree } of mergedData.worktrees) {
      // Keyed on the registry's local entry, NOT on connection `kind`. In
      // the web client the serving backend is registered kind:'remote'
      // (it genuinely is, over a socket), so a kind test badges every row
      // including the one you're attached to — noise, and it buries the
      // signal the badge exists to carry.
      if (backendId === LOCAL_BACKEND_ID) continue
      out[worktree.path] = backendLabel || backendId
    }
    return out
  }, [mergedData.worktrees])
  // Worktrees the user has actually opened this session, keyed the same way
  // the render loop keys its rows.
  //
  // Mounting every worktree keeps PTYs alive across switches, which is right
  // for local ones — the processes are already on this machine. It is NOT
  // right across a network: mounting a remote worktree fires pty:create on
  // ITS backend, so mounting all of them at once asks a remote to spawn a
  // shell and an agent for every worktree it hosts the moment we connect.
  // On a large fleet that is enough to take the box down, which it did.
  // Remote worktrees therefore mount on first open and stay mounted after.
  const [openedWorktrees, setOpenedWorktrees] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  // Forget worktrees that no longer exist anywhere in the fleet (deleted,
  // or their backend removed). Pruned against ALL backends, not the
  // view-filtered list, so flipping to single view doesn't forget which
  // remote worktrees were open. Without this, a worktree recreated at the
  // same path — or a backend re-added — would mount eagerly on reappearance
  // without the user opening it: the fan-out this set exists to prevent.
  // Subscribes to the worktree LISTS alone, not every backend's state:
  // holding the full states re-rendered App on every streamed chat token
  // from any host. This only changes when some backend's list does.
  const fleetWorktreeLists = useAllBackendStatesSelector(getFleetWorktreeLists)
  // loch history tracking: which repos get the sidebar nudge, and which one's
  // full-screen explainer is open (per-client UI focus, so plain state).
  const historyPromptRepos = useAllBackendStatesSelector(selectHistoryPromptRepos)
  const [historyTrackingRepo, setHistoryTrackingRepo] = useState<string | null>(null)
  const dismissHistoryPrompt = useCallback(
    (repoRoot: string) => {
      void getBackendFor(mergedData.repoBackendId[repoRoot] ?? null).setLochPromptDismissed(repoRoot, true)
    },
    [mergedData.repoBackendId]
  )
  useEffect(() => {
    setOpenedWorktrees((prev) => {
      if (prev.size === 0) return prev
      const live = new Set<string>()
      for (const b of fleetWorktreeLists) {
        for (const w of b.value) live.add(`${b.backendId}\u0000${w.path}`)
      }
      let next: Set<string> | null = null
      for (const key of prev) {
        if (!live.has(key)) {
          next ??= new Set(prev)
          next.delete(key)
        }
      }
      return next ?? prev
    })
  }, [fleetWorktreeLists])
  // Worktree list, repoRoots, and pending-creation FSM all live in the
  // main-process store. activeWorktreeId stays local — it's per-client view
  // focus that eventually becomes per-window.
  //
  // These read the MERGED list, not the active backend's. Leaving them
  // active-scoped silently broke selecting a remote row: the
  // "active id points at something that no longer exists" guard below
  // validates activeWorktreeId against this array, so a remote worktree's
  // path looked stale the instant it was selected and got reset back.
  const worktrees = mergedData.flatWorktrees
  const pendingWorktrees = mergedData.pendingWorktrees
  const pendingDeletions = mergedData.pendingDeletions
  const pendingDeletionByPath = useMemo(() => {
    const m: Record<string, (typeof pendingDeletions)[number]> = {}
    for (const d of pendingDeletions) m[d.path] = d
    return m
  }, [pendingDeletions])
  const worktreeRepoByPath = useMemo(() => {
    const m: Record<string, string> = {}
    for (const w of worktrees) m[w.path] = w.repoRoot
    return m
  }, [worktrees])
  // Initial focus = first worktree in the already-hydrated store.
  const [activeWorktreeId, setActiveWorktreeId] = useState<string | null>(
    () => worktrees[0]?.path ?? null
  )
  // Switching worktrees re-renders the newly shown workspace and right
  // column, which can take a few frames. The sidebar reads this optimistic
  // copy so its highlight moves on the first frame, while the real switch
  // renders in a transition behind it.
  const [sidebarActiveId, setSidebarActiveId] = useOptimistic(activeWorktreeId)
  // Which backend the SELECTED worktree belongs to. Distinct from
  // `activeBackendId` above: that's whose rows are currently listed, this
  // is whose worktree is open. They're the same today, because the sidebar
  // only lists one backend's worktrees — once rows merge across backends
  // they diverge, and every read describing the open worktree has to follow
  // this one rather than the chip.
  //
  // A path is only unique WITHIN a backend, so this is the other half of
  // the worktree's identity, not a convenience.
  // DERIVED, never stored. Every path that changes the selected worktree
  // would otherwise have to remember to update a stored copy, and six of
  // them didn't: hotkey cycling (x2), the old Command Center, Command Palette,
  // "go to main", and the stale-focus reset. Each left the chrome reading
  // a different backend than the one hosting the open worktree.
  //
  // The owner map is the single source of truth, so selecting a worktree
  // by ANY route now implies its backend. Ambiguous only when two backends
  // share an absolute path — the known composite-identity gap.
  const selectedBackendId =
    (activeWorktreeId ? fleetData.pathBackendId[activeWorktreeId] : undefined) ??
    activeBackendId
  const switchWorktree = useCallback(
    (path: string, alsoInTransition?: () => void) => {
      startTransition(() => {
        setSidebarActiveId(path)
        setActiveWorktreeId(path)
        alsoInTransition?.()
      })
    },
    [setSidebarActiveId]
  )
  const activeAlias = useAliasForWorktree(selectedBackendId, activeWorktreeId)
  useEffect(() => {
    if (!activeWorktreeId) {
      document.title = 'Ness'
      return
    }
    const wt = worktrees.find((w) => w.path === activeWorktreeId)
    if (!wt) {
      document.title = 'Ness'
      return
    }
    const label = activeAlias ?? wt.branch
    document.title = `${label} — Ness`
  }, [activeWorktreeId, activeAlias, worktrees])
  const [editingAliasPath, setEditingAliasPath] = useState<string | null>(null)
  // Pane / tab tree lives in the main-process store; the renderer reads it
  // and dispatches every mutation as an IPC method call. Per-client UI
  // focus (which pane in each worktree the user last interacted with) is
  // still renderer-local — like activeWorktreeId.
  // Pane trees across ALL backends. `usePanes()` would be the active
  // backend's slice only, which silently breaks every cross-backend lookup
  // below: `activeWorkspaceVisible` would find no tree for a remote
  // worktree and render the empty-center fallback at the
  // same time as the workspace it claims isn't there.
  const panes = mergedData.panes
  const [activePaneId, setActivePaneId] = useState<Record<string, string>>({})

  // Derived flat-tab views — preserved so the read-heavy parts of the app
  // (status aggregation, hotkeys, PR refresh) don't need pane awareness.
  const terminalTabs = useTabsByWorktree()
  const activeTabId = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {}
    for (const [wtPath, tree] of Object.entries(panes)) {
      const leaves = getLeaves(tree)
      const focusedId = activePaneId[wtPath] ?? leaves[0]?.id
      const focused = findLeaf(tree, focusedId) || leaves[0]
      if (focused) out[wtPath] = focused.activeTabId
    }
    return out
  }, [panes, activePaneId])
  const focusedTabId = activeWorktreeId ? activeTabId[activeWorktreeId] ?? null : null
  // Per-terminal status/pendingTool/shellActivity all live in the
  // main-process store. Hooks in main/hooks.ts (status) and
  // main/pty-manager.ts (shellActivity, exit) dispatch through the store;
  // we read via useTerminals().
  const terminals = useTerminals()
  const statuses = terminals.statuses
  const pendingTools = terminals.pendingTools
  const shellActivity = terminals.shellActivity
  // PR state lives in the main-process store (see src/main/pr-poller.ts).
  // Polling, on-focus refresh, and stale dedup all live there.
  const prs = usePrs()
  const prStatuses = prs.byPath
  const mergedPaths = prs.mergedByPath
  const prLoading = prs.loading
  // Per-worktree last-active timestamps — derived in main by the
  // activity-deriver, dispatched as terminals/lastActiveChanged events.
  const lastActive = useLastActive()
  const repoRoots = mergedData.repoRoots
  // Per-repo config lives in the main-process store. Active repo derived
  // below from the focused worktree.
  const repoConfigs = useRepoConfigs()
  // Map of worktree path → repoRoot for quick lookups outside of `worktrees`.
  // Populated whenever the worktree list refreshes.
  // Hooks consent lives in the main-process store. Accept/decline
  // dispatch through dedicated methods; the boot-time "already installed?"
  // detection lives in main.
  const { consent: hooksConsent } = useHooks()
  // Step 3's history half only makes sense where loch exists or Ness can
  // download it for this platform.
  const historyOffered = useAppState((s) => s.loch.available || s.loch.installable)
  // Form draft for step 3's history checkbox until "Install hooks" applies it.
  const [recordHistoryDraft, setRecordHistoryDraft] = useState(true)
  const updaterStatus = useUpdater().status
  const [updateBannerDismissed, setUpdateBannerDismissed] = useState(false)
  const [manualUpdateBannerDismissed, setManualUpdateBannerDismissed] = useState(false)
  const announcements = useAnnouncements()
  const assignedPRs = useAssignedPRs()
  const [announcementsMenuOpen, setAnnouncementsMenuOpen] = useState(false)
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [singleScreenMode, setSingleScreenMode] = useState(false)
  // macOS hides the traffic lights in native fullscreen — main pushes the
  // boolean so we can drop the 80px Ness-header leading clearance.
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem('harness:sidebarWidth'))
    return Number.isFinite(saved) && saved > 0 ? saved : 224
  })
  const [rightPanelWidth, setRightPanelWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem('harness:rightPanelWidth'))
    return Number.isFinite(saved) && saved > 0 ? saved : 256
  })
  const [rightColumnHidden, setRightColumnHidden] = useState<boolean>(() => {
    return localStorage.getItem('harness:rightColumnHidden') === '1'
  })
  useEffect(() => {
    localStorage.setItem('harness:rightColumnHidden', rightColumnHidden ? '1' : '0')
  }, [rightColumnHidden])
  useEffect(() => {
    localStorage.setItem('harness:sidebarWidth', String(sidebarWidth))
  }, [sidebarWidth])
  useEffect(() => {
    localStorage.setItem('harness:rightPanelWidth', String(rightPanelWidth))
  }, [rightPanelWidth])
  const collapse = useWorktreeCollapse()
  const {
    setCollapsedGroups,
    unifiedRepos,
    setUnifiedRepos,
    isGroupCollapsed,
    toggleGroup,
    togglePinnedOpen
  } = collapse
  // Two halves: hotkeys only need order + grouping, so they read the base
  // and don't rebuild their action map on every worktree switch.
  const worktreeListBase = useWorktreeListBase(collapse)
  const worktreeListModel = useProjectAccordion(worktreeListBase, activeWorktreeId, collapse.pinnedOpenRepos)
  // The palette groups by status; within a group, list worktrees in sidebar
  // order so a dragged project order carries over.
  const paletteWorktrees = useMemo(() => {
    const rank = new Map(worktreeListBase.orderedPaths.map((p, i) => [p, i]))
    return [...worktrees].sort((a, b) => (rank.get(a.path) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.path) ?? Number.MAX_SAFE_INTEGER))
  }, [worktrees, worktreeListBase.orderedPaths])
  const handleSidebarResize = useCallback((delta: number) => {
    setSidebarWidth((w) => Math.max(160, Math.min(SIDEBAR_MAX_PX, w + delta)))
  }, [])
  const handleRightPanelResize = useCallback((delta: number) => {
    setRightPanelWidth((w) => Math.max(180, Math.min(600, w - delta)))
  }, [])
  // A stored width from before the static cap is clamped down here so the
  // rendered sidebar respects the current max.
  const effectiveSidebarWidth = Math.min(sidebarWidth, SIDEBAR_MAX_PX)
  const [showNewWorktree, setShowNewWorktree] = useState(false)
  // Set by the sidebar "+" to pre-pick a repo; transient — cleared on close so
  // the next open (e.g. cmd+N) defaults to the active worktree's repo instead.
  const [newWorktreeRepo, setNewWorktreeRepo] = useState<string | undefined>(undefined)
  // Set by clicking a phantom "review-requested" entry in the sidebar so
  // the "new worktree from PR" screen opens with that PR pre-selected.
  // Cleared alongside the repo when the modal closes.
  const [newWorktreeInitialPRNumber, setNewWorktreeInitialPRNumber] = useState<number | undefined>(undefined)
  const [newWorktreeForkSource, setNewWorktreeForkSource] = useState<ForkSource | undefined>(undefined)
  // Set by "Build a custom tool" in the right column so the screen opens
  // with a branch name and kickoff prompt already filled in. Same
  // transient lifetime as the two above.
  const [newWorktreePrefill, setNewWorktreePrefill] = useState<
    { branch: string; prompt: string } | undefined
  >(undefined)
  useEffect(() => {
    if (!showNewWorktree) {
      setNewWorktreeRepo(undefined)
      setNewWorktreeInitialPRNumber(undefined)
      setNewWorktreeForkSource(undefined)
      setNewWorktreePrefill(undefined)
    }
  }, [showNewWorktree])
  // Chat's "Fork into new worktree" opens the create screen with the
  // conversation queued up; main copies the transcript once the worktree
  // exists on disk.
  useEffect(() => {
    return onOpenForkIntoWorktree((source) => {
      setShowActivity(false)
      setShowCleanup(false)
      setNewWorktreeRepo(worktreeRepoByPath[source.worktreePath])
      setNewWorktreeForkSource(source)
      setShowNewWorktree(true)
    })
  }, [worktreeRepoByPath])
  const handleOpenAssignedPR = useCallback((repoRoot: string, prNumber: number) => {
    setShowActivity(false)
    setShowCleanup(false)
    setNewWorktreeRepo(repoRoot)
    setNewWorktreeInitialPRNumber(prNumber)
    setShowNewWorktree(true)
  }, [])
  // Worktrees whose git creation is still running (or has errored). They
  // show in the sidebar immediately on submit so the user sees the new entry
  // right away instead of waiting on the modal.
  const [showSettings, setShowSettings] = useState(false)
  const [settingsInitialSection, setSettingsInitialSection] = useState<'github' | undefined>(undefined)
  const [showGuide, setShowGuide] = useState(false)
  const [showMyWeek, setShowMyWeek] = useState(false)
  const [showActivity, setShowActivity] = useState(false)
  const [showCleanup, setShowCleanup] = useState(false)
  /** Repo the subscription graph is showing, or null when it's closed. */
  const [graphRepo, setGraphRepo] = useState<string | null>(null)
  const [showCommandPalette, setShowCommandPalette] = useState(false)
  const [commandPaletteMode, setCommandPaletteMode] = useState<'root' | 'files'>('root')
  const [showPerfMonitor, setShowPerfMonitor] = useState(false)
  const [showGitHubApiLog, setShowGitHubApiLog] = useState(false)
  const [showHotkeyCheatsheet, setShowHotkeyCheatsheet] = useState(false)
  const holdToQuit = useHoldToQuit()
  const [showQuakeTerminal, setShowQuakeTerminal] = useState(false)
  const [showNewProject, setShowNewProject] = useState(false)
  const [reportIssueState, setReportIssueState] = useState<OpenReportIssueDetail | null>(null)
  const [showAddBackend, setShowAddBackend] = useState(false)
  // Dev-only: forces the welcome / onboarding form to render even when
  // the user already has repos added, so the layout can be inspected
  // without wiping `userData/config.json`. Toggled from Help → Debug:
  // Preview Onboarding (gated `!app.isPackaged`).
  const [previewOnboarding, setPreviewOnboarding] = useState(false)
  const [crashedTabIds, setCrashedTabIds] = useState<ReadonlySet<string>>(() => new Set())
  // `theme` and `defaultAgent` are both seeded at init, so we track
  // explicit confirmation separately for the onboarding step checkmarks.
  const [themeChosen, setThemeChosen] = useState(false)
  const [agentChosen, setAgentChosen] = useState(false)
  // Onboarding import. The scan result is a picker for this one wizard —
  // per-client form state, not something another viewer needs to mirror.
  const [existingWork, setExistingWork] = useState<DiscoveredWork | null>(null)
  const [workScanned, setWorkScanned] = useState(false)
  const [importSelection, setImportSelection] = useState<ReadonlySet<string>>(() => new Set())
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  // The agent step was answered from the scan rather than by a click.
  const [agentInferred, setAgentInferred] = useState(false)
  const [importFocusPath, setImportFocusPath] = useState<string | null>(null)
  // Land on the worktree the user touched last, once the imported list
  // has reached this client.
  useEffect(() => {
    if (!importFocusPath) return
    if (!worktrees.some((w) => w.path === importFocusPath)) return
    setActiveWorktreeId(importFocusPath)
    setImportFocusPath(null)
  }, [importFocusPath, worktrees])
  const onboardingVisible = mergedData.repoRoots.length === 0 || previewOnboarding
  const workScanStarted = useRef(false)
  useEffect(() => {
    if (!onboardingVisible) {
      workScanStarted.current = false
      return
    }
    if (workScanStarted.current) return
    workScanStarted.current = true
    setWorkScanned(false)
    const scanStartedAt = Date.now()
    backend
      .scanExistingWork()
      .then((work) => {
        setExistingWork(work)
        setImportSelection(new Set(defaultSelectedRepoRoots(work.repos, work.scannedAt)))
        if (work.suggestedAgent && (work.mayPreselectAgent || previewOnboarding)) {
          // Someone with a history of Claude or Codex sessions has already
          // told us which agent they use. Chat is the interface we steer
          // toward; the TUI stays one click away in the step itself.
          // Only on a genuine first run: this screen also shows for an
          // existing user with no repos left, whose settings are theirs.
          // Preview mode must not rewrite the real settings just by opening.
          if (!previewOnboarding) {
            void backend.setDefaultAgent(work.suggestedAgent)
            void backend.setDefaultClaudeTabType('json')
          }
          setAgentInferred(true)
          setAgentChosen(true)
        }
      })
      .catch(() => setExistingWork(null))
      .finally(() => {
        // The scan usually returns in well under a second. Hold the status
        // row long enough to read, so it doesn't register as a flicker.
        const remaining = 900 - (Date.now() - scanStartedAt)
        window.setTimeout(() => setWorkScanned(true), Math.max(0, remaining))
      })
  }, [onboardingVisible, previewOnboarding, backend])
  const settings = useSettings()
  const { hasGithubToken: hasGithubPat, githubAuthSource, nameClaudeSessions, defaultAgent } = settings
  // Apply the persisted UI scale to the root html element so every
  // rem-based size (text-xs/sm/base/lg, w-N/h-N icons, padding-*) shifts
  // in lockstep. See SCALES in shared/state/settings.ts for the table.
  useEffect(() => {
    const px = scaleSpec(settings.uiScale).rootPx
    document.documentElement.style.fontSize = `${px}px`
    return () => {
      document.documentElement.style.fontSize = ''
    }
  }, [settings.uiScale])
  // Transient "Resize: <label>" toast in the upper center whenever the UI
  // scale changes. Per-client ephemeral UI, so local state — not a slice.
  // prevUiScaleRef seeds to the current value so we don't toast on mount.
  const [resizeToast, setResizeToast] = useState<string | null>(null)
  const resizeToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevUiScaleRef = useRef(settings.uiScale)
  useEffect(() => {
    if (settings.uiScale === prevUiScaleRef.current) return
    prevUiScaleRef.current = settings.uiScale
    setResizeToast(scaleSpec(settings.uiScale).label)
    if (resizeToastTimer.current) clearTimeout(resizeToastTimer.current)
    resizeToastTimer.current = setTimeout(() => setResizeToast(null), 1200)
    return () => {
      if (resizeToastTimer.current) clearTimeout(resizeToastTimer.current)
    }
  }, [settings.uiScale])
  const activeTheme = useActiveTheme()
  const nameAgentSessions = nameClaudeSessions
  const hasGithubToken = hasGithubPat || !!githubAuthSource
  const hotkeyOverrides = settings.hotkeys ?? undefined
  // First-run tour (see FirstRunTour.tsx). Progress lives in the main
  // store, which also decides every transition but the user's clicks; this
  // client only places the popouts.
  const { tour } = useOnboarding()
  const tourHomePath = useMemo(
    () =>
      tour.step === 'home'
        ? (worktrees.find((w) => w.isMain && w.repoRoot === tour.repoRoot)?.path ?? null)
        : null,
    [tour, worktrees]
  )
  // Shared by the tour popout and the center empty state (main keeps the
  // tour's home workspace tab-less while popout 1 is up, so the center is
  // what's showing) so both drive the same kickoff and tour transition.
  const handleTourStart = useCallback(async () => {
    const result = await backend.tourStartSomethingNew().catch(() => ({ ok: false as const }))
    if (result.ok) setActiveWorktreeId(result.worktreePath)
  }, [backend])
  const handleTourDismiss = useCallback(() => void backend.tourDismiss().catch(() => {}), [backend])

  const configLoadError = useConfigLoadError()

  // Count of "real" worktrees the user has spawned — main repo doesn't count
  // as an agent. Used by the empty state.
  const agentWorktreeCount = useMemo(
    () => worktrees.filter((w) => !w.isMain).length,
    [worktrees]
  )

  const activeAnnouncement = useMemo(
    () =>
      pickActiveAnnouncement(announcements.items, {
        muted: settings.announcementsMuted,
        dismissedIds: settings.dismissedAnnouncementIds,
        firstLaunchAt: settings.firstLaunchAt,
        now: Date.now()
      }),
    [
      announcements.items,
      settings.announcementsMuted,
      settings.dismissedAnnouncementIds,
      settings.firstLaunchAt
    ]
  )
  // Track which worktrees already have hooks installed so we only prompt once

  // Panes + repos + worktrees are all hydrated from the main-process store
  // before App mounts. The only thing we still need to do at mount is ask
  // main for a fresh worktree list in case anything changed on disk.
  useEffect(() => {
    void backend.refreshWorktreesList()
  }, [])

  // Open Settings from the menu (Cmd+,)
  useEffect(() => {
    const cleanup = backend.onOpenSettings(() => setShowSettings(true))
    return cleanup
  }, [])

  // Toggle perf monitor from the menu (Cmd+Shift+D)
  useEffect(() => {
    const cleanup = backend.onTogglePerfMonitor(() => setShowPerfMonitor((v) => !v))
    return cleanup
  }, [])

  // Debug → Open GitHub API Log
  useEffect(() => {
    const cleanup = backend.onOpenGitHubApiLog(() => setShowGitHubApiLog(true))
    return cleanup
  }, [])

  // UI size — View menu items (Cmd+= / Cmd+- / Cmd+0). Read the current
  // rung from the slice on each fire (a useEffect snapshot would stale-
  // close over the value) and step through SCALES.
  useEffect(() => {
    const step = (delta: number): void => {
      const cur = settings.uiScale
      const i = SCALES.findIndex((s) => s.id === cur)
      const idx = i < 0 ? 0 : i
      const target = SCALES[Math.max(0, Math.min(SCALES.length - 1, idx + delta))]
      if (target && target.id !== cur) void backend.setUiScale(target.id)
    }
    const cleanups = [
      backend.onUiScaleUp(() => step(1)),
      backend.onUiScaleDown(() => step(-1)),
      backend.onUiScaleReset(() => {
        if (settings.uiScale !== 'small') void backend.setUiScale('small')
      })
    ]
    return () => { for (const c of cleanups) c() }
  }, [settings.uiScale])

  // Toggle single-screen mode from the menu (F12)
  useEffect(() => {
    const cleanup = backend.onToggleSingleScreen(() => setSingleScreenMode((v) => !v))
    return cleanup
  }, [])

  useEffect(() => {
    const cleanup = backend.onFullscreenChanged((next) => setIsFullscreen(next))
    return cleanup
  }, [])

  useEffect(() => backend.onNotchInsetChanged(setNotchInset), [])

  useEffect(() => {
    document.documentElement.dataset.fullscreen = isFullscreen ? 'true' : 'false'
  }, [isFullscreen])

  // Mirrors the styles.css titlebar-lead overrides for the inline-styled
  // single-screen top bars, which a root-attribute selector can't reach.
  // Only macOS hides its controls in fullscreen; LinuxWindowControls stay.
  const singleScreenLeadingPx =
    WINDOW_CONTROLS === 'none' || (WINDOW_CONTROLS === 'mac' && isFullscreen) ? 0 : TITLE_LEADING_PX

  // Open Keyboard Shortcuts from the menu
  useEffect(() => {
    const cleanup = backend.onOpenKeyboardShortcuts(() => setShowHotkeyCheatsheet(true))
    return cleanup
  }, [])

  // File → New Project…
  useEffect(() => {
    const cleanup = backend.onOpenNewProject(() => setShowNewProject(true))
    return cleanup
  }, [])

  // File → Add Backend… — the chip strip is hidden when only Local
  // exists (no `+` button visible), so the menu is the entry point
  // for adding the first remote.
  useEffect(() => {
    const cleanup = backend.onOpenAddBackend(() => setShowAddBackend(true))
    return cleanup
  }, [])

  // Report Issue — triggered from the Help menu, the sidebar, the
  // Settings Support section, and the openReportIssueFor() helper (used
  // by the error boundary). Closes any open overlay (Settings, hotkey
  // cheatsheet) so the full-screen report takes over the center area.
  useEffect(() => {
    const openReport = (detail: OpenReportIssueDetail): void => {
      setShowSettings(false)
      setShowHotkeyCheatsheet(false)
      setReportIssueState(detail)
    }
    const cleanupMenu = backend.onOpenReportIssue(() => openReport({}))
    const cleanupBus = onOpenReportIssue((detail) => openReport(detail))
    return () => {
      cleanupMenu()
      cleanupBus()
    }
  }, [])

  // Debug: Crash Focused Tab (Help menu → for testing the ErrorBoundary).
  // Finds the active worktree's active pane and flips its active tab into
  // a throwing render. The boundary catches it inside the tab.
  useEffect(() => {
    return backend.onDebugCrashFocusedTab(() => {
      const wtPath = activeWorktreeId
      if (!wtPath) return
      const tree = panes[wtPath]
      if (!tree) return
      const leaves = getLeaves(tree)
      const paneId = activePaneId[wtPath] ?? leaves[0]?.id
      const leaf = leaves.find((l) => l.id === paneId) ?? leaves[0]
      const tabId = leaf?.activeTabId
      if (!tabId) return
      setCrashedTabIds((prev) => {
        const next = new Set(prev)
        next.add(tabId)
        return next
      })
    })
  }, [activeWorktreeId, panes, activePaneId])

  // Debug: Preview Onboarding (dev-only Help menu entry). Toggles a
  // renderer-local override that forces the welcome / onboarding form
  // to render regardless of repo count — handy for inspecting the
  // layout without wiping userData.
  useEffect(() => {
    return backend.onDebugPreviewOnboarding(() => {
      setPreviewOnboarding((v) => !v)
    })
  }, [])

  // Trigger a full PR refresh in main. Used by the sidebar refresh button
  // and after worktree creation/removal.
  const fetchAllPRStatuses = useCallback(() => {
    void backend.refreshPRsAll()
  }, [])

  const activeRepoRoot = activeWorktreeId
    ? worktrees.find((w) => w.path === activeWorktreeId)?.repoRoot ?? worktreeRepoByPath[activeWorktreeId] ?? null
    : null
  // Derive activeRepoConfig from the store. Updates propagate automatically
  // when any client commits a setRepoConfig.
  const activeRepoConfig: RepoConfig | null = activeRepoRoot
    ? repoConfigs[activeRepoRoot] ?? null
    : null

  // Ask main for a single-worktree PR refresh. Used by the activity observer
  // when a terminal enters the "waiting" state (likely just pushed).
  const fetchPRStatus = useCallback((wtPath: string) => {
    void backendFor(wtPath).refreshPRsOne(wtPath)
  }, [backendFor])

  // Ask main for a stale-only single-worktree refresh. Used when the user
  // activates a worktree — main dedups internally so rapid switching won't
  // hammer the GitHub API.
  const fetchPRStatusIfStale = useCallback((wtPath: string) => {
    void backendFor(wtPath).refreshPRsOneIfStale(wtPath)
  }, [backendFor])

  // On window focus, ask main for a stale-only bulk refresh. Main dedups
  // against its own lastAllFetchAt clock. Announcements piggyback on the
  // same trigger — the poller is the dedup boundary on that side too.
  useEffect(() => {
    const onFocus = (): void => {
      void backend.refreshPRsAllIfStale()
      void backend.refreshAnnouncements()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  // Map a terminal ID back to its worktree path
  const terminalToWorktree = useCallback((terminalId: string): string | null => {
    for (const [wtPath, tabs] of Object.entries(terminalTabs)) {
      if (tabs.some((t) => t.id === terminalId)) return wtPath
    }
    return null
  }, [terminalTabs])

  // Observe terminal status transitions to trigger PR refresh when a Claude
  // tab finishes a turn ('waiting'). lastActive timestamps are now derived
  // in main by the activity-deriver, so we don't need to track them here.
  const prevStatusesRef = useRef<Record<string, PtyStatus>>({})
  useEffect(() => {
    const prev = prevStatusesRef.current
    for (const [id, status] of Object.entries(statuses)) {
      if (prev[id] === status) continue
      if (status === 'waiting') {
        const wtPath = terminalToWorktree(id)
        if (wtPath) fetchPRStatus(wtPath)
      }
    }
    prevStatusesRef.current = statuses
  }, [statuses, terminalToWorktree, fetchPRStatus])

  // Auto-focus the active terminal when switching worktrees so the user can
  // start typing immediately. Deferred to the next frame so the xterm layer
  // is visible (TerminalPanels use display:none for inactive worktrees).
  useEffect(() => {
    if (!activeWorktreeId) return
    const tabId = activeTabId[activeWorktreeId]
    if (!tabId || tabId.startsWith('diff-')) return
    const raf = requestAnimationFrame(() => focusTerminalById(tabId))
    return () => cancelAnimationFrame(raf)
  }, [activeWorktreeId, activeTabId])

  // When a worktree becomes active, refresh its PR status if stale. Hooks
  // installation and pane initialization both run in main now (see
  // installHooksForAcceptedWorktrees + WorktreesFSM in src/main/index.ts).
  useEffect(() => {
    if (!activeWorktreeId) return
    if (isPendingId(activeWorktreeId)) return
    fetchPRStatusIfStale(activeWorktreeId)
  }, [activeWorktreeId, fetchPRStatusIfStale])

  // Wake-on-activation: merged worktrees stay asleep at boot, so we need
  // to force pane init on first focus. No-op for paths that already have
  // panes (ensureInitialized in main returns early).
  useEffect(() => {
    if (!activeWorktreeId) return
    const key = `${selectedBackendId}\u0000${activeWorktreeId}`
    setOpenedWorktrees((prev) => (prev.has(key) ? prev : new Set(prev).add(key)))
  }, [activeWorktreeId, selectedBackendId])

  useEffect(() => {
    if (!activeWorktreeId) return
    if (isPendingId(activeWorktreeId)) return
    // Routed to the worktree's OWNING backend, not the active one. App sits
    // above every BackendScope, so the default `backend` here is
    // active-routed — which would ask the local backend to initialize panes
    // for a path that only exists on a remote, leaving the remote worktree
    // permanently tab-less and unselectable.
    void getBackendFor(selectedBackendId).panesEnsureInitialized(activeWorktreeId)
  }, [activeWorktreeId, selectedBackendId])

  // If the active id points at something that no longer exists — a
  // finished deletion, a dismissed pending creation, a stale focus after
  // a refresh — route focus to a neighbor so the center pane doesn't
  // collapse into an empty region.
  // Nothing selected yet is the same problem: a fresh install mounts with
  // an empty list, so once the wizard adds projects (one or many), open the
  // one the tour is about rather than leaving the center empty.
  useEffect(() => {
    if (!activeWorktreeId) {
      // `tour` is the active backend's slice; `worktrees` is merged.
      const pick = pickInitialWorktree({
        tourStep: tour.step,
        tourHomePath,
        worktreePaths: worktrees.map((w) => w.path),
        tourBackendHasRows: worktrees.some((w) => fleetData.pathBackendId[w.path] === activeBackendId)
      })
      if (pick) setActiveWorktreeId(pick)
      return
    }
    if (isPendingId(activeWorktreeId)) {
      if (pendingWorktrees.some((p) => p.id === activeWorktreeId)) return
    } else {
      if (worktrees.some((w) => w.path === activeWorktreeId)) return
      if (pendingDeletions.some((d) => d.path === activeWorktreeId)) return
    }
    setActiveWorktreeId(worktrees[0]?.path ?? null)
  }, [activeWorktreeId, worktrees, pendingWorktrees, pendingDeletions, tourHomePath, tour.step, fleetData.pathBackendId, activeBackendId])

  const handleAcceptHooks = useCallback(() => {
    void backend.acceptHooks()
  }, [])

  const handleDeclineHooks = useCallback(() => {
    void backend.declineHooks()
  }, [])

  // Re-show the update banner if a new download arrives after a prior dismiss.
  useEffect(() => {
    if (updaterStatus?.state === 'downloaded') setUpdateBannerDismissed(false)
  }, [updaterStatus?.state])

  // Re-show the manual-install banner whenever a newer "available" version
  // lands — keyed on version so dismissing v2.8.0 doesn't suppress v2.9.0.
  const manualAvailableVersion =
    updaterStatus?.state === 'available' && updaterStatus.manualInstallRequired
      ? updaterStatus.version
      : null
  useEffect(() => {
    if (manualAvailableVersion) setManualUpdateBannerDismissed(false)
  }, [manualAvailableVersion])

  const handleUpdateRestart = useCallback(() => {
    void backend.quitAndInstall()
  }, [])

  // All worktree + repo + pending-creation handlers. Also subscribes to
  // external-create events from the ness-control MCP and routes focus
  // to the new path.
  const {
    handleAddRepo,
    handleRemoveRepo,
    handleRefreshWorktrees,
    handleSubmitNewWorktree,
    handleSubmitNewPRWorktree,
    handleRetryPendingWorktree,
    handleDismissPendingWorktree,
    handleContinuePendingWorktree,
    handleContinueWorktree,
    handleDeleteWorktree,
    handleBulkDeleteWorktrees,
    handlePruneWorktrees,
    handleDismissPendingDeletion,
    repoPickerOpen,
    handleRepoPickerSelect,
    handleRepoPickerCancel,
    repoAddPrompt,
    handleConfirmRepoResolve,
    handleDismissRepoPrompt
  } = useWorktreeHandlers({
    pathBackendId: fleetData.pathBackendId,
    repoBackendId: fleetData.repoBackendId,
    pendingBackendId: fleetData.pendingBackendId,
    worktrees,
    pendingWorktrees,
    repoRoots,
    worktreeRepoByPath,
    terminalTabs,
    prStatuses,
    activeWorktreeId,
    setActiveWorktreeId,
    setActivePaneId,
    setShowNewWorktree
  })

  // All tab/pane mutation handlers (addTab, closeTab, restartClaude,
  // selectTab, openCommit/File/Diff, reorder, move, split, sendToClaude).
  // Each handler dispatches an IPC method to main; per-client UI focus
  // updates happen here.
  const {
    appendTabToPane,
    handleAddTerminalTab,
    handleAddAgentTab,
    handleAddBrowserTab,
    handleAddJsonClaudeTab,
    handleConvertTabType,
    handleCloseTab,
    handleRestartAgentTab,
    handleSelectTab,
    handleSleepTab,
    handleOpenPR,
    handleReorderTabs,
    handleMoveTabToPane,
    handleSplitPane,
    handleSendToAgent,
    handleOpenFile,
    handleOpenDiff,
    handleOpenCommitFileDiff
  } = useTabHandlers({
    panes,
    activePaneId,
    setActivePaneId,
    activeWorktreeId,
    setActiveWorktreeId,
    pathBackendId: fleetData.pathBackendId
  })

  const { goBack, goForward } = useTabHistory({
    activeWorktreeId: isPendingId(activeWorktreeId) ? null : activeWorktreeId,
    focusedTabId,
    panes,
    setActiveWorktreeId,
    selectTab: handleSelectTab
  })

  // Hoisted out of the WorkspaceView JSX below. Every worktree stays mounted,
  // so an inline arrow here allocates N new callbacks on every App render and
  // defeats WorkspaceView's memo before it can compare anything else.
  const handleFocusPane = useCallback((wtPath: string, paneId: string) => {
    setActivePaneId((prev) => (prev[wtPath] === paneId ? prev : { ...prev, [wtPath]: paneId }))
  }, [])

  const handleSidebarSelectWorktree = useCallback(
    (path: string) => {
      switchWorktree(
        path,
        () => {
          setShowNewWorktree(false)
          setShowActivity(false)
          setShowCleanup(false)
          setGraphRepo(null)
        }
      )
    },
    [switchWorktree]
  )

  const handleSidebarSelectTab = useCallback(
    (wtPath: string, paneId: string, tabId: string) => {
      handleSidebarSelectWorktree(wtPath)
      startTransition(() => handleSelectTab(wtPath, paneId, tabId))
    },
    [handleSidebarSelectWorktree, handleSelectTab]
  )

  const handleEndAliasEdit = useCallback(() => setEditingAliasPath(null), [])

  const handleOpenSubscriptionGraph = useCallback(
    (repoRoot?: string) => {
      const repo =
        repoRoot ?? (activeWorktreeId ? worktreeRepoByPath[activeWorktreeId] : undefined) ?? repoRoots[0]
      if (!repo) return
      setShowNewWorktree(false)
      setShowActivity(false)
      setShowCleanup(false)
      setGraphRepo(repo)
    },
    [activeWorktreeId, worktreeRepoByPath, repoRoots]
  )
  const handleGraphFocusTab = useCallback(
    (wtPath: string, tabId: string) => {
      const tree = panes[wtPath]
      const leaf = tree ? findLeafByTabId(tree, tabId) : null
      if (leaf) handleSidebarSelectTab(wtPath, leaf.id, tabId)
      else handleSidebarSelectWorktree(wtPath)
    },
    [panes, handleSidebarSelectTab, handleSidebarSelectWorktree]
  )
  const handleCloseSubscriptionGraph = useCallback(() => setGraphRepo(null), [])
  // Any other full-content view replaces the graph.
  useEffect(() => {
    if (showNewWorktree || showActivity || showCleanup) setGraphRepo(null)
  }, [showNewWorktree, showActivity, showCleanup])

  // Hoisted for RightColumn's memo, so the sidebar's optimistic highlight
  // render doesn't re-render the whole right column with unchanged data.
  const handleOpenGithubSettings = useCallback(() => {
    setSettingsInitialSection('github')
    setShowSettings(true)
  }, [])
  const handleOpenActivePR = useCallback(
    (url: string) => {
      if (activeWorktreeId) handleOpenPR(activeWorktreeId, url)
    },
    [activeWorktreeId, handleOpenPR]
  )
  const handleOpenActiveReview = useCallback(() => {
    if (activeWorktreeId) void backendFor(activeWorktreeId).panesOpenReview(activeWorktreeId)
  }, [activeWorktreeId, backendFor])
  const handleCollapseRightColumn = useCallback(() => setRightColumnHidden(true), [])
  const handleBuildCustomTool = useCallback((branch: string, prompt: string) => {
    setNewWorktreePrefill({ branch, prompt })
    setShowNewWorktree(true)
  }, [])

  const effectiveDefaultAgent = defaultAgent ?? 'claude'
  const handleAddAgentTabWithDefault = useCallback(
    (wtPath: string, kind: AgentKind | undefined, paneId?: string) => {
      handleAddAgentTab(wtPath, kind ?? effectiveDefaultAgent, paneId)
    },
    [handleAddAgentTab, effectiveDefaultAgent]
  )

  // True when the active worktree's workspace (and its tab bar) is actually on
  // screen — i.e. no full-content view (new-worktree, activity, cleanup, command
  // center, review, report-issue) is replacing it and the active worktree isn't
  // pending/deleting. The Quake terminal only responds when this holds, so it
  // never drops over a view that's hiding the tabs.
  const workspaceVisible =
    !showNewWorktree &&
    !showActivity &&
    !showCleanup && graphRepo === null &&
    reportIssueState === null &&
    !!activeWorktreeId &&
    !isPendingId(activeWorktreeId) &&
    !pendingDeletionByPath[activeWorktreeId]

  // Dismiss the Quake terminal if a view takes over and hides the tabs.
  useEffect(() => {
    if (!workspaceVisible && showQuakeTerminal) setShowQuakeTerminal(false)
  }, [workspaceVisible, showQuakeTerminal])

  // Guard accidental closes of a still-running tab (the common ⌘W-meant-for-⌘Q
  // fat-finger). Every close path — the ⌘W hotkey, the File→Close Tab menu
  // accelerator, and a tab's × button — funnels through requestCloseTab, so
  // the guard is enforced in one place. A tab counts as running when its
  // agent status is processing/waiting/needs-approval or a shell has a live
  // process; anything else closes immediately.
  const [closeTabConfirm, setCloseTabConfirm] = useState<{
    worktreePath: string
    tabId: string
    label: string
    reason: string
  } | null>(null)
  const requestCloseTab = useCallback(
    (worktreePath: string, tabId: string) => {
      // A second ⌘W (or menu Close Tab) while the guard is already up for this
      // same tab confirms the close — repeating the gesture that opened it.
      if (
        closeTabConfirm &&
        closeTabConfirm.worktreePath === worktreePath &&
        closeTabConfirm.tabId === tabId
      ) {
        handleCloseTab(worktreePath, tabId)
        setCloseTabConfirm(null)
        return
      }
      // Fleet-wide reads: the sidebar can close a tab on any backend, and the
      // active-backend maps would miss a remote tab and skip the guard.
      const tab = (mergedData.tabsByWorktree[worktreePath] || []).find((t) => t.id === tabId)
      const reason = closeTabConfirmReason(
        mergedData.statuses[tabId],
        mergedData.shellActivity[tabId]
      )
      if (tab && reason) {
        setCloseTabConfirm({ worktreePath, tabId, label: tab.label || 'This tab', reason })
        return
      }
      handleCloseTab(worktreePath, tabId)
    },
    [
      mergedData.tabsByWorktree,
      mergedData.statuses,
      mergedData.shellActivity,
      handleCloseTab,
      closeTabConfirm
    ]
  )
  const confirmCloseTab = useCallback(() => {
    if (!closeTabConfirm) return
    handleCloseTab(closeTabConfirm.worktreePath, closeTabConfirm.tabId)
    setCloseTabConfirm(null)
  }, [closeTabConfirm, handleCloseTab])
  const cancelCloseTab = useCallback(() => setCloseTabConfirm(null), [])
  // requestCloseTab changes identity on every status tick; the sidebar's
  // memoized tab rows get a stable forwarder instead.
  const requestCloseTabRef = useRef(requestCloseTab)
  requestCloseTabRef.current = requestCloseTab
  const handleSidebarCloseTab = useCallback(
    (worktreePath: string, tabId: string) => requestCloseTabRef.current(worktreePath, tabId),
    []
  )

  // Sidebar-aware hotkey handlers + the resolved binding map for tooltips.
  // The hook also subscribes to keystrokes via useHotkeys internally.
  const { hotkeyActions, resolvedHotkeys } = useHotkeyHandlers({
    pathBackendId: fleetData.pathBackendId,
    worktrees,
    listModel: worktreeListBase,
    repoRoots,
    unifiedRepos,
    prStatuses,
    mergedPaths,
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
    setShowCommandPalette,
    setCommandPaletteMode,
    setShowPerfMonitor,
    setShowHotkeyCheatsheet,
    setShowQuakeTerminal,
    quakeTerminalAllowed: workspaceVisible,
    handleAddTerminalTab,
    handleOpenPR,
    handleCloseTab: requestCloseTab,
    handleSelectTab,
    handleSplitPane,
    handleRefreshWorktrees,
    // NewWorktreeScreen cycles repos on Cmd+[ / Cmd+].
    historyBack: showNewWorktree ? undefined : goBack,
    historyForward: showNewWorktree ? undefined : goForward,
    setShowSettings,
    onStartAliasEdit: setEditingAliasPath
  })

  // File → Close Tab (Cmd+W). The accelerator lives on the menu item
  // so it fires even when focus is inside a WebContentsView (browser
  // tab). Closes the currently active tab in the active worktree.
  useEffect(() => {
    const cleanup = backend.onCloseFocusedTab(() => {
      if (!activeWorktreeId) return
      const tabId = activeTabId[activeWorktreeId]
      if (tabId) requestCloseTab(activeWorktreeId, tabId)
    })
    return cleanup
  }, [backend, activeWorktreeId, activeTabId, requestCloseTab])

  // Window → Split Pane Right / Down — accelerators on the menu so they
  // fire from any focus context (browser tab, etc.). Delegates to the
  // same handler the renderer-side hotkey binding uses.
  useEffect(() => {
    const a = backend.onSplitPaneRight(() => hotkeyActions.splitPaneRight?.())
    const b = backend.onSplitPaneDown(() => hotkeyActions.splitPaneDown?.())
    return () => {
      a()
      b()
    }
  }, [backend, hotkeyActions])

  // Per-worktree aggregates come from the shared list model so the sidebar
  // and command palette can't disagree about a status.
  const worktreeStatuses = worktreeListModel.statusByPath
  const worktreePendingTools = worktreeListModel.pendingToolByPath

  // Activity-log transitions are recorded by main's activity-deriver
  // (see src/main/activity-deriver.ts). The renderer no longer pings
  // recordActivity directly.

  if (showGuide) {
    return <Guide onClose={() => setShowGuide(false)} />
  }

  if (showNewProject) {
    return (
      <NewProjectScreen
        onCancel={() => setShowNewProject(false)}
        onCreated={(createdPath) => {
          setShowNewProject(false)
          const main =
            worktrees.find((w) => w.repoRoot === createdPath && w.isMain) ||
            worktrees.find((w) => w.repoRoot === createdPath)
          if (main) setActiveWorktreeId(main.path)
        }}
      />
    )
  }

  const settingsOverlay = showSettings ? (
    <div className="fixed inset-0 z-50">
      <Settings
        onClose={() => {
          setShowSettings(false)
          setSettingsInitialSection(undefined)
        }}
        onOpenGuide={() => {
          setShowSettings(false)
          setSettingsInitialSection(undefined)
          setShowGuide(true)
        }}
        onOpenMyWeek={() => {
          setShowSettings(false)
          setSettingsInitialSection(undefined)
          setShowMyWeek(true)
        }}
        initialSection={settingsInitialSection}
      />
    </div>
  ) : null

  const myWeekOverlay = showMyWeek ? (
    <div className="fixed inset-0 z-50 flex">
      <WeeklyWrappedScreen onClose={() => setShowMyWeek(false)} />
    </div>
  ) : null

  const repoPickerOverlay = (
    <RemoteFilePicker
      isOpen={repoPickerOpen}
      title="Open Git Repository"
      selectLabel="Open"
      onSelect={(path) => {
        void handleRepoPickerSelect(path)
      }}
      onCancel={handleRepoPickerCancel}
    />
  )

  const repoAddPromptOverlay =
    repoAddPrompt?.kind === 'resolve' ? (
      <ResolveRepoModal
        picked={repoAddPrompt.picked}
        resolved={repoAddPrompt.resolved}
        onConfirm={() => {
          void handleConfirmRepoResolve()
        }}
        onCancel={handleDismissRepoPrompt}
      />
    ) : repoAddPrompt?.kind === 'error' ? (
      <RepoAddErrorModal message={repoAddPrompt.message} onDismiss={handleDismissRepoPrompt} />
    ) : null


  // A corrupt config preempts everything, including the onboarding screen
  // below — a corrupt load lands on empty defaults, which would otherwise
  // trigger first-run onboarding underneath the recovery modal.
  if (configLoadError) {
    return (
      <HotkeysProvider bindings={resolvedHotkeys}>
        <div className="flex h-full flex-col">
          <div className="drag-region h-10 shrink-0 flex items-stretch titlebar-lead">
            <AppTitleSegment />
          </div>
          <div className="flex-1" />
        </div>
        <InvalidConfigModal />
      </HotkeysProvider>
    )
  }

  if (repoRoots.length === 0 || previewOnboarding) {
    const step1Complete = themeChosen
    const step2Complete = agentChosen
    const recordNewRepos = settings.lochRecordNewRepos
    const step3Complete = hooksConsent !== 'pending'
    // An answered step shows the saved choice. Hooks answered before this
    // question existed leave it null, which records nothing, so show it off.
    const historyChecked =
      recordNewRepos ?? (hooksConsent === 'pending' ? recordHistoryDraft : false)
    const activeStep: 1 | 2 | 3 | 4 = !step1Complete
      ? 1
      : !step2Complete
        ? 2
        : !step3Complete
          ? 3
          : 4
    // "Found work" means something the import could actually add. In preview
    // mode everything is usually already added, and the step still renders
    // so the layout can be inspected.
    const foundWork =
      existingWork && existingWork.repos.some((r) => previewOnboarding || !r.alreadyAdded)
        ? existingWork
        : null
    const showImportStep = !!foundWork
    const shownAgent = agentInferred && previewOnboarding ? (existingWork?.suggestedAgent ?? defaultAgent) : defaultAgent
    const chatIsDefault = settings.defaultClaudeTabType === 'json'
    const handleImportWork = async (): Promise<void> => {
      if (previewOnboarding) {
        setPreviewOnboarding(false)
        return
      }
      setImporting(true)
      setImportError(null)
      try {
        const result = await backend.importExistingWork([...importSelection])
        if (result.focusWorktreePath) setImportFocusPath(result.focusWorktreePath)
      } catch (err) {
        // Repos are registered one at a time, so a failure part-way can
        // leave some already added; say so instead of failing silently.
        setImportError(err instanceof Error ? err.message : String(err))
      } finally {
        setImporting(false)
      }
    }
    return (
      <HotkeysProvider bindings={resolvedHotkeys}>
      <div className="flex h-full flex-col">
        <div className="drag-region h-10 shrink-0 flex items-stretch titlebar-lead">
          <AppTitleSegment />
        </div>
        {previewOnboarding && repoRoots.length > 0 && (
          <div className="shrink-0 px-4 py-1.5 bg-warning/10 border-b border-warning/30 text-xs text-fg-bright flex items-center justify-between gap-3">
            <span>
              <strong className="font-semibold">Preview mode</strong> — viewing onboarding with {repoRoots.length} repo{repoRoots.length === 1 ? '' : 's'} already added.
            </span>
            <button
              onClick={() => setPreviewOnboarding(false)}
              className="px-2 py-0.5 rounded bg-panel border border-border hover:border-border-strong cursor-pointer"
            >
              Exit preview
            </button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl w-full px-6 py-6">
           <div className="mx-auto max-w-xl">
            <div className="text-center mb-6">
              <NessMark className="h-14 w-auto mx-auto mb-4 text-brand" />
              <h1 className="gradient-text text-3xl font-extrabold tracking-tight mb-2">Ness</h1>
              <p className="text-fg text-sm leading-relaxed max-w-md mx-auto">
                Run many coding agents in parallel
              </p>
            </div>

            <div className="grid grid-cols-3 gap-2 mb-2">
              <div className="rounded-lg border border-border bg-panel p-3">
                <div className="h-14 mb-3 flex flex-col justify-center gap-1.5 bg-app/50 rounded border border-border px-2 py-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-success shrink-0" />
                    <span className="text-[9px] font-mono text-muted flex-1 truncate">feat/onboarding</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-warning shrink-0" />
                    <span className="text-[9px] font-mono text-muted flex-1 truncate">fix/login-flash</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-success shrink-0" />
                    <span className="text-[9px] font-mono text-muted flex-1 truncate">refactor/auth</span>
                  </div>
                </div>
                <div className="text-xs text-fg-bright font-medium mb-0.5">Parallel agents</div>
                <div className="text-[11px] text-dim leading-snug">One window, many sessions</div>
              </div>
              <div className="rounded-lg border border-border bg-panel p-3">
                <div className="h-14 mb-3 flex items-center justify-center bg-app/50 rounded border border-border">
                  <div className="flex flex-col items-center">
                    <div className="px-1.5 py-0.5 rounded bg-surface border border-border-strong text-[8px] font-mono text-fg-bright">.git</div>
                    <svg width="60" height="12" viewBox="0 0 60 12" className="text-faint">
                      <path d="M30 0 L30 5 L10 5 L10 12 M30 5 L30 12 M30 5 L50 5 L50 12" stroke="currentColor" strokeWidth="1" fill="none" />
                    </svg>
                    <div className="flex gap-1.5">
                      <div className="w-2.5 h-2.5 rounded bg-success/20 border border-success/50" />
                      <div className="w-2.5 h-2.5 rounded bg-info/20 border border-info/50" />
                      <div className="w-2.5 h-2.5 rounded bg-warning/20 border border-warning/50" />
                    </div>
                  </div>
                </div>
                <div className="text-xs text-fg-bright font-medium mb-0.5">Worktrees handled</div>
                <div className="text-[11px] text-dim leading-snug">Your original repo stays clean</div>
              </div>
              <div className="rounded-lg border border-border bg-panel p-3">
                <div className="h-14 mb-3 flex flex-col items-center justify-center gap-1 bg-app/50 rounded border border-border px-2">
                  <div className="flex items-center gap-1.5 w-full">
                    <span className="w-1.5 h-1.5 rounded-full bg-success shrink-0" />
                    <span className="text-[9px] text-muted font-mono">working</span>
                  </div>
                  <div className="flex items-center gap-1.5 w-full">
                    <span className="w-1.5 h-1.5 rounded-full bg-warning shrink-0" />
                    <span className="text-[9px] text-muted font-mono">waiting</span>
                  </div>
                  <div className="flex items-center gap-1.5 w-full">
                    <span className="w-1.5 h-1.5 rounded-full bg-danger shrink-0" />
                    <span className="text-[9px] text-muted font-mono">approve</span>
                  </div>
                </div>
                <div className="text-xs text-fg-bright font-medium mb-0.5">Status at a glance</div>
                <div className="text-[11px] text-dim leading-snug">Dots show who's waiting</div>
              </div>
            </div>
            {/* Collapses once the scan settles; what it found is reported in
                the last step, next to the list it applies to. */}
            <div className="mb-8">
              {!workScanned && (
                <div className="rounded-lg border border-border bg-panel px-4 py-3 flex items-center gap-2.5 text-xs text-dim">
                  <Loader2 className="icon-sm animate-spin shrink-0" />
                  Looking for conversations and projects already on this machine…
                </div>
              )}
            </div>
           </div>

            <div className="space-y-3">
              <div
                className={`mx-auto max-w-xl rounded-xl border bg-panel p-4 transition-colors ${
                  activeStep === 1
                    ? 'border-accent/50 ring-1 ring-accent/25'
                    : 'border-border'
                }`}
              >
                <div className="flex items-start gap-3 mb-3">
                  {step1Complete ? (
                    <CheckCircle2 className="icon-lg text-success shrink-0 mt-0.5" />
                  ) : (
                    <div
                      className={`w-5 h-5 rounded-full border-2 text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5 ${
                        activeStep === 1 ? 'border-accent text-accent' : 'border-border-strong text-dim'
                      }`}
                    >
                      1
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-fg-bright text-sm font-medium">Pick your dark theme</div>
                    <div className="text-xs text-dim mt-0.5">You can configure a light one and auto-switch with the OS from Settings later.</div>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-1.5 ml-8">
                  {BUILT_IN_THEMES_BY_MODE.dark.map((opt) => {
                    const isActive = activeTheme.id === opt.id && themeChosen
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => {
                          backend.setThemeDark(opt.id)
                          setThemeChosen(true)
                        }}
                        className={`flex items-center gap-2 px-2 py-1.5 rounded-lg border transition-colors cursor-pointer ${
                          isActive
                            ? 'bg-surface text-fg-bright border-fg'
                            : 'bg-panel border-border text-dim hover:text-fg hover:border-border-strong'
                        }`}
                      >
                        <div className="flex gap-0.5 shrink-0">
                          {opt.swatches.map((c) => (
                            <span
                              key={c}
                              className="w-2.5 h-2.5 rounded-sm border border-border-strong"
                              style={{ backgroundColor: c }}
                            />
                          ))}
                        </div>
                        <span className="text-[11px] font-medium truncate">{opt.label}</span>
                      </button>
                    )
                  })}
                </div>
              </div>

              <div
                className={`mx-auto max-w-xl rounded-xl border bg-panel p-4 transition-colors ${
                  activeStep === 2
                    ? 'border-accent/50 ring-1 ring-accent/25'
                    : 'border-border'
                }`}
              >
                <div className="flex items-start gap-3 mb-3">
                  {step2Complete ? (
                    <CheckCircle2 className="icon-lg text-success shrink-0 mt-0.5" />
                  ) : (
                    <div
                      className={`w-5 h-5 rounded-full border-2 text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5 ${
                        activeStep === 2 ? 'border-accent text-accent' : 'border-border-strong text-dim'
                      }`}
                    >
                      2
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-fg-bright text-sm font-medium">
                      {agentInferred && agentChosen
                        ? `You use ${getAgentInfo(shownAgent).displayName}`
                        : 'Choose your default agent'}
                    </div>
                    <div className="text-xs text-dim mt-0.5">
                      {agentInferred && agentChosen
                        ? 'Automatically detected from the conversations on this machine'
                        : 'This is what new tabs will spawn. You can change it later in Settings.'}
                    </div>
                  </div>
                  {agentInferred && agentChosen && (
                    <button
                      onClick={() => {
                        setAgentInferred(false)
                        setAgentChosen(false)
                      }}
                      className="text-xs text-accent hover:underline cursor-pointer shrink-0 mt-0.5"
                    >
                      Change
                    </button>
                  )}
                </div>
                {!(agentInferred && agentChosen) && (
                  <div className="flex gap-2 ml-8">
                    {AGENT_REGISTRY.map((agent) => (
                      <button
                        key={agent.kind}
                        onClick={() => {
                          backend.setDefaultAgent(agent.kind)
                          // Chat is the default interface for any agent that
                          // has one; the line below is the way back to the TUI.
                          if (!agentChosen && existingWork?.mayPreselectAgent === true && !previewOnboarding && supportsChat(agent.kind)) {
                            void backend.setDefaultClaudeTabType('json')
                          }
                          setAgentChosen(true)
                        }}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                          defaultAgent === agent.kind && agentChosen
                            ? 'bg-surface text-fg-bright border border-fg'
                            : 'bg-panel border border-border text-dim hover:text-fg hover:border-border-strong'
                        }`}
                      >
                        <AgentIcon kind={agent.kind} className="icon-sm" />
                        {agent.displayName}
                      </button>
                    ))}
                  </div>
                )}
                {agentChosen && supportsChat(shownAgent) && (
                  <div className={`ml-8 text-xs text-dim leading-relaxed ${agentInferred ? '' : 'mt-3'}`}>
                    {chatIsDefault ? (
                      <>
                        <span className="text-fg">Conversations open in Ness Chat</span>, with your full
                        history. Same {getAgentInfo(shownAgent).displayName}, same config, same permissions.{' '}
                        <button
                          onClick={() => { void backend.setDefaultClaudeTabType('xterm') }}
                          className="text-fg-bright hover:underline cursor-pointer whitespace-nowrap"
                        >
                          Prefer the terminal UI? Use the TUI instead
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="text-fg">Conversations open in the terminal UI</span>, exactly as you
                        run it today.{' '}
                        <button
                          onClick={() => { void backend.setDefaultClaudeTabType('json') }}
                          className="text-fg-bright hover:underline cursor-pointer whitespace-nowrap"
                        >
                          Switch to Ness Chat
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>

              <div
                className={`mx-auto max-w-xl rounded-xl border bg-panel p-4 transition-colors ${
                  activeStep === 3
                    ? 'border-accent/50 ring-1 ring-accent/25'
                    : 'border-border'
                }`}
              >
                <div className="flex items-start gap-3 mb-3">
                  {step3Complete ? (
                    <CheckCircle2 className="icon-lg text-success shrink-0 mt-0.5" />
                  ) : (
                    <div
                      className={`w-5 h-5 rounded-full border-2 text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5 ${
                        activeStep === 3 ? 'border-accent text-accent' : 'border-border-strong text-dim'
                      }`}
                    >
                      3
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-fg-bright text-sm font-medium">Install hooks</div>
                    <div className="text-xs text-dim mt-0.5">
                      Adds a small hook at <code className="bg-app/50 px-1 rounded">~/.claude/settings.json</code> (and the Codex equivalent) so Ness can tell when an agent is{' '}
                      <span className="inline-flex items-center gap-1 whitespace-nowrap">
                        <span className="w-1.5 h-1.5 rounded-full bg-success" />
                        <span className="text-fg">working</span>
                      </span>,{' '}
                      <span className="inline-flex items-center gap-1 whitespace-nowrap">
                        <span className="w-1.5 h-1.5 rounded-full bg-warning" />
                        <span className="text-fg">waiting</span>
                      </span>, or{' '}
                      <span className="inline-flex items-center gap-1 whitespace-nowrap">
                        <span className="w-1.5 h-1.5 rounded-full bg-danger" />
                        <span className="text-fg">asking for approval</span>
                      </span>. Only fires for sessions Ness launches. Others are untouched.
                    </div>
                  </div>
                </div>
                {historyOffered ? (
                  <label
                    className="flex items-start gap-2 ml-8 mb-3 cursor-pointer"
                    title="Adds hooks to each new repo's worktrees (.claude/settings.local.json) and downloads loch if it isn't installed. Snapshots stay in ~/.loch; nothing is uploaded. Change it in Settings → Conversation blame."
                  >
                    <input
                      type="checkbox"
                      checked={historyChecked}
                      onChange={(e) => {
                        // Once the step is answered the box edits the setting
                        // itself; before that it's a draft the button applies.
                        if (hooksConsent === 'pending' && recordNewRepos === null) setRecordHistoryDraft(e.target.checked)
                        else void backend.setLochRecordNewRepos(e.target.checked)
                      }}
                      className="mt-0.5 cursor-pointer icon-base shrink-0"
                    />
                    <div className="text-sm text-fg-bright">
                      Keep track of which agent made every change.{' '}
                      <span className="text-xs text-dim">Powered by loch</span>
                    </div>
                  </label>
                ) : (
                  <div className="text-xs text-dim ml-8 mb-3">
                    Conversation history tracking isn&apos;t available on this platform yet.
                  </div>
                )}
                <div className="flex gap-2 ml-8">
                  <button
                    onClick={() => {
                      handleAcceptHooks()
                      if (historyOffered && recordNewRepos === null) {
                        void backend.setLochRecordNewRepos(recordHistoryDraft)
                      }
                    }}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                      hooksConsent === 'accepted'
                        ? 'bg-surface text-fg-bright border border-fg'
                        : activeStep === 3
                          ? 'bg-accent/20 hover:bg-accent/30 text-fg-bright border border-accent/40'
                          : 'bg-panel border border-border text-dim hover:text-fg hover:border-border-strong'
                    }`}
                  >
                    Install hooks
                  </button>
                  <button
                    onClick={() => {
                      handleDeclineHooks()
                      if (historyOffered && recordNewRepos === null) void backend.setLochRecordNewRepos(false)
                    }}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                      hooksConsent === 'declined'
                        ? 'bg-surface text-fg-bright border border-fg'
                        : 'bg-panel border border-border text-dim hover:text-fg hover:border-border-strong'
                    }`}
                  >
                    Not now
                  </button>
                </div>
              </div>

              <div
                className={`mx-auto transition-[max-width] duration-300 ${showImportStep && activeStep === 4 ? 'max-w-3xl' : 'max-w-xl'} rounded-xl border bg-panel p-4 ${
                  activeStep === 4
                    ? 'border-accent/50 ring-1 ring-accent/25'
                    : 'border-border'
                }`}
              >
                <div className="flex items-start gap-3 mb-3">
                  <div
                    className={`w-5 h-5 rounded-full border-2 text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5 ${
                      activeStep === 4 ? 'border-accent text-accent' : 'border-border-strong text-dim'
                    }`}
                  >
                    4
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-fg-bright text-sm font-medium">
                      {showImportStep ? 'Bring in your work' : 'Open a git repository'}
                    </div>
                    <div className="text-xs text-dim mt-0.5">
                      {showImportStep
                        ? 'We automatically detected your conversation history. Select projects to import your existing conversations. Nothing is moved or changed while importing.'
                        : 'Ness creates worktrees inside a sibling folder — your original repo stays untouched.'}
                    </div>
                  </div>
                </div>
                {foundWork ? (
                  <ImportWorkStep
                    work={foundWork}
                    selected={importSelection}
                    onSelectedChange={setImportSelection}
                    importing={importing}
                    error={importError}
                    onImport={() => { void handleImportWork() }}
                    onAddManually={handleAddRepo}
                    onNewProject={() => setShowNewProject(true)}
                  />
                ) : (
                  <div className="ml-8 flex items-center gap-3 flex-wrap">
                    <button
                      onClick={handleAddRepo}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer bg-fg-bright text-app hover:bg-fg border border-fg-bright"
                    >
                      <FolderOpen className="icon-base" />
                      Open Repository
                    </button>
                    <span className="text-xs text-dim">
                      or{' '}
                      <button
                        onClick={() => setShowNewProject(true)}
                        className="text-fg-bright hover:underline cursor-pointer"
                      >
                        start a new project
                      </button>
                    </span>
                  </div>
                )}
              </div>
            </div>

            <div className="mx-auto max-w-xl mt-6 pt-5 border-t border-border/60 text-center">
              <button
                onClick={() => setShowGuide(true)}
                className="text-xs text-accent hover:underline cursor-pointer"
              >
                New to multi-agent workflows? Read the worktree guide →
              </button>
            </div>
          </div>
        </div>
      </div>
      {settingsOverlay}
      {myWeekOverlay}
      {repoPickerOverlay}
      {repoAddPromptOverlay}
      </HotkeysProvider>
    )
  }

  // True when a real WorkspaceView is on screen for the active worktree —
  // mirrors the render guards in the worktrees.map below (exists, not
  // pending/deleting, has at least one tab). When false and no overlay is
  // up, the center shows a fallback so the draggable Ness title bar is
  // always present (no repos, no worktrees, or panes still initializing).
  const activeWorkspaceVisible =
    !!activeWorktreeId &&
    !isPendingId(activeWorktreeId) &&
    !pendingDeletionByPath[activeWorktreeId] &&
    worktrees.some((w) => w.path === activeWorktreeId) &&
    (() => {
      const tree = panes[activeWorktreeId]
      return !!tree && getLeaves(tree).some((l) => l.tabs.length > 0)
    })()
  const inContentOverlay =
    showNewWorktree || showActivity || showCleanup || graphRepo !== null || reportIssueState !== null
  const activeIsPending =
    isPendingId(activeWorktreeId) && pendingWorktrees.some((p) => p.id === activeWorktreeId)
  const activeIsDeleting = !!activeWorktreeId && !!pendingDeletionByPath[activeWorktreeId]
  const showCenterFallback =
    !inContentOverlay && !activeWorkspaceVisible && !activeIsPending && !activeIsDeleting
  // Trailing-side extension lets the fallback's top bar visually span across
  // the right column's drag strip. The leading side is no longer extended:
  // the left chrome column hosts its own Ness header now, so reaching
  // over it would cover that header.
  const fallbackTrailingExtend = singleScreenMode ? 0 : rightColumnHidden ? 48 : rightPanelWidth + 1

  return (
    <HotkeysProvider bindings={resolvedHotkeys}>
    <div className="flex h-full flex-col">
      <MonacoWorkerFailedBanner />
      {historyTrackingRepo && (
        <HistoryTrackingExplainer
          repoRoot={historyTrackingRepo}
          backendId={mergedData.repoBackendId[historyTrackingRepo] ?? null}
          onClose={() => setHistoryTrackingRepo(null)}
        />
      )}
      {resizeToast && (
        <div className="pointer-events-none fixed top-12 left-1/2 -translate-x-1/2 z-[60]">
          <div className="rounded-md border border-border-strong bg-panel/95 px-3 py-1.5 text-sm text-fg-bright shadow-lg backdrop-blur">
            Resize: {resizeToast}
          </div>
        </div>
      )}
      {/* Update-ready banner */}
      {updaterStatus?.state === 'downloaded' && !updateBannerDismissed && (
        <div className="bg-success/15 border-b border-success/30 titlebar-lead-wide pr-4 py-2.5 drag-region flex items-center gap-3 shrink-0">
          <span className="text-success text-sm flex-1">
            <a
              onClick={() => backend.openExternal(harnessReleaseNotesUrl(updaterStatus.version))}
              className="underline hover:text-success cursor-pointer no-drag"
            >
              Ness {updaterStatus.version}
            </a>{' '}
            is ready to install. Restart to update.
          </span>
          <button
            onClick={handleUpdateRestart}
            className="px-3 py-1 bg-success/30 hover:bg-success/40 rounded text-sm text-success transition-colors shrink-0 cursor-pointer no-drag"
          >
            Restart &amp; install
          </button>
          <button
            onClick={() => setUpdateBannerDismissed(true)}
            className="px-3 py-1 text-success/80 hover:text-success text-sm transition-colors shrink-0 cursor-pointer no-drag"
          >
            Later
          </button>
        </div>
      )}

      {/* Manual-install banner — packaging types where electron-updater can't
          auto-install (.deb, flatpak, snap) point users at the release page. */}
      {updaterStatus?.state === 'available' &&
        updaterStatus.manualInstallRequired &&
        !manualUpdateBannerDismissed && (
          <div className="bg-info/15 border-b border-info/30 titlebar-lead-wide pr-4 py-2.5 drag-region flex items-center gap-3 shrink-0">
            <span className="text-info text-sm flex-1">
              Ness {updaterStatus.version} is available. Download the new package from
              GitHub Releases to update.
            </span>
            <button
              onClick={() => {
                if (updaterStatus.releaseUrl) backend.openExternal(updaterStatus.releaseUrl)
              }}
              className="px-3 py-1 bg-info/30 hover:bg-info/40 rounded text-sm text-info transition-colors shrink-0 cursor-pointer no-drag"
            >
              Open release page
            </button>
            <button
              onClick={() => setManualUpdateBannerDismissed(true)}
              className="px-3 py-1 text-info/80 hover:text-info text-sm transition-colors shrink-0 cursor-pointer no-drag"
            >
              Later
            </button>
          </div>
        )}

      {/* Remote announcements banner — fetched in main from
          getness.dev/announcements.json, filtered down to the
          single newest entry the user hasn't dismissed and that hasn't
          expired. Muted globally via the kebab menu. */}
      {activeAnnouncement && (
        <div className="bg-accent/15 border-b border-accent/30 titlebar-lead-wide pr-4 py-2.5 drag-region flex items-center gap-3 shrink-0">
          <span className="text-accent text-sm flex-1">
            <a
              onClick={() => backend.openExternal(activeAnnouncement.href)}
              className="font-semibold underline hover:text-accent cursor-pointer no-drag"
            >
              {activeAnnouncement.title}
            </a>
            {activeAnnouncement.summary && (
              <span className="text-accent/80 ml-2">— {activeAnnouncement.summary}</span>
            )}
          </span>
          <div className="relative no-drag self-stretch flex items-center">
            <button
              aria-label="More announcement options"
              onClick={() => setAnnouncementsMenuOpen((v) => !v)}
              className="px-2 py-1 text-accent/80 hover:text-accent text-sm transition-colors shrink-0 cursor-pointer"
            >
              &#x22EF;
            </button>
            {announcementsMenuOpen && (
              <div
                role="menu"
                className="no-drag absolute right-0 top-full mt-1 z-20 min-w-[180px] rounded border border-accent/30 bg-app shadow-md text-sm"
              >
                <button
                  role="menuitem"
                  onClick={() => {
                    setAnnouncementsMenuOpen(false)
                    void backend.muteAnnouncements(true)
                  }}
                  className="no-drag block w-full text-left px-3 py-2 hover:bg-accent/10 cursor-pointer"
                >
                  Hide all announcements
                </button>
              </div>
            )}
          </div>
          <button
            aria-label="Dismiss announcement"
            onClick={() => {
              setAnnouncementsMenuOpen(false)
              void backend.dismissAnnouncement(activeAnnouncement.id)
            }}
            className="px-2 py-1 text-accent/80 hover:text-accent text-sm transition-colors shrink-0 cursor-pointer no-drag"
          >
            &times;
          </button>
        </div>
      )}

      {/* Hooks consent banner — one-time prompt at first launch. Ness
          installs agent status hooks at ~/.claude/settings.json (+ Codex
          equivalent). The hook command is gated on $HARNESS_TERMINAL_ID
          so sessions spawned outside Ness are unaffected. */}
      {hooksConsent === 'pending' && (
        <div className="bg-warning/15 border-b border-warning/30 titlebar-lead-wide pr-4 py-2.5 drag-region flex items-center gap-3 shrink-0">
          <span className="text-warning text-sm flex-1">
            Ness installs status hooks at <code className="text-xs">~/.claude/settings.json</code> to detect
            agent state (waiting, processing, needs approval). They only fire for agents you
            launch inside Ness and can be removed at any time from Settings.
          </span>
          <button
            onClick={handleAcceptHooks}
            className="px-3 py-1 bg-warning/30 hover:bg-warning/40 rounded text-sm text-warning transition-colors shrink-0 cursor-pointer no-drag"
          >
            Enable
          </button>
          <button
            onClick={handleDeclineHooks}
            className="px-3 py-1 text-warning/80 hover:text-warning text-sm transition-colors shrink-0 cursor-pointer no-drag"
          >
            Skip
          </button>
        </div>
      )}

      <div className="flex flex-1 min-h-0 relative">
        {/* Collapsed-sidebar mode keeps the Ness header pinned at its
            full sidebar width above the 48px CollapsedSidebar — the
            workspace top bar pushes its content right of this overlay,
            and the workspace content area extends underneath. */}
        {!singleScreenMode && !sidebarVisible && (
          <div
            className="absolute top-0 left-0 h-10 z-20 drag-region flex items-stretch border-b border-border-strong bg-panel titlebar-lead"
            style={{ width: effectiveSidebarWidth + 1 }}
          >
            <div className="flex-1 min-w-0 flex items-stretch overflow-hidden">
              <AppTitleSegment fillParent />
            </div>
            <ResizeHandle onDelta={handleSidebarResize} />
          </div>
        )}
        {!singleScreenMode && sidebarVisible && (
          <div className="shrink-0 flex flex-col overflow-hidden" style={{ width: effectiveSidebarWidth }}><div className="drag-region h-10 shrink-0 flex items-stretch border-b border-border-strong bg-panel titlebar-lead"><AppTitleSegment fillParent /></div><div className="flex-1 min-h-0 flex"><Sidebar
            model={worktreeListModel}
            activeWorktreeId={sidebarActiveId}
            activeTabId={sidebarActiveId ? (activeTabId[sidebarActiveId] ?? null) : null}
            snoozeDefaultDays={settings.snoozeDefaultDays}
            prLoading={prLoading}
            onOpenAssignedPR={handleOpenAssignedPR}
            historyPromptRepos={historyPromptRepos}
            onOpenHistoryTracking={setHistoryTrackingRepo}
            onDismissHistoryPrompt={dismissHistoryPrompt}
            agentCount={agentWorktreeCount}
            onSelectWorktree={handleSidebarSelectWorktree}
            pathBackendId={fleetData.pathBackendId}
            originByPath={originByPath}
            onSelectTab={handleSidebarSelectTab}
            onCloseTab={handleSidebarCloseTab}
            onDismissPendingWorktree={handleDismissPendingWorktree}
            onNewWorktree={(repoRoot) => {
              setNewWorktreeRepo(repoRoot)
              setShowNewWorktree(true)
            }}
            onContinueWorktree={handleContinueWorktree}
            onDeleteWorktree={handleDeleteWorktree}
            onPruneWorktrees={handlePruneWorktrees}
            onRefresh={handleRefreshWorktrees}
            repoCount={repoRoots.length}
            onAddRepo={handleAddRepo}
            onRemoveRepo={handleRemoveRepo}
            onOpenSettings={() => setShowSettings(true)}
            onOpenAddBackend={() => setShowAddBackend(true)}
            onOpenHotkeyCheatsheet={() => setShowHotkeyCheatsheet(true)}
            onOpenActivity={() => setShowActivity(true)}
            onOpenSubscriptionGraph={handleOpenSubscriptionGraph}
            onOpenCleanup={() => setShowCleanup(true)}
            onOpenNewProject={() => setShowNewProject(true)}
            onOpenMyWeek={() => setShowMyWeek(true)}
            width={effectiveSidebarWidth}
            onToggleGroup={toggleGroup}
            onTogglePinnedOpen={togglePinnedOpen}
            unifiedRepos={unifiedRepos}
            onToggleUnifiedRepos={() => setUnifiedRepos((v) => !v)}
            onCollapseSidebar={() => setSidebarVisible(false)}
            editingAliasPath={editingAliasPath}
            onStartAliasEdit={setEditingAliasPath}
            onEndAliasEdit={handleEndAliasEdit}
          /></div></div>
        )}
        {!singleScreenMode && !sidebarVisible && (
          <div className="shrink-0 flex flex-col"><div className="drag-region h-10 shrink-0" /><div className="flex-1 min-h-0 flex"><CollapsedSidebar
            onExpand={() => setSidebarVisible(true)}
            onAddRepo={handleAddRepo}
            onNewWorktree={() => {
              setNewWorktreeRepo(undefined)
              setShowNewWorktree(true)
            }}
            onOpenCleanup={() => setShowCleanup(true)}
            onOpenNewProject={() => setShowNewProject(true)}
            onOpenActivity={() => setShowActivity(true)}
            onOpenSubscriptionGraph={handleOpenSubscriptionGraph}
            onOpenMyWeek={() => setShowMyWeek(true)}
            onOpenHotkeyCheatsheet={() => setShowHotkeyCheatsheet(true)}
            onOpenSettings={() => setShowSettings(true)}
          /></div></div>
        )}
        {!singleScreenMode && sidebarVisible && (
          <div className="shrink-0 flex flex-col"><div className="flex-1 min-h-0 flex"><ResizeHandle onDelta={handleSidebarResize} /></div></div>
        )}
        {/* Render ALL worktrees' terminals to keep PTYs alive across switches.
            Now spans every backend, not just the active one — each subtree is
            pinned to its owning backend below, so a remote worktree's panes
            keep streaming while a local one is on screen. Driven by the
            whole fleet, not the view-filtered list: see useFleetWorktrees. */}
        {fleetData.worktrees.map(({ backendId, worktree: wt }) => {
          const paneTree = fleetData.panes[wt.path]
          if (!paneTree) return null
          const leaves = getLeaves(paneTree)
          if (leaves.length === 0 || !leaves.some((l) => l.tabs.length > 0)) return null
          const mountKey = `${backendId}\u0000${wt.path}`
          // Local worktrees mount eagerly (cheap, keeps PTYs warm); remote
          // ones only once opened, so connecting never fans out across the
          // network. See openedWorktrees above.
          const eagerMount = backendId === LOCAL_BACKEND_ID
          const everOpened = openedWorktrees.has(mountKey)
          const isSelected = wt.path === activeWorktreeId && backendId === selectedBackendId
          if (!eagerMount && !everOpened && !isSelected) return null
          const isVisible = !showNewWorktree && !showActivity && !showCleanup && graphRepo === null && reportIssueState === null && isSelected && !pendingDeletionByPath[wt.path]
          return (
            <div
              key={`${backendId}\u0000${wt.path}`}
              className="flex-1 min-w-0"
              style={{ display: isVisible ? 'flex' : 'none' }}
            >
              {/* Pins this worktree's panes to the backend that owns it, so
                  their requests, sends and terminal:data subscriptions go to
                  the right transport even though every worktree stays
                  mounted. This is what lets a local and a remote worktree be
                  live at the same time. */}
              <BackendScope backendId={backendId}>
              <ErrorBoundary label={`worktree:${wt.path}`}>
                <WorkspaceView
                  worktreePath={wt.path}
                  repoLabel={wt.repoRoot.split('/').pop() || wt.repoRoot}
                  branch={wt.branch}
                  paneTree={paneTree}
                  focusedPaneId={activePaneId[wt.path] || leaves[0]?.id || ''}
                  visible={isVisible}
                  crashedTabIds={crashedTabIds}
                  nameAgentSessions={nameAgentSessions}
                  onSelectTab={handleSelectTab}
                  onFocusPane={handleFocusPane}
                  onAddTab={handleAddTerminalTab}
                  defaultAgent={effectiveDefaultAgent}
                  onAddAgentTab={handleAddAgentTabWithDefault}
                  onAddBrowserTab={handleAddBrowserTab}
                  onAddJsonClaudeTab={handleAddJsonClaudeTab}
                  onConvertTabType={handleConvertTabType}
                  defaultClaudeTabType={settings.defaultClaudeTabType}
                  onSleepTab={handleSleepTab}
                  onCloseTab={requestCloseTab}
                  onRestartAgentTab={handleRestartAgentTab}
                  onReorderTabs={handleReorderTabs}
                  onMoveTabToPane={handleMoveTabToPane}
                  onSendToAgent={handleSendToAgent}
                  topBarLeadingPx={
                    singleScreenMode
                      ? singleScreenLeadingPx
                      : sidebarVisible
                        ? 0
                        : effectiveSidebarWidth + 1
                  }
                  hideAppTitle
                  topBarLeadingExtendPx={
                    singleScreenMode || sidebarVisible ? 0 : 48
                  }
                  topBarTrailingExtendPx={
                    !singleScreenMode && !showNewWorktree && !showActivity && !showCleanup && graphRepo === null && reportIssueState === null
                      ? rightColumnHidden
                        ? 48
                        : rightPanelWidth + 1
                      : 0
                  }
                />
              </ErrorBoundary>
              </BackendScope>
            </div>
          )
        })}
        {showNewWorktree && (
          <NewWorktreeScreen
            onSubmit={handleSubmitNewWorktree}
            onPRSubmit={handleSubmitNewPRWorktree}
            onCancel={() => setShowNewWorktree(false)}
            repoRoots={repoRoots}
            hostLabelByRoot={hostLabelByRoot}
            repoKeyByRoot={repoKeyByRoot}
            defaultRepoRoot={newWorktreeRepo ?? (activeWorktreeId ? worktreeRepoByPath[activeWorktreeId] : undefined)}
            initialPRNumber={newWorktreeInitialPRNumber}
            forkSource={newWorktreeForkSource}
            initialBranch={newWorktreePrefill?.branch}
            initialPrompt={newWorktreePrefill?.prompt}
          />
        )}
        {reportIssueState !== null && (
          <ReportIssueScreen
            onClose={() => setReportIssueState(null)}
            initialKind={reportIssueState.kind}
            initialTitle={reportIssueState.title}
            initialBody={reportIssueState.body}
            prefilledContext={reportIssueState.context}
          />
        )}
        {showActivity && (
          <div className="flex-1 min-w-0 flex">
            <Activity
              onClose={() => setShowActivity(false)}
              onOpenMyWeek={() => {
                setShowActivity(false)
                setShowMyWeek(true)
              }}
              worktrees={worktrees}
              prStatuses={prStatuses}
              mergedPaths={mergedPaths}
            />
          </div>
        )}
        {showCleanup && (
          <div className="flex-1 min-w-0 flex">
            <Cleanup
              onClose={() => setShowCleanup(false)}
              worktrees={worktrees}
              prStatuses={prStatuses}
              mergedPaths={mergedPaths}
              lastActive={lastActive}
              backendFor={backendFor}
              onBulkDelete={handleBulkDeleteWorktrees}
            />
          </div>
        )}
        {graphRepo !== null && (
          <div className="flex-1 min-w-0 flex">
            {/* The repo can be on any backend (the sidebar merges them all),
                so the view reads the one that owns it, not the active one. */}
            <BackendScope backendId={mergedData.repoBackendId[graphRepo] ?? null}>
            <Suspense fallback={<div className="flex-1 bg-app" />}>
              <SubscriptionGraphView
                repoRoot={graphRepo}
                onChangeRepo={setGraphRepo}
                onClose={handleCloseSubscriptionGraph}
                onFocusTab={handleGraphFocusTab}
                onOpenWorktree={handleSidebarSelectWorktree}
              />
            </Suspense>
            </BackendScope>
          </div>
        )}
        {showCenterFallback && (
          <div className="flex-1 min-w-0 flex flex-col">
            <div
              className="drag-region h-10 shrink-0 border-b border-border bg-panel flex items-stretch relative z-10"
              style={{
                paddingLeft: singleScreenMode
                  ? singleScreenLeadingPx || undefined
                  : sidebarVisible
                    ? undefined
                    : effectiveSidebarWidth + 1,
                marginLeft: !singleScreenMode && !sidebarVisible ? -48 : undefined,
                marginRight: fallbackTrailingExtend ? -fallbackTrailingExtend : undefined
              }}
            >
              {singleScreenMode && <AppTitleSegment />}
            </div>
            <div className="flex-1 flex items-center justify-center">
              <CenterEmptyState
                mode={centerEmptyMode({ onboardingVisible, tourHomePath })}
                newWorktreeBinding={resolvedHotkeys.newWorktree}
                onTourStart={handleTourStart}
                onSkipTour={handleTourDismiss}
                onNewWorktree={() => setShowNewWorktree(true)}
              />
            </div>
          </div>
        )}
        {!showNewWorktree && !showActivity && !showCleanup && graphRepo === null && reportIssueState === null && isPendingId(activeWorktreeId) && (() => {
          const pending = pendingWorktrees.find((p) => p.id === activeWorktreeId)
          if (!pending) return null
          return (
            <CreatingWorktreeScreen
              pending={pending}
              onRetry={handleRetryPendingWorktree}
              onDismiss={handleDismissPendingWorktree}
              onContinue={handleContinuePendingWorktree}
            />
          )
        })()}
        {!showNewWorktree && !showActivity && !showCleanup && graphRepo === null && reportIssueState === null && activeWorktreeId && pendingDeletionByPath[activeWorktreeId] && (
          <DeletingWorktreeScreen
            deletion={pendingDeletionByPath[activeWorktreeId]}
            onDismiss={handleDismissPendingDeletion}
          />
        )}
        {!onboardingVisible && (
          <FirstRunTour
            tour={tour}
            homePath={tourHomePath}
            onStart={handleTourStart}
            onDismiss={handleTourDismiss}
          />
        )}
        {/* Right panel — hidden on the new-worktree screen so the form gets the full width.
            Pushed down 40px so the workspace tab bar can extend across the top, full width.
            The 40px top spacers are deliberately NOT drag regions: the tab bar's trailing
            extension already paints a drag region over this strip with `no-drag` tabs punched
            out. macOS app-region rects are union/diff'd in DOM order (last wins per pixel), so a
            `drag-region` here — rendered after the tab bar — would re-mark the tab pixels as
            draggable and swallow clicks on tabs that overflow above the right column. */}
        {!singleScreenMode && !showNewWorktree && !showActivity && !showCleanup && graphRepo === null && reportIssueState === null && !rightColumnHidden && (
          <div className="shrink-0 flex flex-col"><div className="h-10 shrink-0" /><div className="flex-1 min-h-0 flex"><ResizeHandle onDelta={handleRightPanelResize} /></div></div>
        )}
        {!singleScreenMode && !showNewWorktree && !showActivity && !showCleanup && graphRepo === null && reportIssueState === null && !rightColumnHidden && (
          <BackendScope backendId={selectedBackendId}><div className="shrink-0 flex flex-col"><div className="h-10 shrink-0" /><div className="flex-1 min-h-0 flex"><RightColumn
            width={rightPanelWidth}
            activeWorktreeId={activeWorktreeId}
            activeRepoRoot={activeRepoRoot}
            focusedTabId={focusedTabId}
            worktrees={worktrees}
            prStatuses={prStatuses}
            prLoading={prLoading}
            hasGithubToken={hasGithubToken}
            activeRepoConfig={activeRepoConfig}
            onRefreshPRs={fetchAllPRStatuses}
            onOpenGithubSettings={handleOpenGithubSettings}
            onOpenDiff={handleOpenDiff}
            onOpenCommitFileDiff={handleOpenCommitFileDiff}
            onOpenFile={handleOpenFile}
            onSendToAgent={handleSendToAgent}
            onOpenPR={handleOpenActivePR}
            onOpenReview={handleOpenActiveReview}
            onCollapse={handleCollapseRightColumn}
            onBuildCustomTool={handleBuildCustomTool}
          /></div></div></BackendScope>
        )}
        {!singleScreenMode && !showNewWorktree && !showActivity && !showCleanup && graphRepo === null && reportIssueState === null && rightColumnHidden && (
          <div className="shrink-0 flex flex-col"><div className="h-10 shrink-0" /><div className="flex-1 min-h-0 flex"><CollapsedRightPanel
            worktreePath={activeWorktreeId}
            onExpand={() => setRightColumnHidden(false)}
            onOpenPR={(url) => {
              if (activeWorktreeId) handleOpenPR(activeWorktreeId, url)
            }}
            onReview={() => {
              if (activeWorktreeId) void backendFor(activeWorktreeId).panesOpenReview(activeWorktreeId)
            }}
            onFileQuickOpen={() => {
              setShowHotkeyCheatsheet(false)
              setCommandPaletteMode('files')
              setShowCommandPalette(true)
            }}
            onOpenCommitFileDiff={handleOpenCommitFileDiff}
          /></div></div>
        )}
        <QuakeTerminal
          worktreePath={activeWorktreeId && !isPendingId(activeWorktreeId) ? activeWorktreeId : null}
          open={showQuakeTerminal && workspaceVisible}
          onClose={() => setShowQuakeTerminal(false)}
          leftPx={singleScreenMode ? 0 : sidebarVisible ? effectiveSidebarWidth + 1 : 48}
          rightPx={singleScreenMode ? 0 : rightColumnHidden ? 48 : rightPanelWidth + 1}
          topPx={40}
        />
      </div>
    </div>
    {settingsOverlay}
    {myWeekOverlay}
    {repoPickerOverlay}
    {repoAddPromptOverlay}
    {showPerfMonitor && <PerfMonitorHUD onClose={() => setShowPerfMonitor(false)} />}
    {showGitHubApiLog && (
      <GitHubApiLogPanel onClose={() => setShowGitHubApiLog(false)} />
    )}
    <Toasts />
    {showCommandPalette && (
      <CommandPalette
        worktrees={paletteWorktrees}
        worktreeStatuses={worktreeStatuses}
        prStatuses={prStatuses}
        mergedPaths={mergedPaths}
        activeWorktreeId={activeWorktreeId}
        resolvedHotkeys={resolvedHotkeys}
        initialMode={commandPaletteMode}
        onClose={() => setShowCommandPalette(false)}
        onSelectWorktree={(path) => {
          setShowNewWorktree(false)
          setShowActivity(false)
          setShowCleanup(false)
          setGraphRepo(null)
          setActiveWorktreeId(path)
        }}
        onAction={(action) => {
          const handler = hotkeyActions[action]
          if (handler) handler()
        }}
        onOpenFile={(filePath) => handleOpenFile(filePath)}
        onAddBackend={() => setShowAddBackend(true)}
      />
    )}
    {showHotkeyCheatsheet && (
      <HotkeyCheatsheet
        resolvedHotkeys={resolvedHotkeys}
        onClose={() => setShowHotkeyCheatsheet(false)}
        onOpenCommandPalette={() => {
          setCommandPaletteMode('root')
          setShowCommandPalette(true)
        }}
      />
    )}
    <AddBackendModal
      isOpen={showAddBackend}
      onClose={() => setShowAddBackend(false)}
    />
    {holdToQuit.phase !== 'idle' && (
      <HoldToQuitOverlay key={holdToQuit.holdId} fading={holdToQuit.phase === 'fading'} />
    )}
    {closeTabConfirm && (
      <ConfirmCloseTabModal
        tabLabel={closeTabConfirm.label}
        reason={closeTabConfirm.reason}
        onConfirm={confirmCloseTab}
        onCancel={cancelCloseTab}
      />
    )}
    </HotkeysProvider>
  )
}
