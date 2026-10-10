// Bump libuv's threadpool from its default of 4 so background filesystem
// work (fs.promises.rm for trashed worktrees, other unlinks) can
// parallelize on multi-core machines. Must run before any import that
// could touch the threadpool. Respect an explicit override — power users
// setting UV_THREADPOOL_SIZE themselves shouldn't have their choice
// silently upgraded.
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16'

import { existsSync, lstatSync, readFileSync } from 'fs'
import { createRequire } from 'module'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { PtyManager } from './pty-manager'
import { ApprovalBridge } from './approval-bridge'
import { JsonClaudeManager, bundledClaudeBinPath, forkTranscript, hasForkableTranscript } from './json-claude-manager'
import { buildRelocationPreamble } from './fork-relocation'
import { shellQuote } from './shell-quote'
import {
  readAttachmentImage,
  writeAttachmentImage
} from './json-claude-attachments'
import { JsonClaudeStatusDeriver } from './json-claude-status-deriver'
import { Store } from './store'
import { WebSocketServerTransport } from './transport-websocket'
import { CompoundServerTransport } from './transport-compound'
import { createWebClientServer } from './web-client-server'
import { getOrCreateWsToken, rotateWsToken } from './ws-token'
import { networkInterfaces } from 'os'
import type { Server as HttpServer } from 'http'
import type { ServerTransport } from '../shared/transport/transport'
import { detectRuntime } from './paths'
import { fixPathFromLoginShell } from './path-fix'
import { parseCliFlags, USAGE, type CliFlags } from './cli-args'
import { PlaywrightBrowserManager } from './browser-manager-playwright'
import type { BrowserManagerLike } from './browser-manager-types'
import { normalizeViewport } from '../shared/browser-viewport'
import { PerfMonitor, formatRendererSample } from './perf-monitor'
import type { RendererPerfSample } from '../shared/perf-types'
import {
  setGitHubApiRecorder,
  setGitHubApiLoggingEnabled,
  getGitHubApiLogSnapshot,
  clearGitHubApiLog,
  subscribeGitHubApiLog
} from './github-recorder'
import { PRPoller } from './pr-poller'
import { WorktreesFSM } from './worktrees-fsm'
import { WorktreeDeletionFSM } from './worktree-deletion-fsm'
import { sweepWorktreeTrashOnBoot } from './worktree-trash'
import { PanesFSM, stripTransientTabFields } from './panes-fsm'
import { ActivityDeriver } from './activity-deriver'
import { CiNotifier } from './ci-notifier'
import { AutoSleepMonitor } from './auto-sleep-monitor'
import { WakeLockController } from './wake-lock-controller'
import { WorktreeWatcher } from './worktree-watcher'
import { FileContentWatcher } from './file-content-watcher'
import { SnoozeTimer } from './snooze-timer'
import { getWeeklyStats } from './weekly-stats'
import { discoverTools, runTool } from './tools'
import type { TerminalTab, PaneNode, PaneLeaf } from '../shared/state/terminals'
import { findTabById, getLeaves, mapLeaves } from '../shared/state/terminals'
import { listWorktrees, listBranches, continueWorktree, isWorktreeDirty, defaultWorktreeDir, getChangedFiles, getFileDiff, getBranchCommits, getCommitDiff, getCommitMeta, getCommitChangedFiles, getCommitFileDiffSides, getCommitRangeChangedFiles, getCommitRangeFileDiffSides, getMainWorktreeStatus, prepareMainForMerge, mergeWorktreeLocally, getBranchSha, previewMergeConflicts, getBranchDiffStats, listAllFiles, listRecentCommitShas, readWorktreeFile, readWorktreeFileBinary, writeWorktreeFile, getFileDiffSides, getCurrentBranch, renameWorktreeBranch, unsymlinkClaudeSettings, readClaudeAllowEntries, pruneWorktrees, type MergeStrategy } from './worktree'
import { listOpenPRs, getPRByNumber, testToken, starRepo, unstarRepo, isRepoStarred, mergePR, approvePR, getRepoInfo, type GitHubMergeMethod, type MergePRResult, type PRLookupResult } from './github'
import { AVAILABLE_EDITORS, DEFAULT_EDITOR_ID, openInEditor } from './editor'
import { resolveEditorId } from '../shared/editor-resolve'
import { setSecret, getSecret, hasSecret, deleteSecret } from './secrets'
import { resolveGitHubToken, getTokenSource, invalidateTokenCache, getCachedToken } from './github-auth'
import {
  loadConfig,
  saveConfig,
  saveConfigSync,
  getConfigLoadError,
  discardCorruptConfigAndReset,
  DEFAULT_CLAUDE_COMMAND,
  AVAILABLE_THEMES,
  THEME_APP_BG,
  DEFAULT_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_FONT_SIZE,
  DEFAULT_WORKTREE_BASE,
  DEFAULT_MERGE_STRATEGY,
  DEFAULT_SIDEBAR_DENSITY,
  DEFAULT_HARNESS_SYSTEM_PROMPT,
  DEFAULT_HARNESS_SYSTEM_PROMPT_MAIN,
  pruneTerminalHistory,
  LOCAL_BACKEND_ID,
  type BackendConnection,
  type PersistedPaneNode,
  type QuestStep
} from './persistence'
import {
  loadRepoConfig,
  saveRepoConfig,
  repoConfigFilename,
  migrateRepoConfigFilename,
  type RepoConfig
} from './repo-config'
import { createNewProject, type GitignorePreset } from './repo-create'
import { resolveRepoPath } from './repo-resolve'
import { registerRepoRoot } from './repo-roots'
import type { AddRepoResult } from '../shared/repo-pick'
import { isWorktreeMerged } from '../shared/state/prs'
import type { ForkSource } from '../shared/state/worktrees'
import { MAX_WAKE } from '../shared/state/snooze'
import { hasScratchpadNote } from '../shared/state/scratchpad'
import { normalizeAlias } from '../shared/state/aliases'
import { parseRuleKey, ruleKey, type PermissionRule } from '../shared/permission-match'
import {
  isJsonClaudePermissionMode,
  parseAutomatedMessage,
  wrapAutomatedMessage,
  type JsonClaudePermissionMode
} from '../shared/state/json-claude'
import { deriveWorktreeStatus } from './worktree-status'
import {
  DEFAULT_LIGHT_THEME,
  DEFAULT_DARK_THEME,
  DEFAULT_PR_REVIEW_PROMPT,
  DEFAULT_JSON_MODE_TRANSCRIPT_WINDOW,
  MAX_JSON_MODE_TRANSCRIPT_WINDOW,
  DEFAULT_SIDEBAR_DETAILS,
  DEFAULT_NESSIE_COLOR,
  nessieColorById,
  BOTTOM_ICON_KEYS,
  type SidebarDetailPrefs,
  type SidebarDetailPrefsByMode,
  type PreventSleepMode,
  type HiddenBottomIcons,
  type BottomIconKey
} from '../shared/state/settings'
import { watchStatusDir } from './hooks'
import { getAgent, type AgentKind } from './agents'
import { buildClaudeLaunchSettings } from './claude-launch'
import { HARNESS_REPO_OWNER, HARNESS_REPO_NAME } from '../shared/constants'
import { readRecentDebugLog } from './debug'
import { CostTracker } from './cost-tracker'
import { ContextTracker } from './context-tracker'
import { getAllSessionCosts } from './cost-aggregator'
import { getClaudeAuthStatus } from './claude-auth'
import { listDir as fsListDir, resolveHome as fsResolveHome } from './fs-listing'
import { listConfiguredHosts } from './ssh-config'
import { SshTunnelManager } from './ssh-tunnel-manager'
import { SshReconnectSupervisor } from './ssh-reconnect-supervisor'
import { startControlServer, type BrowserTabSummary } from './control-server'
import {
  deliverToWorktreeChat,
  describeWorktree,
  resolveWorktreeQuery
} from './chat-delivery'
import { buildMergeConflictMessage } from './merge-conflict-request'
import { writeMcpConfigForTerminal, pruneMcpConfigs, getBridgeScriptPath } from './mcp-config'
import { getControlServerInfo } from './control-server'
import { recordActivity, getActivityLog, clearAllActivity, clearActivityForWorktree, sealAllActive, touchActivityMeta, finalizeActivity, type ActivityState, type PRState } from './activity'
import { log, getLogFilePath } from './debug'
import { loadCustomThemes } from './themes-loader'
import { perfLog, flushPerfLogSync } from './perf-log'
import { buildInitialAppState } from './build-initial-state'
import { AnnouncementsPoller } from './announcements-poller'

function toAgentKind(value: string | undefined): AgentKind {
  if (value === 'codex') return 'codex'
  if (value === 'cursor') return 'cursor'
  return 'claude'
}

// Dev-restart resilience: electron-vite closes our stdout/stderr pipe on
// stop/restart; an in-flight console write then fails with EIO/EPIPE. These
// are benign during teardown — swallow only the pipe-write codes, rethrow
// everything else. Covers both the sync throw (uncaughtException) and the
// async error-event path (stream 'error').
const isBenignPipeError = (e: unknown): boolean =>
  !!e && typeof e === 'object' && ['EIO', 'EPIPE'].includes((e as NodeJS.ErrnoException).code ?? '')

process.stdout.on('error', (e) => { if (!isBenignPipeError(e)) throw e })
process.stderr.on('error', (e) => { if (!isBenignPipeError(e)) throw e })
// Log-and-continue for uncaught main-process errors (issue #185). A single
// unhandled throw from any code path — a stray child_process 'error' event,
// a broken slice dispatch, a rejected background promise — used to take
// down the whole app and every open Claude tab with it. That's disastrous
// relative to the underlying bug: we'd rather keep the window alive with
// one broken session than lose the user's other agents' state.
// The log line is the load-bearing part — crash forensics need it to
// figure out which subsystem misbehaved.
process.on('uncaughtException', (e) => {
  if (isBenignPipeError(e)) return
  log('main', 'uncaughtException', e instanceof Error ? (e.stack ?? e.message) : String(e))
})
process.on('unhandledRejection', (reason) => {
  log(
    'main',
    'unhandledRejection',
    reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
  )
})

// Runtime detection — Electron sets process.versions.electron, plain
// Node leaves it undefined. The mode picks itself; there's no env-var
// override to fight with.
const runtime = detectRuntime()

// Boot the local backend. The HARNESS_REMOTE_URL "process-wide remote"
// path was removed in Tier 1 — the chip strip / add-backend modal is
// the only way to reach a remote backend now (see
// plans/tier-1-multi-backend-ux.md §J).
//
// Apply the userData path override BEFORE fixPathFromLoginShell
// runs. path-fix can call log() (on PATH change / timeout / missing
// sentinels), and log() reads userDataDir() which caches its first
// result — without this, the default userData path gets cached
// and the override inside bootLocal arrives too late. bootLocal also
// calls applyUserDataPathOverride; app.setPath is idempotent, so the
// second call is a no-op.
if (runtime === 'electron') {
  const dynamicRequire = createRequire(__filename)
  const ds = dynamicRequire('./desktop-shell') as typeof import('./desktop-shell')
  ds.applyUserDataPathOverride()
}
// PATH fix runs before bootLocal so PtyManager / JsonClaudeManager are
// constructed with an environment that includes Homebrew/nvm/etc.
// Covers both Electron-from-Dock and headless-via-ssh/systemd, both of
// which can start with a stripped PATH. No-op outside of macOS today;
// see path-fix.ts.
void fixPathFromLoginShell().then(bootLocal)

// Wrap the entire local-mode boot in a function so the remote-mode
// branch above can early-exit cleanly. Function declarations are
// hoisted, so the call site above sees this definition. Everything
// inside used to live at module top-level; the only change is the
// extra `function bootLocal(): void {` wrapper + matching brace at
// EOF — the body is otherwise identical.
function bootLocal(): void {

// Resolves the caller's MCP scope from their terminal id. Used by both
// the control HTTP server (on every tool call, authoritative) and
// writeMcpConfigForTerminal (to seed best-effort HARNESS_* env vars in
// the spawned bridge). Closes over the local `store` constructed below.
function resolveCallerScope(terminalId: string) {
  if (!terminalId) return null
  const panes = store.getSnapshot().state.terminals.panes
  let worktreePath: string | null = null
  let tabType: TerminalTab['type'] | null = null
  for (const [wtPath, tree] of Object.entries(panes)) {
    for (const leaf of getLeaves(tree)) {
      const tab = leaf.tabs.find((t) => t.id === terminalId)
      if (tab) {
        worktreePath = wtPath
        tabType = tab.type
        break
      }
    }
    if (worktreePath) break
  }
  if (!worktreePath) return null
  const wt = store
    .getSnapshot()
    .state.worktrees.list.find((w) => w.path === worktreePath)
  if (!wt) return null
  return {
    terminalId,
    worktreePath,
    repoRoot: wt.repoRoot,
    isMain: wt.isMain,
    // Chat tabs render their transcript as markdown; terminal tabs are an
    // xterm, where an embedded image is just literal text. Tools that
    // advertise rendering affordances gate on this.
    rendersMarkdown: tabType === 'json-claude'
  }
}

/** Find the worktree that owns a given shell tab id. Only matches tabs whose
 * type is 'shell'; agent/browser/diff/file tabs are not addressable via the
 * shell MCP even if an id collision were possible. */
function findShellWorktree(shellId: string): string | null {
  const panes = store.getSnapshot().state.terminals.panes
  for (const [wtPath, tree] of Object.entries(panes)) {
    for (const leaf of getLeaves(tree)) {
      for (const tab of leaf.tabs) {
        if (tab.id === shellId && tab.type === 'shell') return wtPath
      }
    }
  }
  return null
}

/** True for a shell tab that was created with a command (`create_shell`) and
 * whose process is gone. That command runs exactly once, in createShell's
 * eager spawn; afterwards the tab is a transcript of the run, not a live
 * shell — which is also how it behaves when the command exits mid-session.
 * The renderer still fires pty:create when it mounts such a tab (it can't
 * tell a spent shell from a fresh one), so the spawn is dropped here rather
 * than handing back an interactive prompt no command shell would ever show. */
function isSpentCommandShell(id: string): boolean {
  const tab = findTabById(store.getSnapshot().state.terminals.panes, id)
  return tab?.type === 'shell' && !!tab.command
}
// Resolves the harness version from disk so it works in every runtime
// (Electron dev/packaged, headless dev, headless tarball). Electron's
// `app.getVersion()` would do the job in two of those four, but the
// headless server has no `app`, so we read package.json (or the
// pack-headless VERSION sidecar) directly. Cached after first hit —
// the file layout doesn't change while the process is alive.
let cachedHarnessVersion: string | null = null
function getHarnessVersion(): string {
  if (cachedHarnessVersion) return cachedHarnessVersion
  const candidates: Array<{ path: string; parse: (text: string) => string | null }> = [
    {
      path: join(__dirname, '..', '..', 'package.json'),
      parse: (text) => {
        const v = (JSON.parse(text) as { version?: unknown }).version
        return typeof v === 'string' ? v : null
      }
    },
    {
      path: join(__dirname, '..', 'VERSION'),
      parse: (text) => text.trim() || null
    }
  ]
  for (const { path, parse } of candidates) {
    try {
      const v = parse(readFileSync(path, 'utf8'))
      if (v) {
        cachedHarnessVersion = v
        return v
      }
    } catch {
      // try next candidate
    }
  }
  cachedHarnessVersion = 'unknown'
  return cachedHarnessVersion
}

// Headless-only CLI flags (--host / --port / --help / --version). Parse
// before any heavy init so --help / --version exit instantly without
// loading config or constructing managers. Electron's argv carries
// chromium switches that aren't ours to validate, so we skip parsing
// in Electron entirely — these flags are a headless ergonomics feature.
const cliFlags: CliFlags = (() => {
  if (runtime !== 'node') {
    return { showHelp: false, showVersion: false }
  }
  const result = parseCliFlags(process.argv.slice(2))
  if (result.kind === 'error') {
    process.stderr.write(`harness-server: ${result.message}\n\n`)
    process.stderr.write(USAGE)
    process.exit(2)
  }
  if (result.flags.showHelp) {
    process.stdout.write(USAGE)
    process.exit(0)
  }
  if (result.flags.showVersion) {
    process.stdout.write(`${resolveServerVersion()}\n`)
    process.exit(0)
  }
  return result.flags
})()

function resolveServerVersion(): string {
  const fromEnv = process.env['npm_package_version']
  if (fromEnv) return fromEnv
  const candidates = [
    join(__dirname, '../../package.json'),
    join(__dirname, '../package.json')
  ]
  for (const path of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof pkg.version === 'string') return pkg.version
    } catch {
      // try next
    }
  }
  return 'unknown'
}

// Load the desktop shell ONLY in Electron mode. `createRequire` hides
// the lookup from the bundler, so the headless build doesn't drag
// electron + electron-updater + WebContentsView in via static analysis.
// In Electron mode the file lives next to this one in the build output
// (added as a second `input` in electron.vite.config.ts).
type DesktopShellModule = typeof import('./desktop-shell')
let desktopShellMod: DesktopShellModule | null = null
if (runtime === 'electron') {
  const dynamicRequire = createRequire(__filename)
  desktopShellMod = dynamicRequire('./desktop-shell') as DesktopShellModule
  // Apply the userData path override BEFORE loadConfig below — the
  // paths module caches its first resolution, so waiting until
  // createDesktopShell() (which needs the store) would pin dev to the
  // production config dir.
  desktopShellMod.applyUserDataPathOverride()
}

const ptyManager = new PtyManager()
let config = loadConfig()
let stopWatchingStatus: (() => void) | null = null

// Desktop surfaces a corrupt-config load via the recovery modal (configHealth
// slice → InvalidConfigModal). Headless has no UI to drive the fix, so it
// abandons the bad file and boots on defaults (the quarantine copy is kept).
let configLoadError = getConfigLoadError()
if (configLoadError && runtime !== 'electron') {
  log('config', `corrupt config on headless boot, resetting: ${configLoadError.message}`)
  config = discardCorruptConfigAndReset()
  configLoadError = null
}

const store = new Store(
  buildInitialAppState(config, { hasGithubToken: hasSecret('githubToken'), configLoadError })
)

// Scan for user-authored themes once the store exists. Done as a
// dispatch (rather than seeding into buildInitialAppState) so the
// reload IPC follows the same code path.
try {
  store.dispatch({ type: 'settings/customThemesChanged', payload: loadCustomThemes() })
} catch (err) {
  log('themes', `initial scan failed: ${(err as Error).message}`)
}
const approvalBridge = new ApprovalBridge(store, {
  getClaudeCommand: () =>
    store.getSnapshot().state.settings.claudeCommand || DEFAULT_CLAUDE_COMMAND,
  isAutoApproveEnabled: () =>
    store.getSnapshot().state.settings.autoApprovePermissions === true,
  getAutoApproveSteerInstructions: () =>
    store.getSnapshot().state.settings.autoApproveSteerInstructions || ''
})
const jsonClaudeManager = new JsonClaudeManager(store, {
  getClaudeCommand: () =>
    store.getSnapshot().state.settings.claudeCommand || DEFAULT_CLAUDE_COMMAND,
  getUseSystemClaude: () =>
    store.getSnapshot().state.settings.useSystemClaudeForJsonMode === true,
  getApprovalSocketPath: (sessionId) => approvalBridge.startSession(sessionId),
  closeApprovalSession: (sessionId) => approvalBridge.stopSession(sessionId),
  getClaudeEnvVars: () =>
    store.getSnapshot().state.settings.claudeEnvVars || {},
  getControlServer: () => getControlServerInfo(),
  getControlBridgeScriptPath: () => getBridgeScriptPath(),
  isHarnessMcpEnabled: () =>
    store.getSnapshot().state.settings.harnessMcpEnabled !== false,
  getCallerScope: (sessionId) => {
    const scope = resolveCallerScope(sessionId)
    if (!scope) return null
    return {
      worktreePath: scope.worktreePath,
      repoRoot: scope.repoRoot,
      isMain: scope.isMain
    }
  },
  getLaunchSettings: (worktreePath, modelOverride) =>
    buildClaudeLaunchSettings({
      cwd: worktreePath,
      worktrees: store.getSnapshot().state.worktrees.list,
      config,
      modelOverride
    })
})
const perfMonitor = new PerfMonitor()
setGitHubApiRecorder(() => perfMonitor.recordGitHubApiCall())
setGitHubApiLoggingEnabled(config.expandedDiagnosticLoggingEnabled === true)

// Active SSH tunnels keyed by backend id. Populated by the
// ssh:bootstrap / ssh:reconnect handlers; entries are torn down on
// connections:remove and on app quit. The remote `harness-server` is
// intentionally NOT killed on unregister — it stays alive for future
// reconnects + other Ness instances. See plans/remote-main.md §4.
//
// The manager reports dropped links; the supervisor below owns the
// retry policy. They're declared in this order because the manager's
// onDropped closes over the supervisor, which in turn closes over
// runSshReconnect — all resolved lazily at call time, so the cycle is
// fine, but don't collapse them into eager references.
const sshTunnelManager = new SshTunnelManager({
  onDropped: (backendId) => {
    log('ssh-bootstrap', `tunnel dropped for ${backendId}; scheduling reconnect`)
    sshReconnectSupervisor.notifyDropped(backendId)
  }
})

const sshReconnectSupervisor = new SshReconnectSupervisor({
  connectionExists: (backendId) =>
    (config.connections ?? []).some((c) => c.id === backendId && !!c.ssh),
  reconnect: async (backendId) => {
    await runSshReconnect({ bootstrapId: `reconnect-${backendId}`, connectionId: backendId })
  },
  onAttemptState: (backendId, { phase, attempt, delayMs }) => {
    const conn = (config.connections ?? []).find((c) => c.id === backendId)
    if (!conn?.ssh) return
    const bootstrapId = `reconnect-${backendId}`
    const now = Date.now()
    // The slice entry may not exist yet (first drop) — `started` is a
    // create, the rest are patches that no-op on a missing id.
    if (!store.getSnapshot().state.sshBootstrap.byId[bootstrapId]) {
      store.dispatch({
        type: 'sshBootstrap/started',
        payload: { bootstrapId, label: conn.label, target: conn.ssh.target, now }
      })
      store.dispatch({
        type: 'sshBootstrap/connectionLinked',
        payload: { bootstrapId, connectionId: backendId }
      })
    }
    store.dispatch({ type: 'sshBootstrap/phaseChanged', payload: { bootstrapId, phase, now } })
    store.dispatch({
      type: 'sshBootstrap/lineLogged',
      payload: {
        bootstrapId,
        line:
          phase === 'reconnecting'
            ? `reconnect attempt ${attempt + 1}…`
            : `connection lost — retrying in ${Math.round((delayMs ?? 0) / 1000)}s`,
        now
      }
    })
  }
})

// In Electron mode createDesktopShell applies the dev-mode userData
// override (must run before anything reads paths) and constructs the
// WebContentsView-backed BrowserManager + Electron IPC transport. In
// headless mode we instantiate PlaywrightBrowserManager, which spins
// up Chromium via playwright-core on the first browser-tab create.
const desktopEarly = desktopShellMod
  ? desktopShellMod.createDesktopShell({ store, perfMonitor, config })
  : null
const browserManager: BrowserManagerLike =
  desktopEarly?.browserManager ?? new PlaywrightBrowserManager()

// The compound transport lets the Electron IPC transport and the WS
// transport run side-by-side off a single registration path — every
// `transport.onRequest` / `sendSignal` call below registers on both.
// In headless mode the WS transport is the only member, so it's also
// the only consumer of every handler.
//
// Headless mode always starts the WS transport (it's the ONLY way for a
// client to reach the server). Electron mode honors the existing toggle
// — enable via wsTransportEnabled in config.json, or HARNESS_WS_TRANSPORT=1.
const wsEnabled =
  runtime === 'node' ||
  config.wsTransportEnabled === true ||
  process.env['HARNESS_WS_TRANSPORT'] === '1'
// CLI flag > env var > config > default. --port 0 picks an ephemeral
// port (the existing wsTransport.listen path handles it). cliFlags is
// already populated above (gated on headless runtime).
const envPort = Number.parseInt(process.env['HARNESS_WS_PORT'] ?? '', 10)
const wsPort =
  cliFlags.port != null && cliFlags.port >= 0
    ? cliFlags.port
    : Number.isFinite(envPort) && envPort > 0
      ? envPort
      : (config.wsTransportPort ?? 37291)
const wsHost =
  cliFlags.host ||
  process.env['HARNESS_WS_HOST'] ||
  config.wsTransportHost ||
  '127.0.0.1'

// Load (or generate + persist) the shared auth token. Persistence lets
// users pin the web-client URL to a phone homescreen or bookmark it
// and have it keep working across main-process restarts. Rotation
// happens explicitly via Settings, not on every boot.
const wsToken = wsEnabled ? getOrCreateWsToken() : null

