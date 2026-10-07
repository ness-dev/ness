import type { StateEvent, StateSnapshot } from '../shared/state'
export type { StateEvent, StateSnapshot }

import type { Worktree, PendingWorktree, PendingDeletion, ForkSource } from '../shared/state/worktrees'
export type { Worktree, PendingWorktree, PendingDeletion, ForkSource }

import type { RepoConfig } from '../shared/state/repo-configs'
export type { RepoConfig }

import type { ToolSpec, ToolRunResult } from '../shared/tools'
export type { ToolSpec, ToolRunResult }

import type { WeeklyStats, TopWorktree } from '../shared/weekly-stats'
export type { WeeklyStats, TopWorktree }

import type { SessionCostSummary, ClaudeAuthInfo, SubscriptionTier } from '../shared/cost-summary'
export type { SessionCostSummary, ClaudeAuthInfo, SubscriptionTier }

import type { AddRepoResult } from '../shared/repo-pick'
export type { AddRepoResult }

import type { PreventSleepMode } from '../shared/state/settings'
export type { PreventSleepMode }

/** Per-kind dirtiness flags for a worktree. `git` reflects
 *  uncommitted changes; `scratchpad` reflects a non-empty scratchpad
 *  note. The delete-worktree flow surfaces each kind separately so the
 *  confirm dialog can name what would actually be lost. */
export interface WorktreeDirtyStatus {
  git: boolean
  scratchpad: boolean
}

export interface FsEntry {
  name: string
  isDir: boolean
  isGitRepo: boolean
  isSymlink: boolean
  truncated?: true
}

export interface FileReadResult {
  content: string | null
  size: number
  binary: boolean
  truncated: boolean
  error?: string
}

export type FileBinaryReadResult =
  | { ok: true; base64: string; mime: string; size: number }
  | { ok: false; error: string }

export interface FileWriteResult {
  ok: boolean
  error?: string
}

export interface MergeConflictFixResult {
  ok: boolean
  error?: string
}

export interface FileDiffSides {
  original: string
  modified: string
  originalExists: boolean
  modifiedExists: boolean
  modifiedBinary: boolean
  error?: string
}

import type {
  AgentKind,
  PtyStatus,
  PendingTool,
  SplitDirection,
  TerminalTab,
  WorkspacePane,
  PaneNode,
  PaneLeaf,
  PaneSplit
} from '../shared/state/terminals'
export type { AgentKind, PtyStatus, PendingTool, SplitDirection, TerminalTab, WorkspacePane, PaneNode, PaneLeaf, PaneSplit }

export interface PersistedTab {
  id: string
  type: 'agent' | 'shell'
  label: string
  agentKind?: AgentKind
  sessionId?: string
}

export interface PersistedPane {
  id: string
  tabs: PersistedTab[]
  activeTabId: string
}

export type QuestStep = 'hidden' | 'spawn-second' | 'switch-between' | 'finale' | 'done'

import type { UpdaterStatus } from '../shared/state/updater'
export type { UpdaterStatus }

export interface CommitMeta {
  hash: string
  shortHash: string
  author: string
  authorEmail: string
  date: string
  subject: string
  body: string
}

export interface CommitDiff extends CommitMeta {
  diff: string
}

export interface BranchCommit {
  hash: string
  shortHash: string
  subject: string
  author: string
  relativeDate: string
  timestamp: number
  pushed: boolean
}

export interface ChangedFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
  staged: boolean
  additions?: number
  deletions?: number
}

import type { PerfMetrics, PerfSample, RendererPerfSample } from '../shared/perf-types'
export type { PerfMetrics, PerfSample, RendererPerfSample }

import type {
  GitHubApiEntry,
  GitHubApiLogSnapshot,
  GitHubApiMinuteBucket,
  GitHubApiRateLimit
} from '../shared/github-api-log-types'
export type {
  GitHubApiEntry,
  GitHubApiLogSnapshot,
  GitHubApiMinuteBucket,
  GitHubApiRateLimit
}

import type { CheckStatus, PRReview, PRStatus } from '../shared/state/prs'
export type { CheckStatus, PRReview, PRStatus }

import type { PRSummary, PRMetadata, PRLookupResult } from '../shared/github-types'
export type { PRSummary, PRMetadata, PRLookupResult }

import type { BrowserState, BrowserTabState } from '../shared/state/browser'
import type { BrowserViewport } from '../shared/browser-viewport'
export type { BrowserState, BrowserTabState }

