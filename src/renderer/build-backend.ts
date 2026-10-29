// Renderer-side construction of the `Backend` interface — what was
// historically `window.api`, now built in renderer context so that
// remote backends (whose transport is a renderer-living
// WebSocketClientTransport) bypass the preload entirely. See
// plans/tier-1-multi-backend-ux.md and the discussion in commit
// history for why we moved this out of the preload.
//
// Two transport accessors are passed in (rather than a single
// `transport` reference):
//
//   - `getActiveTransport()` — returns whichever backend the user has
//     currently selected (local handle for local, WS transport for
//     remotes). Most methods route through this so the UI's commands
//     go to the active backend.
//   - `getLocalTransport()` — always returns the local backend's
//     transport handle. Used by the connections list (which is a
//     renderer-shell concern, never forwarded to remotes — see
//     plans/tier-1-multi-backend-ux.md §C/§G), the menu signals
//     (only the local Electron has a Menu), and window controls
//     (the local BrowserWindow is what's being controlled).
//
// Both accessors are called LAZILY on each method invocation so that
// flipping the active backend with `BackendsRegistry.setActive(id)`
// instantly redirects subsequent calls without rebuilding the
// Backend object. Components reading via `useBackend()` see a
// stable reference; only the underlying call destination changes.
//
// The actual method declarations below are a near-verbatim move of
// the contents of the preload's old `contextBridge.exposeInMainWorld('api', ...)`
// block — same channel names, same arg shapes, same JSDoc-worthy
// behavior. The historical reason this lived in the preload (single
// global transport, contextIsolation requiring contextBridge for
// ipcRenderer) no longer applies once we got multi-backend right.

import type {
  ClientSignalHandler,
  ElectronOnlyHelpers,
  LocalTransportHandle,
  StateEventListener
} from '../shared/transport/transport'
import type { ElectronAPI, AgentKind, ReviewCommentStatus, ReviewVerdict } from './types'
import type { RendererPerfSample } from '../shared/perf-types'
import type { ForkSource } from '../shared/state/worktrees'
import type { BrowserViewport } from '../shared/browser-viewport'
import type { JsonClaudePermissionMode } from '../shared/state/json-claude'
import {
  CLIENT_OWNED_CONFIG_CHANNELS,
  type SidebarDetailPrefsByMode,
  type PreventSleepMode,
  type AgentReviewDelivery,
  type HiddenBottomIcons,
  type BottomIconKey
} from '../shared/state/settings'

export type { ElectronOnlyHelpers }

type DataCallback = (id: string, data: string) => void
type ExitCallback = (id: string, exitCode: number) => void