// Electron-packaged builds resolve the web-client bundle inside the asar;
// every other path (Electron-dev, headless) reads it from a sibling of
// the main bundle. resolveWebClientDir() does the packaged check inside
// the desktop shell so this file stays free of `app.getAppPath`.
const webClientDir =
  desktopShellMod?.resolveWebClientDir?.() ?? join(__dirname, '../web-client')

const webHttpServer: HttpServer | null =
  wsEnabled && wsToken
    ? createWebClientServer({ token: wsToken, rootDir: webClientDir })
    : null

const wsTransport =
  wsEnabled && wsToken
    ? new WebSocketServerTransport(
        store,
        { host: wsHost, server: webHttpServer ?? undefined, token: wsToken },
        perfMonitor
      )
    : null

const transports: ServerTransport[] = []
if (desktopEarly) transports.push(desktopEarly.transport)
if (wsTransport) transports.push(wsTransport)
const transport: CompoundServerTransport = new CompoundServerTransport(transports)
transport.start()

// Sweep any controller/spectator roster entries owned by a client when
// they disconnect. Covers BrowserWindow close (Electron) and WS socket
// close alike; the reducer handles idempotence.
transport.onClientDisconnect((clientId) => {
  store.dispatch({
    type: 'terminals/clientDisconnected',
    payload: { clientId }
  })
  costTracker.removeClient(clientId)
  contextTracker.removeClient(clientId)
})

if (webHttpServer && wsTransport) {
  webHttpServer.on('error', (err) => {
    log('web-client', 'http server error', err.message)
  })
  webHttpServer.listen(wsPort, wsHost, () => {
    const displayHost = wsHost === '0.0.0.0' ? getLanHost() : wsHost
    // Resolve the actual listening port — when wsPort is 0 (ephemeral),
    // address() is the only place the real port surfaces.
    const addr = webHttpServer.address()
    const boundPort = addr && typeof addr === 'object' ? addr.port : wsPort
    // Log to stdout so the user can paste the URL into another browser
    // without digging through the debug log. TODO(production): expose
    // through a Settings UI screen with a copy button + regenerate action.
    // eslint-disable-next-line no-console
    console.log(
      `[ws-transport] enabled on ws://${displayHost}:${boundPort}?token=${wsTransport.getToken()} (bind=${wsHost})`
    )
    // eslint-disable-next-line no-console
    console.log(
      `[web-client] open http://${displayHost}:${boundPort}/?token=${wsTransport.getToken()}`
    )
  })
}

/** Pick a non-loopback IPv4 address to display when binding to 0.0.0.0,
 *  so the printed URL is reachable from another device on the LAN. Falls
 *  back to '0.0.0.0' literal if no usable interface is found. */
function getLanHost(): string {
  const ifaces = networkInterfaces()
  for (const list of Object.values(ifaces)) {
    if (!list) continue
    for (const entry of list) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return '0.0.0.0'
}

/** Enumerate every non-loopback IPv4 address paired with its interface
 *  name, so the Settings UI can surface a picker when a machine has
 *  multiple plausible LAN bindings (WiFi + ethernet + VPN tunnel). */
function getLanAddresses(): Array<{ iface: string; address: string }> {
  const result: Array<{ iface: string; address: string }> = []
  const ifaces = networkInterfaces()
  for (const [name, list] of Object.entries(ifaces)) {
    if (!list) continue
    for (const entry of list) {
      if (entry.family === 'IPv4' && !entry.internal) {
        result.push({ iface: name, address: entry.address })
      }
    }
  }
  return result
}

// Tails Claude Code session jsonl transcripts on Stop hook events,
// sums per-model usage, and dispatches costs/usageUpdated. See
// src/main/cost-tracker.ts and src/shared/state/costs.ts.
const costTracker = new CostTracker(store)
costTracker.start()

// CostPanel is collapsed-by-default. Renderer signals its expand state
// per client; tracker short-circuits parsing while the set is empty.
transport.onRequest('costs:setInterest', (ctx, expanded: boolean) => {
  costTracker.setClientInterested(ctx.clientId, expanded)
  return true
})

transport.onRequest(
  'costs:getAllSessions',
  async (_ctx, sinceMs?: number) => {
    return getAllSessionCosts({ sinceMs })
  }
)

// Point-in-time context-window occupancy for both terminal and chat
// tabs. See src/main/context-tracker.ts and
// src/shared/state/context-window.ts.
const contextTracker = new ContextTracker(store)
contextTracker.start()

// Same collapsed-by-default gating as the cost panel — analyzing a
// multi-megabyte transcript per turn is only worth it while someone is
// looking at the result.
transport.onRequest('contextWindow:setInterest', (ctx, expanded: boolean) => {
  contextTracker.setClientInterested(ctx.clientId, expanded)
  return true
})

transport.onRequest('claude:getAuthStatus', async () => {
  return getClaudeAuthStatus()
})

// Auto-persist the costs slice to config.json on each change. Debounced
// inside saveConfig; cheap to fire on every dispatch.
store.subscribe((event) => {
  if (event.type.startsWith('costs/')) {
    config.costs = store.getSnapshot().state.costs
    saveConfig(config)
  }
})

// Persist snooze entries through to disk so wakeAt survives restart.
store.subscribe((event) => {
  if (event.type.startsWith('snooze/')) {
    const byPath = store.getSnapshot().state.snooze.byPath
    if (Object.keys(byPath).length === 0) {
      delete config.snooze
    } else {
      config.snooze = byPath
    }
    saveConfig(config)
  }
})

// Persist per-worktree CI-notify overrides so they survive restart.
store.subscribe((event) => {
  if (event.type.startsWith('ciNotify/')) {
    const byPath = store.getSnapshot().state.ciNotify.byPath
    if (Object.keys(byPath).length === 0) {
      delete config.ciNotify
    } else {
      config.ciNotify = byPath
    }
    saveConfig(config)
  }
})

// Persist alias map through to disk so aliases survive restart.
store.subscribe((event) => {
  if (event.type.startsWith('aliases/')) {
    const byPath = store.getSnapshot().state.aliases.byPath
    if (Object.keys(byPath).length === 0) {
      delete config.aliases
    } else {
      config.aliases = byPath
    }
    saveConfig(config)
  }
})

// Persist pins through to disk so the Pinned section survives restart.
store.subscribe((event) => {
  if (event.type.startsWith('pinned/')) {
    const byPath = store.getSnapshot().state.pinned.byPath
    if (Object.keys(byPath).length === 0) {
      delete config.pinned
    } else {
      config.pinned = byPath
    }
    saveConfig(config)
  }
})

// When a session ID is discovered from a hook event (e.g. Codex assigns
// its own session ID), persist panes immediately so the ID survives a quit.
store.subscribe((event) => {
  if (event.type === 'terminals/sessionIdDiscovered') {
    persistPanes(store.getSnapshot().state.terminals.panes)
  }
})

// Mirror json-claude session state into terminals/statusChanged so the
// sidebar + tab-bar dots light up the same way they do for xterm tabs.
// Lives in its own module — see src/main/json-claude-status-deriver.ts.
const jsonClaudeStatusDeriver = new JsonClaudeStatusDeriver(store)
jsonClaudeStatusDeriver.start()

/** Resolve the GitHub login of whoever owns the configured token, and
 *  dispatch it so the sidebar can route PRs they didn't author into the
 *  Reviewing group. Best-effort: any failure leaves the slice at null,
 *  which falls back to the pre-Reviewing grouping. Safe to call after
 *  any token resolution. */
async function refreshViewerLogin(): Promise<void> {
  const token = getCachedToken()
  if (!token) {
    store.dispatch({ type: 'settings/viewerLoginChanged', payload: null })
    return
  }
  const result = await testToken(token)
  store.dispatch({
    type: 'settings/viewerLoginChanged',
    payload: result.ok && result.username ? result.username : null
  })
}

/** Query the harness star state, dispatch it to the slice, and auto-star
 *  exactly once per user (sticky so manual unstars survive reboots). Safe
 *  to call after any token resolution — boot, PAT save, etc. */
async function refreshHarnessStarState(): Promise<void> {
  const token = getCachedToken()
  if (!token) {
    store.dispatch({ type: 'settings/harnessStarredChanged', payload: null })
    return
  }
  const starred = await isRepoStarred(token, HARNESS_REPO_OWNER, HARNESS_REPO_NAME)
  if (starred === false && !config.harnessAutoStarred) {
    const result = await starRepo(token, HARNESS_REPO_OWNER, HARNESS_REPO_NAME)
    if (result.ok) {
      config.harnessAutoStarred = true
      saveConfig(config)
      store.dispatch({ type: 'settings/harnessStarredChanged', payload: true })
      log('app', 'auto-starred harness on first GitHub connection')
      return
    }
    log('app', 'auto-star failed', result.error)
  }
  store.dispatch({ type: 'settings/harnessStarredChanged', payload: starred })
}

const prPoller = new PRPoller(store, {
  getRepoRoots: () => config.repoRoots || [],
  getLocallyMerged: () => config.locallyMerged || {},
  setLocallyMerged: (next) => {
    if (Object.keys(next).length === 0) {
      delete config.locallyMerged
    } else {
      config.locallyMerged = next
    }
    saveConfig(config)
  }
})

const announcementsPoller = new AnnouncementsPoller(store)

ptyManager.setStore(store)
ptyManager.setSendSignal((channel, ...args) => transport.sendSignal(channel, ...args))
ptyManager.setPerfMonitor(perfMonitor)
perfMonitor.start(store, () => ptyManager.getActivePtyCount())

// Per-client changed-files subscriptions, layered on the WorktreeWatcher
// (constructed below — it needs worktreesFSM for its branch-sync callback).
const worktreeWatchSubs = new Map<string, Map<string, () => void>>()

// Watches individual files for content changes (FileView + working-tree
// ReviewDiffPane refresh-on-disk-edit). Refcounted per absolute path; one
// fs.watch handle per file regardless of how many clients are open.
// Subs are keyed by clientId so a window close releases everything.
const fileContentWatcher = new FileContentWatcher()
const fileContentWatchSubs = new Map<string, Map<string, () => void>>()

function unsubscribeAllForClient(clientId: string): void {
  const wtSubs = worktreeWatchSubs.get(clientId)
  if (wtSubs) {
    for (const off of wtSubs.values()) off()
    worktreeWatchSubs.delete(clientId)
  }
  const fileSubs = fileContentWatchSubs.get(clientId)
  if (fileSubs) {
    for (const off of fileSubs.values()) off()
    fileContentWatchSubs.delete(clientId)
  }
}

transport.onClientDisconnect((clientId) => unsubscribeAllForClient(clientId))

browserManager.setStore(store)

// Reconcile BrowserManager with the pane tree: for every 'browser' tab in
// the store, make sure a WebContentsView exists; for every view we own
// that no longer has a corresponding tab, destroy it.
function reconcileBrowserViews(): void {
  const panes = store.getSnapshot().state.terminals.panes
  const live = new Map<string, { worktreePath: string; url: string }>()
  for (const [wtPath, tree] of Object.entries(panes)) {
    for (const leaf of getLeaves(tree)) {
      for (const tab of leaf.tabs) {
        if (tab.type === 'browser') {
          live.set(tab.id, { worktreePath: wtPath, url: tab.url || 'about:blank' })
        }
      }
    }
  }
  for (const [tabId, info] of live) {
    if (!browserManager.hasTab(tabId)) {
      browserManager.create(tabId, info.worktreePath, info.url)
    }
  }
  for (const tabId of browserManager.listAllTabIds()) {
    if (!live.has(tabId)) browserManager.destroy(tabId)
  }
}

store.subscribe((event) => {
  if (
    event.type === 'terminals/panesForWorktreeChanged' ||
    event.type === 'terminals/panesForWorktreeCleared' ||
    event.type === 'terminals/panesReplaced'
  ) {
    reconcileBrowserViews()
  }
  // When a browser tab navigates the event lands in the `browser` slice
  // instead of mutating the pane tree, so the pane-FSM's auto-persist
  // doesn't fire. Trigger one here when the URL changes so reload
  // restores where the user actually navigated to, not the blank tab
  // they originally opened.
  if (event.type === 'browser/tabStateChanged') {
    if ('url' in (event.payload.state as Record<string, unknown>)) {
      persistPanes(store.getSnapshot().state.terminals.panes)
    }
  }
})

// Persist pane trees back to config in the nested-by-repo shape. Walks
// the tree, strips transient tab fields, and drops leaves with no
// persistable tabs (diff/file viewer tabs are ephemeral).
function persistPanes(panes: Record<string, PaneNode>): void {
  const nested: Record<string, Record<string, PersistedPaneNode>> = {}
  for (const [wtPath, tree] of Object.entries(panes)) {
    const wt = store.getSnapshot().state.worktrees.list.find((w) => w.path === wtPath)
    const repoRoot = wt?.repoRoot || '__orphan__'
    const persisted = treeToPersistedNode(tree)
    if (persisted) {
      if (!nested[repoRoot]) nested[repoRoot] = {}
      nested[repoRoot][wtPath] = persisted
    }
  }
  config.panes = nested
  saveConfig(config)
}

function treeToPersistedNode(node: PaneNode): PersistedPaneNode | null {
  if (node.type === 'leaf') {
    const tabs = node.tabs
      .filter(
        (t) =>
          t.type === 'agent' ||
          t.type === 'shell' ||
          t.type === 'browser' ||
          t.type === 'json-claude'
      )
      .map((t) => {
        const stripped = stripTransientTabFields(t as TerminalTab)
        // For browser tabs, the tab's state.url field is set once at
        // creation and never updated — navigation events flow into the
        // `browser` slice, not the pane tree. Pull the live URL from the
        // BrowserManager so the persisted snapshot reflects where the
        // user actually navigated to.
        const liveUrl =
          stripped.type === 'browser' ? browserManager.getUrl(stripped.id) : null
        return {
          id: stripped.id,
          type: stripped.type as 'agent' | 'shell' | 'browser' | 'json-claude',
          label: stripped.label,
          agentKind: stripped.agentKind,
          sessionId: stripped.sessionId,
          url: liveUrl || stripped.url,
          command: stripped.command,
          cwd: stripped.cwd,
          model: stripped.model,
          ...(stripped.customLabel ? { customLabel: stripped.customLabel } : {})
        }
      })
    if (tabs.length === 0) return null
    const validActive = tabs.some((t) => t.id === node.activeTabId)
      ? node.activeTabId
      : tabs[0].id
    return { type: 'leaf', id: node.id, tabs, activeTabId: validActive }
  }
  const left = treeToPersistedNode(node.children[0])
  const right = treeToPersistedNode(node.children[1])
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

// IMPORTANT — construction order is load-bearing.
//
// PanesFSM must be constructed BEFORE WorktreesFSM because WorktreesFSM's
// onWorktreeCreated callback (defined below) closes over `panesFSM`.
// JavaScript doesn't blow up at construction time because the closure
// only runs later, but if you reorder these and panesFSM is in the
// temporal dead zone when the callback fires, you'll get a
// ReferenceError that only surfaces when a worktree is created.
//
// The conceptual coupling — "creating a worktree triggers pane
// initialization" — used to live visibly in App.tsx where the renderer
// orchestrated both. After the state migration, it became an implicit
// contract between two main-side modules that this file wires together.
// If you ever refactor this further, consider inverting: have PanesFSM
// subscribe to `worktrees/listChanged` itself and call ensureInitialized
// on any new worktree. That would make the dependency direction explicit
// and remove the construction-order requirement.
const panesFSM = new PanesFSM(store, {
  persist: persistPanes,
  getRepoRootForWorktree: (wtPath) => {
    const wt = store.getSnapshot().state.worktrees.list.find((w) => w.path === wtPath)
    return wt?.repoRoot
  },
  getLatestClaudeSessionId: async (wtPath) => {
    const kind = store.getSnapshot().state.settings.defaultAgent ?? 'claude'
    return getAgent(kind).latestSessionId(wtPath)
  },
  getDefaultAgentKind: () => toAgentKind(store.getSnapshot().state.settings.defaultAgent),
  getDefaultClaudeTabType: () => {
    const s = store.getSnapshot().state.settings
    return s.defaultClaudeTabType === 'json' ? 'json' : 'xterm'
  },
  // Authoritative PTY teardown when tabs leave the tree. The renderer
  // no longer kills PTYs from XTerminal unmount cleanups (that was the
  // only path before, and it broke the moment we had clients that
  // could disconnect without intending to kill agents). Tab-close /
  // restart / clear events are the actual lifecycle boundary.
  killTabPty: (tabId) => ptyManager.kill(tabId),
  killJsonClaude: (sessionId) => jsonClaudeManager.kill(sessionId),
  clearJsonClaudeSession: (sessionId) =>
    store.dispatch({ type: 'jsonClaude/sessionCleared', payload: { sessionId } }),
  startJsonClaudeWithPrompt: (sessionId, worktreePath, initialPrompt) => {
    startJsonClaudeSession(sessionId, worktreePath)
    if (initialPrompt) jsonClaudeManager.send(sessionId, initialPrompt)
  },
  startJsonClaude: (sessionId, worktreePath) => {
    startJsonClaudeSession(sessionId, worktreePath)
  }
})

/** Look up a json-claude tab's persisted `model` override by sessionId
 *  (which is also the tab id for json-claude tabs). Returned to the
 *  json-claude manager so resume/kickoff/wake all respect a per-tab pin
 *  that was set when the worktree was created. */
function findJsonClaudeTabModel(sessionId: string): string | undefined {
  const panes = store.getSnapshot().state.terminals.panes
  for (const tree of Object.values(panes)) {
    for (const leaf of getLeaves(tree)) {
      for (const tab of leaf.tabs) {
        if (tab.id === sessionId && tab.type === 'json-claude') {
          return tab.model && tab.model.trim() ? tab.model.trim() : undefined
        }
      }
    }
  }
  return undefined
}

/** Single source of truth for "spin up the json-claude subprocess for
 *  this sessionId". Used by the jsonClaude:start IPC handler, the
 *  panesFSM's startJsonClaudeWithPrompt + startJsonClaude options
 *  (kickoff + wake), so all paths produce the same dispatch + seed +
 *  create order. Idempotent — JsonClaudeManager.create() short-circuits
 *  if the instance is already running. */
function startJsonClaudeSession(sessionId: string, worktreePath: string): void {
  if (jsonClaudeManager.hasSession(sessionId)) return
  store.dispatch({
    type: 'jsonClaude/sessionStarted',
    payload: {
      sessionId,
      worktreePath,
      defaultPermissionMode:
        store.getSnapshot().state.settings.jsonModeDefaultPermissionMode
    }
  })
  jsonClaudeManager.seedFromTranscript(sessionId, worktreePath)
  const permMode =
    store.getSnapshot().state.jsonClaude.sessions[sessionId]?.permissionMode ||
    'default'
  jsonClaudeManager.create(sessionId, worktreePath, permMode, findJsonClaudeTabModel(sessionId))
}

/** Resolve what the new worktree's first agent tab should start from,
 *  performing the transcript fork when one was requested. Shared by the FSM
 *  path (UI creation) and the MCP path (worktrees:externalCreate) so both
 *  produce an identically-seeded session. */
async function resolveForkedKickoff(args: {
  createdPath: string
  initialPrompt?: string
  forkSource?: ForkSource
  baseRef?: string
}): Promise<{ initialPrompt?: string; forkedSessionId?: string }> {
  const { createdPath, initialPrompt, forkSource, baseRef } = args
  if (!forkSource) return { initialPrompt }

  const outcome = forkTranscript({
    sourceSessionId: forkSource.sessionId,
    sourceWorktreePath: forkSource.worktreePath,
    destWorktreePath: createdPath
  })
  if (!outcome.ok || !outcome.newSessionId) {
    // Degrade to a normal empty session rather than failing creation —
    // the worktree already exists on disk at this point.
    log('worktrees', `conversation fork into ${createdPath} failed: ${outcome.reason}`)
    return { initialPrompt }
  }

  const preamble = await buildRelocationPreamble({
    sourceWorktreePath: forkSource.worktreePath,
    destWorktreePath: createdPath,
    baseRef
  })
  // The preamble goes INSIDE an automated-kickoff sentinel rather than in
  // front of it — `parseAutomatedMessage` only matches at the start of the
  // text, so prepending would leave the tags visible in the transcript.
  const automated = parseAutomatedMessage(initialPrompt)
  return {
    initialPrompt: automated
      ? wrapAutomatedMessage(automated.source, `${preamble}${automated.body}`, {
          from: automated.from
        })
      : `${preamble}${initialPrompt ?? ''}`,
    forkedSessionId: outcome.newSessionId
  }
}

/** Interrupt an in-flight json-claude turn and wait for it to actually
 *  reach a boundary. Callers that touch the session's stdin or jsonl
 *  right after (interrupt-and-send, rewind, model swap) need the turn
 *  stopped first, not merely asked to stop.
 *
 *  Two ordering traps, both load-bearing:
 *  - Subscribe BEFORE writing the interrupt frame, or the dispatch we're
 *    waiting for can land before the listener exists.
 *  - Ignore anything dispatched DURING manager.interrupt(): it flips busy
 *    off optimistically in its own synchronous dispatch, so an ungated
 *    listener resolves on that instead of on the subprocess's `result`
 *    frame and we're back to racing the dying turn.
 *
 *  An aborted turn doesn't always emit a result frame, hence the timeout
 *  fallback. `via=` in the log line says which path a given call took. */
const QUIESCE_TIMEOUT_MS = 1500
async function interruptAndQuiesce(sessionId: string): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false
    let armed = false
    const startedAt = Date.now()
    const finish = (via: 'boundary' | 'timeout'): void => {
      if (settled) return
      settled = true
      unsub()
      clearTimeout(timer)
      log(
        'json-claude',
        `quiesce sessionId=${sessionId} via=${via} ms=${Date.now() - startedAt}`
      )
      resolve()
    }
    const unsub = store.subscribe((event) => {
      if (!armed) return
      if (
        event.type === 'jsonClaude/busyChanged' &&
        event.payload.sessionId === sessionId &&
        event.payload.busy === false
      ) {
        finish('boundary')
      }
    })
    const timer = setTimeout(() => finish('timeout'), QUIESCE_TIMEOUT_MS)
    jsonClaudeManager.interrupt(sessionId)
    armed = true
  })
}

const worktreesFSM = new WorktreesFSM(store, {
  getRepoRoots: () => config.repoRoots || [],
  getWorktreeSetupCmd: () => config.worktreeSetupCommand || '',
  getWorktreeBaseMode: () => config.worktreeBase || DEFAULT_WORKTREE_BASE,
  onWorktreeCreated: async ({ createdPath, initialPrompt, teleportSessionId, agentKind, model, forkSource, baseRef }) => {
    void prPoller.refreshAll()
    const kickoff = await resolveForkedKickoff({ createdPath, initialPrompt, forkSource, baseRef })
    panesFSM.ensureInitialized(createdPath, {
      initialPrompt: kickoff.initialPrompt,
      teleportSessionId,
      agentKind,
      model,
      forkedSessionId: kickoff.forkedSessionId
    })
    if (teleportSessionId) {
      setTimeout(() => void worktreesFSM.refreshList(), 10_000)
    }
  }
})

const worktreeDeletionFSM = new WorktreeDeletionFSM(store, {
  getGlobalTeardownCmd: () => config.worktreeTeardownCommand || '',
  worktreesFSM
})

// The WorktreeWatcher serves both the Changed Files panel (ref-counted
// subscribe() above/below) and event-driven branch-name sync off one fs.watch
// handle per worktree. The branch half watches each worktree's gitdir HEAD so a
// branch switch / rename / detached-HEAD / rebase step in a terminal re-reads
// the branch immediately, instead of waiting for the next create/delete/manual
// refresh (which is how "rebasing 2/22" used to get stuck forever). refreshList
// is deduped via applyList, so a no-op fs event won't churn the store.
const worktreeWatcher = new WorktreeWatcher(() => {
  void worktreesFSM.refreshList()
})
// Keep the branch-sync watch set in lockstep with the worktree list. Only
// reacts to listChanged (infrequent); sync() is a cheap set-diff that
// opens/closes watchers and never dispatches, so there's no feedback loop.
store.subscribe((event) => {
  if (event.type !== 'worktrees/listChanged') return
  worktreeWatcher.sync(store.getSnapshot().state.worktrees.list)
})

const activityDeriver = new ActivityDeriver(store)

// How anything in main reaches a worktree's agent chat. Shared by the CI
// notifier and the send_message MCP tool so both route (and wake) alike.
const chatDeliveryDeps = {
  send: (sessionId: string, text: string) => jsonClaudeManager.send(sessionId, text),
  hasSession: (sessionId: string) => jsonClaudeManager.hasSession(sessionId),
  wake: (worktreePath: string, tabId: string) =>
    panesFSM.wakeJsonClaudeTab(worktreePath, tabId)
}

// Injects a "CI is failing" message into a worktree's agent chat when its
// PR checks go red. Kept out of PRPoller so the poller stays ignorant of
// chat sessions.
const ciNotifier = new CiNotifier(store, chatDeliveryDeps)