import type {
  JsonClaudeChatEntry,
  JsonClaudePermissionMode
} from '../shared/state/json-claude'
export type { JsonClaudeChatEntry }

export type MergeStrategy = 'squash' | 'merge-commit' | 'fast-forward'

export type SidebarDensity = 'compact' | 'comfy'

import type {
  SidebarDetailPrefs as SidebarDetailPrefsShared,
  SidebarDetailPrefsByMode as SidebarDetailPrefsByModeShared,
  HiddenBottomIcons as HiddenBottomIconsShared,
  BottomIconKey as BottomIconKeyShared
} from '../shared/state/settings'
export type SidebarDetailPrefs = SidebarDetailPrefsShared
export type SidebarDetailPrefsByMode = SidebarDetailPrefsByModeShared
export type HiddenBottomIcons = HiddenBottomIconsShared
export type BottomIconKey = BottomIconKeyShared

export type GitHubMergeMethod = 'merge' | 'squash' | 'rebase'

export interface MergePRResult {
  ok: boolean
  error?: string
  errorCode?: 'unauthorized' | 'method_not_allowed' | 'conflict' | 'unprocessable' | 'unknown'
  sha?: string
}

export interface MainWorktreeStatus {
  path: string
  currentBranch: string
  baseBranch: string
  isOnBase: boolean
  isDirty: boolean
  ready: boolean
}

export interface MergeConflictPreview {
  hasConflict: boolean
  files: string[]
  unsupported?: boolean
}

export interface MergeLocalResult {
  ok: true
  strategy: MergeStrategy
  mergedBranch: string
  baseBranch: string
  mainPath: string
}

export interface ElectronAPI {
  listWorktrees(repoRoot: string): Promise<Worktree[]>
  listBranches(repoRoot: string): Promise<string[]>
  runPendingWorktree(params: {
    id: string
    repoRoot: string
    branchName: string
    initialPrompt?: string
    teleportSessionId?: string
    agentKind?: AgentKind
    model?: string,
    forkSource?: ForkSource
    checkoutExisting?: boolean
    baseRef?: string
  }): Promise<
    | { id: string; outcome: 'success'; createdPath: string }
    | { id: string; outcome: 'setup-failed'; createdPath: string }
    | { id: string; outcome: 'error'; error: string }
  >
  runPendingPRWorktree(params: {
    id: string
    repoRoot: string
    prNumber: number
    initialPrompt?: string
    agentKind?: AgentKind
    model?: string
  }): Promise<
    | { id: string; outcome: 'success'; createdPath: string }
    | { id: string; outcome: 'setup-failed'; createdPath: string }
    | { id: string; outcome: 'error'; error: string }
  >
  retryPendingWorktree(id: string): Promise<
    | { id: string; outcome: 'success'; createdPath: string }
    | { id: string; outcome: 'setup-failed'; createdPath: string }
    | { id: string; outcome: 'error'; error: string }
  >
  dismissPendingWorktree(id: string): Promise<boolean>
  refreshWorktreesList(): Promise<boolean>
  continueWorktree(
    repoRoot: string,
    worktreePath: string,
    newBranchName: string,
    baseBranch?: string
  ): Promise<{ worktree: Worktree; stashReapplied: boolean; stashConflict: boolean }>
  /** `bulk` marks a sweep over many worktrees, so the main process dequeues
   *  it behind interactive reads instead of starving them. */
  isWorktreeDirty(path: string, opts?: { bulk?: boolean }): Promise<WorktreeDirtyStatus>
  removeWorktree(
    repoRoot: string,
    path: string,
    force?: boolean,
    removeMeta?: { prNumber?: number; prState?: PRStatus['state'] }
  ): Promise<{ queued: true }>
  dismissPendingDeletion(path: string): Promise<boolean>
  pruneWorktrees(repoRoot: string): Promise<boolean>
  getWorktreeDir(repoRoot: string): Promise<string>
  listRepos(): Promise<string[]>
  addRepo(): Promise<AddRepoResult>
  addRepoAtPath(repoRoot: string): Promise<AddRepoResult>
  removeRepo(repoRoot: string): Promise<boolean>
  createNewProject(opts: {
    parentDir: string
    name: string
    includeReadme: boolean
    gitignorePreset: 'none' | 'node' | 'python' | 'macos'
  }): Promise<{ path: string } | { error: string }>
  pickDirectory(opts?: { defaultPath?: string; title?: string }): Promise<string | null>
  listDir(path: string, opts?: { showHidden?: boolean }): Promise<FsEntry[]>
  resolveHome(): Promise<string>