export function buildBackend(
  getActiveTransport: () => LocalTransportHandle,
  getLocalTransport: () => LocalTransportHandle,
  electronHelpers: ElectronOnlyHelpers | null
): ElectronAPI {
  // Active-routed (most things). Goes to whichever backend the user
  // currently has selected.
  const req = (name: string, ...args: unknown[]): Promise<unknown> =>
    getActiveTransport().request(name, ...args)
  const sig = (name: string, ...args: unknown[]): void =>
    getActiveTransport().send(name, ...args)
  const onActiveSignal = (
    name: string,
    handler: ClientSignalHandler
  ): (() => void) => getActiveTransport().onSignal(name, handler)

  // Always-local. Bypasses the active-backend router for renderer-shell
  // concerns (connections list) and for things only the local Electron
  // can fire (menu signals, window controls).
  const reqLocal = (name: string, ...args: unknown[]): Promise<unknown> =>
    getLocalTransport().request(name, ...args)
  const sigLocal = (name: string, ...args: unknown[]): void =>
    getLocalTransport().send(name, ...args)
  const onLocalSignal = (
    name: string,
    handler: ClientSignalHandler
  ): (() => void) => getLocalTransport().onSignal(name, handler)

  // Settings. Appearance, hotkeys and local-window behavior belong to
  // the client, not to whichever workspace it happens to be looking at
  // — so those channels answer from the client's own backend while the
  // rest (operational config a remote's main acts on) stay active-routed.
  // The split is declared once in CLIENT_OWNED_CONFIG_CHANNELS, next to
  // the matching CLIENT_OWNED_SETTING_KEYS that `useSettings` overlays.
  // In the web client both accessors return the same transport, so this
  // is a no-op there.
  const reqConfig = (name: string, ...args: unknown[]): Promise<unknown> =>
    CLIENT_OWNED_CONFIG_CHANNELS.has(name)
      ? getLocalTransport().request(name, ...args)
      : getActiveTransport().request(name, ...args)

  // Stub used when an Electron-only helper is called in the web
  // client (where `electronHelpers` is null). Logged once per call
  // site name so a missed branch surfaces in the console without
  // crashing.
  const warned = new Set<string>()
  const electronOnly = <T,>(name: string, fallback: T): T => {
    if (!warned.has(name)) {
      warned.add(name)
      // eslint-disable-next-line no-console
      console.warn(`[backend] '${name}' is unavailable in this runtime`)
    }
    return fallback
  }

  // The api object literal below is what `window.api` historically
  // pointed at, modulo the swap from preload-bound helpers (req/sig
  // closing over a single transport) to the registry-aware ones above.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api: any = {
    listWorktrees: (repoRoot: string) => req('worktree:list', repoRoot),
    listBranches: (repoRoot: string) => req('worktree:branches', repoRoot),

    runPendingWorktree: (params: {
      id: string
      repoRoot: string
      branchName: string
      initialPrompt?: string
      teleportSessionId?: string
      agentKind?: AgentKind
      model?: string
      forkSource?: ForkSource
      checkoutExisting?: boolean
      baseRef?: string
    }) => req('worktrees:runPending', params),
    runPendingPRWorktree: (params: {
      id: string
      repoRoot: string
      prNumber: number
      initialPrompt?: string
      agentKind?: AgentKind
      model?: string
    }) => req('worktrees:runPendingPR', params),
    retryPendingWorktree: (id: string) => req('worktrees:retryPending', id),
    dismissPendingWorktree: (id: string) => req('worktrees:dismissPending', id),
    refreshWorktreesList: () => req('worktrees:refreshList'),

    continueWorktree: (
      repoRoot: string,
      worktreePath: string,
      newBranchName: string,
      baseBranch?: string
    ) => req('worktree:continue', repoRoot, worktreePath, newBranchName, baseBranch),
    isWorktreeDirty: (path: string, opts?: { bulk?: boolean }) =>
      req('worktree:isDirty', path, opts),
    removeWorktree: (
      repoRoot: string,
      path: string,
      force?: boolean,
      removeMeta?: { prNumber?: number; prState?: 'open' | 'draft' | 'merged' | 'closed' },
      opts?: { overrideLock?: boolean }
    ) => req('worktree:remove', repoRoot, path, force, removeMeta, opts),
    dismissPendingDeletion: (path: string) => req('worktree:dismissPendingDeletion', path),
    pruneWorktrees: (repoRoot: string) => req('worktrees:prune', repoRoot),
    getWorktreeDir: (repoRoot: string) => req('worktree:dir', repoRoot),

    listRepos: () => req('repo:list'),
    addRepo: () => req('repo:add'),
    addRepoAtPath: (repoRoot: string) => req('repo:addAtPath', repoRoot),
    removeRepo: (repoRoot: string) => req('repo:remove', repoRoot),
    createNewProject: (opts: {
      parentDir: string
      name: string
      includeReadme: boolean
      gitignorePreset: 'none' | 'node' | 'python' | 'macos'
    }) => req('repo:createNewProject', opts),
    pickDirectory: (opts?: { defaultPath?: string; title?: string }) =>
      req('dialog:pickDirectory', opts),

    listDir: (path: string, opts?: { showHidden?: boolean }) =>
      req('fs:listDir', path, opts),
    resolveHome: () => req('fs:resolveHome'),

    listAllFiles: (worktreePath: string) => req('worktree:listFiles', worktreePath),
    listRecentCommitShas: (worktreePath: string) =>
      req('worktree:recentCommitShas', worktreePath),
    readWorktreeFile: (worktreePath: string, filePath: string) =>
      req('worktree:readFile', worktreePath, filePath),
    readWorktreeFileBinary: (worktreePath: string, filePath: string) =>
      req('worktree:readFileBinary', worktreePath, filePath),
    writeWorktreeFile: (worktreePath: string, filePath: string, contents: string) =>
      req('worktree:writeFile', worktreePath, filePath, contents),

    getChangedFiles: (worktreePath: string, mode?: 'working' | 'branch') =>
      req('worktree:changedFiles', worktreePath, mode),
    watchChangedFiles: (worktreePath: string) =>
      sig('worktree:watchChangedFiles', worktreePath),
    unwatchChangedFiles: (worktreePath: string) =>
      sig('worktree:unwatchChangedFiles', worktreePath),
    onChangedFilesInvalidated: (callback: (worktreePath: string) => void) =>
      onActiveSignal('worktree:changedFilesInvalidated', (path) => {
        callback(path as string)
      }),
    watchFile: (worktreePath: string, relativePath: string) =>
      sig('file:watchSubscribe', worktreePath, relativePath),
    unwatchFile: (worktreePath: string, relativePath: string) =>
      sig('file:watchUnsubscribe', worktreePath, relativePath),
    onFileContentChanged: (
      callback: (worktreePath: string, relativePath: string) => void
    ) =>
      onActiveSignal('file:contentChanged', (worktreePath, relativePath) => {
        callback(worktreePath as string, relativePath as string)
      }),
    getFileDiff: (
      worktreePath: string,
      filePath: string,
      staged: boolean,
      mode?: 'working' | 'branch'
    ) => req('worktree:fileDiff', worktreePath, filePath, staged, mode),
    getFileDiffSides: (
      worktreePath: string,
      filePath: string,
      staged: boolean,
      mode?: 'working' | 'branch'
    ) => req('worktree:fileDiffSides', worktreePath, filePath, staged, mode),
    getBranchCommits: (worktreePath: string) => req('worktree:branchCommits', worktreePath),
    listTools: (worktreePath: string) => req('tools:list', worktreePath),
    runTool: (worktreePath: string, toolId: string) => req('tools:run', worktreePath, toolId),
    getCommitDiff: (worktreePath: string, hash: string) =>
      req('worktree:commitDiff', worktreePath, hash),
    getCommitMeta: (worktreePath: string, hash: string) =>
      req('worktree:commitMeta', worktreePath, hash),
    getCommitChangedFiles: (worktreePath: string, hash: string) =>
      req('worktree:commitChangedFiles', worktreePath, hash),
    getCommitFileDiffSides: (worktreePath: string, hash: string, filePath: string) =>
      req('worktree:commitFileDiffSides', worktreePath, hash, filePath),
    getCommitRangeChangedFiles: (worktreePath: string, fromHash: string, toHash: string) =>
      req('worktree:commitRangeChangedFiles', worktreePath, fromHash, toHash),
    getCommitRangeFileDiffSides: (
      worktreePath: string,
      fromHash: string,
      toHash: string,
      filePath: string
    ) => req('worktree:commitRangeFileDiffSides', worktreePath, fromHash, toHash, filePath),
    getMainWorktreeStatus: (repoRoot: string) => req('worktree:mainStatus', repoRoot),
    prepareMainForMerge: (repoRoot: string) => req('worktree:prepareMain', repoRoot),
    previewMergeConflicts: (repoRoot: string, sourceBranch: string, worktreePath?: string) =>
      req('worktree:previewMerge', repoRoot, sourceBranch, worktreePath),
    mergeWorktreeLocally: (
      repoRoot: string,
      sourceBranch: string,
      strategy: 'squash' | 'merge-commit' | 'fast-forward',
      worktreePath?: string
    ) => req('worktree:mergeLocal', repoRoot, sourceBranch, strategy, worktreePath),

    refreshPRsAll: () => req('prs:refreshAll'),
    refreshPRsAllIfStale: () => req('prs:refreshAllIfStale'),
    refreshPRsOne: (worktreePath: string) => req('prs:refreshOne', worktreePath),
    refreshPRsOneIfStale: (worktreePath: string) => req('prs:refreshOneIfStale', worktreePath),

    refreshAnnouncements: () => req('announcements:refresh'),
    dismissAnnouncement: (id: string) => req('announcements:dismiss', id),
    muteAnnouncements: (muted: boolean) => req('announcements:mute', muted),
    listRepoPRs: (repoRoot: string) => req('prs:listOpen', repoRoot),
    getPRByNumber: (repoRoot: string, prNumber: number) =>
      req('prs:getByNumber', repoRoot, prNumber),
    mergePR: (worktreePath: string, method: 'merge' | 'squash' | 'rebase') =>
      req('pr:merge', worktreePath, method),
    approvePR: (worktreePath: string) => req('pr:approve', worktreePath),

    getWeeklyStats: () => req('stats:getWeekly'),

    setHotkeyOverrides: (hotkeys: Record<string, string>) => reqConfig('config:setHotkeys', hotkeys),
    resetHotkeyOverrides: () => reqConfig('config:resetHotkeys'),
    setClaudeCommand: (command: string) => reqConfig('config:setClaudeCommand', command),
    getDefaultClaudeCommand: () => reqConfig('config:getDefaultClaudeCommand'),
    setWorktreeScripts: (scripts: { setup?: string; teardown?: string }) =>
      reqConfig('config:setWorktreeScripts', scripts),
    setRepoConfig: (repoRoot: string, next: Record<string, unknown>) =>
      req('repoConfig:set', repoRoot, next),
    migrateRepoConfigFilename: (repoRoot: string) =>
      req('repoConfig:migrateFilename', repoRoot),
    setClaudeEnvVars: (vars: Record<string, string>) => reqConfig('config:setClaudeEnvVars', vars),
    setDefaultAgent: (agent: string) => reqConfig('config:setDefaultAgent', agent),
    setCodexCommand: (command: string) => reqConfig('config:setCodexCommand', command),
    setCursorCommand: (command: string) => reqConfig('config:setCursorCommand', command),
    setClaudeModel: (model: string | null) => reqConfig('config:setClaudeModel', model),
    setCodexModel: (model: string | null) => reqConfig('config:setCodexModel', model),
    setCursorModel: (model: string | null) => reqConfig('config:setCursorModel', model),
    setCodexEnvVars: (vars: Record<string, string>) => reqConfig('config:setCodexEnvVars', vars),
    setCursorEnvVars: (vars: Record<string, string>) => reqConfig('config:setCursorEnvVars', vars),
    setHarnessMcpEnabled: (enabled: boolean) => reqConfig('config:setHarnessMcpEnabled', enabled),
    setAutoApprovePermissions: (enabled: boolean) =>
      reqConfig('config:setAutoApprovePermissions', enabled),
    setAutoApproveSteerInstructions: (text: string) =>
      reqConfig('config:setAutoApproveSteerInstructions', text),
    setClaudeTuiFullscreen: (enabled: boolean) => reqConfig('config:setClaudeTuiFullscreen', enabled),
    setWsTransportEnabled: (enabled: boolean) => reqConfig('config:setWsTransportEnabled', enabled),
    setWsTransportPort: (port: number) => reqConfig('config:setWsTransportPort', port),
    setWsTransportHost: (host: string) => reqConfig('config:setWsTransportHost', host),
    getWsTransportInfo: () => reqConfig('config:getWsTransportInfo'),
    rotateWsToken: () => reqConfig('config:rotateWsToken'),
    getLanAddresses: () => req('net:getLanAddresses'),
    setBrowserToolsEnabled: (enabled: boolean) => reqConfig('config:setBrowserToolsEnabled', enabled),
    setBrowserToolsMode: (mode: 'view' | 'full') => reqConfig('config:setBrowserToolsMode', mode),
    setConversationForkEnabled: (enabled: boolean) =>
      reqConfig('config:setConversationForkEnabled', enabled),
    setWorktreeMessagingEnabled: (enabled: boolean) =>
      reqConfig('config:setWorktreeMessagingEnabled', enabled),
    setAgentTabNamingEnabled: (enabled: boolean) =>
      reqConfig('config:setAgentTabNamingEnabled', enabled),
    setDefaultClaudeTabType: (value: 'xterm' | 'json') =>
      reqConfig('config:setDefaultClaudeTabType', value),
    setChatPromotionDismissed: (value: boolean) =>
      reqConfig('config:setChatPromotionDismissed', value),
    setJsonModeChatDensity: (value: 'compact' | 'comfy') =>
      reqConfig('config:setJsonModeChatDensity', value),
    setUiScale: (value: 'x-small' | 'small' | 'medium' | 'large' | 'x-large') =>
      reqConfig('config:setUiScale', value),
    setNessieColor: (value: string) => reqConfig('config:setNessieColor', value),
    setJsonModeSendOnEnter: (enabled: boolean) =>
      reqConfig('config:setJsonModeSendOnEnter', enabled),
    setAutoScrollToBottom: (enabled: boolean) =>
      reqConfig('config:setAutoScrollToBottom', enabled),
    setJsonModeDefaultPermissionMode: (value: JsonClaudePermissionMode) =>
      reqConfig('config:setJsonModeDefaultPermissionMode', value),
    setJsonModeTranscriptWindow: (value: number) =>
      reqConfig('config:setJsonModeTranscriptWindow', value),
    setAutoSleepMinutes: (value: number) => reqConfig('config:setAutoSleepMinutes', value),
    setPreventSleepMode: (value: PreventSleepMode) =>
      reqConfig('config:setPreventSleepMode', value),
    // Backend-owned, not client-owned: these decide how main spawns a
    // reviewer, so every client of a workspace wants the same value.
    setAgentReviewDelivery: (value: AgentReviewDelivery) =>
      req('config:setAgentReviewDelivery', value),
    setPreventSleepUntil: (value: number | null) =>
      reqConfig('config:setPreventSleepUntil', value),
    setAutoUpdateEnabled: (enabled: boolean) => reqConfig('config:setAutoUpdateEnabled', enabled),
    setWarnBeforeQuitting: (enabled: boolean) => reqConfig('config:setWarnBeforeQuitting', enabled),
    setOpenPrInBrowserTab: (enabled: boolean) => reqConfig('config:setOpenPrInBrowserTab', enabled),
    setTerminalPlainClickOpensInApp: (enabled: boolean) =>
      reqConfig('config:setTerminalPlainClickOpensInApp', enabled),
    setExpandedDiagnosticLoggingEnabled: (enabled: boolean) =>
      reqConfig('config:setExpandedDiagnosticLoggingEnabled', enabled),
    setShowAssignedPRs: (enabled: boolean) => reqConfig('config:setShowAssignedPRs', enabled),
    refreshAssignedPRs: () => req('prs:refreshAssigned'),
    grantPermission: (rule: { toolName: string; ruleContent?: string }, grantedFrom?: string) =>
      req('permissions:grant', rule, grantedFrom),
    revokePermission: (id: string) => req('permissions:revoke', id),
    clearPermissions: () => req('permissions:clear'),
    setNewWorktreeAdvancedOpen: (open: boolean) =>
      reqConfig('config:setNewWorktreeAdvancedOpen', open),
    setStarterTasksDismissed: (dismissed: boolean) =>
      reqConfig('config:setStarterTasksDismissed', dismissed),
    setHarnessSystemPromptEnabled: (enabled: boolean) =>
      reqConfig('config:setHarnessSystemPromptEnabled', enabled),
    setHarnessSystemPrompt: (prompt: string) => reqConfig('config:setHarnessSystemPrompt', prompt),
    setHarnessSystemPromptMain: (prompt: string) =>
      reqConfig('config:setHarnessSystemPromptMain', prompt),
    setPrReviewPrompt: (prompt: string) => reqConfig('config:setPrReviewPrompt', prompt),
    prepareMcpForTerminal: (terminalId: string) =>
      req('mcp:prepareForTerminal', terminalId),
    onWorktreesExternalCreate: (
      callback: (payload: { repoRoot: string; worktree: unknown; initialPrompt?: string }) => void
    ) =>
      onActiveSignal('worktrees:externalCreate', (payload) => {
        callback(payload as { repoRoot: string; worktree: unknown; initialPrompt?: string })
      }),
    setNameClaudeSessions: (enabled: boolean) => reqConfig('config:setNameClaudeSessions', enabled),
    setThemeMode: (mode: 'light' | 'dark' | 'system') => reqConfig('config:setThemeMode', mode),
    setThemeLight: (theme: string) => reqConfig('config:setThemeLight', theme),
    setThemeDark: (theme: string) => reqConfig('config:setThemeDark', theme),
    setLastEffectiveAppBg: (hex: string) => sig('config:setLastEffectiveAppBg', hex),
    reloadCustomThemes: () => reqConfig('config:reloadCustomThemes'),
    openThemesFolder: () => reqLocal('config:openThemesFolder'),
    setCostsInterest: (expanded: boolean) => req('costs:setInterest', expanded),
    setContextWindowInterest: (expanded: boolean) =>
      req('contextWindow:setInterest', expanded),
    getAllSessionCosts: (sinceMs?: number) => req('costs:getAllSessions', sinceMs),
    getClaudeAuthStatus: () => req('claude:getAuthStatus'),
    getAvailableThemes: () => reqConfig('config:getAvailableThemes'),
    setTerminalFontFamily: (fontFamily: string) =>
      reqConfig('config:setTerminalFontFamily', fontFamily),
    getDefaultTerminalFontFamily: () => reqConfig('config:getDefaultTerminalFontFamily'),
    setTerminalFontSize: (fontSize: number) => reqConfig('config:setTerminalFontSize', fontSize),

    panesAddTab: (wtPath: string, tab: unknown, paneId?: string) =>
      req('panes:addTab', wtPath, tab, paneId),
    panesCloseTab: (wtPath: string, tabId: string) => req('panes:closeTab', wtPath, tabId),
    panesRestartAgentTab: (wtPath: string, tabId: string, newId: string) =>
      req('panes:restartAgentTab', wtPath, tabId, newId),
    panesConvertTabType: (
      wtPath: string,
      tabId: string,
      newType: 'agent' | 'json-claude'
    ) => req('panes:convertTabType', wtPath, tabId, newType),
    panesSelectTab: (wtPath: string, paneId: string, tabId: string) =>
      req('panes:selectTab', wtPath, paneId, tabId),
    panesReorderTabs: (wtPath: string, paneId: string, fromId: string, toId: string) =>
      req('panes:reorderTabs', wtPath, paneId, fromId, toId),
    panesRenameTab: (wtPath: string, tabId: string, label: string) =>
      req('panes:renameTab', wtPath, tabId, label),
    panesMoveTabToPane: (wtPath: string, tabId: string, toPaneId: string, toIndex?: number) =>
      req('panes:moveTabToPane', wtPath, tabId, toPaneId, toIndex),
    panesSplitPane: (
      wtPath: string,
      fromPaneId: string,
      direction?: 'horizontal' | 'vertical'
    ) => req('panes:splitPane', wtPath, fromPaneId, direction),
    panesSetRatio: (wtPath: string, splitId: string, ratio: number) =>
      req('panes:setRatio', wtPath, splitId, ratio),
    panesClearForWorktree: (wtPath: string) => req('panes:clearForWorktree', wtPath),
    panesEnsureInitialized: (wtPath: string) => req('panes:ensureInitialized', wtPath),
    panesSleepTab: (wtPath: string, tabId: string) => req('panes:sleepTab', wtPath, tabId),
    panesWakeTab: (wtPath: string, tabId: string) => req('panes:wakeTab', wtPath, tabId),
    panesOpenReview: (wtPath: string) => req('panes:openReview', wtPath),
    panesOpenFile: (wtPath: string, filePath: string, nearTabId?: string) =>
      req('panes:openFile', wtPath, filePath, nearTabId),
    panesSetReviewSelection: (
      wtPath: string,
      tabId: string,
      fromCommit?: string,
      toCommit?: string
    ) => req('panes:setReviewSelection', wtPath, tabId, fromCommit, toCommit),
    touchWorktreeLastActive: (wtPath: string) =>
      req('terminals:touchLastActive', wtPath),

    getTerminalHistory: (id: string) => req('terminal:getHistory', id),
    clearTerminalHistory: (id: string) => req('terminal:forgetHistory', id),
    agentSessionFileExists: (cwd: string, sessionId: string, agentKind?: string) =>
      req('agent:sessionFileExists', cwd, sessionId, agentKind),
    getLatestAgentSessionId: (cwd: string, agentKind?: string) =>
      req('agent:latestSessionId', cwd, agentKind),
    buildAgentSpawnArgs: (
      agentKind: string,
      opts: {
        terminalId: string
        cwd: string
        sessionId?: string
        initialPrompt?: string
        teleportSessionId?: string
        sessionName?: string
        modelOverride?: string
      }
    ) => req('agent:buildSpawnArgs', agentKind, opts),

    setOnboardingQuest: (quest: string) => reqConfig('config:setOnboardingQuest', quest),
    setWorktreeBase: (mode: 'remote' | 'local') => reqConfig('config:setWorktreeBase', mode),
    setMergeStrategy: (strategy: 'squash' | 'merge-commit' | 'fast-forward') =>
      reqConfig('config:setMergeStrategy', strategy),
    setSidebarDensity: (density: 'compact' | 'comfy') =>
      reqConfig('config:setSidebarDensity', density),
    setSidebarTabsExpansion: (mode: 'never' | 'selected' | 'all') =>
      reqConfig('config:setSidebarTabsExpansion', mode),
    setSidebarDetails: (prefs: SidebarDetailPrefsByMode) =>
      reqConfig('config:setSidebarDetails', prefs),
    setHiddenBottomIcons: (hidden: HiddenBottomIcons) =>
      reqConfig('config:setHiddenBottomIcons', hidden),
    setBottomIconOrder: (order: BottomIconKey[]) =>
      reqConfig('config:setBottomIconOrder', order),

    setEditor: (editorId: string) => reqConfig('config:setEditor', editorId),
    setRepoEditor: (repoRoot: string, editorId: string | null) =>
      reqConfig('config:setRepoEditor', repoRoot, editorId),
    setWorktreeEditor: (worktreePath: string, editorId: string | null) =>
      reqConfig('config:setWorktreeEditor', worktreePath, editorId),
    getAvailableEditors: () => reqConfig('config:getAvailableEditors'),

    snooze: (path: string, wakeAt: number) => req('snooze:snooze', path, wakeAt),
    pinWorktree: (path: string) => req('pinned:pin', path),
    unpinWorktree: (path: string) => req('pinned:unpin', path),
    unsnooze: (path: string) => req('snooze:unsnooze', path),
    setSnoozeDefaultDays: (days: number) => reqConfig('config:setSnoozeDefaultDays', days),
    setCiNotifyOverride: (path: string, enabled: boolean | null) =>
      req('ciNotify:setOverride', path, enabled),
    setNotifyChatOnCiFailure: (enabled: boolean) =>
      reqConfig('config:setNotifyChatOnCiFailure', enabled),
    requestMergeConflictFix: (worktreePath: string) =>
      req('prs:requestConflictFix', worktreePath),
    setAlias: (path: string, alias: string) => req('aliases:set', path, alias),
    clearAlias: (path: string) => req('aliases:clear', path),

    setScratchpadText: (worktreePath: string, text: string) =>
      req('scratchpad:setText', worktreePath, text),

    addReviewComment: (
      worktreePath: string,
      input: Parameters<ElectronAPI['addReviewComment']>[1]
    ) => req('reviews:addComment', worktreePath, input),
    deleteReviewComment: (worktreePath: string, id: string) =>
      req('reviews:deleteComment', worktreePath, id),
    setReviewCommentStatus: (worktreePath: string, id: string, status: ReviewCommentStatus) =>
      req('reviews:setCommentStatus', worktreePath, id, status),
    addReviewReply: (worktreePath: string, commentId: string, body: string) =>
      req('reviews:addReply', worktreePath, commentId, body),
    refreshReviewAnchors: (worktreePath: string, filePath?: string) =>
      req('reviews:refreshAnchors', worktreePath, filePath),
    editReviewComment: (worktreePath: string, id: string, body: string) =>
      req('reviews:editComment', worktreePath, id, body),
    listReviewTargets: (worktreePath: string) => req('reviews:listChatTabs', worktreePath),
    editReviewSubmission: (
      worktreePath: string,
      id: string,
      summary: string,
      verdict: ReviewVerdict
    ) => req('reviews:editSubmission', worktreePath, id, summary, verdict),
    deleteReviewSubmission: (worktreePath: string, id: string) =>
      req('reviews:deleteSubmission', worktreePath, id),
    sendReviewSubmission: (worktreePath: string, id: string, targetTabId?: string) =>
      req('reviews:sendSubmission', worktreePath, id, targetTabId),

    openInEditor: (worktreePath: string, filePath?: string) =>
      req('editor:open', worktreePath, filePath),

    // Corrupt-config recovery. Always-local: the broken config.json lives on
    // the local Electron machine, and save-and-retry / reset relaunch it.
    readRawConfig: () => reqLocal('config:readRawConfig'),
    saveRawConfigAndRetry: (text: string) =>
      reqLocal('config:saveRawConfigAndRetry', text),
    resetConfigToDefaults: () => reqLocal('config:resetConfigToDefaults'),

    hasGithubToken: () => req('settings:hasGithubToken'),
    setGithubToken: (token: string) => req('settings:setGithubToken', token),
    clearGithubToken: () => req('settings:clearGithubToken'),
    setHarnessStarred: (starred: boolean) => req('settings:setHarnessStarred', starred),

    getVersion: () => req('updater:getVersion'),
    readRecentLog: (maxLines?: number) => req('debug:readRecentLog', maxLines),
    checkForUpdates: () => req('updater:checkForUpdates'),
    quitAndInstall: () => req('updater:quitAndInstall'),
    devSimulateUpdate: (state: 'available' | 'downloading' | 'downloaded' | 'clear') =>
      req('updater:devSimulate', state),

    // Always-local: shell.openExternal opens on the local user's
    // machine, never on the remote backend. Same with debug log paths.
    openExternal: (url: string) => sigLocal('shell:openExternal', url),
    openPath: (path: string) => reqLocal('shell:openPath', path),
    openDebugLog: () => reqLocal('debug:openLog'),
    showDebugLogInFolder: () => reqLocal('debug:showLogInFolder'),

    getFilePath: (file: File) =>
      electronHelpers ? electronHelpers.getFilePath(file) : electronOnly('getFilePath', ''),

    getPerfMetrics: () => req('perf:getMetrics'),
    perfReportRendererSample: (sample: RendererPerfSample) =>
      sig('perf:reportRendererSample', sample),

    getGitHubApiLog: () => req('debug:getGitHubApiLog'),
    clearGitHubApiLog: () => req('debug:clearGitHubApiLog'),
    onGitHubApiLogAppended: (callback: (entry: unknown) => void) =>
      onActiveSignal('debug:githubApiLogAppended', (entry) => callback(entry)),

    logError: (
      label: string,
      error: { name?: string; message?: string; stack?: string },
      info?: { componentStack?: string | null }
    ) =>
      req(
        'debug:logError',
        label,
        error?.name ?? 'Error',
        error?.message ?? '',
        error?.stack ?? '',
        info?.componentStack ?? ''
      ),

    // Window controls — always target the local Electron window. In the
    // web client the helpers are null and these are no-ops (the browser
    // owns its own window controls).
    windowMinimize: () =>
      electronHelpers ? electronHelpers.windowMinimize() : electronOnly('windowMinimize', undefined),
    windowToggleMaximize: () =>
      electronHelpers
        ? electronHelpers.windowToggleMaximize()
        : electronOnly('windowToggleMaximize', undefined),
    windowClose: () =>
      electronHelpers ? electronHelpers.windowClose() : electronOnly('windowClose', undefined),

    // Menu signals — only the local Electron menu fires these. Bind to
    // local transport so they keep working regardless of which backend
    // is active.
    onOpenSettings: (callback: () => void) =>
      onLocalSignal('app:openSettings', () => callback()),
    // Hold-⌘Q-to-quit overlay, driven entirely by the main process (it
    // owns the before-input-event detection + hold timer). Always local.
    onHoldToQuitStart: (callback: () => void) =>
      onLocalSignal('app:holdToQuitStart', () => callback()),
    onHoldToQuitCancel: (callback: () => void) =>
      onLocalSignal('app:holdToQuitCancel', () => callback()),
    onTogglePerfMonitor: (callback: () => void) =>
      onLocalSignal('app:togglePerfMonitor', () => callback()),
    onToggleSingleScreen: (callback: () => void) =>
      onLocalSignal('app:toggleSingleScreen', () => callback()),
    onOpenKeyboardShortcuts: (callback: () => void) =>
      onLocalSignal('app:openKeyboardShortcuts', () => callback()),
    onCloseFocusedTab: (callback: () => void) =>
      onLocalSignal('app:closeFocusedTab', () => callback()),
    onSplitPaneRight: (callback: () => void) =>
      onLocalSignal('app:splitPaneRight', () => callback()),
    onSplitPaneDown: (callback: () => void) =>
      onLocalSignal('app:splitPaneDown', () => callback()),
    onOpenNewProject: (callback: () => void) =>
      onLocalSignal('menu:newProject', () => callback()),
    onOpenReportIssue: (callback: () => void) =>
      onLocalSignal('app:openReportIssue', () => callback()),
    onOpenGitHubApiLog: (callback: () => void) =>
      onLocalSignal('app:openGitHubApiLog', () => callback()),
    onDebugCrashFocusedTab: (callback: () => void) =>
      onLocalSignal('app:debugCrashFocusedTab', () => callback()),
    onDebugPreviewOnboarding: (callback: () => void) =>
      onLocalSignal('app:debugPreviewOnboarding', () => callback()),
    onOpenAddBackend: (callback: () => void) =>
      onLocalSignal('app:openAddBackend', () => callback()),
    onUiScaleUp: (callback: () => void) =>
      onLocalSignal('app:uiScaleUp', () => callback()),
    onUiScaleDown: (callback: () => void) =>
      onLocalSignal('app:uiScaleDown', () => callback()),
    onUiScaleReset: (callback: () => void) =>
      onLocalSignal('app:uiScaleReset', () => callback()),
    onFullscreenChanged: (callback: (isFullscreen: boolean) => void) =>
      onLocalSignal('window:fullscreenChanged', (...args: unknown[]) =>
        callback(Boolean(args[0]))
      ),

    acceptHooks: () => req('hooks:accept'),
    declineHooks: () => req('hooks:decline'),
    uninstallHooks: () => req('hooks:uninstall'),

    browserNavigate: (tabId: string, url: string) => req('browser:navigate', tabId, url),
    browserBack: (tabId: string) => req('browser:back', tabId),
    browserForward: (tabId: string) => req('browser:forward', tabId),
    browserReload: (tabId: string) => req('browser:reload', tabId),
    browserOpenDevTools: (tabId: string) => req('browser:openDevTools', tabId),
    browserSetViewport: (
      tabId: string,
      viewport: BrowserViewport | null,
      opts?: { reload?: boolean }
    ) => req('browser:setViewport', tabId, viewport, opts),
    browserSetBounds: (
      tabId: string,
      bounds: { x: number; y: number; width: number; height: number } | null
    ) => sig('browser:setBounds', tabId, bounds),
    browserHide: (tabId: string) => sig('browser:hide', tabId),
    browserScreenshot: (
      tabId: string,
      opts?: { format?: 'jpeg' | 'png'; quality?: number }
    ) => req('browser:screenshot', tabId, opts),
    browserClick: (
      tabId: string,
      x: number,
      y: number,
      opts?: { button?: 'left' | 'right' | 'middle'; clickCount?: number }
    ) => req('browser:click', tabId, x, y, opts),
    browserType: (tabId: string, text: string, key?: string) =>
      req('browser:type', tabId, text, key),
    browserScroll: (tabId: string, dx: number, dy: number) =>
      req('browser:scroll', tabId, dx, dy),

    createTerminal: (
      id: string,
      cwd: string,
      cmd: string,
      args: string[],
      agentKind?: string,
      cols?: number,
      rows?: number
    ) => sig('pty:create', id, cwd, cmd, args, agentKind, cols, rows),
    writeTerminal: (id: string, data: string) => sig('pty:write', id, data),
    resizeTerminal: (id: string, cols: number, rows: number) =>
      sig('pty:resize', id, cols, rows),
    killTerminal: (id: string) => sig('pty:kill', id),
    joinTerminal: (id: string) => sig('terminal:join', id),
    leaveTerminal: (id: string) => sig('terminal:leave', id),
    takeTerminalControl: (id: string, cols: number, rows: number) =>
      sig('terminal:takeControl', id, cols, rows),
    setTerminalProgress: (id: string, state: 0 | 1 | 2 | 3 | 4, value: number) =>
      sig('terminal:setProgress', id, state, value),
    onTerminalData: (callback: DataCallback) =>
      onActiveSignal('terminal:data', (id, data) => {
        callback(id as string, data as string)
      }),
    getActivityLog: () => req('activity:get'),
    clearActivityLog: (worktreePath?: string) => req('activity:clear', worktreePath),

    onTerminalExit: (callback: ExitCallback) =>
      onActiveSignal('terminal:exit', (id, exitCode) => {
        callback(id as string, exitCode as number)
      }),

    resolveJsonClaudeApproval: (
      requestId: string,
      result: {
        behavior: 'allow' | 'deny'
        updatedInput?: Record<string, unknown>
        updatedPermissions?: unknown[]
        message?: string
        interrupt?: boolean
      }
    ) => req('jsonClaude:resolveApproval', requestId, result),
    rerunJsonClaudeAutoApprovalReview: (requestId: string) =>
      req('jsonClaude:rerunAutoApprovalReview', requestId),
    startJsonClaude: (id: string, cwd: string) => req('jsonClaude:start', id, cwd),
    sendJsonClaudeMessage: (
      id: string,
      text: string,
      images?: Array<{ mediaType: string; data: string; path: string }>
    ) => sig('jsonClaude:send', id, text, images),
    cancelQueuedJsonClaudeMessage: (id: string, messageId: string) =>
      sig('jsonClaude:cancelQueued', id, messageId),
    writeJsonClaudeAttachmentImage: (base64: string, mediaType: string) =>
      req('jsonClaude:writeAttachmentImage', base64, mediaType),
    readJsonClaudeAttachmentImage: (path: string) =>
      req('jsonClaude:readAttachmentImage', path),
    getJsonClaudeEntries: (sessionId: string) =>
      req('jsonClaude:getEntries', sessionId),
    killJsonClaude: (id: string) => req('jsonClaude:kill', id),
    interruptJsonClaude: (id: string) => req('jsonClaude:interrupt', id),
    interruptAndSendJsonClaude: (
      id: string,
      text: string,
      images?: Array<{ mediaType: string; data: string; path: string }>
    ) => req('jsonClaude:interruptAndSend', id, text, images),
    rewindJsonClaudeTo: (id: string, entryId: string) =>
      req('jsonClaude:rewindTo', id, entryId),
    forkJsonClaudeAt: (id: string, entryId: string) =>
      req('jsonClaude:forkAt', id, entryId),
    openJsonClaudeAuthLoginTab: (worktreePath: string) =>
      req('jsonClaude:openAuthLoginTab', worktreePath),
    setJsonClaudePermissionMode: (
      id: string,
      mode: JsonClaudePermissionMode
    ) => req('jsonClaude:setPermissionMode', id, mode),
    setJsonClaudeTabModel: (id: string, model: string) =>
      req('jsonClaude:setTabModel', id, model),
    grantJsonClaudeSessionToolApprovals: (id: string, toolNames: string[]) =>
      req('jsonClaude:grantSessionToolApprovals', id, toolNames),
    clearJsonClaudeSessionToolApprovals: (id: string, toolNames?: string[]) =>
      req('jsonClaude:clearSessionToolApprovals', id, toolNames),

    getStateSnapshot: () => getActiveTransport().getStateSnapshot(),
    onStateEvent: (callback: StateEventListener) =>
      getActiveTransport().onStateEvent(callback),
    getClientId: () => getActiveTransport().getClientId(),

    // Connections list — always-local; the connections list is renderer-
    // shell-owned (never forwarded to remote backends, which don't
    // manage other backends). See plans/tier-1-multi-backend-ux.md §C/§G.
    connectionsList: () => reqLocal('connections:list'),
    connectionsAdd: (
      input: { label: string; url: string; kind: 'remote'; color?: string; initials?: string },
      token: string
    ) => reqLocal('connections:add', input, token),
    connectionsRemove: (id: string) => reqLocal('connections:remove', id),
    connectionsRename: (id: string, label: string) =>
      reqLocal('connections:rename', id, label),
    connectionsSetActive: (id: string) => reqLocal('connections:setActive', id),
    connectionsGetActive: () => reqLocal('connections:getActive'),
    connectionsSetLastConnected: (id: string, when?: number) =>
      reqLocal('connections:setLastConnected', id, when),
    connectionsGetToken: (id: string) => reqLocal('connections:getToken', id),
    connectionsHasToken: (id: string) => reqLocal('connections:hasToken', id),

    // SSH bootstrap helpers — always-local; only the local Electron
    // backend bootstraps remote backends. See plans/remote-main.md §4.
    sshListConfiguredHosts: () => reqLocal('ssh:listConfiguredHosts'),
    sshBootstrap: (input: { bootstrapId: string; target: string; label: string }) =>
      reqLocal('ssh:bootstrap', input),
    sshReconnect: (input: { bootstrapId: string; connectionId: string }) =>
      reqLocal('ssh:reconnect', input),
    sshUpgradeServer: (input: { bootstrapId: string; connectionId: string }) =>
      reqLocal('ssh:upgradeServer', input)
  }

  return api as ElectronAPI
}