// Tears down idle json-mode subprocesses (yellow-dot tabs older than
// settings.autoSleepMinutes). Constructed after panesFSM since it
// drives panesFSM.sleepJsonClaudeTab.
const autoSleepMonitor = new AutoSleepMonitor(store, panesFSM)

// Holds a power-save blocker while the configured prevent-sleep mode
// (or the temporary timer) wants the machine awake. Pure side effect —
// subscribes to the store, never owns slice state.
const wakeLockController = new WakeLockController(store)

/** Install agent status hooks at the user-scope settings file for both
 *  supported agents. Called once when consent flips to 'accepted'. The
 *  hook command is env-gated on $HARNESS_TERMINAL_ID, so it no-ops for
 *  sessions started outside Ness. */
function installHooksGlobally(): void {
  // installHooks() is idempotent — it strips any existing Ness entries
  // before writing a fresh one — so calling it unconditionally also
  // collapses duplicate entries left by earlier buggy install passes.
  for (const agent of [getAgent('claude'), getAgent('codex'), getAgent('cursor')]) {
    agent.installHooks()
  }
}

function uninstallHooksGlobally(): void {
  for (const agent of [getAgent('claude'), getAgent('codex'), getAgent('cursor')]) {
    agent.uninstallHooks()
  }
}

/** One-shot boot migration undoing the old symlink scheme.
 *
 *  Ness used to symlink every worktree's `.claude/settings.local.json` at
 *  its main worktree's copy so "Always allow" grants would be shared. That
 *  never worked: Claude Code refuses to write through a symlinked settings
 *  file (see shared/permission-match.ts), so a symlinked worktree persisted
 *  nothing at all. Ness owns the shared allowlist itself now.
 *
 *  Two jobs, both idempotent, gated behind `claudeSettingsUnsymlinked` so a
 *  user who later hand-edits their settings files isn't swept again:
 *    1. Convert every symlink back to a real file, so Claude's own
 *       persistence (and terminal-tab grants) starts working again.
 *    2. Seed `permissions.rules` from the `permissions.allow` entries found
 *       along the way, so grants the user already made survive the switch. */
function migrateClaudeSettingsOffSymlinks(): void {
  if (config.claudeSettingsUnsymlinked) return
  const list = store.getSnapshot().state.worktrees.list
  const recovered: string[] = []
  for (const wt of list) {
    try {
      const fromLink = unsymlinkClaudeSettings(wt.path)
      if (fromLink !== null) {
        recovered.push(...fromLink)
        log('hooks', `un-symlinked .claude/settings.local.json: ${wt.path}`)
      } else {
        recovered.push(...readClaudeAllowEntries(wt.path))
      }
    } catch (err) {
      log(
        'hooks',
        `un-symlink failed for ${wt.path}`,
        err instanceof Error ? err.message : err
      )
    }
  }

  config.claudeSettingsUnsymlinked = true
  saveConfig(config)

  if (recovered.length === 0) return
  const imported = grantPermissionRules(
    recovered.map((entry) => parseRuleKey(entry)).filter((r): r is PermissionRule => r !== null)
  )
  if (imported > 0) {
    log('hooks', `imported ${imported} permission rule(s) from existing settings.local.json files`)
  }
}

/** Add rules to the global allowlist, persist, and return how many were
 *  actually new. Shared by the migration and the IPC handler so both go
 *  through the same dedup + persist path. */
function grantPermissionRules(rules: PermissionRule[], grantedFrom?: string): number {
  let added = 0
  for (const rule of rules) {
    const before = store.getSnapshot().state.permissions.rules.length
    store.dispatch({
      type: 'permissions/granted',
      payload: {
        rule: {
          id: ruleKey(rule),
          toolName: rule.toolName,
          ...(rule.ruleContent ? { ruleContent: rule.ruleContent } : {}),
          grantedAt: Date.now(),
          ...(grantedFrom ? { grantedFrom } : {})
        }
      }
    })
    if (store.getSnapshot().state.permissions.rules.length > before) added++
  }
  if (added > 0) persistPermissionRules()
  return added
}

function persistPermissionRules(): void {
  config.permissionRules = store.getSnapshot().state.permissions.rules
  saveConfig(config)
}

// Sleep-on-boot for merged worktrees.
//
// At boot, we don't want to spin up a Claude process for every worktree
// the user has lying around — most users have many old merged branches
// they'll never look at again. Instead, we wait for the first PR-poller
// pass to land (so we know which worktrees are merged), then init only
// the non-merged ones. Merged worktrees stay "asleep" until the user
// explicitly clicks them (the renderer fires panes:ensureInitialized on
// activation — see the useEffect on activeWorktreeId in App.tsx).
//
// Three cases the state machine has to handle:
//   1. Boot drain on prs/mergedChanged — happy path with a token + GH
//      reachable. Init non-merged paths from the pending queue.
//   2. Boot drain on 3s timeout — no token, no network, brand-new repo,
//      etc. Init everything in the pending queue unconditionally so we
//      don't strand the user.
//   3. Post-boot worktrees/listChanged — a repo is added later. Mirror
//      the previous behavior and init every wt unconditionally so any
//      newly-appearing worktree gets the default Claude+Shell pair.
//
// Rule: this only prevents *starting* Claude for merged-at-boot
// worktrees. If a PR flips to merged mid-session, the already-running
// Claude is left alone (the activity-deriver handles the visual merged
// treatment separately).
const BOOT_INIT_TIMEOUT_MS = 3000
let bootDrained = false
const pendingBootInit = new Set<string>()
let bootTimer: NodeJS.Timeout | null = null

// Yield to the event loop every N inits so 30+ ensureInitialized
// dispatches (each followed by a renderer state-event broadcast and a
// JSON persist write) don't run as one synchronous block. Without this,
// boot freezes the UI for seconds while the renderer can't paint
// between dispatches.
const BOOT_INIT_BATCH_SIZE = 3

// Worktrees created over MCP never enter the pending list — control-server
// calls addWorktree directly — so they claim their path here instead for the
// window where seeding is async (a conversation fork shells out to git to
// build the relocation preamble).
const seedingWorktreePaths = new Set<string>()

// A worktree that's still mid-creation belongs to whoever is creating it: the
// creator seeds the first agent tab with the kickoff prompt and, for a
// conversation fork, the forked session id. The path is already in
// `git worktree list` by then, so an unguarded sweep can win the race —
// ensureInitialized is first-write-wins and silently drops the seeding.
function isMidCreation(wtPath: string): boolean {
  if (seedingWorktreePaths.has(wtPath)) return true
  return store
    .getSnapshot()
    .state.worktrees.pending.some(
      (p) => p.createdPath === wtPath && (p.status === 'creating' || p.status === 'setup')
    )
}

async function drainBootInit(force: boolean): Promise<void> {
  if (bootDrained) return
  bootDrained = true
  if (bootTimer) {
    clearTimeout(bootTimer)
    bootTimer = null
  }
  const state = store.getSnapshot().state
  const paths = [...pendingBootInit]
  pendingBootInit.clear()
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i]
    if ((force || !isWorktreeMerged(state.prs, path)) && !isMidCreation(path)) {
      panesFSM.ensureInitialized(path)
    }
    if (i + 1 < paths.length && (i + 1) % BOOT_INIT_BATCH_SIZE === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
}

store.subscribe((event) => {
  if (event.type === 'worktrees/listChanged') {
    const worktrees = store.getSnapshot().state.worktrees
    const list = worktrees.list
    if (bootDrained) {
      // Paths whose creation FSM hasn't reached onWorktreeCreated yet own
      // their own init — it carries the kickoff prompt, agent kind and
      // model that this sweep doesn't have.
      for (const wt of list) {
        if (!isMidCreation(wt.path)) panesFSM.ensureInitialized(wt.path)
      }
      return
    }
    for (const wt of list) pendingBootInit.add(wt.path)
    if (!bootTimer) {
      bootTimer = setTimeout(() => {
        drainBootInit(true).catch((err) => log('boot', 'drainBootInit (timeout) failed', err))
      }, BOOT_INIT_TIMEOUT_MS)
    }
    return
  }
  if (event.type === 'prs/mergedChanged' && !bootDrained) {
    drainBootInit(false).catch((err) => log('boot', 'drainBootInit (merged) failed', err))
  }
})

// Drop snooze entries for worktrees that no longer exist so the map
// can't leak across worktree removals.
store.subscribe((event) => {
  if (event.type !== 'worktrees/listChanged') return
  const live = new Set(store.getSnapshot().state.worktrees.list.map((w) => w.path))
  const byPath = store.getSnapshot().state.snooze.byPath
  for (const path of Object.keys(byPath)) {
    if (!live.has(path)) {
      store.dispatch({ type: 'snooze/clear', payload: path })
    }
  }
})

// Same for CI-notify overrides — a removed worktree's override would
// otherwise linger and silently apply to a future worktree at the same path.
store.subscribe((event) => {
  if (event.type !== 'worktrees/listChanged') return
  const live = new Set(store.getSnapshot().state.worktrees.list.map((w) => w.path))
  const byPath = store.getSnapshot().state.ciNotify.byPath
  for (const path of Object.keys(byPath)) {
    if (!live.has(path)) {
      store.dispatch({ type: 'ciNotify/clear', payload: path })
    }
  }
})

// Same for pins — a removed worktree must not leave an orphan entry
// keeping an empty Pinned section alive.
store.subscribe((event) => {
  if (event.type !== 'worktrees/listChanged') return
  const live = new Set(store.getSnapshot().state.worktrees.list.map((w) => w.path))
  const byPath = store.getSnapshot().state.pinned.byPath
  for (const path of Object.keys(byPath)) {
    if (!live.has(path)) {
      store.dispatch({ type: 'pinned/clear', payload: path })
    }
  }
})

// Same idea for scratchpad notes: drop slice entries for removed
// worktrees, and prune them from the on-disk config so the file
// doesn't accumulate orphan paths.
store.subscribe((event) => {
  if (event.type !== 'worktrees/listChanged') return
  const live = new Set(store.getSnapshot().state.worktrees.list.map((w) => w.path))
  const byPath = store.getSnapshot().state.scratchpad.byWorktreePath
  let prunedDisk = false
  for (const path of Object.keys(byPath)) {
    if (live.has(path)) continue
    store.dispatch({ type: 'scratchpad/worktreeRemoved', payload: path })
    if (config.scratchpadNotes) {
      for (const repoRoot of Object.keys(config.scratchpadNotes)) {
        const repoMap = config.scratchpadNotes[repoRoot]
        if (repoMap && path in repoMap) {
          delete repoMap[path]
          if (Object.keys(repoMap).length === 0) {
            delete config.scratchpadNotes[repoRoot]
          }
          prunedDisk = true
        }
      }
    }
  }
  if (prunedDisk) {
    if (config.scratchpadNotes && Object.keys(config.scratchpadNotes).length === 0) {
      delete config.scratchpadNotes
    }
    saveConfig(config)
  }
})

// Drop alias entries for worktrees that no longer exist so the map
// can't leak across worktree removals.
store.subscribe((event) => {
  if (event.type !== 'worktrees/listChanged') return
  const live = new Set(store.getSnapshot().state.worktrees.list.map((w) => w.path))
  const byPath = store.getSnapshot().state.aliases.byPath
  for (const path of Object.keys(byPath)) {
    if (!live.has(path)) {
      store.dispatch({ type: 'aliases/cleared', payload: { path } })
    }
  }
})

const snoozeTimer = new SnoozeTimer(store)
snoozeTimer.start()

// Toggle "Warn Before Quitting". Shared by the Settings IPC handler and the
// app-menu checkbox (wired into the desktop shell), so both stay in sync.
// Persists only the off state (default-on, like autoUpdateEnabled).
function setWarnBeforeQuitting(enabled: boolean): void {
  if (enabled) {
    delete config.warnBeforeQuitting
  } else {
    config.warnBeforeQuitting = false
  }
  saveConfig(config)
  store.dispatch({
    type: 'settings/warnBeforeQuittingChanged',
    payload: config.warnBeforeQuitting !== false
  })
}

/** Publish what version of `harness-server` a remote is running, and
 *  whether it matches us. Headless tarballs ship on the same tag as the
 *  desktop build, so anything other than exact equality means the two
 *  halves can disagree about the wire protocol — we flag it and let the
 *  user decide (upgrading restarts the remote, killing its sessions). */
function recordRemoteServerVersion(connectionId: string, installed: string | null): void {
  if (!installed) return
  const expected = getHarnessVersion()
  store.dispatch({
    type: 'sshBootstrap/serverVersionProbed',
    payload: {
      connectionId,
      installed,
      expected,
      upgradeAvailable: expected !== 'unknown' && installed !== expected,
      checkedAt: Date.now()
    }
  })
}

/** Re-establish (or reuse) the SSH tunnel for an existing SSH backend.
 *  Shared between the `ssh:reconnect` IPC handler and the boot-time
 *  pre-warm loop in runBoot(). Idempotent: if a tunnel for this
 *  backend is already live, returns its URL+token without re-running
 *  the SSH handshake. */
const sshReconnectsInFlight = new Map<
  string,
  Promise<{ url: string; token: string; localPort: number }>
>()

async function runSshReconnect(input: {
  bootstrapId: string
  connectionId: string
}): Promise<{ url: string; token: string; localPort: number }> {
  if (!input || typeof input.connectionId !== 'string') {
    throw new Error('connectionId is required')
  }
  if (typeof input.bootstrapId !== 'string' || !input.bootstrapId) {
    throw new Error('bootstrapId is required')
  }
  // The boot pre-warm and the renderer's hydrate fire for the same
  // backend at almost the same moment. The liveness check below can't
  // separate them — neither has registered a tunnel yet — so both would
  // run a full bootstrap and leave two tunnels (and two harness-servers)
  // behind. Whoever asks second joins the first attempt instead.
  const existingAttempt = sshReconnectsInFlight.get(input.connectionId)
  if (existingAttempt) return existingAttempt
  const attempt = runSshReconnectUncoalesced(input)
  sshReconnectsInFlight.set(input.connectionId, attempt)
  try {
    return await attempt
  } finally {
    sshReconnectsInFlight.delete(input.connectionId)
  }
}

async function runSshReconnectUncoalesced(input: {
  bootstrapId: string
  connectionId: string
}): Promise<{ url: string; token: string; localPort: number }> {
  const conn = (config.connections ?? []).find((c) => c.id === input.connectionId)
  if (!conn) throw new Error(`unknown backend ${input.connectionId}`)
  if (!conn.ssh) throw new Error(`backend ${input.connectionId} is not an SSH backend`)

  // Only short-circuit on a tunnel that's actually alive. The local
  // net.Server keeps listening after the SSH link dies, so a dead entry
  // looks identical to a live one from the outside — handing its URL
  // back was why "reconnect" couldn't recover and remove/re-add was the
  // only fix. Dispose the corpse first: openTunnel wants to rebind the
  // same local port, and it silently falls back to a random one if the
  // old listener is still holding it.
  const existing = sshTunnelManager.get(input.connectionId)
  if (existing) {
    if (sshTunnelManager.isAlive(input.connectionId)) {
      const url = sshTunnelManager.buildLocalUrl(input.connectionId)!
      return { url, token: existing.token, localPort: existing.localPort }
    }
    log('ssh-bootstrap', `discarding dead tunnel for ${input.connectionId} before reconnect`)
    sshTunnelManager.unregister(input.connectionId)
  }

  const { parseSshTarget, bootstrapRemote } = await import('./ssh-bootstrap')
  const target = parseSshTarget(conn.ssh.target)
  store.dispatch({
    type: 'sshBootstrap/started',
    payload: {
      bootstrapId: input.bootstrapId,
      label: conn.label,
      target: target.raw,
      now: Date.now()
    }
  })
  store.dispatch({
    type: 'sshBootstrap/connectionLinked',
    payload: { bootstrapId: input.bootstrapId, connectionId: conn.id }
  })

  try {
    const result = await bootstrapRemote(
      target,
      {
        onPhase: (phase) => {
          store.dispatch({
            type: 'sshBootstrap/phaseChanged',
            payload: { bootstrapId: input.bootstrapId, phase, now: Date.now() }
          })
        },
        onLine: (line) => {
          store.dispatch({
            type: 'sshBootstrap/lineLogged',
            payload: { bootstrapId: input.bootstrapId, line, now: Date.now() }
          })
        }
      },
      {
        preferredLocalPort: conn.ssh.tunnelLocalPort,
        skipInstallIfRunning: true,
        expectedVersion: getHarnessVersion()
      }
    )
    recordRemoteServerVersion(conn.id, result.serverVersion)
    sshTunnelManager.register({
      backendId: conn.id,
      localPort: result.localPort,
      remotePort: result.remotePort,
      token: result.token,
      ssh: result.ssh,
      tunnelServer: result.tunnelServer
    })
    // ws:// not http:// — WebSocketClientTransport calls `new WebSocket(url)`
    // which throws on http schemes.
    const url = `ws://127.0.0.1:${result.localPort}/?token=${result.token}`
    const idx = (config.connections ?? []).findIndex((c) => c.id === conn.id)
    if (idx >= 0) {
      const next = config.connections!.slice()
      next[idx] = {
        ...next[idx],
        url,
        ssh: { target: target.raw, tunnelLocalPort: result.localPort }
      }
      config.connections = next
      setSecret(`backend-token:${conn.id}`, result.token)
      saveConfig(config)
    }
    store.dispatch({
      type: 'sshBootstrap/tunnelReady',
      payload: { bootstrapId: input.bootstrapId, localPort: result.localPort, now: Date.now() }
    })
    store.dispatch({
      type: 'sshBootstrap/phaseChanged',
      payload: { bootstrapId: input.bootstrapId, phase: 'connected', now: Date.now() }
    })
    return { url, token: result.token, localPort: result.localPort }
  } catch (err) {
    const bootstrapErr =
      (err as { bootstrapError?: import('../shared/state/ssh-bootstrap').BootstrapError })
        .bootstrapError ?? {
        code: 'unknown' as const,
        message: err instanceof Error ? err.message : String(err)
      }
    store.dispatch({
      type: 'sshBootstrap/errored',
      payload: { bootstrapId: input.bootstrapId, error: bootstrapErr, now: Date.now() }
    })
    throw err
  }
}