  getMainWorktreeStatus(repoRoot: string): Promise<MainWorktreeStatus>
  prepareMainForMerge(repoRoot: string): Promise<MainWorktreeStatus>
  previewMergeConflicts(repoRoot: string, sourceBranch: string, worktreePath?: string): Promise<MergeConflictPreview>
  mergeWorktreeLocally(
    repoRoot: string,
    sourceBranch: string,
    strategy: MergeStrategy,
    worktreePath?: string
  ): Promise<MergeLocalResult>

  refreshPRsAll(): Promise<boolean>
  refreshPRsAllIfStale(): Promise<boolean>
  refreshPRsOne(worktreePath: string): Promise<boolean>
  refreshPRsOneIfStale(worktreePath: string): Promise<boolean>

  refreshAnnouncements(): Promise<boolean>
  dismissAnnouncement(id: string): Promise<boolean>
  muteAnnouncements(muted: boolean): Promise<boolean>
  listRepoPRs(repoRoot: string): Promise<PRSummary[] | null>
  getPRByNumber(repoRoot: string, prNumber: number): Promise<PRLookupResult>
  mergePR(
    worktreePath: string,
    method: GitHubMergeMethod
  ): Promise<MergePRResult>
  approvePR(
    worktreePath: string
  ): Promise<{ ok: true } | { ok: false; error: string }>

  getWeeklyStats(): Promise<WeeklyStats>
  getBranchCommits(worktreePath: string): Promise<BranchCommit[]>
  listTools(worktreePath: string): Promise<ToolSpec[]>
  runTool(worktreePath: string, toolId: string): Promise<ToolRunResult>
  getCommitDiff(worktreePath: string, hash: string): Promise<CommitDiff | null>
  getCommitMeta(worktreePath: string, hash: string): Promise<CommitMeta | null>
  getCommitChangedFiles(worktreePath: string, hash: string): Promise<ChangedFile[]>
  getCommitFileDiffSides(worktreePath: string, hash: string, filePath: string): Promise<FileDiffSides>
  getCommitRangeChangedFiles(worktreePath: string, fromHash: string, toHash: string): Promise<ChangedFile[]>
  getCommitRangeFileDiffSides(
    worktreePath: string,
    fromHash: string,
    toHash: string,
    filePath: string
  ): Promise<FileDiffSides>
  listAllFiles(worktreePath: string): Promise<string[]>
  listRecentCommitShas(worktreePath: string): Promise<string[]>
  readWorktreeFile(worktreePath: string, filePath: string): Promise<FileReadResult>
  readWorktreeFileBinary(
    worktreePath: string,
    filePath: string
  ): Promise<FileBinaryReadResult>
  writeWorktreeFile(
    worktreePath: string,
    filePath: string,
    contents: string
  ): Promise<FileWriteResult>
  getChangedFiles(worktreePath: string, mode?: 'working' | 'branch'): Promise<ChangedFile[]>
  watchChangedFiles(worktreePath: string): void
  unwatchChangedFiles(worktreePath: string): void
  onChangedFilesInvalidated(callback: (worktreePath: string) => void): () => void
  watchFile(worktreePath: string, relativePath: string): void
  unwatchFile(worktreePath: string, relativePath: string): void
  onFileContentChanged(
    callback: (worktreePath: string, relativePath: string) => void
  ): () => void
  getFileDiff(
    worktreePath: string,
    filePath: string,
    staged: boolean,
    mode?: 'working' | 'branch'
  ): Promise<string>
  getFileDiffSides(
    worktreePath: string,
    filePath: string,
    staged: boolean,
    mode?: 'working' | 'branch'
  ): Promise<FileDiffSides>

  // Settings — all reads come from useSettings()/useRepoConfigs()/etc.
  // Only the mutation methods + a few constant accessors remain on the IPC.
  setHotkeyOverrides(hotkeys: Record<string, string>): Promise<boolean>
  resetHotkeyOverrides(): Promise<boolean>
  setClaudeCommand(command: string): Promise<boolean>
  getDefaultClaudeCommand(): Promise<string>
  setHarnessMcpEnabled(enabled: boolean): Promise<boolean>
  setAutoApprovePermissions(enabled: boolean): Promise<boolean>
  setAutoApproveSteerInstructions(text: string): Promise<boolean>
  setClaudeTuiFullscreen(enabled: boolean): Promise<boolean>
  setWsTransportEnabled(enabled: boolean): Promise<boolean>
  setWsTransportPort(port: number): Promise<number>
  setWsTransportHost(host: string): Promise<string>
  getWsTransportInfo(): Promise<{ port: number; token: string; host: string } | null>
  rotateWsToken(): Promise<string>
  getLanAddresses(): Promise<Array<{ iface: string; address: string }>>
  setBrowserToolsEnabled(enabled: boolean): Promise<boolean>
  setBrowserToolsMode(mode: 'view' | 'full'): Promise<boolean>
  setConversationForkEnabled(enabled: boolean): Promise<boolean>
  setWorktreeMessagingEnabled(enabled: boolean): Promise<boolean>
  setDefaultClaudeTabType(value: 'xterm' | 'json'): Promise<boolean>
  setChatPromotionDismissed(value: boolean): Promise<boolean>
  setJsonModeChatDensity(value: 'compact' | 'comfy'): Promise<boolean>
  setUiScale(value: 'x-small' | 'small' | 'medium' | 'large' | 'x-large'): Promise<boolean>
  setNessieColor(value: string): Promise<boolean>
  setJsonModeSendOnEnter(enabled: boolean): Promise<boolean>
  setAutoScrollToBottom(enabled: boolean): Promise<boolean>
  setJsonModeDefaultPermissionMode(
    value: JsonClaudePermissionMode
  ): Promise<boolean>
  setJsonModeTranscriptWindow(value: number): Promise<boolean>
  setAutoSleepMinutes(value: number): Promise<boolean>
  setPreventSleepMode(value: PreventSleepMode): Promise<boolean>
  setPreventSleepUntil(value: number | null): Promise<boolean>
  setAutoUpdateEnabled(enabled: boolean): Promise<boolean>
  setWarnBeforeQuitting(enabled: boolean): Promise<boolean>
  setOpenPrInBrowserTab(enabled: boolean): Promise<boolean>
  setTerminalPlainClickOpensInApp(enabled: boolean): Promise<boolean>
  setExpandedDiagnosticLoggingEnabled(enabled: boolean): Promise<boolean>
  setShowAssignedPRs(enabled: boolean): Promise<boolean>
  refreshAssignedPRs(): Promise<boolean>
  setShareClaudeSettings(enabled: boolean): Promise<boolean>
  setNewWorktreeAdvancedOpen(open: boolean): Promise<boolean>
  setStarterTasksDismissed(dismissed: boolean): Promise<boolean>
  setHarnessSystemPromptEnabled(enabled: boolean): Promise<boolean>
  setHarnessSystemPrompt(prompt: string): Promise<boolean>
  setHarnessSystemPromptMain(prompt: string): Promise<boolean>
  setPrReviewPrompt(prompt: string): Promise<boolean>
  prepareMcpForTerminal(terminalId: string): Promise<string | null>
  onWorktreesExternalCreate(
    callback: (payload: { repoRoot: string; worktree: Worktree; initialPrompt?: string }) => void
  ): () => void
  setClaudeEnvVars(vars: Record<string, string>): Promise<boolean>
  setDefaultAgent(agent: string): Promise<boolean>
  setCodexCommand(command: string): Promise<boolean>
  setCursorCommand(command: string): Promise<boolean>
  setClaudeModel(model: string | null): Promise<boolean>
  setCodexModel(model: string | null): Promise<boolean>
  setCursorModel(model: string | null): Promise<boolean>
  setCodexEnvVars(vars: Record<string, string>): Promise<boolean>
  setCursorEnvVars(vars: Record<string, string>): Promise<boolean>
  setNameClaudeSessions(enabled: boolean): Promise<boolean>
  setThemeMode(mode: 'light' | 'dark' | 'system'): Promise<boolean>
  setThemeLight(theme: string): Promise<boolean>
  setThemeDark(theme: string): Promise<boolean>
  setLastEffectiveAppBg(hex: string): void
  /** Rescan `<userData>/themes/*.json` and update the slice. Returns
   *  the new theme count. */
  reloadCustomThemes(): Promise<number>
  /** Reveal the themes directory in the OS file browser (Electron only).
   *  Always returns the absolute directory path so the web client can
   *  surface it manually. */
  openThemesFolder(): Promise<{ ok: true; path: string } | { ok: false; path: string; message: string }>
  setCostsInterest(expanded: boolean): Promise<boolean>
  setContextWindowInterest(expanded: boolean): Promise<boolean>
  getAllSessionCosts(sinceMs?: number): Promise<SessionCostSummary[]>
  getClaudeAuthStatus(): Promise<ClaudeAuthInfo>
  getAvailableThemes(): Promise<readonly string[]>
  setTerminalFontFamily(fontFamily: string): Promise<boolean>
  getDefaultTerminalFontFamily(): Promise<string>
  setTerminalFontSize(fontSize: number): Promise<boolean>
  setOnboardingQuest(quest: QuestStep): Promise<boolean>
  setWorktreeScripts(scripts: { setup: string; teardown: string }): Promise<boolean>
  setRepoConfig(repoRoot: string, next: Partial<RepoConfig>): Promise<RepoConfig | null>
  migrateRepoConfigFilename(repoRoot: string): Promise<boolean>
  setWorktreeBase(mode: 'remote' | 'local'): Promise<boolean>
  setMergeStrategy(strategy: MergeStrategy): Promise<boolean>
  setSidebarDensity(density: SidebarDensity): Promise<boolean>
  setSidebarDetails(prefs: SidebarDetailPrefsByMode): Promise<boolean>
  setHiddenBottomIcons(hidden: HiddenBottomIcons): Promise<boolean>
  setBottomIconOrder(order: BottomIconKey[]): Promise<boolean>
  setEditor(editorId: string): Promise<boolean>
  /** Set (or clear, with `null`) the per-repo editor override. */
  setRepoEditor(repoRoot: string, editorId: string | null): Promise<boolean>
  /** Set (or clear, with `null`) the per-worktree editor override. */
  setWorktreeEditor(worktreePath: string, editorId: string | null): Promise<boolean>
  getAvailableEditors(): Promise<{ id: string; name: string }[]>
  snooze(path: string, wakeAt: number): Promise<boolean>
  unsnooze(path: string): Promise<boolean>
  pinWorktree(path: string): Promise<boolean>
  unpinWorktree(path: string): Promise<boolean>
  setSnoozeDefaultDays(days: number): Promise<boolean>
  /** `enabled: null` clears the override so the worktree inherits the
   *  global `notifyChatOnCiFailure` setting again. */
  setCiNotifyOverride(path: string, enabled: boolean | null): Promise<boolean>
  setNotifyChatOnCiFailure(enabled: boolean): Promise<boolean>
  /** Injects a "resolve this PR's conflicts" turn into the worktree's agent
   *  chat, waking a slept tab if needed. */
  requestMergeConflictFix(worktreePath: string): Promise<MergeConflictFixResult>
  setScratchpadText(worktreePath: string, text: string): Promise<boolean>
  setAlias(path: string, alias: string): Promise<boolean>
  clearAlias(path: string): Promise<boolean>
  openInEditor(worktreePath: string, filePath?: string): Promise<{ ok: true } | { ok: false; error: string }>