function registerIpcHandlers(): void {
  // Worktree handlers — every call takes an explicit repoRoot, since a single
  // window now shows worktrees from multiple repos at once.
  transport.onRequest('worktree:list', async (_ctx, repoRoot: string) => {
    if (!repoRoot) return []
    const trees = await listWorktrees(repoRoot)
    for (const wt of trees) {
      touchActivityMeta(wt.path, { branch: wt.branch, repoRoot })
    }
    return trees
  })

  transport.onRequest('worktree:branches', async (_ctx, repoRoot: string) => {
    if (!repoRoot) return []
    return listBranches(repoRoot)
  })

  // Worktree creation flows through the WorktreesFSM in main; main also
  // creates the default Claude+Shell pane pair (with the initial prompt
  // embedded) before the call returns. Renderer just awaits + focuses.
  transport.onRequest(
    'worktrees:runPending',
    async (_ctx, params: {
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
    }) => {
      return worktreesFSM.runPending(params)
    }
  )
  transport.onRequest(
    'worktrees:runPendingPR',
    async (
      _ctx,
      params: {
        id: string
        repoRoot: string
        prNumber: number
        initialPrompt?: string
        agentKind?: AgentKind
        model?: string
      }
    ) => {
      return worktreesFSM.runPendingPR(params)
    }
  )
  transport.onRequest('worktrees:retryPending', async (_ctx, id: string) => {
    return worktreesFSM.retryPending(id)
  })
  transport.onRequest('worktrees:dismissPending', (_ctx, id: string) => {
    worktreesFSM.dismissPending(id)
    return true
  })
  transport.onRequest('worktrees:refreshList', async (_ctx) => {
    await worktreesFSM.refreshList()
    return true
  })

  transport.onRequest(
    'worktree:continue',
    async (_ctx, repoRoot: string, worktreePath: string, newBranchName: string, baseBranch?: string) => {
      if (!repoRoot) throw new Error('No repo root provided')
      const mode = config.worktreeBase || DEFAULT_WORKTREE_BASE
      return continueWorktree(repoRoot, worktreePath, newBranchName, {
        baseBranch,
        fetchRemote: !baseBranch && mode === 'remote'
      })
    }
  )

  transport.onRequest('worktree:isDirty', async (_ctx, path: string, opts?: { bulk?: boolean }) => {
    const git = await isWorktreeDirty(path, opts?.bulk ? 'bulk' : 'interactive')
    const scratchpad = hasScratchpadNote(store.getSnapshot().state.scratchpad, path)
    return { git, scratchpad }
  })

  transport.onRequest('worktree:remove', async (_ctx, 
    repoRoot: string,
    path: string,
    force?: boolean,
    removeMeta?: { prNumber?: number; prState?: PRState }
  ) => {
    if (!repoRoot) throw new Error('No repo root provided')
    // Drop any locally-merged flag for the branch at this path. We still
    // need the worktree record for its branch name *before* kicking off
    // the async deletion.
    const trees = await listWorktrees(repoRoot)
    const wt = trees.find((t) => t.path === path)
    if (wt && config.locallyMerged && wt.branch && config.locallyMerged[wt.branch]) {
      delete config.locallyMerged[wt.branch]
      saveConfig(config)
    }
    // Drop any per-worktree editor override so a future worktree reusing this
    // path doesn't silently inherit it.
    if (config.worktreeEditors?.[path]) setEditorOverride('worktree', path, null)
    // Capture final stats *before* the working tree is gone.
    const diffStats = await getBranchDiffStats(path)
    if (wt) touchActivityMeta(path, { branch: wt.branch, repoRoot })
    finalizeActivity(path, {
      diffStats,
      prNumber: removeMeta?.prNumber,
      prState: removeMeta?.prState
    })
    // Fire-and-forget: the WorktreeDeletionFSM runs the teardown script
    // and git worktree remove in the background, streaming progress
    // through the store. Returns immediately so the renderer can animate
    // the deletion card instead of freezing on the row.
    worktreeDeletionFSM.enqueue({
      repoRoot,
      path,
      branch: wt?.branch || '',
      force
    })
    return { queued: true }
  })

  transport.onRequest('worktree:dismissPendingDeletion', (_ctx, path: string) => {
    worktreeDeletionFSM.dismiss(path)
    return true
  })

  transport.onRequest('worktrees:prune', async (_ctx, repoRoot: string) => {
    if (!repoRoot) throw new Error('No repo root provided')
    await pruneWorktrees(repoRoot)
    await worktreesFSM.refreshList()
    return true
  })

  transport.onRequest('worktree:dir', async (_ctx, repoRoot: string) => {
    if (!repoRoot) return ''
    return defaultWorktreeDir(repoRoot)
  })

  transport.onRequest('repo:list', (_ctx) => {
    return config.repoRoots
  })

  // Native repo:add (folder picker) and dialog:pickDirectory live in
  // desktop-shell.ts. The web client uses repo:addAtPath below combined
  // with the renderer-side RemoteFilePicker.
  transport.onRequest('repo:addAtPath', async (_ctx, picked: string): Promise<AddRepoResult> => {
    if (!picked || typeof picked !== 'string') {
      return { kind: 'not-a-repo', picked: picked || '' }
    }
    const resolution = await resolveRepoPath(picked)
    if (resolution.kind === 'ok') {
      const repoRoot = resolution.root
      if (registerRepoRoot(repoRoot, { config, store, worktreesFSM })) {
        void worktreesFSM.refreshList()
      }
      return { kind: 'added', repoRoot }
    }
    return resolution
  })

  transport.onRequest(
    'fs:listDir',
    (_ctx, dirPath: string, opts?: { showHidden?: boolean }) =>
      fsListDir(dirPath, opts ?? {})
  )
  transport.onRequest('fs:resolveHome', () => fsResolveHome())

  transport.onRequest(
    'repo:createNewProject',
    async (_ctx, opts: {
      parentDir: string
      name: string
      includeReadme: boolean
      gitignorePreset: GitignorePreset
    }) => {
      const result = await createNewProject(opts)
      if ('error' in result) return result
      const repoRoot = result.path
      if (registerRepoRoot(repoRoot, { config, store, worktreesFSM })) {
        void worktreesFSM.refreshList()
      }
      return { path: repoRoot }
    }
  )

  transport.onRequest('repo:remove', (_ctx, repoRoot: string) => {
    const idx = config.repoRoots.indexOf(repoRoot)
    if (idx === -1) return false
    config.repoRoots.splice(idx, 1)
    // Also drop any persisted panes for the removed repo so they don't
    // linger as orphans.
    if (config.panes && config.panes[repoRoot]) {
      delete config.panes[repoRoot]
    }
    saveConfig(config)
    // Same for any editor override — otherwise Settings keeps listing the
    // removed repo under "Overridden in …" with no way to clear it.
    if (config.repoEditors?.[repoRoot]) setEditorOverride('repo', repoRoot, null)
    worktreesFSM.dispatchRepos([...config.repoRoots])
    store.dispatch({ type: 'repoConfigs/removed', payload: repoRoot })
    void worktreesFSM.refreshList()
    return true
  })

  // Changed files
  transport.onRequest('worktree:changedFiles', async (_ctx, worktreePath: string, mode?: 'working' | 'branch') => {
    return getChangedFiles(worktreePath, mode ?? 'working')
  })

  transport.onSignal('worktree:watchChangedFiles', (ctx, worktreePath: string) => {
    if (!worktreePath) return
    let subs = worktreeWatchSubs.get(ctx.clientId)
    if (!subs) {
      subs = new Map()
      worktreeWatchSubs.set(ctx.clientId, subs)
    }
    if (subs.has(worktreePath)) return
    const off = worktreeWatcher.subscribe(worktreePath, () => {
      transport.sendSignal('worktree:changedFilesInvalidated', worktreePath)
    })
    subs.set(worktreePath, off)
  })

  transport.onSignal('worktree:unwatchChangedFiles', (ctx, worktreePath: string) => {
    const subs = worktreeWatchSubs.get(ctx.clientId)
    const off = subs?.get(worktreePath)
    if (!off) return
    off()
    subs!.delete(worktreePath)
    if (subs!.size === 0) worktreeWatchSubs.delete(ctx.clientId)
  })

  // Per-file content watcher — fires 'file:contentChanged' on the
  // (worktreePath, relativePath) tuple when the absolute file changes on
  // disk. Used by FileView and working-tree ReviewDiffPane to refresh
  // when an agent (or any external tool) edits the same file.
  transport.onSignal(
    'file:watchSubscribe',
    (ctx, worktreePath: string, relativePath: string) => {
      if (!worktreePath || !relativePath) return
      const key = `${worktreePath}\x00${relativePath}`
      let subs = fileContentWatchSubs.get(ctx.clientId)
      if (!subs) {
        subs = new Map()
        fileContentWatchSubs.set(ctx.clientId, subs)
      }
      if (subs.has(key)) return
      const absolutePath = join(worktreePath, relativePath)
      const off = fileContentWatcher.subscribe(absolutePath, () => {
        transport.sendSignal('file:contentChanged', worktreePath, relativePath)
      })
      subs.set(key, off)
    }
  )

  transport.onSignal(
    'file:watchUnsubscribe',
    (ctx, worktreePath: string, relativePath: string) => {
      if (!worktreePath || !relativePath) return
      const key = `${worktreePath}\x00${relativePath}`
      const subs = fileContentWatchSubs.get(ctx.clientId)
      const off = subs?.get(key)
      if (!off) return
      off()
      subs!.delete(key)
      if (subs!.size === 0) fileContentWatchSubs.delete(ctx.clientId)
    }
  )

  transport.onRequest(
    'worktree:fileDiff',
    async (_ctx, 
      worktreePath: string,
      filePath: string,
      staged: boolean,
      mode?: 'working' | 'branch'
    ) => {
      return getFileDiff(worktreePath, filePath, staged, mode ?? 'working')
    }
  )

  transport.onRequest('worktree:listFiles', async (_ctx, worktreePath: string) => {
    return listAllFiles(worktreePath)
  })

  transport.onRequest('worktree:recentCommitShas', async (_ctx, worktreePath: string) => {
    return listRecentCommitShas(worktreePath)
  })

  transport.onRequest('worktree:readFile', async (_ctx, worktreePath: string, filePath: string) => {
    return readWorktreeFile(worktreePath, filePath)
  })

  transport.onRequest(
    'worktree:readFileBinary',
    async (_ctx, worktreePath: string, filePath: string) => {
      return readWorktreeFileBinary(worktreePath, filePath)
    }
  )

  transport.onRequest(
    'worktree:writeFile',
    async (_ctx, worktreePath: string, filePath: string, contents: string) => {
      return writeWorktreeFile(worktreePath, filePath, contents)
    }
  )

  transport.onRequest(
    'worktree:fileDiffSides',
    async (_ctx, 
      worktreePath: string,
      filePath: string,
      staged: boolean,
      mode?: 'working' | 'branch'
    ) => {
      return getFileDiffSides(worktreePath, filePath, staged, mode ?? 'working')
    }
  )

  transport.onRequest('worktree:branchCommits', async (_ctx, worktreePath: string) => {
    return getBranchCommits(worktreePath)
  })

  transport.onRequest('tools:list', async (_ctx, worktreePath: string) => {
    return discoverTools(worktreePath)
  })

  transport.onRequest('tools:run', async (_ctx, worktreePath: string, toolId: string) => {
    const wt = store.getSnapshot().state.worktrees.list.find((w) => w.path === worktreePath)
    return runTool(worktreePath, toolId, {
      branch: wt?.branch ?? '',
      repoRoot: wt?.repoRoot ?? worktreePath
    })
  })

  transport.onRequest('worktree:commitDiff', async (_ctx, worktreePath: string, hash: string) => {
    return getCommitDiff(worktreePath, hash)
  })

  transport.onRequest('worktree:commitMeta', async (_ctx, worktreePath: string, hash: string) => {
    return getCommitMeta(worktreePath, hash)
  })

  transport.onRequest('worktree:commitChangedFiles', async (_ctx, worktreePath: string, hash: string) => {
    return getCommitChangedFiles(worktreePath, hash)
  })

  transport.onRequest(
    'worktree:commitFileDiffSides',
    async (_ctx, worktreePath: string, hash: string, filePath: string) => {
      return getCommitFileDiffSides(worktreePath, hash, filePath)
    }
  )

  transport.onRequest(
    'worktree:commitRangeChangedFiles',
    async (_ctx, worktreePath: string, fromHash: string, toHash: string) => {
      return getCommitRangeChangedFiles(worktreePath, fromHash, toHash)
    }
  )

  transport.onRequest(
    'worktree:commitRangeFileDiffSides',
    async (_ctx, worktreePath: string, fromHash: string, toHash: string, filePath: string) => {
      return getCommitRangeFileDiffSides(worktreePath, fromHash, toHash, filePath)
    }
  )

  // PR status lives in the main-process store, polled by PRPoller. Renderers
  // subscribe via the state event stream; these methods trigger on-demand
  // refreshes (new worktree created, window focus, worktree activate,
  // terminal entered 'waiting' state).
  transport.onRequest('prs:refreshAll', async (_ctx) => {
    await prPoller.refreshAll()
    return true
  })
  transport.onRequest('prs:refreshAllIfStale', (_ctx) => {
    prPoller.refreshAllIfStale()
    return true
  })
  transport.onRequest('prs:refreshOne', async (_ctx, worktreePath: string) => {
    await prPoller.refreshOne(worktreePath)
    return true
  })
  transport.onRequest('prs:refreshOneIfStale', (_ctx, worktreePath: string) => {
    prPoller.refreshOneIfStale(worktreePath)
    return true
  })
  transport.onRequest('prs:refreshAssigned', async (_ctx) => {
    await prPoller.refreshAssignedPRs()
    return true
  })

  // Manual counterpart to the CI-failure notifier: the user asks the agent
  // to go resolve this PR's conflicts. Never fires on its own — see
  // buildMergeConflictMessage.
  transport.onRequest(
    'prs:requestConflictFix',
    (_ctx, worktreePath: string): { ok: boolean; error?: string } => {
      if (typeof worktreePath !== 'string' || !worktreePath) {
        return { ok: false, error: 'No worktree' }
      }
      const state = store.getSnapshot().state
      const pr = state.prs.byPath[worktreePath]
      if (!pr) return { ok: false, error: 'No PR for this branch' }
      const result = deliverToWorktreeChat(
        state,
        chatDeliveryDeps,
        worktreePath,
        buildMergeConflictMessage(pr)
      )
      if (!result.ok) {
        return {
          ok: false,
          error:
            result.reason === 'no-chat-tab'
              ? 'No agent chat tab in this worktree'
              : "Couldn't wake the agent chat tab"
        }
      }
      log(
        'merge-conflict',
        `asked ${result.sessionId} to fix conflicts on ${worktreePath}${result.woke ? ' (woke tab)' : ''}`
      )
      return { ok: true }
    }
  )

  transport.onRequest('announcements:refresh', async (_ctx) => {
    await announcementsPoller.refresh()
    return true
  })
  transport.onRequest('announcements:dismiss', (_ctx, id: string) => {
    if (typeof id !== 'string' || !id) return false
    const existing = config.dismissedAnnouncementIds || []
    if (!existing.includes(id)) {
      config.dismissedAnnouncementIds = [...existing, id]
      saveConfig(config)
    }
    store.dispatch({ type: 'settings/announcementDismissed', payload: id })
    return true
  })
  transport.onRequest('announcements:mute', (_ctx, muted: boolean) => {
    if (muted) {
      config.announcementsMuted = true
    } else {
      delete config.announcementsMuted
    }
    saveConfig(config)
    store.dispatch({ type: 'settings/announcementsMutedChanged', payload: muted === true })
    return true
  })

  // Used by the "Open PR" tab in New Worktree to populate the picker.
  // Returns null on auth/network failure so the UI can show a graceful
  // error state.
  transport.onRequest('prs:listOpen', async (_ctx, repoRoot: string) => {
    if (!repoRoot) return null
    return listOpenPRs(repoRoot)
  })

  // Used by the "Open PR" tab in New Worktree to resolve a typed PR number
  // on demand (works even for PRs not in the fetched list). Resolves against
  // the upstream repo like prs:listOpen.
  transport.onRequest(
    'prs:getByNumber',
    async (_ctx, repoRoot: string, prNumber: number): Promise<PRLookupResult> => {
      if (!repoRoot || !Number.isInteger(prNumber) || prNumber <= 0) {
        return { ok: false, reason: 'error', message: 'Invalid PR number' }
      }
      return getPRByNumber(repoRoot, prNumber)
    }
  )

  transport.onRequest(
    'pr:merge',
    async (_ctx, worktreePath: string, method: GitHubMergeMethod): Promise<MergePRResult> => {
      const token = getCachedToken()
      if (!token) {
        return {
          ok: false,
          error: 'Connect a GitHub token in Settings before merging',
          errorCode: 'unauthorized'
        }
      }
      const repoInfo = await getRepoInfo(worktreePath)
      if (!repoInfo) {
        return {
          ok: false,
          error: 'Could not resolve GitHub owner/repo from worktree origin',
          errorCode: 'unknown'
        }
      }
      const cached = store.getSnapshot().state.prs.byPath[worktreePath]
      let prNumber = cached?.number
      if (typeof prNumber !== 'number') {
        // Force a refresh through the poller so the slice is populated
        // for the next click; the merge will use the freshly cached
        // number then. UX-wise this just makes the first click after a
        // long-stale state require a second click — acceptable.
        await prPoller.refreshOne(worktreePath)
        prNumber = store.getSnapshot().state.prs.byPath[worktreePath]?.number
      }
      if (typeof prNumber !== 'number') {
        return {
          ok: false,
          error: 'No pull request found for this worktree',
          errorCode: 'unknown'
        }
      }
      const result = await mergePR(token, repoInfo.owner, repoInfo.repo, prNumber, method)
      if (result.ok) {
        void prPoller.refreshOne(worktreePath)
      }
      return result
    }
  )

  transport.onRequest(
    'pr:approve',
    async (_ctx, worktreePath: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      const cached = store.getSnapshot().state.prs.byPath[worktreePath]
      let prNumber = cached?.number
      if (typeof prNumber !== 'number') {
        await prPoller.refreshOne(worktreePath)
        prNumber = store.getSnapshot().state.prs.byPath[worktreePath]?.number
      }
      if (typeof prNumber !== 'number') {
        return { ok: false, error: 'No pull request found for this worktree' }
      }
      const result = await approvePR(worktreePath, prNumber)
      if (result.ok) {
        void prPoller.refreshOne(worktreePath)
      }
      return result
    }
  )

  transport.onRequest('stats:getWeekly', async (_ctx) => {
    const snap = store.getSnapshot().state
    return getWeeklyStats(snap.prs, snap.worktrees)
  })

  transport.onRequest('worktree:mainStatus', async (_ctx, repoRoot: string) => {
    if (!repoRoot) throw new Error('No repo root provided')
    return getMainWorktreeStatus(repoRoot)
  })

  transport.onRequest('worktree:previewMerge', async (_ctx, repoRoot: string, sourceBranch: string, worktreePath?: string) => {
    if (!repoRoot) throw new Error('No repo root provided')
    let branch = sourceBranch
    if (worktreePath) {
      const resolved = await getCurrentBranch(worktreePath)
      if (resolved) branch = resolved
    }
    const status = await getMainWorktreeStatus(repoRoot)
    return previewMergeConflicts(repoRoot, branch, status.baseBranch)
  })

  transport.onRequest('worktree:prepareMain', async (_ctx, repoRoot: string) => {
    if (!repoRoot) throw new Error('No repo root provided')
    return prepareMainForMerge(repoRoot)
  })

  transport.onRequest(
    'worktree:mergeLocal',
    async (_ctx, repoRoot: string, sourceBranch: string, strategy: MergeStrategy, worktreePath?: string) => {
      if (!repoRoot) throw new Error('No repo root provided')
      let branch = sourceBranch
      if (worktreePath) {
        const resolved = await getCurrentBranch(worktreePath)
        if (resolved) branch = resolved
      }
      const result = await mergeWorktreeLocally(repoRoot, branch, strategy)
      const sha = await getBranchSha(repoRoot, branch)
      if (sha) {
        if (!config.locallyMerged) config.locallyMerged = {}
        config.locallyMerged[branch] = sha
        saveConfig(config)
      }
      void prPoller.refreshAll()
      return result
    }
  )

  // Legacy worktree:mergedStatus handler is gone — the computation is now
  // inlined in PRPoller.refreshAll, which runs across all roots in one pass
  // and dispatches prs/mergedChanged.

  // Config — the renderer reads via useSettings() etc.; only mutation
  // handlers and a few constant-accessors live on the IPC.
  transport.onRequest('config:setHotkeys', (_ctx, hotkeys: Record<string, string>) => {
    config.hotkeys = hotkeys
    saveConfig(config)
    store.dispatch({ type: 'settings/hotkeysChanged', payload: hotkeys })
    return true
  })

  transport.onRequest('config:resetHotkeys', (_ctx) => {
    delete config.hotkeys
    saveConfig(config)
    store.dispatch({ type: 'settings/hotkeysChanged', payload: null })
    return true
  })

  transport.onRequest('config:setClaudeCommand', (_ctx, command: string) => {
    const trimmed = command.trim()
    if (!trimmed || trimmed === DEFAULT_CLAUDE_COMMAND) {
      delete config.claudeCommand
    } else {
      config.claudeCommand = trimmed
    }
    saveConfig(config)
    store.dispatch({
      type: 'settings/claudeCommandChanged',
      payload: config.claudeCommand || DEFAULT_CLAUDE_COMMAND
    })
    return true
  })

  transport.onRequest('config:getDefaultClaudeCommand', (_ctx) => {
    return DEFAULT_CLAUDE_COMMAND
  })

  transport.onRequest('config:setDefaultAgent', (_ctx, agent: string) => {
    const kind: AgentKind =
      agent === 'codex' ? 'codex' : agent === 'cursor' ? 'cursor' : 'claude'
    config.defaultAgent = kind
    saveConfig(config)
    store.dispatch({ type: 'settings/defaultAgentChanged', payload: kind })
    return true
  })

  transport.onRequest('config:setCodexCommand', (_ctx, command: string) => {
    const trimmed = command.trim()
    if (!trimmed || trimmed === 'codex') {
      delete config.codexCommand
    } else {
      config.codexCommand = trimmed
    }
    saveConfig(config)
    store.dispatch({
      type: 'settings/codexCommandChanged',
      payload: config.codexCommand || 'codex'
    })
    return true
  })

  transport.onRequest('config:setCursorCommand', (_ctx, command: string) => {
    const trimmed = command.trim()
    if (!trimmed || trimmed === 'agent') {
      delete config.cursorCommand
    } else {
      config.cursorCommand = trimmed
    }
    saveConfig(config)
    store.dispatch({
      type: 'settings/cursorCommandChanged',
      payload: config.cursorCommand || 'agent'
    })
    return true
  })

  transport.onRequest('config:setClaudeModel', (_ctx, model: string | null) => {
    if (model) {
      config.claudeModel = model
    } else {
      delete config.claudeModel
    }
    saveConfig(config)
    store.dispatch({ type: 'settings/claudeModelChanged', payload: model })
    return true
  })

  transport.onRequest('config:setCodexModel', (_ctx, model: string | null) => {
    if (model) {
      config.codexModel = model
    } else {
      delete config.codexModel
    }
    saveConfig(config)
    store.dispatch({ type: 'settings/codexModelChanged', payload: model })
    return true
  })

  transport.onRequest('config:setCursorModel', (_ctx, model: string | null) => {
    if (model) {
      config.cursorModel = model
    } else {
      delete config.cursorModel
    }
    saveConfig(config)
    store.dispatch({ type: 'settings/cursorModelChanged', payload: model })
    return true
  })

  transport.onRequest('config:setCodexEnvVars', (_ctx, vars: Record<string, string>) => {
    if (!vars || Object.keys(vars).length === 0) {
      delete config.codexEnvVars
    } else {
      config.codexEnvVars = vars
    }
    saveConfig(config)
    store.dispatch({ type: 'settings/codexEnvVarsChanged', payload: config.codexEnvVars || {} })
    return true
  })

  transport.onRequest('config:setCursorEnvVars', (_ctx, vars: Record<string, string>) => {
    if (!vars || Object.keys(vars).length === 0) {
      delete config.cursorEnvVars
    } else {
      config.cursorEnvVars = vars
    }
    saveConfig(config)
    store.dispatch({ type: 'settings/cursorEnvVarsChanged', payload: config.cursorEnvVars || {} })
    return true
  })

  transport.onRequest('repoConfig:migrateFilename', (_ctx, repoRoot: string) => {
    if (!repoRoot) return false
    if (!migrateRepoConfigFilename(repoRoot)) return false
    store.dispatch({
      type: 'repoConfigs/changed',
      payload: {
        repoRoot,
        config: loadRepoConfig(repoRoot),
        filename: repoConfigFilename(repoRoot)
      }
    })
    return true
  })

  transport.onRequest('repoConfig:set', (_ctx, repoRoot: string, next: Record<string, unknown>) => {
    if (!repoRoot) return null
    const current = loadRepoConfig(repoRoot)
    const merged: RepoConfig = { ...current }
    for (const [k, v] of Object.entries(next || {})) {
      if (v === null || v === undefined) {
        delete (merged as Record<string, unknown>)[k]
      } else {
        ;(merged as Record<string, unknown>)[k] = v
      }
    }
    const saved = saveRepoConfig(repoRoot, merged)
    store.dispatch({
      type: 'repoConfigs/changed',
      payload: { repoRoot, config: saved, filename: repoConfigFilename(repoRoot) }
    })
    return saved
  })

  transport.onRequest(
    'config:setWorktreeScripts',
    (_ctx, scripts: { setup?: string; teardown?: string }) => {
      const setup = (scripts?.setup || '').trim()
      const teardown = (scripts?.teardown || '').trim()
      if (setup) config.worktreeSetupCommand = setup
      else delete config.worktreeSetupCommand
      if (teardown) config.worktreeTeardownCommand = teardown
      else delete config.worktreeTeardownCommand
      saveConfig(config)
      store.dispatch({
        type: 'settings/worktreeScriptsChanged',
        payload: { setup, teardown }
      })
      return true
    }
  )

  transport.onRequest('config:setClaudeEnvVars', (_ctx, vars: Record<string, string>) => {
    const cleaned: Record<string, string> = {}
    if (vars && typeof vars === 'object') {
      for (const [rawKey, rawVal] of Object.entries(vars)) {
        const key = String(rawKey).trim()
        if (!key) continue
        // POSIX-ish name check — letters, digits, underscore, not starting with a digit.
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
        cleaned[key] = rawVal == null ? '' : String(rawVal)
      }
    }
    if (Object.keys(cleaned).length === 0) {
      delete config.claudeEnvVars
    } else {
      config.claudeEnvVars = cleaned
    }
    saveConfig(config)
    store.dispatch({ type: 'settings/claudeEnvVarsChanged', payload: cleaned })
    return true
  })

  transport.onRequest('config:setNewWorktreeAdvancedOpen', (_ctx, open: boolean) => {
    if (open) {
      config.newWorktreeAdvancedOpen = true
    } else {
      delete config.newWorktreeAdvancedOpen
    }
    saveConfig(config)
    store.dispatch({
      type: 'settings/newWorktreeAdvancedOpenChanged',
      payload: config.newWorktreeAdvancedOpen === true
    })
    return true
  })

  transport.onRequest('config:setStarterTasksDismissed', (_ctx, dismissed: boolean) => {
    if (dismissed) {
      config.starterTasksDismissed = true
    } else {
      delete config.starterTasksDismissed
    }
    saveConfig(config)
    store.dispatch({
      type: 'settings/starterTasksDismissedChanged',
      payload: config.starterTasksDismissed === true
    })
    return true
  })

  transport.onRequest('config:setAutoUpdateEnabled', (_ctx, enabled: boolean) => {
    if (enabled) {
      delete config.autoUpdateEnabled
    } else {
      config.autoUpdateEnabled = false
    }
    saveConfig(config)
    store.dispatch({
      type: 'settings/autoUpdateEnabledChanged',
      payload: config.autoUpdateEnabled !== false
    })
    if (config.autoUpdateEnabled === false) {
      desktopHooks.stopAutoUpdateChecks()
    } else {
      desktopHooks.startAutoUpdateChecks()
    }
    return true
  })

  transport.onRequest('config:setWarnBeforeQuitting', (_ctx, enabled: boolean) => {
    setWarnBeforeQuitting(enabled)
    return true
  })

  transport.onRequest('config:setOpenPrInBrowserTab', (_ctx, enabled: boolean) => {
    if (enabled) {
      config.openPrInBrowserTab = true
    } else {
      delete config.openPrInBrowserTab
    }
    saveConfig(config)
    store.dispatch({ type: 'settings/openPrInBrowserTabChanged', payload: enabled })
    return true
  })

  transport.onRequest('config:setTerminalPlainClickOpensInApp', (_ctx, enabled: boolean) => {
    if (enabled) {
      config.terminalPlainClickOpensInApp = true
    } else {
      delete config.terminalPlainClickOpensInApp
    }
    saveConfig(config)
    store.dispatch({ type: 'settings/terminalPlainClickOpensInAppChanged', payload: enabled })
    return true
  })

  transport.onRequest('config:setExpandedDiagnosticLoggingEnabled', (_ctx, enabled: boolean) => {
    if (enabled) {
      config.expandedDiagnosticLoggingEnabled = true
    } else {
      delete config.expandedDiagnosticLoggingEnabled
    }
    saveConfig(config)
    setGitHubApiLoggingEnabled(enabled)
    store.dispatch({
      type: 'settings/expandedDiagnosticLoggingEnabledChanged',
      payload: enabled
    })
    return true
  })

  transport.onRequest('config:setShowAssignedPRs', (_ctx, enabled: boolean) => {
    if (enabled) {
      config.showAssignedPRs = true
    } else {
      delete config.showAssignedPRs
    }
    saveConfig(config)
    store.dispatch({
      type: 'settings/showAssignedPRsChanged',
      payload: enabled
    })
    if (enabled) {
      void prPoller.refreshAssignedPRs()
    } else {
      prPoller.clearAssignedPRs()
    }
    return true
  })

  transport.onRequest('config:setHarnessSystemPromptEnabled', (_ctx, enabled: boolean) => {
    if (enabled) {
      delete config.harnessSystemPromptEnabled
    } else {
      config.harnessSystemPromptEnabled = false
    }
    saveConfig(config)
    store.dispatch({
      type: 'settings/harnessSystemPromptEnabledChanged',
      payload: config.harnessSystemPromptEnabled !== false
    })
    return true
  })

  transport.onRequest('config:setHarnessSystemPrompt', (_ctx, prompt: string) => {
    const trimmed = prompt.trim()
    if (!trimmed || trimmed === DEFAULT_HARNESS_SYSTEM_PROMPT) {
      delete config.harnessSystemPrompt
    } else {
      config.harnessSystemPrompt = prompt
    }
    saveConfig(config)
    store.dispatch({
      type: 'settings/harnessSystemPromptChanged',
      payload: config.harnessSystemPrompt || DEFAULT_HARNESS_SYSTEM_PROMPT
    })
    return true
  })

  transport.onRequest('config:setHarnessSystemPromptMain', (_ctx, prompt: string) => {
    const trimmed = prompt.trim()
    if (!trimmed || trimmed === DEFAULT_HARNESS_SYSTEM_PROMPT_MAIN) {
      delete config.harnessSystemPromptMain
    } else {
      config.harnessSystemPromptMain = prompt
    }
    saveConfig(config)
    store.dispatch({
      type: 'settings/harnessSystemPromptMainChanged',
      payload: config.harnessSystemPromptMain || DEFAULT_HARNESS_SYSTEM_PROMPT_MAIN
    })
    return true
  })

  transport.onRequest('config:setPrReviewPrompt', (_ctx, prompt: string) => {
    const trimmed = prompt.trim()
    if (!trimmed || trimmed === DEFAULT_PR_REVIEW_PROMPT) {
      delete config.prReviewPrompt
    } else {
      config.prReviewPrompt = prompt
    }
    saveConfig(config)
    store.dispatch({
      type: 'settings/prReviewPromptChanged',
      payload: config.prReviewPrompt || DEFAULT_PR_REVIEW_PROMPT
    })
    return true
  })

  transport.onRequest('config:setHarnessMcpEnabled', (_ctx, enabled: boolean) => {
    if (enabled) {
      delete config.harnessMcpEnabled
    } else {
      config.harnessMcpEnabled = false
    }
    saveConfig(config)
    store.dispatch({
      type: 'settings/harnessMcpEnabledChanged',
      payload: config.harnessMcpEnabled !== false
    })
    return true
  })

  transport.onRequest('config:setAutoApprovePermissions', (_ctx, enabled: boolean) => {
    if (enabled) {
      config.autoApprovePermissions = true
    } else {
      delete config.autoApprovePermissions
    }
    saveConfig(config)
    store.dispatch({
      type: 'settings/autoApprovePermissionsChanged',
      payload: config.autoApprovePermissions === true
    })
    return true
  })

  transport.onRequest('config:setAutoApproveSteerInstructions', (_ctx, text: string) => {
    const trimmed = (text || '').trim()
    if (!trimmed) {
      delete config.autoApproveSteerInstructions
    } else {
      config.autoApproveSteerInstructions = text
    }
    saveConfig(config)
    store.dispatch({
      type: 'settings/autoApproveSteerInstructionsChanged',
      payload: config.autoApproveSteerInstructions || ''
    })
    return true
  })

  transport.onRequest(
    'permissions:grant',
    (_ctx, rule: PermissionRule, grantedFrom?: string): boolean => {
      if (!rule || typeof rule.toolName !== 'string' || !rule.toolName) return false
      grantPermissionRules(
        [
          {
            toolName: rule.toolName,
            ...(rule.ruleContent ? { ruleContent: rule.ruleContent } : {})
          }
        ],
        grantedFrom
      )
      return true
    }
  )

  transport.onRequest('permissions:revoke', (_ctx, id: string): boolean => {
    if (!id) return false
    store.dispatch({ type: 'permissions/revoked', payload: { id } })
    persistPermissionRules()
    return true
  })

  transport.onRequest('permissions:clear', (): boolean => {
    store.dispatch({ type: 'permissions/cleared' })
    persistPermissionRules()
    return true
  })

  transport.onRequest('mcp:prepareForTerminal', (_ctx, terminalId: string): string | null => {
    if (config.harnessMcpEnabled === false) return null
    if (!terminalId) return null
    return writeMcpConfigForTerminal(terminalId, resolveCallerScope(terminalId))
  })

  transport.onRequest('config:setWsTransportEnabled', (_ctx, enabled: boolean) => {
    if (enabled) {
      config.wsTransportEnabled = true
    } else {
      delete config.wsTransportEnabled
    }
    saveConfig(config)
    store.dispatch({ type: 'settings/wsTransportEnabledChanged', payload: enabled })
    // The WS server itself doesn't hot-toggle — the setting takes effect on
    // next app launch. Keeping the toggle state-only for v1 avoids having
    // to handle port conflicts, mid-session reconnects, etc.
    return true
  })

  transport.onRequest('config:setWsTransportPort', (_ctx, port: number) => {
    const clamped = Math.max(1024, Math.min(65535, Math.floor(port)))
    if (clamped === 37291) {
      delete config.wsTransportPort
    } else {
      config.wsTransportPort = clamped
    }
    saveConfig(config)
    store.dispatch({ type: 'settings/wsTransportPortChanged', payload: clamped })
    return clamped
  })

  transport.onRequest('config:setWsTransportHost', (_ctx, host: string) => {
    // Only two values are meaningful for v1: '127.0.0.1' (loopback) or
    // '0.0.0.0' (all interfaces, LAN-reachable). Anything else is treated
    // as loopback so a typo can't accidentally expose the server.
    const next = host === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1'
    if (next === '127.0.0.1') {
      delete config.wsTransportHost
    } else {
      config.wsTransportHost = next
    }
    saveConfig(config)
    store.dispatch({ type: 'settings/wsTransportHostChanged', payload: next })
    return next
  })

  transport.onRequest('config:getWsTransportInfo', (_ctx) => {
    // Exposes the live token + port for clients (or a future UI) that need
    // to know the connect URL. Returns null when the WS transport is not
    // running, to distinguish "off" from "on but unknown".
    if (!wsTransport) return null
    return {
      port: wsTransport.getPort(),
      token: wsTransport.getToken(),
      host: wsTransport.getHost()
    }
  })

  transport.onRequest('config:rotateWsToken', (_ctx) => {
    // Writes a fresh token to the encrypted secrets store. The running
    // HTTP + WS servers captured the old token in closures at boot, so
    // they keep accepting it until the app restarts; the UI surfaces a
    // "relaunch required" hint after a rotation.
    const next = rotateWsToken()
    log('ws-transport', 'auth token rotated — takes effect on next launch')
    return next
  })

  transport.onRequest('net:getLanAddresses', (_ctx) => getLanAddresses())

  transport.onRequest('config:setClaudeTuiFullscreen', (_ctx, enabled: boolean) => {
    if (enabled) {
      delete config.claudeTuiFullscreen
    } else {
      config.claudeTuiFullscreen = false
    }
    saveConfig(config)
    store.dispatch({
      type: 'settings/claudeTuiFullscreenChanged',
      payload: config.claudeTuiFullscreen !== false
    })
    return true
  })

  transport.onRequest('config:setBrowserToolsEnabled', (_ctx, enabled: boolean) => {
    if (enabled) {
      delete config.browserToolsEnabled
    } else {
      config.browserToolsEnabled = false
    }
    saveConfig(config)
    store.dispatch({
      type: 'settings/browserToolsEnabledChanged',
      payload: config.browserToolsEnabled !== false
    })
    return true
  })

  transport.onRequest('config:setConversationForkEnabled', (_ctx, enabled: boolean) => {
    if (enabled) {
      config.conversationForkEnabled = true
    } else {
      delete config.conversationForkEnabled
    }
    saveConfig(config)
    store.dispatch({
      type: 'settings/conversationForkEnabledChanged',
      payload: config.conversationForkEnabled === true
    })
    return true
  })

  transport.onRequest('config:setBrowserToolsMode', (_ctx, mode: 'view' | 'full') => {
    const next = mode === 'view' ? 'view' : 'full'
    if (next === 'full') {
      delete config.browserToolsMode
    } else {
      config.browserToolsMode = next
    }
    saveConfig(config)
    store.dispatch({
      type: 'settings/browserToolsModeChanged',
      payload: next
    })
    return true
  })

  transport.onRequest('config:setWorktreeMessagingEnabled', (_ctx, enabled: boolean) => {
    if (enabled) {
      config.worktreeMessagingEnabled = true
    } else {
      delete config.worktreeMessagingEnabled
    }
    saveConfig(config)
    store.dispatch({
      type: 'settings/worktreeMessagingEnabledChanged',
      payload: config.worktreeMessagingEnabled === true
    })
    return true
  })

  transport.onRequest('config:setNameClaudeSessions', (_ctx, enabled: boolean) => {
    if (enabled) {
      config.nameClaudeSessions = true
    } else {
      delete config.nameClaudeSessions
    }
    saveConfig(config)
    store.dispatch({
      type: 'settings/nameClaudeSessionsChanged',
      payload: !!config.nameClaudeSessions
    })
    return true
  })
  transport.onRequest('config:setThemeMode', (_ctx, mode: string) => {
    if (mode !== 'light' && mode !== 'dark' && mode !== 'system') return false
    if (mode === 'system') {
      delete config.themeMode
    } else {
      config.themeMode = mode
    }
    saveConfig(config)
    store.dispatch({ type: 'settings/themeModeChanged', payload: mode })
    return true
  })

  // Accept built-in IDs (validated against AVAILABLE_THEMES) and any
  // currently-loaded custom theme id of the matching mode. Custom IDs
  // are filename-derived and not statically known, so the live slice is
  // the source of truth.
  const isKnownLightTheme = (id: string): boolean => {
    if (AVAILABLE_THEMES.includes(id as (typeof AVAILABLE_THEMES)[number])) return true
    return store.getSnapshot().state.settings.customThemes.some(
      (t) => t.id === id && t.mode === 'light'
    )
  }
  const isKnownDarkTheme = (id: string): boolean => {
    if (AVAILABLE_THEMES.includes(id as (typeof AVAILABLE_THEMES)[number])) return true
    return store.getSnapshot().state.settings.customThemes.some(
      (t) => t.id === id && t.mode === 'dark'
    )
  }

  transport.onRequest('config:setThemeLight', (_ctx, theme: string) => {
    if (typeof theme !== 'string' || !isKnownLightTheme(theme)) {
      return false
    }
    if (theme === DEFAULT_LIGHT_THEME) {
      delete config.themeLight
    } else {
      config.themeLight = theme
    }
    saveConfig(config)
    store.dispatch({ type: 'settings/themeLightChanged', payload: theme })
    return true
  })

  transport.onRequest('config:setThemeDark', (_ctx, theme: string) => {
    if (typeof theme !== 'string' || !isKnownDarkTheme(theme)) {
      return false
    }
    if (theme === DEFAULT_DARK_THEME) {
      delete config.themeDark
    } else {
      config.themeDark = theme
    }
    saveConfig(config)
    store.dispatch({ type: 'settings/themeDarkChanged', payload: theme })
    return true
  })

  // Fire-and-forget: the renderer reports the hex it just applied so we can
  // use it as the BrowserWindow backgroundColor on the next launch. No
  // dispatch — this never needs to be reflected in slice state.
  transport.onSignal('config:setLastEffectiveAppBg', (_ctx, hex: unknown) => {
    if (typeof hex !== 'string' || !hex) return
    if (hex === config.lastEffectiveAppBg) return
    config.lastEffectiveAppBg = hex
    saveConfig(config)
  })

  transport.onRequest('config:reloadCustomThemes', (_ctx) => {
    const themes = loadCustomThemes()
    store.dispatch({ type: 'settings/customThemesChanged', payload: themes })
    return themes.length
  })

  // `config:openThemesFolder` lives in desktop-shell.ts so it only spawns
  // a window-manager file-browser on the local Electron host. Headless
  // backends don't register it; the renderer falls back to displaying
  // the path string.

  transport.onRequest('config:setTerminalFontFamily', (_ctx, fontFamily: string) => {
    const trimmed = (fontFamily || '').trim()
    if (!trimmed || trimmed === DEFAULT_TERMINAL_FONT_FAMILY) {
      delete config.terminalFontFamily
    } else {
      config.terminalFontFamily = trimmed
    }
    saveConfig(config)
    store.dispatch({
      type: 'settings/terminalFontFamilyChanged',
      payload: config.terminalFontFamily || DEFAULT_TERMINAL_FONT_FAMILY
    })
    return true
  })

  transport.onRequest('config:getDefaultTerminalFontFamily', (_ctx) => DEFAULT_TERMINAL_FONT_FAMILY)

  transport.onRequest('config:setTerminalFontSize', (_ctx, fontSize: number) => {
    const n = Number(fontSize)
    if (!Number.isFinite(n) || n < 8 || n > 48) return false
    const rounded = Math.round(n)
    if (rounded === DEFAULT_TERMINAL_FONT_SIZE) {
      delete config.terminalFontSize
    } else {
      config.terminalFontSize = rounded
    }
    saveConfig(config)
    store.dispatch({
      type: 'settings/terminalFontSizeChanged',
      payload: config.terminalFontSize || DEFAULT_TERMINAL_FONT_SIZE
    })
    return true
  })

  // Set (or clear, with editorId === null) one per-repo / per-worktree editor
  // override. Both maps live in config.json — see the note on Config.repoEditors
  // for why these deliberately aren't in the repo's committed .ness.json.
  function setEditorOverride(
    scope: 'repo' | 'worktree',
    key: string,
    editorId: string | null
  ): boolean {
    if (editorId !== null && !AVAILABLE_EDITORS.some((e) => e.id === editorId)) return false
    const field = scope === 'repo' ? 'repoEditors' : 'worktreeEditors'
    const map = { ...(config[field] || {}) }
    if (editorId === null) delete map[key]
    else map[key] = editorId
    if (Object.keys(map).length === 0) delete config[field]
    else config[field] = map
    saveConfig(config)
    store.dispatch({
      type: scope === 'repo' ? 'settings/repoEditorChanged' : 'settings/worktreeEditorChanged',
      payload: { key, editorId }
    })
    return true
  }

  // Run the shared worktree → repo → global chain. The worktree's repoRoot
  // comes from the store rather than the caller so every existing
  // `openInEditor(worktreePath, …)` callsite picks up overrides unchanged.
  function resolveEditorForWorktree(worktreePath: string): string {
    const { state } = store.getSnapshot()
    const repoRoot = state.worktrees.list.find((w) => w.path === worktreePath)?.repoRoot
    return resolveEditorId({
      globalEditor: state.settings.editor,
      repoEditors: state.settings.repoEditors,
      worktreeEditors: state.settings.worktreeEditors,
      repoRoot,
      worktreePath
    })
  }

  transport.onRequest('config:setEditor', (_ctx, editorId: string) => {
    if (!AVAILABLE_EDITORS.some((e) => e.id === editorId)) return false
    if (editorId === DEFAULT_EDITOR_ID) {
      delete config.editor
    } else {
      config.editor = editorId
    }
    saveConfig(config)
    store.dispatch({ type: 'settings/editorChanged', payload: editorId })
    return true
  })

  transport.onRequest('config:setRepoEditor', (_ctx, repoRoot: string, editorId: string | null) =>
    setEditorOverride('repo', repoRoot, editorId)
  )

  transport.onRequest(
    'config:setWorktreeEditor',
    (_ctx, worktreePath: string, editorId: string | null) =>
      setEditorOverride('worktree', worktreePath, editorId)
  )

  transport.onRequest('config:getAvailableEditors', (_ctx) => {
    return AVAILABLE_EDITORS.map(({ id, name }) => ({ id, name }))
  })

  transport.onRequest('editor:open', (_ctx, worktreePath: string, filePath?: string) => {
    return openInEditor(resolveEditorForWorktree(worktreePath), worktreePath, filePath)
  })

  transport.onRequest('config:setWorktreeBase', (_ctx, mode: 'remote' | 'local') => {
    if (mode !== 'remote' && mode !== 'local') return false
    if (mode === DEFAULT_WORKTREE_BASE) {
      delete config.worktreeBase
    } else {
      config.worktreeBase = mode
    }
    saveConfig(config)
    store.dispatch({ type: 'settings/worktreeBaseChanged', payload: mode })
    return true
  })

  transport.onRequest(
    'config:setMergeStrategy',
    (_ctx, strategy: 'squash' | 'merge-commit' | 'fast-forward') => {
      if (
        strategy !== 'squash' &&
        strategy !== 'merge-commit' &&
        strategy !== 'fast-forward'
      ) {
        return false
      }
      config.mergeStrategy = strategy
      saveConfig(config)
      store.dispatch({ type: 'settings/mergeStrategyChanged', payload: strategy })
      return true
    }
  )

  transport.onRequest(
    'config:setSidebarDensity',
    (_ctx, density: 'compact' | 'comfy') => {
      if (density !== 'compact' && density !== 'comfy') return false
      if (density === DEFAULT_SIDEBAR_DENSITY) {
        delete config.sidebarDensity
      } else {
        config.sidebarDensity = density
      }
      saveConfig(config)
      store.dispatch({ type: 'settings/sidebarDensityChanged', payload: density })
      return true
    }
  )

  transport.onRequest(
    'config:setSidebarDetails',
    (_ctx, prefs: SidebarDetailPrefsByMode) => {
      if (!prefs || typeof prefs !== 'object') return false
      const normalizeMode = (
        mode: 'compact' | 'comfy',
        input: Partial<SidebarDetailPrefs> | undefined
      ): SidebarDetailPrefs => {
        const defaults = DEFAULT_SIDEBAR_DETAILS[mode]
        const src = input || {}
        const bool = (k: keyof SidebarDetailPrefs): boolean =>
          typeof src[k] === 'boolean' ? (src[k] as boolean) : defaults[k]
        return {
          repoLabel: bool('repoLabel'),
          branch: bool('branch'),
          age: bool('age'),
          diff: bool('diff'),
          milestone: bool('milestone'),
          prNumber: bool('prNumber'),
          assignee: bool('assignee')
        }
      }
      const next: SidebarDetailPrefsByMode = {
        compact: normalizeMode('compact', prefs.compact),
        comfy: normalizeMode('comfy', prefs.comfy)
      }
      const modeIsDefault = (mode: 'compact' | 'comfy'): boolean => {
        const cur = next[mode]
        const def = DEFAULT_SIDEBAR_DETAILS[mode]
        return (
          cur.repoLabel === def.repoLabel &&
          cur.branch === def.branch &&
          cur.age === def.age &&
          cur.diff === def.diff &&
          cur.milestone === def.milestone &&
          cur.prNumber === def.prNumber &&
          cur.assignee === def.assignee
        )
      }
      if (modeIsDefault('compact') && modeIsDefault('comfy')) {
        delete config.sidebarDetails
      } else {
        config.sidebarDetails = next
      }
      saveConfig(config)
      store.dispatch({ type: 'settings/sidebarDetailsChanged', payload: next })
      return true
    }
  )

  transport.onRequest(
    'config:setHiddenBottomIcons',
    (_ctx, hidden: HiddenBottomIcons) => {
      if (!hidden || typeof hidden !== 'object') return false
      const next: HiddenBottomIcons = {}
      for (const key of BOTTOM_ICON_KEYS) {
        if ((hidden as Record<BottomIconKey, unknown>)[key] === true) next[key] = true
      }
      if (Object.keys(next).length === 0) {
        delete config.hiddenBottomIcons
      } else {
        config.hiddenBottomIcons = next
      }
      saveConfig(config)
      store.dispatch({ type: 'settings/hiddenBottomIconsChanged', payload: next })
      return true
    }
  )

  transport.onRequest(
    'config:setBottomIconOrder',
    (_ctx, order: BottomIconKey[]) => {
      if (!Array.isArray(order)) return false
      const seen = new Set<BottomIconKey>()
      const clean: BottomIconKey[] = []
      for (const k of order) {
        if (
          typeof k === 'string' &&
          (BOTTOM_ICON_KEYS as readonly string[]).includes(k) &&
          !seen.has(k as BottomIconKey)
        ) {
          clean.push(k as BottomIconKey)
          seen.add(k as BottomIconKey)
        }
      }
      // Append any canonical keys the caller omitted so the stored order
      // never silently loses items.
      for (const k of BOTTOM_ICON_KEYS) {
        if (!seen.has(k)) clean.push(k)
      }
      const isCanonical =
        clean.length === BOTTOM_ICON_KEYS.length &&
        clean.every((k, i) => k === BOTTOM_ICON_KEYS[i])
      if (isCanonical) {
        delete config.bottomIconOrder
      } else {
        config.bottomIconOrder = clean
      }
      saveConfig(config)
      store.dispatch({ type: 'settings/bottomIconOrderChanged', payload: clean })
      return true
    }
  )

  transport.onRequest('config:getAvailableThemes', (_ctx) => {
    return AVAILABLE_THEMES
  })

  transport.onRequest('config:setOnboardingQuest', (_ctx, quest: string) => {
    const valid = ['hidden', 'spawn-second', 'switch-between', 'finale', 'done']
    if (!valid.includes(quest)) return false
    config.onboarding = { ...(config.onboarding || {}), quest: quest as QuestStep }
    saveConfig(config)
    store.dispatch({
      type: 'onboarding/questChanged',
      payload: quest as QuestStep
    })
    return true
  })

  // Pane / tab tree — fully main-owned via PanesFSM. Renderers call these
  // methods instead of computing pane state locally. ensureInitialized is
  // not exposed: main calls it directly from worktree creation paths.
  transport.onRequest(
    'panes:addTab',
    (_ctx, wtPath: string, tab: TerminalTab, paneId?: string) => {
      panesFSM.addTab(wtPath, tab, paneId)
      return true
    }
  )
  transport.onRequest('panes:closeTab', (_ctx, wtPath: string, tabId: string) => {
    panesFSM.closeTab(wtPath, tabId)
    return true
  })
  transport.onRequest(
    'panes:restartAgentTab',
    (_ctx, wtPath: string, tabId: string, newId: string) => {
      panesFSM.restartAgentTab(wtPath, tabId, newId)
      return true
    }
  )
  transport.onRequest(
    'panes:convertTabType',
    (_ctx, wtPath: string, tabId: string, newType: 'agent' | 'json-claude') => {
      const valid = newType === 'agent' || newType === 'json-claude'
      if (!valid) return false
      panesFSM.convertTabType(wtPath, tabId, newType)
      return true
    }
  )
  transport.onRequest(
    'panes:selectTab',
    (_ctx, wtPath: string, paneId: string, tabId: string) => {
      panesFSM.selectTab(wtPath, paneId, tabId)
      return true
    }
  )
  transport.onRequest(
    'panes:renameTab',
    (_ctx, wtPath: string, tabId: string, label: string) => {
      panesFSM.renameTab(wtPath, tabId, label)
      return true
    }
  )
  transport.onRequest(
    'panes:reorderTabs',
    (_ctx, wtPath: string, paneId: string, fromId: string, toId: string) => {
      panesFSM.reorderTabs(wtPath, paneId, fromId, toId)
      return true
    }
  )
  transport.onRequest(
    'panes:moveTabToPane',
    (_ctx, 
      wtPath: string,
      tabId: string,
      toPaneId: string,
      toIndex?: number
    ) => {
      panesFSM.moveTabToPane(wtPath, tabId, toPaneId, toIndex)
      return true
    }
  )
  transport.onRequest('panes:openReview', (_ctx, wtPath: string) => {
    panesFSM.openReviewTab(wtPath)
    return true
  })
  transport.onRequest(
    'panes:openFile',
    (_ctx, wtPath: string, filePath: string, nearTabId?: string) => {
      panesFSM.openFileTab(wtPath, filePath, nearTabId)
      return true
    }
  )
  transport.onRequest(
    'panes:setReviewSelection',
    (_ctx, wtPath: string, tabId: string, fromCommit?: string, toCommit?: string) => {
      panesFSM.setReviewSelection(wtPath, tabId, fromCommit, toCommit)
      return true
    }
  )
  transport.onRequest(
    'panes:splitPane',
    (_ctx, wtPath: string, fromPaneId: string, direction?: 'horizontal' | 'vertical') => {
      return panesFSM.splitPane(wtPath, fromPaneId, direction || 'horizontal')
    }
  )
  transport.onRequest(
    'panes:setRatio',
    (_ctx, wtPath: string, splitId: string, ratio: number) => {
      panesFSM.setRatio(wtPath, splitId, ratio)
      return true
    }
  )
  transport.onRequest('panes:clearForWorktree', (_ctx, wtPath: string) => {
    panesFSM.clearForWorktree(wtPath)
    return true
  })
  transport.onRequest('panes:sleepTab', (_ctx, wtPath: string, tabId: string) => {
    panesFSM.sleepJsonClaudeTab(wtPath, tabId)
    return true
  })
  transport.onRequest('panes:wakeTab', (_ctx, wtPath: string, tabId: string) => {
    // Route by tab type. json-claude needs its subprocess spawned;
    // shell only flips mode (XTerminal owns the PTY spawn). Dispatch by
    // type here rather than fanning out to both methods so any future
    // unconditional side-effect added to either wake path can't silently
    // fire on the wrong tab type.
    const type = panesFSM.getTabType(wtPath, tabId)
    if (type === 'json-claude') panesFSM.wakeJsonClaudeTab(wtPath, tabId)
    else if (type === 'shell') panesFSM.wakeShellTab(wtPath, tabId)
    return true
  })
  // Renderer-driven lastActive bump. The composer fires this while the
  // user is typing so the auto-sleep monitor can't re-sleep a tab mid-
  // composition — ActivityDeriver only bumps lastActive on status
  // transitions (and only after a 30s debounce), so typing into an
  // already-'waiting' tab leaves the timestamp stale otherwise.
  transport.onRequest('terminals:touchLastActive', (_ctx, wtPath: string) => {
    store.dispatch({
      type: 'terminals/lastActiveChanged',
      payload: { worktreePath: wtPath, ts: Date.now() }
    })
    return true
  })
  // Wake-on-activation. Renderer fires this whenever the user focuses a
  // worktree (sidebar click, hotkey, command palette). Boot-time sleep
  // skips merged worktrees, so this is the only path that wakes them.
  // No-op for paths that already have panes.
  transport.onRequest('panes:ensureInitialized', (_ctx, wtPath: string) => {
    if (!isMidCreation(wtPath)) panesFSM.ensureInitialized(wtPath)
    return true
  })

  // Activity log — per-worktree status transition history for the Activity view.
  // The activity-deriver in main now calls recordActivity directly when it
  // observes status changes; this IPC stays for any direct-from-renderer
  // pings that haven't been migrated yet.
  transport.onSignal('activity:record', (_ctx, worktreePath: string, state: ActivityState) => {
    recordActivity(worktreePath, state)
  })

  transport.onRequest('activity:get', (_ctx) => {
    return getActivityLog()
  })

  transport.onRequest('activity:clear', (_ctx, worktreePath?: string) => {
    if (worktreePath) clearActivityForWorktree(worktreePath)
    else clearAllActivity()
    return true
  })

  // Terminal scrollback — owned entirely by main. PtyManager tees the PTY
  // onData stream into a per-id ring buffer, persists it on a 30s cadence and
  // on before-quit, and hands it back here on request. Renderer replays it
  // into a fresh xterm instance before wiring up live data.
  transport.onRequest('terminal:getHistory', (_ctx, id: string) => {
    return ptyManager.getHistory(id)
  })

  transport.onRequest('terminal:forgetHistory', (_ctx, id: string) => {
    ptyManager.forgetHistory(id)
    return true
  })

  transport.onRequest('agent:sessionFileExists', (_ctx, cwd: string, sessionId: string, agentKind?: string): boolean => {
    const kind = toAgentKind(agentKind)
    return getAgent(kind).sessionFileExists(cwd, sessionId)
  })

  transport.onRequest('agent:latestSessionId', (_ctx, cwd: string, agentKind?: string): string | null => {
    const kind = toAgentKind(agentKind)
    return getAgent(kind).latestSessionId(cwd)
  })

  transport.onRequest(
    'agent:buildSpawnArgs',
    (_ctx, agentKind: string, opts: {
      terminalId: string; cwd: string; sessionId?: string;
      initialPrompt?: string; teleportSessionId?: string;
      sessionName?: string;
      modelOverride?: string
    }): string => {
      const kind = toAgentKind(agentKind)
      const agent = getAgent(kind)
      const command =
        kind === 'claude'
          ? (config.claudeCommand || agent.defaultCommand)
          : kind === 'codex'
            ? (config.codexCommand || agent.defaultCommand)
            : (config.cursorCommand || agent.defaultCommand)
      const mcpConfigPath = writeMcpConfigForTerminal(
        opts.terminalId,
        resolveCallerScope(opts.terminalId)
      )

      const override = opts.modelOverride && opts.modelOverride.trim() ? opts.modelOverride.trim() : undefined
      let systemPrompt: string | undefined
      let tuiFullscreen: boolean | undefined
      let model: string | null
      if (kind === 'claude') {
        const launch = buildClaudeLaunchSettings({
          cwd: opts.cwd,
          worktrees: store.getSnapshot().state.worktrees.list,
          config,
          modelOverride: override
        })
        systemPrompt = launch.systemPrompt
        tuiFullscreen = launch.tuiFullscreen
        model = launch.model ?? null
      } else if (kind === 'codex') {
        model = override || config.codexModel || null
      } else {
        model = override || config.cursorModel || null
      }

      return agent.buildSpawnArgs({ ...opts, command, mcpConfigPath, model, systemPrompt, tuiFullscreen })
    }
  )

  // Settings: GitHub token
  transport.onRequest('settings:hasGithubToken', (_ctx) => {
    return store.getSnapshot().state.settings.hasGithubToken
  })

  transport.onRequest('settings:setGithubToken', async (_ctx, token: string) => {
    const trimmed = token.trim()
    if (!trimmed) {
      deleteSecret('githubToken')
      store.dispatch({ type: 'settings/hasGithubTokenChanged', payload: false })
      invalidateTokenCache()
      await resolveGitHubToken()
      store.dispatch({ type: 'settings/githubAuthSourceChanged', payload: getTokenSource() })
      await refreshHarnessStarState()
      return { ok: true }
    }
    // Validate the token first by hitting /user
    const test = await testToken(trimmed)
    if (!test.ok) return { ok: false, error: test.error }
    setSecret('githubToken', trimmed)
    store.dispatch({ type: 'settings/hasGithubTokenChanged', payload: true })
    invalidateTokenCache()
    await resolveGitHubToken()
    store.dispatch({ type: 'settings/githubAuthSourceChanged', payload: getTokenSource() })
    void refreshViewerLogin()
    await refreshHarnessStarState()
    return { ok: true, username: test.username }
  })

  transport.onRequest('settings:clearGithubToken', async (_ctx) => {
    deleteSecret('githubToken')
    store.dispatch({ type: 'settings/hasGithubTokenChanged', payload: false })
    invalidateTokenCache()
    await resolveGitHubToken()
    store.dispatch({ type: 'settings/githubAuthSourceChanged', payload: getTokenSource() })
    void refreshViewerLogin()
    await refreshHarnessStarState()
    return true
  })

  transport.onRequest('settings:setHarnessStarred', async (_ctx, starred: boolean) => {
    const token = getCachedToken()
    if (!token) return { ok: false, error: 'No GitHub token' }
    const result = starred
      ? await starRepo(token, HARNESS_REPO_OWNER, HARNESS_REPO_NAME)
      : await unstarRepo(token, HARNESS_REPO_OWNER, HARNESS_REPO_NAME)
    if (result.ok) {
      store.dispatch({ type: 'settings/harnessStarredChanged', payload: starred })
    }
    return result
  })

  // updater:getVersion is mode-agnostic — both Electron windows and WS
  // clients (web client, multi-backend Electron remotes) ask for it.
  // Reads from package.json / VERSION rather than Electron's
  // app.getVersion() so the headless server can answer without an `app`.
  transport.onRequest('updater:getVersion', (_ctx) => getHarnessVersion())

  // updater:checkForUpdates / updater:quitAndInstall: the real
  // implementations live in desktop-shell.ts (they drive electron-updater
  // and tear down PTYs before handing off to Squirrel). Register no-op
  // fallbacks here only in headless mode — updating the server binary is
  // the user's job (install script / package manager), not something
  // electron-updater can drive remotely. In Electron mode we skip the
  // fallback so the desktop-shell registration wins (ipcMain.handle
  // throws on duplicates; the WS transport's Map.set silently overwrites
  // — the gate keeps both transports consistent).
  if (runtime === 'node') {
    const headlessUpdaterError = {
      ok: false as const,
      error: 'Updates are managed by the local app, not the server'
    }
    transport.onRequest('updater:checkForUpdates', (_ctx) => headlessUpdaterError)
    transport.onRequest('updater:quitAndInstall', (_ctx) => headlessUpdaterError)
  }

  transport.onRequest('debug:readRecentLog', (_ctx, maxLines?: number) => {
    return readRecentDebugLog(maxLines)
  })

  // Performance monitor
  transport.onRequest('perf:getMetrics', (_ctx) => perfMonitor.getMetrics())
  // One aggregated bucket per second per renderer, and only when a threshold
  // tripped or the 30s heartbeat came due — the renderer decides what's
  // interesting so a stalling renderer isn't also flooding IPC.
  transport.onSignal('perf:reportRendererSample', (_ctx, ...args: unknown[]) => {
    const sample = args[0] as RendererPerfSample | undefined
    if (!sample || typeof sample !== 'object' || !Array.isArray(sample.flags)) return
    perfMonitor.recordRendererSample(sample)
    perfLog(
      sample.flags.length > 0 ? 'renderer-slow' : 'renderer-snapshot',
      formatRendererSample(sample),
      sample
    )
  })

  // GitHub API debug log — ring buffer + per-minute rollups + last-seen
  // rate limit. Renderer polls `debug:getGitHubApiLog` on 1s (matching
  // the perf-monitor polling cadence). The append signal is fired for
  // clients that want to reduce poll latency on bursts; the current
  // renderer panel doesn't use it, but it's cheap to expose.
  transport.onRequest('debug:getGitHubApiLog', (_ctx) => getGitHubApiLogSnapshot())
  transport.onRequest('debug:clearGitHubApiLog', (_ctx) => {
    clearGitHubApiLog()
    return true
  })
  subscribeGitHubApiLog((entry) => {
    transport.sendSignal('debug:githubApiLogAppended', entry)
  })

  // Renderer error-boundary reporting — the preload flattens Error/ErrorInfo
  // into plain strings because Error objects don't survive structured-clone.
  transport.onRequest(
    'debug:logError',
    (_ctx, label: string, name: string, message: string, stack: string, componentStack: string) => {
      log(
        'renderer-error',
        `[${label}] ${name}: ${message}\nStack:\n${stack}\nComponent stack:\n${componentStack}`
      )
      return true
    }
  )

  // Hooks. Install/uninstall happen once at user scope — the hook command
  // is env-gated on $HARNESS_TERMINAL_ID so sessions spawned outside
  // Ness are unaffected.
  transport.onRequest('hooks:accept', (_ctx) => {
    installHooksGlobally()
    config.hooksConsent = 'accepted'
    saveConfig(config)
    store.dispatch({ type: 'hooks/consentChanged', payload: 'accepted' })
    return true
  })

  transport.onRequest('hooks:decline', (_ctx) => {
    config.hooksConsent = 'declined'
    saveConfig(config)
    store.dispatch({ type: 'hooks/consentChanged', payload: 'declined' })
    return true
  })

  transport.onRequest('hooks:uninstall', (_ctx) => {
    uninstallHooksGlobally()
    config.hooksConsent = 'pending'
    saveConfig(config)
    store.dispatch({ type: 'hooks/consentChanged', payload: 'pending' })
    return true
  })

  // shell:openExternal lives in desktop-shell.ts (Electron's `shell`
  // module). Web clients open links via `window.open` directly.

  // Browser tabs — in Electron mode, WebContentsView instances owned by
  // BrowserManager. In headless mode, Playwright pages owned by
  // PlaywrightBrowserManager. Both implement BrowserManagerLike so the
  // handler bodies don't branch on runtime. The browser:setBounds
  // signal is registered only in desktop-shell.ts since it needs the
  // BrowserWindow to attach into.
  transport.onRequest('browser:navigate', (_ctx, tabId: string, url: string) => {
    browserManager.navigate(tabId, url)
    return true
  })
  transport.onRequest('browser:back', (_ctx, tabId: string) => {
    browserManager.back(tabId)
    return true
  })
  transport.onRequest('browser:forward', (_ctx, tabId: string) => {
    browserManager.forward(tabId)
    return true
  })
  transport.onRequest('browser:reload', (_ctx, tabId: string) => {
    browserManager.reload(tabId)
    return true
  })
  transport.onRequest('browser:openDevTools', (_ctx, tabId: string) => {
    browserManager.openDevTools(tabId)
    return true
  })
  // Device-mode emulation. Null clears it. Validation lives in the shared
  // helper so the renderer picker and the MCP tool can't disagree about what
  // a legal viewport is.
  transport.onRequest(
    'browser:setViewport',
    async (_ctx, tabId: string, viewport: unknown, opts?: { reload?: boolean }) => {
      if (viewport == null) {
        await browserManager.setViewport(tabId, null, opts)
        return { ok: true, viewport: null }
      }
      const parsed = normalizeViewport(viewport)
      if (!parsed.viewport) {
        return { ok: false, error: parsed.error ?? 'invalid viewport' }
      }
      try {
        await browserManager.setViewport(tabId, parsed.viewport, opts)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
      return { ok: true, viewport: parsed.viewport }
    }
  )
  transport.onSignal('browser:hide', (_ctx, tabId: string) => {
    browserManager.hide(tabId)
  })
  // Headless / web-client renderers can't host a WebContentsView overlay
  // and instead poll a screenshot + drive the page through these RPCs.
  // Same handlers serve Electron clients too — useful for the eventual
  // "remote view of a local desktop tab" case.
  transport.onRequest(
    'browser:screenshot',
    async (
      _ctx,
      tabId: string,
      opts?: { format?: 'jpeg' | 'png'; quality?: number }
    ) => {
      return browserManager.capturePage(tabId, opts)
    }
  )
  transport.onRequest(
    'browser:click',
    (
      _ctx,
      tabId: string,
      x: number,
      y: number,
      opts?: { button?: 'left' | 'right' | 'middle'; clickCount?: number }
    ) => {
      browserManager.clickTab(tabId, x, y, opts)
      return true
    }
  )
  transport.onRequest(
    'browser:type',
    (_ctx, tabId: string, text: string, key?: string) => {
      browserManager.typeTab(tabId, text, key)
      return true
    }
  )
  transport.onRequest(
    'browser:scroll',
    async (_ctx, tabId: string, dx: number, dy: number) => {
      await browserManager.scrollTab(tabId, dx, dy)
      return true
    }
  )

  // PTY signals are gated by the per-terminal controller in the sessions
  // slice (see `src/shared/state/terminals.ts`). pty:write and pty:resize
  // from a non-controller client are silently dropped — the renderer
  // overlay blocks them locally, but main refuses them too so a stale
  // client can never sneak bytes into the PTY. pty:create always sets
  // the creator as controller; new clients joining an existing terminal
  // come in as spectators via terminal:join.
  transport.onSignal(
    'pty:create',
    (ctx, id: string, cwd: string, cmd: string, args: string[], agentKind?: string, cols?: number, rows?: number) => {
      const isAgent = !!agentKind
      const extraEnv = agentKind === 'claude' ? config.claudeEnvVars
        : agentKind === 'codex' ? config.codexEnvVars
        : agentKind === 'cursor' ? config.cursorEnvVars
        : undefined
      const existed = ptyManager.hasTerminal(id)
      if (!existed && isSpentCommandShell(id)) {
        log('pty', `create id=${id} dropped — command shell already ran`)
        return
      }
      ptyManager.create(id, cwd, cmd, args, extraEnv, !isAgent, cols, rows)
      if (!existed) {
        // Creator becomes controller immediately so their first keystroke
        // — which is a fire-and-forget signal right behind pty:create —
        // passes the gate. Awaitable ordering on pty:create isn't
        // available (it's a signal, not a request); all writes in the
        // current renderer flow arrive strictly after the signal handler
        // returns, so the dispatch here lands first.
        const applyCols = cols && cols > 0 ? cols : 120
        const applyRows = rows && rows > 0 ? rows : 30
        store.dispatch({
          type: 'terminals/controlTaken',
          payload: { terminalId: id, clientId: ctx.clientId, cols: applyCols, rows: applyRows }
        })
      } else {
        // A second client attached to an already-running PTY. Record them
        // as a spectator so the UI reflects the viewer count; taking
        // control still requires an explicit click.
        store.dispatch({
          type: 'terminals/clientJoined',
          payload: { terminalId: id, clientId: ctx.clientId }
        })
      }
    }
  )

  transport.onSignal('pty:write', (ctx, id: string, data: string) => {
    const session = store.getSnapshot().state.terminals.sessions[id]
    if (!session) {
      // No roster yet — accept (single-client boot path). The next
      // pty:create / terminal:join will establish ownership.
      ptyManager.write(id, data)
      return
    }
    if (session.controllerClientId !== ctx.clientId) return
    ptyManager.write(id, data)
  })

  transport.onSignal('pty:resize', (ctx, id: string, cols: number, rows: number) => {
    const session = store.getSnapshot().state.terminals.sessions[id]
    if (session && session.controllerClientId !== ctx.clientId) return
    ptyManager.resize(id, cols, rows)
    store.dispatch({
      type: 'terminals/sizeChanged',
      payload: { terminalId: id, cols, rows }
    })
  })

  transport.onSignal('pty:kill', (_ctx, id: string) => {
    ptyManager.kill(id)
  })

  // Permission-prompt approval pipe. A json-claude tab asks Claude Code to
  // delegate per-tool approvals to our bundled MCP server, which forwards
  // the request over a per-session Unix socket owned by ApprovalBridge.
  // The request surfaces in the store as jsonClaude/approvalRequested; the
  // renderer UI calls this handler once the user clicks Allow/Deny, which
  // writes the PermissionResult back out over the same socket.
  transport.onRequest(
    'jsonClaude:resolveApproval',
    (
      _ctx,
      requestId: string,
      result: {
        behavior: 'allow' | 'deny'
        updatedInput?: Record<string, unknown>
        updatedPermissions?: unknown[]
        message?: string
        interrupt?: boolean
      }
    ) => {
      return approvalBridge.resolveApproval(requestId, result)
    }
  )

  transport.onRequest(
    'jsonClaude:rerunAutoApprovalReview',
    (_ctx, requestId: string) => {
      return approvalBridge.rerunAutoApprovalReview(requestId)
    }
  )

  // JSON-mode Claude subprocess lifecycle. start == spawn claude -p with
  // stream-json IO + the bundled permission-prompt MCP server. The
  // sessionId doubles as the tab id and is used by panesFSM to persist
  // the tab across reload; spawn picks --resume vs. --session-id based
  // on whether the jsonl already exists on disk.
  transport.onRequest('jsonClaude:start', (_ctx, sessionId: string, cwd: string) => {
    if (!sessionId || !cwd) return false
    log('json-claude', `IPC start sessionId=${sessionId}`)
    // Multi-client idempotency: when two viewers (e.g. desktop + mobile)
    // are looking at the same json-claude tab during a tab-type swap,
    // both JsonModeChats mount and both fire startJsonClaude.
    // startJsonClaudeSession's hasSession() short-circuit covers that —
    // no double-dispatch of sessionStarted, no double-spawn.
    startJsonClaudeSession(sessionId, cwd)
    return true
  })
  transport.onSignal(
    'jsonClaude:send',
    (
      _ctx,
      sessionId: string,
      text: string,
      images?: Array<{ mediaType: string; data: string; path: string }>
    ) => {
      jsonClaudeManager.send(sessionId, text, images)
    }
  )
  transport.onSignal(
    'jsonClaude:cancelQueued',
    (_ctx, sessionId: string, messageId: string) => {
      jsonClaudeManager.cancelQueued(sessionId, messageId)
    }
  )
  transport.onRequest('jsonClaude:kill', (_ctx, sessionId: string) => {
    jsonClaudeManager.kill(sessionId)
    return true
  })
  transport.onRequest('jsonClaude:interrupt', (_ctx, sessionId: string) => {
    jsonClaudeManager.interrupt(sessionId)
    return true
  })

  // "Stop what you're doing and do this instead." Abort the in-flight
  // turn, then deliver the draft as a fresh one. Sequenced here rather
  // than as interrupt()+send() from the renderer because both frames go
  // to the same stdin with no flush between them — a user message
  // written straight after the interrupt frame can be drained by the
  // very turn we're killing. Lives in the handler, not the manager,
  // because a turn parked on a tool approval won't reach a boundary
  // until the approval is resolved, and only the handler layer reaches
  // approvalBridge (same rationale as rewindTo).
  transport.onRequest(
    'jsonClaude:interruptAndSend',
    async (
      _ctx,
      sessionId: string,
      text: string,
      images?: Array<{ mediaType: string; data: string; path: string }>
    ): Promise<{ ok: boolean; reason?: string }> => {
      if (!sessionId) return { ok: false, reason: 'missing args' }
      if (!text && !(images && images.length > 0)) {
        return { ok: false, reason: 'empty message' }
      }
      const session = store.getSnapshot().state.jsonClaude.sessions[sessionId]
      if (!session) return { ok: false, reason: 'unknown session' }

      if (session.busy) await interruptAndQuiesce(sessionId)
      approvalBridge.cancelPendingForSession(sessionId, 'interrupted by user')

      // busy is false by now (interrupt flips it, or it already was), so
      // this takes the fresh-turn path rather than the queue path.
      jsonClaudeManager.send(sessionId, text, images)
      return { ok: true }
    }
  )

  // Rewind to a clicked assistant message. Orchestrates: interrupt
  // in-flight stream (if any) → await `result` boundary (≤1500ms) so
  // the jsonl is quiesced → deny pending approvals for the session →
  // manager.rewindTo (truncate jsonl + kill + slice prune) → respawn
  // via --resume. The renderer restricts the menu to assistant rows,
  // so the manager validates the same invariant defensively.
  transport.onRequest(
    'jsonClaude:rewindTo',
    async (
      _ctx,
      sessionId: string,
      entryId: string
    ): Promise<{ ok: boolean; reason?: string }> => {
      if (!sessionId || !entryId) return { ok: false, reason: 'missing args' }
      const startSession = store.getSnapshot().state.jsonClaude.sessions[sessionId]
      if (!startSession) return { ok: false, reason: 'unknown session' }

      if (startSession.busy) await interruptAndQuiesce(sessionId)

      approvalBridge.cancelPendingForSession(sessionId)

      const outcome = jsonClaudeManager.rewindTo(sessionId, entryId)
      if (!outcome.ok) return { ok: false, reason: outcome.reason }

      // Respawn so --resume re-seeds the slice from the truncated jsonl
      // (authoritative — our optimistic dispatch in rewindTo is the
      // pre-respawn fallback).
      startJsonClaudeSession(sessionId, startSession.worktreePath)

      return { ok: true }
    }
  )

  // Fork the current session into a new tab. Unlike rewind, the source
  // stays running — the manager just copies its jsonl prefix into a
  // fresh session file, then we register a sibling tab and spawn the
  // resumed subprocess. panesFSM.addTab appends to the same leaf as
  // the source's active tab.
  transport.onRequest(
    'jsonClaude:forkAt',
    (
      _ctx,
      sessionId: string,
      entryId: string
    ): { ok: boolean; newSessionId?: string; reason?: string } => {
      if (!sessionId || !entryId) return { ok: false, reason: 'missing args' }
      const source = store.getSnapshot().state.jsonClaude.sessions[sessionId]
      if (!source) return { ok: false, reason: 'unknown session' }

      const outcome = jsonClaudeManager.forkAt(sessionId, entryId)
      if (!outcome.ok || !outcome.newSessionId) {
        return { ok: false, reason: outcome.reason }
      }
      const newSessionId = outcome.newSessionId

      // Carry the source tab's label + per-tab model pin so the fork
      // reads as a sibling. Walk panes for the source worktree; the
      // source tab id equals its sessionId.
      let sourceLabel: string | undefined
      let sourceModel: string | undefined
      const tree = store.getSnapshot().state.terminals.panes[source.worktreePath]
      if (tree) {
        outer: for (const leaf of getLeaves(tree)) {
          for (const tab of leaf.tabs) {
            if (tab.id === sessionId && tab.type === 'json-claude') {
              sourceLabel = tab.customLabel?.trim() || tab.label
              sourceModel = tab.model && tab.model.trim() ? tab.model.trim() : undefined
              break outer
            }
          }
        }
      }
      const label = sourceLabel ? `${sourceLabel} (fork)` : 'Chat (fork)'

      panesFSM.addTab(source.worktreePath, {
        id: newSessionId,
        type: 'json-claude',
        label,
        sessionId: newSessionId,
        mode: 'awake',
        ...(sourceModel ? { model: sourceModel } : {})
      })

      startJsonClaudeSession(newSessionId, source.worktreePath)

      return { ok: true, newSessionId }
    }
  )

  transport.onRequest(
    'jsonClaude:openAuthLoginTab',
    (_ctx, worktreePath: string): { ok: true; tabId: string } | { ok: false; error: string } => {
      // One-click /login flow. Spawns the bundled claude binary's
      // `auth login` subcommand in a regular shell tab so the user
      // gets the OAuth handshake without leaving Ness. Both binaries
      // share ~/.claude/, so credentials written here are picked up by
      // the json-mode subprocess on its next start. Falls back to PATH
      // `claude` if the bundled binary can't be resolved (unsupported
      // platform).
      let bin: string
      try {
        bin = bundledClaudeBinPath()
      } catch {
        bin = 'claude'
      }
      const command = `${shellQuote(bin)} auth login`
      const id = `shell-auth-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      panesFSM.addTab(worktreePath, {
        id,
        type: 'shell',
        label: 'claude auth login',
        command
      })
      return { ok: true, tabId: id }
    }
  )

  transport.onRequest(
    'jsonClaude:writeAttachmentImage',
    (_ctx, base64: string, mediaType: string) => {
      try {
        return writeAttachmentImage(base64, mediaType)
      } catch (err) {
        log(
          'json-claude',
          `writeAttachmentImage failed mediaType=${mediaType}`,
          err instanceof Error ? err.message : String(err)
        )
        return null
      }
    }
  )

  transport.onRequest(
    'jsonClaude:readAttachmentImage',
    (_ctx, path: string) => readAttachmentImage(path)
  )

  // Lazy-load chat history. Entries are elided from the initial snapshot
  // (transport.stripSnapshotForWire); this handler returns the authoritative
  // entries for one session and dispatches `entriesSeeded` so every
  // connected client's slice picks them up too.
  transport.onRequest(
    'jsonClaude:getEntries',
    (_ctx, sessionId: string) => {
      if (!sessionId) return []
      const session = store.getSnapshot().state.jsonClaude.sessions[sessionId]
      const entries = session?.entries ?? []
      // Always dispatch when the session exists — even with empty entries,
      // so the slice flips `entriesHydrated: true`. The renderer uses that
      // flag to distinguish "haven't fetched yet" (render blank) from
      // "truly empty session" (render the empty-state card).
      if (session) {
        store.dispatch({
          type: 'jsonClaude/entriesSeeded',
          payload: { sessionId, entries }
        })
      }
      return entries
    }
  )

  transport.onRequest(
    'jsonClaude:setTabModel',
    async (
      _ctx,
      sessionId: string,
      model: string
    ): Promise<{ ok: boolean; reason?: string }> => {
      if (!sessionId) return { ok: false, reason: 'missing sessionId' }
      const session = store.getSnapshot().state.jsonClaude.sessions[sessionId]
      if (!session) return { ok: false, reason: 'unknown session' }
      const trimmed = typeof model === 'string' ? model.trim() : ''

      // Find the tab so we can look up which worktree owns it (needed to
      // dispatch tabModelChanged into the correct pane tree).
      let worktreePath: string | null = null
      const panes = store.getSnapshot().state.terminals.panes
      for (const [wt, tree] of Object.entries(panes)) {
        for (const leaf of getLeaves(tree)) {
          if (leaf.tabs.some((t) => t.id === sessionId)) {
            worktreePath = wt
            break
          }
        }
        if (worktreePath) break
      }
      if (!worktreePath) return { ok: false, reason: 'no owning worktree' }

      // Persist the per-tab override first so the respawn picks it up
      // via findJsonClaudeTabModel(). Empty string clears the override.
      store.dispatch({
        type: 'terminals/tabModelChanged',
        payload: { worktreePath, tabId: sessionId, model: trimmed }
      })

      // Quiesce any in-flight turn cleanly. Interrupt is a soft
      // control_request that keeps the subprocess alive and preserves
      // the partial turn in the jsonl, so --resume picks up cleanly.
      if (session.busy) await interruptAndQuiesce(sessionId)

      approvalBridge.cancelPendingForSession(sessionId)

      // Kill the subprocess, then respawn via the shared start helper.
      // startJsonClaudeSession is idempotent + reads the new tab.model
      // through findJsonClaudeTabModel, so the fresh spawn gets
      // --model <newValue> --resume <sessionId>.
      jsonClaudeManager.kill(sessionId)
      startJsonClaudeSession(sessionId, worktreePath)
      return { ok: true }
    }
  )

  transport.onRequest(
    'jsonClaude:setPermissionMode',
    (_ctx, sessionId: string, mode: JsonClaudePermissionMode) => {
      if (!sessionId) return false
      // Optimistically reflect in the slice so the badge updates
      // immediately. The manager writes a stdin control_request that
      // the subprocess applies mid-turn (same protocol the TUI's
      // shift+tab uses). The persisted slice mode also flows into
      // --permission-mode on the next spawn, so a subsequent kill or
      // reconnect picks it up.
      store.dispatch({
        type: 'jsonClaude/permissionModeChanged',
        payload: { sessionId, mode }
      })
      jsonClaudeManager.setPermissionMode(sessionId, mode)
      return true
    }
  )

  transport.onRequest(
    'jsonClaude:grantSessionToolApprovals',
    (_ctx, sessionId: string, toolNames: string[]) => {
      if (!sessionId || !Array.isArray(toolNames) || toolNames.length === 0) {
        return false
      }
      store.dispatch({
        type: 'jsonClaude/sessionToolApprovalsGranted',
        payload: { sessionId, toolNames }
      })
      return true
    }
  )

  transport.onRequest(
    'jsonClaude:clearSessionToolApprovals',
    (_ctx, sessionId: string, toolNames?: string[]) => {
      if (!sessionId) return false
      store.dispatch({
        type: 'jsonClaude/sessionToolApprovalsCleared',
        payload: { sessionId, toolNames }
      })
      return true
    }
  )

  transport.onRequest(
    'config:setDefaultClaudeTabType',
    (_ctx, value: 'xterm' | 'json') => {
      const next: 'xterm' | 'json' = value === 'json' ? 'json' : 'xterm'
      if (next === 'xterm') {
        delete config.defaultClaudeTabType
      } else {
        config.defaultClaudeTabType = 'json'
      }
      saveConfig(config)
      store.dispatch({
        type: 'settings/defaultClaudeTabTypeChanged',
        payload: next
      })
      return true
    }
  )

  transport.onRequest(
    'config:setChatPromotionDismissed',
    (_ctx, value: boolean) => {
      if (value) {
        config.chatPromotionDismissed = true
      } else {
        delete config.chatPromotionDismissed
      }
      saveConfig(config)
      store.dispatch({
        type: 'settings/chatPromotionDismissedChanged',
        payload: value
      })
      return true
    }
  )

  transport.onRequest(
    'config:setJsonModeChatDensity',
    (_ctx, value: 'compact' | 'comfy') => {
      const next: 'compact' | 'comfy' = value === 'comfy' ? 'comfy' : 'compact'
      if (next === 'compact') {
        delete config.jsonModeChatDensity
      } else {
        config.jsonModeChatDensity = 'comfy'
      }
      saveConfig(config)
      store.dispatch({
        type: 'settings/jsonModeChatDensityChanged',
        payload: next
      })
      return true
    }
  )

  transport.onRequest(
    'config:setUiScale',
    (_ctx, value: 'x-small' | 'small' | 'medium' | 'large' | 'x-large') => {
      const next: 'x-small' | 'small' | 'medium' | 'large' | 'x-large' =
        value === 'x-small' ||
        value === 'medium' ||
        value === 'large' ||
        value === 'x-large'
          ? value
          : 'small'
      if (next === 'small') {
        delete config.uiScale
      } else {
        config.uiScale = next
      }
      saveConfig(config)
      store.dispatch({ type: 'settings/uiScaleChanged', payload: next })
      return true
    }
  )

  transport.onRequest('config:setNessieColor', (_ctx, value: string) => {
    // Resolve through the shared table so an unknown id can never be
    // persisted — a bad value here would leave the app with no brand colour.
    const next = nessieColorById(typeof value === 'string' ? value : '').id
    if (next === DEFAULT_NESSIE_COLOR) {
      delete config.nessieColor
    } else {
      config.nessieColor = next
    }
    saveConfig(config)
    store.dispatch({ type: 'settings/nessieColorChanged', payload: next })
    return true
  })

  transport.onRequest(
    'config:setJsonModeSendOnEnter',
    (_ctx, value: boolean) => {
      const next = value === true
      if (!next) {
        delete config.jsonModeSendOnEnter
      } else {
        config.jsonModeSendOnEnter = true
      }
      saveConfig(config)
      store.dispatch({
        type: 'settings/jsonModeSendOnEnterChanged',
        payload: next
      })
      return true
    }
  )

  transport.onRequest(
    'config:setAutoScrollToBottom',
    (_ctx, value: boolean) => {
      const next = value !== false
      if (next) {
        delete config.autoScrollToBottom
      } else {
        config.autoScrollToBottom = false
      }
      saveConfig(config)
      store.dispatch({
        type: 'settings/autoScrollToBottomChanged',
        payload: next
      })
      return true
    }
  )

  transport.onRequest(
    'config:setJsonModeDefaultPermissionMode',
    (_ctx, value: JsonClaudePermissionMode) => {
      const next: JsonClaudePermissionMode = isJsonClaudePermissionMode(value)
        ? value
        : 'acceptEdits'
      if (next === 'acceptEdits') {
        delete config.jsonModeDefaultPermissionMode
      } else {
        config.jsonModeDefaultPermissionMode = next
      }
      saveConfig(config)
      store.dispatch({
        type: 'settings/jsonModeDefaultPermissionModeChanged',
        payload: next
      })
      return true
    }
  )

  transport.onRequest(
    'config:setJsonModeTranscriptWindow',
    (_ctx, value: number) => {
      const n = Number(value)
      if (!Number.isFinite(n) || n < 0 || n > MAX_JSON_MODE_TRANSCRIPT_WINDOW) {
        return false
      }
      const rounded = Math.floor(n)
      if (rounded === DEFAULT_JSON_MODE_TRANSCRIPT_WINDOW) {
        delete config.jsonModeTranscriptWindow
      } else {
        config.jsonModeTranscriptWindow = rounded
      }
      saveConfig(config)
      store.dispatch({
        type: 'settings/jsonModeTranscriptWindowChanged',
        payload: rounded
      })
      return true
    }
  )

  transport.onRequest('config:setAutoSleepMinutes', (_ctx, value: number) => {
    const n = Number(value)
    if (!Number.isFinite(n) || n < 0 || n > 24 * 60) return false
    const rounded = Math.floor(n)
    if (rounded === 30) {
      delete config.autoSleepMinutes
    } else {
      config.autoSleepMinutes = rounded
    }
    saveConfig(config)
    store.dispatch({
      type: 'settings/autoSleepMinutesChanged',
      payload: rounded
    })
    return true
  })

  // ---- Prevent-sleep (wake-lock) -------------------------------------
  // Mode is persisted; the temporary "+1h" timer (preventSleepUntil) is
  // session-only and dispatched without saving.
  const PREVENT_SLEEP_MODES: PreventSleepMode[] = ['off', 'while-agents-running', 'always']

  transport.onRequest('config:setPreventSleepMode', (_ctx, value: PreventSleepMode) => {
    if (!PREVENT_SLEEP_MODES.includes(value)) return false
    if (value === 'off') delete config.preventSleepMode
    else config.preventSleepMode = value
    saveConfig(config)
    store.dispatch({ type: 'settings/preventSleepModeChanged', payload: value })
    return true
  })

  transport.onRequest('config:setPreventSleepUntil', (_ctx, value: number | null) => {
    // null / invalid → clear; a positive epoch-ms → arm. Session-only: never
    // written to config.json — the WakeLockController owns expiry and the
    // timer resets on relaunch by design.
    const next =
      typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : null
    store.dispatch({ type: 'settings/preventSleepUntilChanged', payload: next })
    return true
  })

  // ---- Multi-backend connections list (Tier 1) -----------------------
  // The connections list is renderer-shell-owned (per plans/tier-1-multi-
  // backend-ux.md §C/§G) — it lives in the local Electron's config.json,
  // not in any backend's slice, and is ONLY exposed by the local backend's
  // transport. Remote backends don't manage other backends. Tokens for
  // remote connections live in secrets.enc keyed `backend-token:<id>`.
  //
  // Renderer-shell handlers are stateless wrt the store — they just read/
  // write `config` and persist via saveConfig. There's no slice for
  // connections by design (nothing else needs to subscribe).
  transport.onRequest('connections:list', () => {
    return config.connections ?? []
  })

  transport.onRequest(
    'connections:add',
    (
      _ctx,
      input: {
        label: string
        url: string
        kind: 'remote'
        color?: string
        initials?: string
        ssh?: { target: string; tunnelLocalPort?: number }
      },
      token: string
    ) => {
      if (!input || input.kind !== 'remote') throw new Error('connections:add only accepts remote connections')
      if (typeof input.url !== 'string' || !input.url) throw new Error('url is required')
      if (typeof input.label !== 'string' || !input.label) throw new Error('label is required')
      if (typeof token !== 'string' || !token) throw new Error('token is required')
      const id = randomUUID()
      const conn: BackendConnection = {
        id,
        label: input.label,
        url: input.url,
        kind: 'remote',
        addedAt: Date.now(),
        ...(input.color ? { color: input.color } : {}),
        ...(input.initials ? { initials: input.initials } : {}),
        ...(input.ssh && typeof input.ssh.target === 'string' && input.ssh.target
          ? {
              ssh: {
                target: input.ssh.target,
                ...(typeof input.ssh.tunnelLocalPort === 'number'
                  ? { tunnelLocalPort: input.ssh.tunnelLocalPort }
                  : {})
              }
            }
          : {})
      }
      const list = (config.connections ?? []).slice()
      list.push(conn)
      config.connections = list
      setSecret(`backend-token:${id}`, token)
      saveConfig(config)
      return conn
    }
  )

  transport.onRequest('connections:remove', (_ctx, id: string) => {
    if (id === LOCAL_BACKEND_ID) throw new Error('cannot remove the local backend')
    const list = config.connections ?? []
    const next = list.filter((c) => c.id !== id)
    if (next.length === list.length) return false
    config.connections = next
    if (config.activeBackendId === id) config.activeBackendId = LOCAL_BACKEND_ID
    deleteSecret(`backend-token:${id}`)
    // Stand the retry loop down before disposing, so the teardown's own
    // close event can't re-arm a reconnect for a backend the user just
    // deleted.
    sshReconnectSupervisor.cancel(id)
    // Tear the local tunnel down for this backend. The remote
    // harness-server is intentionally left running — see
    // plans/remote-main.md §4 "Things to NOT do".
    sshTunnelManager.unregister(id)
    store.dispatch({
      type: 'sshBootstrap/serverVersionForgotten',
      payload: { connectionId: id }
    })
    saveConfig(config)
    return true
  })

  transport.onRequest('connections:rename', (_ctx, id: string, label: string) => {
    if (typeof label !== 'string' || !label.trim()) throw new Error('label is required')
    const list = config.connections ?? []
    const idx = list.findIndex((c) => c.id === id)
    if (idx < 0) return false
    const next = list.slice()
    next[idx] = { ...next[idx], label: label.trim() }
    config.connections = next
    saveConfig(config)
    return true
  })

  transport.onRequest('connections:setActive', (_ctx, id: string) => {
    const list = config.connections ?? []
    if (!list.some((c) => c.id === id)) throw new Error(`unknown backend id: ${id}`)
    config.activeBackendId = id
    saveConfig(config)
    return true
  })

  transport.onRequest('connections:getActive', () => {
    return config.activeBackendId ?? LOCAL_BACKEND_ID
  })

  transport.onRequest('connections:setLastConnected', (_ctx, id: string, when?: number) => {
    const list = config.connections ?? []
    const idx = list.findIndex((c) => c.id === id)
    if (idx < 0) return false
    const next = list.slice()
    next[idx] = { ...next[idx], lastConnectedAt: typeof when === 'number' ? when : Date.now() }
    config.connections = next
    saveConfig(config)
    return true
  })

  transport.onRequest('connections:getToken', (_ctx, id: string) => {
    if (id === LOCAL_BACKEND_ID) return null
    return getSecret(`backend-token:${id}`)
  })

  transport.onRequest('connections:hasToken', (_ctx, id: string) => {
    if (id === LOCAL_BACKEND_ID) return false
    return hasSecret(`backend-token:${id}`)
  })

  // ---- SSH bootstrap helpers (Tier 1 remote-SSH backend flow) -------
  // Renderer-shell-owned, like the connections list above. Only the local
  // Electron backend exposes these — remote backends don't bootstrap other
  // backends. See plans/remote-main.md §4.
  transport.onRequest('ssh:listConfiguredHosts', () => {
    return listConfiguredHosts()
  })

  // First-time SSH bootstrap: SSH in, install (if missing), start the
  // server detached, set up the tunnel, and add the connection.
  // Returns { connectionId } once the connection is persisted; progress
  // events stream into the sshBootstrap slice (subscribe via the
  // sshBootstrap.byId[bootstrapId] hook in the renderer) so the modal
  // can show live progress.
  //
  // Caller MUST pass `bootstrapId` (uuid v4) so it can subscribe to
  // progress events that fire BEFORE this handler returns. Lazy-imported
  // because node-ssh + ssh2 ship native bindings that aren't in the
  // headless tarball.
  transport.onRequest(
    'ssh:bootstrap',
    async (
      _ctx,
      input: { bootstrapId: string; target: string; label: string }
    ): Promise<{ connectionId: string }> => {
      if (!input || typeof input.target !== 'string' || !input.target.trim()) {
        throw new Error('target is required')
      }
      if (typeof input.bootstrapId !== 'string' || !input.bootstrapId) {
        throw new Error('bootstrapId is required')
      }
      const label = (input.label || '').trim() || input.target.trim()
      const { parseSshTarget, bootstrapRemote } = await import('./ssh-bootstrap')
      const target = parseSshTarget(input.target)

      store.dispatch({
        type: 'sshBootstrap/started',
        payload: { bootstrapId: input.bootstrapId, label, target: target.raw, now: Date.now() }
      })

      try {
        const result = await bootstrapRemote(target, {
          onPhase: (phase) => {
            store.dispatch({
              type: 'sshBootstrap/phaseChanged',
              payload: { bootstrapId: input.bootstrapId, phase, now: Date.now() }
            })
          },
          onLine: (line) => {
            store.dispatch({
              type: 'sshBootstrap/lineLogged',
              payload: { bootstrapId: input.bootstrapId, line, now: Date.now() }
            })
          }
        }, { expectedVersion: getHarnessVersion() })

        // Mint the BackendConnection + persist + register tunnel. The
        // URL is the ephemeral loopback we just opened; on next launch
        // we'll re-derive it after re-running the bootstrap.
        // ws:// not http:// — WebSocketClientTransport calls `new WebSocket(url)`
    // which throws on http schemes.
    const url = `ws://127.0.0.1:${result.localPort}/?token=${result.token}`
        const id = randomUUID()
        const conn: BackendConnection = {
          id,
          label,
          url,
          kind: 'remote',
          addedAt: Date.now(),
          ssh: { target: target.raw, tunnelLocalPort: result.localPort }
        }
        const list = (config.connections ?? []).slice()
        list.push(conn)
        config.connections = list
        setSecret(`backend-token:${id}`, result.token)
        saveConfig(config)
        sshTunnelManager.register({
          backendId: id,
          localPort: result.localPort,
          remotePort: result.remotePort,
          token: result.token,
          ssh: result.ssh,
          tunnelServer: result.tunnelServer
        })

        store.dispatch({
          type: 'sshBootstrap/connectionLinked',
          payload: { bootstrapId: input.bootstrapId, connectionId: id }
        })
        recordRemoteServerVersion(id, result.serverVersion)
        store.dispatch({
          type: 'sshBootstrap/phaseChanged',
          payload: { bootstrapId: input.bootstrapId, phase: 'connected', now: Date.now() }
        })
        return { connectionId: id }
      } catch (err) {
        const bootstrapErr = (err as { bootstrapError?: import('../shared/state/ssh-bootstrap').BootstrapError })
          .bootstrapError ?? {
          code: 'unknown' as const,
          message: err instanceof Error ? err.message : String(err)
        }
        store.dispatch({
          type: 'sshBootstrap/errored',
          payload: { bootstrapId: input.bootstrapId, error: bootstrapErr, now: Date.now() }
        })
        throw err
      }
    }
  )

  // Reconnect an existing SSH backend: re-runs the bootstrap (skipping
  // install if the server is already running) and reopens the tunnel.
  // Returns { url, token } so the renderer can build a fresh WS
  // transport pointing at the new loopback port.
  //
  // Idempotent: if a live tunnel for this backend already exists, just
  // return its URL + token without re-running SSH.
  transport.onRequest(
    'ssh:reconnect',
    (_ctx, input: { bootstrapId: string; connectionId: string }) =>
      runSshReconnect(input)
  )

  // Re-install harness-server on an SSH backend and restart it. Only
  // reachable from an explicit user action — it kills the running
  // server, so every session on that remote dies. Returns the new
  // loopback URL + token; the renderer drops its WS transport and
  // re-hydrates against the fresh tunnel.
  transport.onRequest(
    'ssh:upgradeServer',
    async (
      _ctx,
      input: { bootstrapId: string; connectionId: string }
    ): Promise<{ url: string; token: string; localPort: number; serverVersion: string | null }> => {
      if (!input || typeof input.connectionId !== 'string') {
        throw new Error('connectionId is required')
      }
      if (typeof input.bootstrapId !== 'string' || !input.bootstrapId) {
        throw new Error('bootstrapId is required')
      }
      const conn = (config.connections ?? []).find((c) => c.id === input.connectionId)
      if (!conn) throw new Error(`unknown backend ${input.connectionId}`)
      if (!conn.ssh) throw new Error(`backend ${input.connectionId} is not an SSH backend`)

      const { parseSshTarget, upgradeRemoteServer } = await import('./ssh-bootstrap')
      const target = parseSshTarget(conn.ssh.target)
      store.dispatch({
        type: 'sshBootstrap/started',
        payload: {
          bootstrapId: input.bootstrapId,
          label: conn.label,
          target: target.raw,
          now: Date.now()
        }
      })
      store.dispatch({
        type: 'sshBootstrap/connectionLinked',
        payload: { bootstrapId: input.bootstrapId, connectionId: conn.id }
      })

      try {
        const result = await upgradeRemoteServer(target, {
          onPhase: (phase) => {
            store.dispatch({
              type: 'sshBootstrap/phaseChanged',
              payload: { bootstrapId: input.bootstrapId, phase, now: Date.now() }
            })
          },
          onLine: (line) => {
            store.dispatch({
              type: 'sshBootstrap/lineLogged',
              payload: { bootstrapId: input.bootstrapId, line, now: Date.now() }
            })
          }
        })
        // register() disposes the previous entry's SSH connection +
        // tunnel server, so the old loopback port stops accepting.
        sshTunnelManager.register({
          backendId: conn.id,
          localPort: result.localPort,
          remotePort: result.remotePort,
          token: result.token,
          ssh: result.ssh,
          tunnelServer: result.tunnelServer
        })
        const url = `ws://127.0.0.1:${result.localPort}/?token=${result.token}`
        const idx = (config.connections ?? []).findIndex((c) => c.id === conn.id)
        if (idx >= 0) {
          const next = config.connections!.slice()
          next[idx] = {
            ...next[idx],
            url,
            ssh: { target: target.raw, tunnelLocalPort: result.localPort }
          }
          config.connections = next
          setSecret(`backend-token:${conn.id}`, result.token)
          saveConfig(config)
        }
        recordRemoteServerVersion(conn.id, result.serverVersion)
        return {
          url,
          token: result.token,
          localPort: result.localPort,
          serverVersion: result.serverVersion
        }
      } catch (err) {
        const bootstrapErr =
          (err as { bootstrapError?: import('../shared/state/ssh-bootstrap').BootstrapError })
            .bootstrapError ?? {
            code: 'unknown' as const,
            message: err instanceof Error ? err.message : String(err)
          }
        store.dispatch({
          type: 'sshBootstrap/errored',
          payload: { bootstrapId: input.bootstrapId, error: bootstrapErr, now: Date.now() }
        })
        throw err
      }
    }
  )

  transport.onSignal('terminal:join', (ctx, id: string) => {
    store.dispatch({
      type: 'terminals/clientJoined',
      payload: { terminalId: id, clientId: ctx.clientId }
    })
  })

  transport.onSignal('terminal:leave', (ctx, id: string) => {
    store.dispatch({
      type: 'terminals/controlReleased',
      payload: { terminalId: id, clientId: ctx.clientId }
    })
  })

  transport.onSignal('terminal:takeControl', (ctx, id: string, cols: number, rows: number) => {
    // Any client can claim control; the reducer demotes the previous
    // controller (if any) to spectator. Physically resize the PTY so the
    // new owner's viewport becomes authoritative.
    const prev = store.getSnapshot().state.terminals.sessions[id]
    log(
      'take-control',
      `handler id=${id} from=${ctx.clientId} dims=${cols}x${rows} prevController=${prev?.controllerClientId ?? 'null'}`
    )
    store.dispatch({
      type: 'terminals/controlTaken',
      payload: { terminalId: id, clientId: ctx.clientId, cols, rows }
    })
    const next = store.getSnapshot().state.terminals.sessions[id]
    log(
      'take-control',
      `dispatched id=${id} newController=${next?.controllerClientId ?? 'null'} spectators=${JSON.stringify(next?.spectatorClientIds ?? [])}`
    )
    ptyManager.resize(id, cols, rows)
  })

  transport.onSignal('terminal:setProgress', (_ctx, id: string, state: number, value: number) => {
    // OSC 9;4 progress, mirrored from the controller's xterm ProgressAddon.
    // Reducer dedups identical updates so we don't fan out per token.
    if (typeof id !== 'string' || !id) return
    if (state !== 0 && state !== 1 && state !== 2 && state !== 3 && state !== 4) return
    const v = Number(value)
    store.dispatch({
      type: 'terminals/progressChanged',
      payload: { id, state, value: Number.isFinite(v) ? v : 0 }
    })
  })

  transport.onRequest('snooze:snooze', (_ctx, path: string, wakeAt: number) => {
    if (typeof path !== 'string' || !path) return false
    const wake = Number(wakeAt)
    if (!Number.isFinite(wake)) return false
    const now = Date.now()
    // Allow MAX_WAKE ("Never") or any wakeAt at least 1 day out (with 1min slack
    // for clock truncation when the picker rounds to midnight).
    if (wake !== MAX_WAKE && wake < now + 86400000 - 60000) return false
    store.dispatch({
      type: 'snooze/set',
      payload: { path, snoozedAt: now, wakeAt: wake }
    })
    return true
  })

  transport.onRequest('snooze:unsnooze', (_ctx, path: string) => {
    if (typeof path !== 'string' || !path) return false
    store.dispatch({ type: 'snooze/clear', payload: path })
    return true
  })

  transport.onRequest('pinned:pin', (_ctx, path: string) => {
    if (typeof path !== 'string' || !path) return false
    store.dispatch({ type: 'pinned/set', payload: path })
    return true
  })

  transport.onRequest('pinned:unpin', (_ctx, path: string) => {
    if (typeof path !== 'string' || !path) return false
    store.dispatch({ type: 'pinned/clear', payload: path })
    return true
  })

  transport.onRequest(
    'scratchpad:setText',
    (_ctx, worktreePath: string, text: string) => {
      if (typeof worktreePath !== 'string' || !worktreePath) return false
      if (typeof text !== 'string') return false
      const wt = store
        .getSnapshot()
        .state.worktrees.list.find((w) => w.path === worktreePath)
      const repoRoot = wt?.repoRoot
      if (repoRoot) {
        const notes = config.scratchpadNotes || {}
        const repoMap = notes[repoRoot] ? { ...notes[repoRoot] } : {}
        if (text === '') {
          delete repoMap[worktreePath]
        } else {
          repoMap[worktreePath] = text
        }
        const nextNotes = { ...notes }
        if (Object.keys(repoMap).length === 0) {
          delete nextNotes[repoRoot]
        } else {
          nextNotes[repoRoot] = repoMap
        }
        if (Object.keys(nextNotes).length === 0) {
          delete config.scratchpadNotes
        } else {
          config.scratchpadNotes = nextNotes
        }
        saveConfig(config)
      }
      store.dispatch({
        type: 'scratchpad/textChanged',
        payload: { worktreePath, text }
      })
      return true
    }
  )

  transport.onRequest('aliases:set', (_ctx, path: string, alias: string) => {
    if (typeof path !== 'string' || !path) return false
    if (typeof alias !== 'string') return false
    const normalized = normalizeAlias(alias)
    if (!normalized) {
      store.dispatch({ type: 'aliases/cleared', payload: { path } })
    } else {
      store.dispatch({ type: 'aliases/set', payload: { path, alias: normalized } })
    }
    return true
  })

  transport.onRequest('aliases:clear', (_ctx, path: string) => {
    if (typeof path !== 'string' || !path) return false
    store.dispatch({ type: 'aliases/cleared', payload: { path } })
    return true
  })

  transport.onRequest(
    'ciNotify:setOverride',
    (_ctx, path: string, enabled: boolean | null) => {
      if (typeof path !== 'string' || !path) return false
      if (enabled === null) {
        store.dispatch({ type: 'ciNotify/clear', payload: path })
      } else if (typeof enabled === 'boolean') {
        store.dispatch({ type: 'ciNotify/set', payload: { path, enabled } })
      } else {
        return false
      }
      return true
    }
  )

  transport.onRequest('config:setNotifyChatOnCiFailure', (_ctx, enabled: boolean) => {
    if (typeof enabled !== 'boolean') return false
    if (enabled) {
      config.notifyChatOnCiFailure = true
    } else {
      delete config.notifyChatOnCiFailure
    }
    saveConfig(config)
    store.dispatch({ type: 'settings/notifyChatOnCiFailureChanged', payload: enabled })
    return true
  })

  transport.onRequest('config:setSnoozeDefaultDays', (_ctx, days: number) => {
    const n = Number(days)
    if (!Number.isFinite(n)) return false
    const clamped = Math.max(1, Math.floor(n))
    if (clamped === 7) {
      delete config.snoozeDefaultDays
    } else {
      config.snoozeDefaultDays = clamped
    }
    saveConfig(config)
    store.dispatch({ type: 'settings/snoozeDefaultDaysChanged', payload: clamped })
    return true
  })
}