  // Corrupt-config recovery (InvalidConfigModal). save/reset re-apply on
  // success (relaunch in prod), so their result only resolves on failure.
  readRawConfig(): Promise<{ text: string }>
  saveRawConfigAndRetry(text: string): Promise<{ ok: true } | { ok: false; error: string }>
  resetConfigToDefaults(): Promise<{ ok: true } | { ok: false; error: string }>

  panesAddTab(wtPath: string, tab: TerminalTab, paneId?: string): Promise<boolean>
  panesCloseTab(wtPath: string, tabId: string): Promise<boolean>
  panesRestartAgentTab(wtPath: string, tabId: string, newId: string): Promise<boolean>
  panesConvertTabType(
    wtPath: string,
    tabId: string,
    newType: 'agent' | 'json-claude'
  ): Promise<boolean>
  panesSelectTab(wtPath: string, paneId: string, tabId: string): Promise<boolean>
  panesReorderTabs(
    wtPath: string,
    paneId: string,
    fromId: string,
    toId: string
  ): Promise<boolean>
  panesRenameTab(wtPath: string, tabId: string, label: string): Promise<boolean>
  panesMoveTabToPane(
    wtPath: string,
    tabId: string,
    toPaneId: string,
    toIndex?: number
  ): Promise<boolean>
  panesSplitPane(
    wtPath: string,
    fromPaneId: string,
    direction?: 'horizontal' | 'vertical'
  ): Promise<PaneLeaf | null>
  panesSetRatio(
    wtPath: string,
    splitId: string,
    ratio: number
  ): Promise<boolean>
  panesClearForWorktree(wtPath: string): Promise<boolean>
  panesEnsureInitialized(wtPath: string): Promise<boolean>
  panesSleepTab(wtPath: string, tabId: string): Promise<boolean>
  panesWakeTab(wtPath: string, tabId: string): Promise<boolean>
  panesOpenReview(wtPath: string): Promise<boolean>
  panesOpenFile(wtPath: string, filePath: string, nearTabId?: string): Promise<boolean>
  panesSetReviewSelection(
    wtPath: string,
    tabId: string,
    fromCommit?: string,
    toCommit?: string
  ): Promise<boolean>
  touchWorktreeLastActive(wtPath: string): Promise<boolean>
  getTerminalHistory(id: string): Promise<string>
  clearTerminalHistory(id: string): Promise<boolean>
  agentSessionFileExists(cwd: string, sessionId: string, agentKind?: AgentKind): Promise<boolean>
  getLatestAgentSessionId(cwd: string, agentKind?: AgentKind): Promise<string | null>
  buildAgentSpawnArgs(agentKind: string, opts: {
    terminalId: string; cwd: string; sessionId?: string;
    initialPrompt?: string; teleportSessionId?: string;
    sessionName?: string; modelOverride?: string
  }): Promise<string>

  hasGithubToken(): Promise<boolean>
  setGithubToken(token: string): Promise<{ ok: boolean; username?: string; error?: string }>
  clearGithubToken(): Promise<boolean>
  setHarnessStarred(starred: boolean): Promise<{ ok: boolean; error?: string }>

  getVersion(): Promise<string>
  readRecentLog(maxLines?: number): Promise<string>
  checkForUpdates(): Promise<{ ok: boolean; available?: boolean; version?: string; releaseDate?: string; error?: string }>
  quitAndInstall(): Promise<boolean>
  /** Dev-only: fakes an updater status so the update UI can be checked in `npm run dev`. */
  devSimulateUpdate(state: 'available' | 'downloading' | 'downloaded' | 'clear'): Promise<boolean>

  getPerfMetrics(): Promise<PerfMetrics>
  perfReportRendererSample(sample: RendererPerfSample): void

  getGitHubApiLog(): Promise<GitHubApiLogSnapshot>
  clearGitHubApiLog(): Promise<boolean>
  onGitHubApiLogAppended(callback: (entry: GitHubApiEntry) => void): () => void

  logError(
    label: string,
    error: { name?: string; message?: string; stack?: string },
    info?: { componentStack?: string | null }
  ): Promise<boolean>

  openExternal(url: string): void
  openPath(path: string): Promise<{ ok: true } | { ok: false; message: string }>
  openDebugLog(): Promise<{ ok: true } | { ok: false; message: string }>
  showDebugLogInFolder(): Promise<boolean>
  getFilePath(file: File): string
  windowMinimize(): void
  windowToggleMaximize(): void
  windowClose(): void
  onOpenSettings(callback: () => void): () => void
  onHoldToQuitStart(callback: () => void): () => void
  onHoldToQuitCancel(callback: () => void): () => void
  onTogglePerfMonitor(callback: () => void): () => void
  onToggleSingleScreen(callback: () => void): () => void
  onOpenKeyboardShortcuts(callback: () => void): () => void
  onCloseFocusedTab(callback: () => void): () => void
  onSplitPaneRight(callback: () => void): () => void
  onSplitPaneDown(callback: () => void): () => void
  onOpenNewProject(callback: () => void): () => void
  onOpenReportIssue(callback: () => void): () => void
  onOpenGitHubApiLog(callback: () => void): () => void
  onDebugCrashFocusedTab(callback: () => void): () => void
  onDebugPreviewOnboarding(callback: () => void): () => void
  onOpenAddBackend(callback: () => void): () => void
  onUiScaleUp(callback: () => void): () => void
  onUiScaleDown(callback: () => void): () => void
  onUiScaleReset(callback: () => void): () => void
  onFullscreenChanged(callback: (isFullscreen: boolean) => void): () => void

  acceptHooks(): Promise<boolean>
  declineHooks(): Promise<boolean>
  uninstallHooks(): Promise<boolean>