function broadcastToAllWindows(channel: string, ...args: unknown[]): void {
  transport.sendSignal(channel, ...args)
}

// Hooks into the desktop shell that a few mode-agnostic IPC handlers
// need to call. In headless mode they're no-ops; in Electron mode the
// shell replaces them after `startDesktopShell` returns.
const desktopHooks = {
  startAutoUpdateChecks: (): void => {},
  stopAutoUpdateChecks: (): void => {}
}

// Dev-only re-apply of a freshly-fixed config without relaunching (relaunch
// blanks the screen under `electron-vite dev` — see desktop-shell). `config`
// is mutated in place because desktop-shell and many IPC handlers hold it by
// reference; reassigning would strand them on the stale object. The caller
// reloads the window afterward so the renderer re-fetches the new snapshot.
async function reapplyConfigFromDisk(): Promise<void> {
  const fresh = loadConfig()
  const mutable = config as unknown as Record<string, unknown>
  for (const key of Object.keys(mutable)) {
    delete mutable[key]
  }
  Object.assign(config, fresh)

  store.replaceState(
    buildInitialAppState(config, {
      hasGithubToken: hasSecret('githubToken'),
      configLoadError: getConfigLoadError()
    })
  )

  const repoConfigsMap: Record<string, RepoConfig> = {}
  const repoConfigNames: Record<string, string> = {}
  for (const root of config.repoRoots || []) {
    repoConfigsMap[root] = loadRepoConfig(root)
    repoConfigNames[root] = repoConfigFilename(root)
  }
  store.dispatch({
    type: 'repoConfigs/loaded',
    payload: { byRepo: repoConfigsMap, filenameByRepo: repoConfigNames }
  })

  await panesFSM.restoreFromConfig(config.panes)
  await worktreesFSM.refreshList()
  void prPoller.refreshAll()
}