  browserNavigate(tabId: string, url: string): Promise<boolean>
  browserBack(tabId: string): Promise<boolean>
  browserForward(tabId: string): Promise<boolean>
  browserReload(tabId: string): Promise<boolean>
  browserOpenDevTools(tabId: string): Promise<boolean>
  /** Emulate a viewport (device mode) for a browser tab; null clears it. */
  browserSetViewport(
    tabId: string,
    viewport: BrowserViewport | null,
    opts?: { reload?: boolean }
  ): Promise<{ ok: boolean; error?: string; viewport?: BrowserViewport | null }>
  browserSetBounds(
    tabId: string,
    bounds: { x: number; y: number; width: number; height: number } | null
  ): void
  browserHide(tabId: string): void
  browserScreenshot(
    tabId: string,
    opts?: { format?: 'jpeg' | 'png'; quality?: number }
  ): Promise<{ data: string; format: 'jpeg' | 'png' } | null>
  browserClick(
    tabId: string,
    x: number,
    y: number,
    opts?: { button?: 'left' | 'right' | 'middle'; clickCount?: number }
  ): Promise<boolean>
  browserType(tabId: string, text: string, key?: string): Promise<boolean>
  browserScroll(tabId: string, dx: number, dy: number): Promise<boolean>

  createTerminal(
    id: string,
    cwd: string,
    cmd: string,
    args: string[],
    agentKind?: AgentKind,
    cols?: number,
    rows?: number
  ): void
  writeTerminal(id: string, data: string): void
  resizeTerminal(id: string, cols: number, rows: number): void
  killTerminal(id: string): void
  joinTerminal(id: string): void
  leaveTerminal(id: string): void
  takeTerminalControl(id: string, cols: number, rows: number): void
  setTerminalProgress(id: string, state: 0 | 1 | 2 | 3 | 4, value: number): void
  onTerminalData(callback: (id: string, data: string) => void): () => void
  onTerminalExit(callback: (id: string, exitCode: number) => void): () => void

  getActivityLog(): Promise<ActivityLog>
  clearActivityLog(worktreePath?: string): Promise<boolean>

  // JSON-mode Claude — approval bridge + session lifecycle.
  resolveJsonClaudeApproval(
    requestId: string,
    result: {
      behavior: 'allow' | 'deny'
      updatedInput?: Record<string, unknown>
      updatedPermissions?: unknown[]
      message?: string
      interrupt?: boolean
    }
  ): Promise<boolean>
  rerunJsonClaudeAutoApprovalReview(requestId: string): Promise<boolean>
  startJsonClaude(id: string, cwd: string): Promise<boolean>
  sendJsonClaudeMessage(
    id: string,
    text: string,
    images?: Array<{ mediaType: string; data: string; path: string }>
  ): void
  cancelQueuedJsonClaudeMessage(id: string, messageId: string): void
  writeJsonClaudeAttachmentImage(
    base64: string,
    mediaType: string
  ): Promise<string | null>
  readJsonClaudeAttachmentImage(path: string): Promise<string | null>
  getJsonClaudeEntries(sessionId: string): Promise<JsonClaudeChatEntry[]>
  killJsonClaude(id: string): Promise<boolean>
  interruptJsonClaude(id: string): Promise<boolean>
  interruptAndSendJsonClaude(
    id: string,
    text: string,
    images?: Array<{ mediaType: string; data: string; path: string }>
  ): Promise<{ ok: boolean; reason?: string }>
  rewindJsonClaudeTo(
    id: string,
    entryId: string
  ): Promise<{ ok: boolean; reason?: string }>
  forkJsonClaudeAt(
    id: string,
    entryId: string
  ): Promise<{ ok: boolean; newSessionId?: string; reason?: string }>
  openJsonClaudeAuthLoginTab(
    worktreePath: string
  ): Promise<{ ok: true; tabId: string } | { ok: false; error: string }>
  setJsonClaudePermissionMode(
    id: string,
    mode: JsonClaudePermissionMode
  ): Promise<boolean>
  setJsonClaudeTabModel(
    id: string,
    model: string
  ): Promise<{ ok: boolean; reason?: string }>
  grantJsonClaudeSessionToolApprovals(
    id: string,
    toolNames: string[]
  ): Promise<boolean>
  clearJsonClaudeSessionToolApprovals(
    id: string,
    toolNames?: string[]
  ): Promise<boolean>