async function runBoot(): Promise<void> {
  log('app', `started, log file: ${getLogFilePath()}`)

  // Seed the store's flat worktree list before the renderer hydrates, so
  // App.tsx's first render already has the real data. Pane init for the
  // discovered worktrees is handled by the sleep-on-boot subscriber above
  // — refreshList() dispatches `worktrees/listChanged`, which queues every
  // path for init pending the first PR-poller pass (or a 3s timeout).
  void (async () => {
    await panesFSM.restoreFromConfig(config.panes)
    await worktreesFSM.refreshList()
    migrateClaudeSettingsOffSymlinks()
    reconcileBrowserViews()
  })()

  // Seed per-repo config slice from each repo's config file.
  const initialRepoConfigsMap: Record<string, RepoConfig> = {}
  const initialRepoConfigNames: Record<string, string> = {}
  for (const root of config.repoRoots || []) {
    initialRepoConfigsMap[root] = loadRepoConfig(root)
    initialRepoConfigNames[root] = repoConfigFilename(root)
  }
  store.dispatch({
    type: 'repoConfigs/loaded',
    payload: { byRepo: initialRepoConfigsMap, filenameByRepo: initialRepoConfigNames }
  })

  // Start the activity deriver — it observes terminals/prs/panes events
  // and writes recordActivity + lastActive without renderer involvement.
  activityDeriver.start()

  ciNotifier.start()

  autoSleepMonitor.start()

  wakeLockController.start()

  // Resolve the GitHub token (PAT → gh CLI → none) before the PR poller
  // makes its first call. The poller's initial refreshAll waits on this.
  void (async () => {
    await resolveGitHubToken()
    const source = getTokenSource()
    store.dispatch({ type: 'settings/githubAuthSourceChanged', payload: source })
    // Fetch the viewer's GitHub login so worktree-sort can route any PR
    // not authored by us into the Reviewing group. One /user call.
    void refreshViewerLogin()
    prPoller.start()
    void prPoller.refreshAll()
    if (store.getSnapshot().state.settings.showAssignedPRs) {
      void prPoller.refreshAssignedPRs()
    }

    await refreshHarnessStarState()
  })()

  announcementsPoller.start()

  // Seed hooks.consent from disk and migrate legacy per-worktree hooks
  // to a single user-scope install. Runs once per app install; migrated
  // state sticks via config.hooksMigratedToGlobal.
  void (async () => {
    const claudeAgent = getAgent('claude')
    const codexAgent = getAgent('codex')
    const cursorAgent = getAgent('cursor')

    // 1. Decide what the user's previous consent was.
    //    - Explicit persisted value wins (including 'declined').
    //    - Otherwise infer from the current state of disk: any global
    //      install implies 'accepted'; otherwise scan worktrees for
    //      legacy per-worktree markers as evidence of a prior accept.
    let consent: 'pending' | 'accepted' | 'declined' | undefined = config.hooksConsent
    if (!consent) {
      if (claudeAgent.hooksInstalled() || codexAgent.hooksInstalled() || cursorAgent.hooksInstalled()) {
        consent = 'accepted'
      } else {
        let foundLegacy = false
        for (const root of config.repoRoots || []) {
          const trees = await listWorktrees(root).catch(() => [])
          for (const wt of trees) {
            // Probe via strip helper dry-run: we check existence of the
            // per-worktree file + its contents cheaply here by attempting
            // a strip and rolling back mentally — actually easier to just
            // run the strip and treat the "changed" bit as evidence.
            if (claudeAgent.stripHooksFromWorktree(wt.path)) foundLegacy = true
            if (codexAgent.stripHooksFromWorktree(wt.path)) foundLegacy = true
            if (cursorAgent.stripHooksFromWorktree(wt.path)) foundLegacy = true
          }
        }
        consent = foundLegacy ? 'accepted' : 'pending'
        if (foundLegacy) {
          // Migration already happened above as a side-effect.
          config.hooksMigratedToGlobal = true
        }
      }
      config.hooksConsent = consent
      saveConfig(config)
    }

    // 2. If user previously accepted but the global install is missing
    //    (fresh upgrade), install now so status tracking keeps working.
    if (consent === 'accepted') {
      installHooksGlobally()
    }

    // 3. Run the one-shot migration sweep to strip legacy per-worktree
    //    hooks — needed when config.hooksConsent was already persisted
    //    (explicit path above didn't run the sweep) but we haven't
    //    swept yet.
    if (!config.hooksMigratedToGlobal) {
      for (const root of config.repoRoots || []) {
        const trees = await listWorktrees(root).catch(() => [])
        for (const wt of trees) {
          claudeAgent.stripHooksFromWorktree(wt.path)
          codexAgent.stripHooksFromWorktree(wt.path)
          cursorAgent.stripHooksFromWorktree(wt.path)
        }
      }
      config.hooksMigratedToGlobal = true
      saveConfig(config)
    }

    store.dispatch({ type: 'hooks/consentChanged', payload: consent })
  })()

  // Prune terminal history files not referenced by any persisted tab
  const keepIds = new Set<string>()
  function collectTabIds(node: PersistedPaneNode): void {
    if (node.type === 'leaf') {
      for (const tab of node.tabs) keepIds.add(tab.id)
    } else {
      collectTabIds(node.children[0])
      collectTabIds(node.children[1])
    }
  }
  for (const byRepo of Object.values(config.panes || {})) {
    for (const tree of Object.values(byRepo)) {
      collectTabIds(tree)
    }
  }
  pruneTerminalHistory(keepIds)
  pruneMcpConfigs(keepIds)

  // Drain any worktree-trash entries left by a mid-delete crash. The
  // sweep dispatches each entry to the fs threadpool without awaiting,
  // so this call resolves immediately and doesn't block boot.
  void sweepWorktreeTrashOnBoot()

  // Local HTTP control server for the bundled ness-control MCP bridge.
  startControlServer({
    getRepoRoots: () => config.repoRoots,
    getWorktreeBase: () => config.worktreeBase || DEFAULT_WORKTREE_BASE,
    getPrReviewPrompt: () => config.prReviewPrompt || DEFAULT_PR_REVIEW_PROMPT,
    resolveCallerScope,
    hasForkableTranscript,
    getConversationForkEnabled: () => config.conversationForkEnabled === true,
    getBrowserPerms: () => ({
      enabled: config.browserToolsEnabled !== false,
      mode: config.browserToolsMode === 'view' ? 'view' : 'full'
    }),
    getWorktreeStatus: (wt) => deriveWorktreeStatus(store.getSnapshot().state, wt),
    setAlias: (worktreePath, alias) => {
      const normalized = normalizeAlias(alias)
      if (!normalized) {
        store.dispatch({ type: 'aliases/cleared', payload: { path: worktreePath } })
      } else {
        store.dispatch({
          type: 'aliases/set',
          payload: { path: worktreePath, alias: normalized }
        })
      }
    },
    clearAlias: (worktreePath) => {
      store.dispatch({ type: 'aliases/cleared', payload: { path: worktreePath } })
    },
    renameBranch: async (worktreePath, newBranch) => {
      const result = await renameWorktreeBranch(worktreePath, newBranch)
      // The gitdir HEAD watcher would catch this on its own, but the tool
      // response should not be able to arrive before the sidebar agrees.
      if (result.ok && result.renamed) await worktreesFSM.refreshList()
      return result
    },
    messaging: {
      isEnabled: () => config.worktreeMessagingEnabled === true,
      resolveTarget: (query) =>
        resolveWorktreeQuery(store.getSnapshot().state, query),
      describe: (worktreePath) =>
        describeWorktree(store.getSnapshot().state, worktreePath),
      send: (worktreePath, message) =>
        deliverToWorktreeChat(
          store.getSnapshot().state,
          chatDeliveryDeps,
          worktreePath,
          message
        )
    },
    browser: {
      listTabsForWorktree: (wtPath) => {
        const ids = browserManager.listTabsForWorktree(wtPath)
        const out: BrowserTabSummary[] = []
        for (const id of ids) {
          const info = browserManager.getTabInfo(id)
          if (info) out.push(info)
        }
        return out
      },
      getTabWorktree: (tabId) => browserManager.getWorktreePath(tabId),
      getTabUrl: (tabId) => browserManager.getUrl(tabId),
      getTabConsoleLogs: (tabId) => browserManager.getConsoleLogs(tabId),
      screenshotTab: (tabId, opts) => browserManager.capturePage(tabId, opts),
      getTabDom: (tabId) => browserManager.getDom(tabId),
      getTabClickables: (tabId) => browserManager.getClickables(tabId),
      navigateTab: (tabId, url) => browserManager.navigate(tabId, url),
      backTab: (tabId) => browserManager.back(tabId),
      forwardTab: (tabId) => browserManager.forward(tabId),
      reloadTab: (tabId) => browserManager.reload(tabId),
      createTab: (wtPath, url) => {
        const id = `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const finalUrl = url && url.trim() ? url.trim() : 'about:blank'
        panesFSM.addTab(wtPath, {
          id,
          type: 'browser',
          label: 'Browser',
          url: finalUrl
        })
        return { id, url: finalUrl }
      },
      clickTab: (tabId, x, y, options) => browserManager.clickTab(tabId, x, y, options),
      typeTab: (tabId, text, key) => browserManager.typeTab(tabId, text, key),
      scrollTab: (tabId, dx, dy) => browserManager.scrollTab(tabId, dx, dy),
      showCursor: (tabId, x, y) => browserManager.showCursor(tabId, x, y),
      setTabViewport: (tabId, viewport, opts) =>
        browserManager.setViewport(tabId, viewport, opts)
    },
    shell: {
      listShellsForWorktree: (wtPath) => {
        const tree = store.getSnapshot().state.terminals.panes[wtPath]
        if (!tree) return []
        const out: Array<{
          id: string
          label: string
          command?: string
          cwd?: string
          alive: boolean
        }> = []
        for (const leaf of getLeaves(tree)) {
          for (const tab of leaf.tabs) {
            if (tab.type !== 'shell') continue
            out.push({
              id: tab.id,
              label: tab.label,
              command: tab.command,
              cwd: tab.cwd,
              alive: ptyManager.hasTerminal(tab.id)
            })
          }
        }
        return out
      },
      getShellWorktree: (shellId) => findShellWorktree(shellId),
      readShellOutput: (shellId, { lines, match, context }) => {
        const raw = ptyManager.getHistory(shellId)
        if (!raw) return { output: '' }
        // Strip ANSI CSI + OSC sequences so agents don't waste tokens on
        // cursor/color control bytes. Keep printable chars + newlines.
        const stripped = raw
          .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
          .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
          .replace(/\x1b\(./g, '')
          .replace(/\r/g, '')
        const allLines = stripped.split('\n')

        if (!match) {
          if (allLines.length <= lines) return { output: stripped }
          return { output: allLines.slice(-lines).join('\n') }
        }

        let re: RegExp
        try {
          re = new RegExp(match, 'i')
        } catch (err) {
          return { output: '', error: `invalid regex: ${(err as Error).message}` }
        }

        const ctx = context || 0
        const keep = new Set<number>()
        let matchCount = 0
        for (let i = 0; i < allLines.length; i++) {
          if (!re.test(allLines[i])) continue
          matchCount++
          for (let j = Math.max(0, i - ctx); j <= Math.min(allLines.length - 1, i + ctx); j++) {
            keep.add(j)
          }
        }
        // Emit a gap marker ("---") between non-contiguous kept ranges so
        // agents can tell where we skipped, without counting every gap as a
        // token-expensive blank line.
        const kept: string[] = []
        const indices = Array.from(keep).sort((a, b) => a - b)
        let prev = -2
        for (const i of indices) {
          if (i !== prev + 1 && kept.length > 0) kept.push('---')
          kept.push(allLines[i])
          prev = i
        }
        const finalLines = kept.length > lines ? kept.slice(-lines) : kept
        return { output: finalLines.join('\n'), matchCount }
      },
      createShell: (wtPath, { command, cwd, label }) => {
        const id = `shell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const fallback = command ? command.slice(0, 32) : 'Shell'
        const finalLabel = (label && label.trim()) || fallback
        panesFSM.addTab(wtPath, {
          id,
          type: 'shell',
          label: finalLabel,
          command,
          cwd
        })
        // Spawn the PTY eagerly here so agent-initiated `create_shell` calls
        // don't wait for a human to focus the tab — otherwise
        // `read_shell_output` returns empty and the caller thinks the shell
        // failed. `ptyManager.create` is idempotent, so the renderer's later
        // `pty:create` (fired from XTerminal on mount) attaches instead of
        // respawning.
        const spawnCwd = cwd
          ? cwd.startsWith('/') ? cwd : `${wtPath}/${cwd}`
          : wtPath
        const args = command ? ['-ilc', command] : ['-il']
        ptyManager.create(id, spawnCwd, '', args, undefined, true)
        return { id, label: finalLabel }
      },
      killShell: (shellId) => {
        const wtPath = findShellWorktree(shellId)
        if (wtPath) {
          panesFSM.closeTab(wtPath, shellId)
        } else {
          ptyManager.kill(shellId)
        }
      }
    },
    runWorktreeSetup: (ctx) => worktreesFSM.runWorktreeSetup(ctx),
    runPendingPRWorktree: async (params) => {
      // The FSM already handles ensureInitialized (with the prompt) + PR poller
      // refresh via onWorktreeCreated. We just look up the resolved branch
      // from the freshly-refreshed store list and emit the focus broadcast
      // directly so the heavy ensureInitialized/refreshList work doesn't
      // run a second time through the broadcast path.
      // 'setup-failed' still means the worktree exists on disk — surface
      // it to the MCP caller as success so the agent can recover.
      const outcome = await worktreesFSM.runPendingPR(params)
      if (outcome.outcome === 'error') {
        return { ok: false, error: outcome.error }
      }
      const found = store
        .getSnapshot()
        .state.worktrees.list.find((w) => w.path === outcome.createdPath)
      if (!found) {
        return { ok: false, error: `created worktree at ${outcome.createdPath} but couldn't resolve its branch` }
      }
      // agentKind + model are already applied via the FSM's onWorktreeCreated
      // path; we still ship them in the broadcast payload so its shape stays
      // in sync with the new-branch path through deps.broadcast — keeps
      // future refactors that consolidate the two from silently losing data.
      broadcastToAllWindows('worktrees:externalCreate', {
        repoRoot: params.repoRoot,
        worktree: found,
        initialPrompt: params.initialPrompt,
        agentKind: params.agentKind,
        model: params.model
      })
      return { ok: true, path: found.path, branch: found.branch }
    },
    broadcast: (channel, payload) => {
      if (channel === 'worktrees:externalCreate') {
        // Seed panes with the initial prompt BEFORE refreshList — the
        // worktrees/listChanged subscriber also calls ensureInitialized
        // (without opts) for every worktree in the new list, and whoever
        // gets there first wins. Prime the pane with the prompt, then
        // refresh the list so subsequent ensureInitialized calls are
        // no-ops, then tell the renderer to focus the new path.
        const p = payload as {
          repoRoot: string
          worktree: { path: string }
          initialPrompt?: string
          agentKind?: AgentKind
          model?: string
          forkSource?: ForkSource
          baseRef?: string
        }
        // A conversation fork makes the seeding async (the relocation
        // preamble shells out to git), so claim the path first — the
        // worktree is already on disk and visible to `git worktree list`.
        seedingWorktreePaths.add(p.worktree.path)
        void (async () => {
          try {
            const kickoff = await resolveForkedKickoff({
              createdPath: p.worktree.path,
              initialPrompt: p.initialPrompt,
              forkSource: p.forkSource,
              baseRef: p.baseRef
            })
            panesFSM.ensureInitialized(p.worktree.path, {
              initialPrompt: kickoff.initialPrompt,
              agentKind: p.agentKind,
              model: p.model,
              forkedSessionId: kickoff.forkedSessionId
            })
          } finally {
            seedingWorktreePaths.delete(p.worktree.path)
          }
          await worktreesFSM.refreshList()
          broadcastToAllWindows(channel, payload)
        })()
        void prPoller.refreshAll()
        return
      }
      broadcastToAllWindows(channel, payload)
    }
  }).catch((err) => log('control', 'failed to start', err instanceof Error ? err.message : err))

  // Watch status dir globally — hook events become terminals/statusChanged
  // dispatches on the store, which the state transport fans out to all
  // clients.
  stopWatchingStatus = watchStatusDir(store)

  // Pre-warm SSH tunnels for every saved SSH backend so the tunnel is
  // up by the time the renderer's hydrate-remote loop calls
  // `ssh:reconnect` to fetch the URL. We don't await — boot must not
  // block on a flaky network. Errors flow through the sshBootstrap
  // slice's `errored` event so the chip strip can render a tooltip
  // (renderer-side wiring lands in commit 6). Skipped in headless mode
  // (no SSH bootstrap there per design).
  if (runtime === 'electron') {
    for (const conn of config.connections ?? []) {
      if (conn.kind !== 'remote' || !conn.ssh) continue
      const bootstrapId = `boot-${conn.id}`
      void runSshReconnect({ bootstrapId, connectionId: conn.id }).catch((err) => {
        log('ssh-bootstrap', `pre-warm failed for ${conn.id}: ${(err as Error).message}`)
      })
    }
  }

  // Opening the first window + spinning up the auto-updater is the
  // desktop shell's job — see desktop-shell.ts. Headless mode skips
  // both; clients connect via the WS server already listening below.
}