  getStateSnapshot(): Promise<StateSnapshot>
  onStateEvent(callback: (event: StateEvent, seq: number) => void): () => void

  getClientId(): Promise<string>

  // Multi-backend connections list (Tier 1). Always routes to the local
  // Electron backend. See plans/tier-1-multi-backend-ux.md.
  connectionsList(): Promise<BackendConnection[]>
  connectionsAdd(
    input: { label: string; url: string; kind: 'remote'; color?: string; initials?: string },
    token: string
  ): Promise<BackendConnection>
  connectionsRemove(id: string): Promise<boolean>
  connectionsRename(id: string, label: string): Promise<boolean>
  connectionsSetActive(id: string): Promise<boolean>
  connectionsGetActive(): Promise<string>
  connectionsSetLastConnected(id: string, when?: number): Promise<boolean>
  connectionsGetToken(id: string): Promise<string | null>
  connectionsHasToken(id: string): Promise<boolean>

  // SSH bootstrap (remote-SSH backend flow). Always-local; the local
  // Electron backend is the one that drives SSH. See plans/remote-main.md §4.
  sshListConfiguredHosts(): Promise<ConfiguredHost[]>
  /** Kick off a first-time SSH bootstrap. Progress events stream into
   *  the sshBootstrap slice keyed by `bootstrapId` (mint a fresh uuid
   *  v4 client-side BEFORE calling so you can subscribe to progress
   *  via useSshBootstrap(bootstrapId)). Resolves with the persisted
   *  connection id once the tunnel is live and the connection has been
   *  added to `connections[]`. */
  sshBootstrap(input: {
    bootstrapId: string
    target: string
    label: string
  }): Promise<{ connectionId: string }>
  /** Reconnect an existing SSH backend. Idempotent — if a live tunnel
   *  already exists, returns its URL/token without re-running SSH. */
  sshReconnect(input: {
    bootstrapId: string
    connectionId: string
  }): Promise<{ url: string; token: string; localPort: number }>
  /** Re-install harness-server on an SSH backend and restart it.
   *  Destructive — every session on that remote dies. Confirm with the
   *  user first. Resolves with the new loopback URL/token; the caller
   *  must drop and re-hydrate the backend's WS transport. */
  sshUpgradeServer(input: {
    bootstrapId: string
    connectionId: string
  }): Promise<{
    url: string
    token: string
    localPort: number
    serverVersion: string | null
  }>
}

/** An SSH host parsed out of `~/.ssh/config`. Mirrors the main-process
 *  `ConfiguredHost` shape in src/main/ssh-config.ts. */
export interface ConfiguredHost {
  alias: string
  host: string
  user?: string
  port?: number
  identityFile?: string
}

/** A configured backend (multi-backend UX). Kept in sync with the
 *  main-process `BackendConnection` shape in src/main/persistence.ts. */
export interface BackendConnection {
  id: string
  label: string
  url: string
  kind: 'local' | 'remote'
  addedAt: number
  lastConnectedAt?: number
  color?: string
  initials?: string
  /** Set on remotes that were bootstrapped via SSH. The renderer uses
   *  the presence of this field to decide between "edit URL/token" and
   *  "edit SSH target" affordances. The actual reconnect machinery
   *  lives in main; the renderer just kicks `ssh:reconnect` when the
   *  user clicks a disconnected SSH chip. */
  ssh?: {
    target: string
    tunnelLocalPort?: number
  }
}

export type ActivityState = 'processing' | 'waiting' | 'needs-approval' | 'idle' | 'merged'
export interface ActivityEvent { t: number; s: ActivityState }
export interface ActivityDiffStats {
  added: number
  removed: number
  files: number
}
export interface ActivityRecord {
  branch?: string
  repoRoot?: string
  createdAt?: number
  removedAt?: number
  diffStats?: ActivityDiffStats
  prNumber?: number
  prState?: PRStatus['state']
  events: ActivityEvent[]
}
export type ActivityLog = Record<string, ActivityRecord>

// Re-export so existing renderer-side callers can keep importing
// LocalTransportHandle from `./types`. Canonical definition lives in
// src/shared/transport/transport.ts so the preload (limited to
// tsconfig.node.json) can also import it.
export type { LocalTransportHandle } from '../shared/transport/transport'

declare global {
  interface Window {
    __harness_local_transport?: import('../shared/transport/transport').LocalTransportHandle
  }
}