// Now hand control to the desktop shell (Electron) or run boot directly
// (headless). registerIpcHandlers must run BEFORE either path so the
// shared transport's request/signal table is fully populated by the
// time a window or WS client connects.
registerIpcHandlers()

if (desktopShellMod && desktopEarly) {
  const handle = desktopShellMod.startDesktopShell({
    store,
    transport,
    ptyManager,
    browserManager: desktopEarly.browserManager,
    worktreesFSM,
    config,
    runBoot,
    reapplyConfigFromDisk,
    getStopWatchingStatus: () => stopWatchingStatus,
    setStopWatchingStatus: (next) => {
      stopWatchingStatus = next
    },
    onRepoAdded: () => {
      void worktreesFSM.refreshList()
    },
    onBeforeQuit: () => {
      jsonClaudeManager.killAll()
      approvalBridge.stopAll()
      // Close local tunnel ends — the remote `harness-server` is left
      // running (intentional; see plans/remote-main.md §4).
      sshReconnectSupervisor.cancelAll()
      sshTunnelManager.closeAll()
      worktreeWatcher.shutdown()
      flushPerfLogSync()
    },
    setWarnBeforeQuitting
  })
  desktopHooks.startAutoUpdateChecks = handle.startAutoUpdateChecks
  desktopHooks.stopAutoUpdateChecks = handle.stopAutoUpdateChecks
  // Real renderer RSS/CPU for `[snapshot]`. Headless has no BrowserWindow, so
  // no provider is set there and the fields log as null rather than lying.
  perfMonitor.setRendererProcessMetricsProvider(handle.getRendererProcessMetrics)
} else {
  // Headless: no app.whenReady to wait for, no menus, no window. Just
  // boot. The WS server already listens (the webHttpServer.listen call
  // above kicks it off), so a web client can connect as soon as boot
  // resolves.
  void runBoot()
  // Mirror the Electron before-quit cleanups for SIGTERM / SIGINT so a
  // headless host can shut down cleanly. browserManager.destroyAll() is
  // still safe to call — the headless stub no-ops it.
  const shutdown = (): void => {
    stopWatchingStatus?.()
    stopWatchingStatus = null
    ptyManager.killAll('SIGKILL')
    jsonClaudeManager.killAll()
    approvalBridge.stopAll()
    worktreeWatcher.shutdown()
    browserManager.destroyAll()
    sshReconnectSupervisor.cancelAll()
    sshTunnelManager.closeAll()
    sealAllActive()
    saveConfigSync(config)
    flushPerfLogSync()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

} // end bootLocal()

