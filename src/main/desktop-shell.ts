// Electron desktop shell.
//
// Everything in this file is Electron-only — BrowserWindow, dialog, Menu,
// the WebContentsView-backed BrowserManager, electron-updater, the IPC
// handlers that touch any of those. index.ts loads this module via a
// runtime require under `if (runtime === 'electron')`, so the headless
// build never pulls electron through this path.
//
// The split with index.ts:
//   - index.ts owns the mode-agnostic boot — store construction, FSMs,
//     PTY manager, WS transport, control server, hook installer, the
//     bulk of the IPC handler registrations.
//   - This file owns the desktop window + menu, the BrowserManager
//     (WebContentsView), the auto-updater, and the small set of IPC
//     handlers that are inherently desktop-bound (native folder picker,
//     `BrowserWindow`-aware browser:setBounds, updater RPCs).
//
// Construction split:
//   - `createDesktopShell` runs synchronously, before anything that
//     reads `userDataDir()` is touched. It applies the userData path
//     override (so persistence/secrets/debug all see "Harness (Dev)"),
//     creates the BrowserManager, and wires the ElectronServerTransport.
//   - `startDesktopShell` is called after index.ts has registered all
//     mode-agnostic IPC handlers. It registers the desktop-only
//     handlers, builds the menu, opens the first window, kicks off the
//     auto-updater, and hands back lifecycle hooks (start/stop auto
//     update checks) for the few shared handlers that need to call into
//     the desktop side.

import { app, autoUpdater as nativeAutoUpdater, BrowserWindow, dialog, Menu, nativeImage, nativeTheme, screen, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join } from 'path'
import { BrowserManager } from './browser-manager'
import { ElectronServerTransport } from './transport-electron'
import type { Store } from './store'
import type { PerfMonitor, RendererProcessMetrics } from './perf-monitor'
import type { CompoundServerTransport } from './transport-compound'
import type { PtyManager } from './pty-manager'
import type { WorktreesFSM } from './worktrees-fsm'
import type { Config } from './persistence'
import {
  saveConfig,
  saveConfigSync,
  THEME_APP_BG,
  readRawConfigText,
  saveRawConfigText,
  discardCorruptConfigAndReset
} from './persistence'
import { DEFAULT_LIGHT_THEME, DEFAULT_DARK_THEME } from '../shared/state/settings'
import { registerWindowControlHandlers } from './window-controls'
import { sealAllActive } from './activity'
import { log, getLogFilePath } from './debug'
import { isManualUpdateInstallType } from './manual-update'
import { HARNESS_REPO_URL } from '../shared/constants'
import { resolveRepoPath } from './repo-resolve'
import { registerRepoRoot } from './repo-roots'
import type { AddRepoResult } from '../shared/repo-pick'

export interface DesktopShellInit {
  store: Store
  perfMonitor: PerfMonitor
  /** Mutable config object — saveBounds writes into it directly. */
  config: Config
}

export interface DesktopShellEarlyHandle {
  browserManager: BrowserManager
  transport: ElectronServerTransport
}

/** Where the web-client bundle lives at runtime. Differs between
 *  packaged builds (asar-relative) and dev / unpacked (sibling of the
 *  main bundle output). Lives here so index.ts doesn't need to call
 *  `app.getAppPath()` directly. */
const FALLBACK_BG = '#0a0a0a'

/** Pick the BrowserWindow backgroundColor that best matches the user's
 *  configured theme, so the first paint doesn't flash a contrasting bg
 *  while React mounts. In Phase 1 only built-in themes are known here,
 *  so the hex is read from `THEME_APP_BG`; the renderer writes whatever
 *  it actually applied back into `config.lastEffectiveAppBg`, which is
 *  the Phase 2 cushion for custom themes main can't synchronously see. */
function resolveWindowBg(config: Config): string {
  const mode = config.themeMode ?? 'system'
  const wantDark = mode === 'system' ? nativeTheme.shouldUseDarkColors : mode === 'dark'
  const id = wantDark
    ? (config.themeDark ?? DEFAULT_DARK_THEME)
    : (config.themeLight ?? DEFAULT_LIGHT_THEME)
  return THEME_APP_BG[id] ?? config.lastEffectiveAppBg ?? FALLBACK_BG
}

export function resolveWebClientDir(): string {
  return app.isPackaged
    ? join(app.getAppPath(), 'out/web-client')
    : join(__dirname, '../web-client')
}

/** Dev mode uses a sibling userData dir so a running dev instance doesn't
 *  fight with the installed prod app over config.json / activity.json /
 *  secrets.enc / etc. Must run before any module reads userDataDir() —
 *  that's `loadConfig()` in index.ts — so index.ts calls this right
 *  after requiring desktop-shell, not inside `createDesktopShell`
 *  (which only runs later, once the store + config exist).
 *
 *  Packaged builds pin the lowercase 'harness' — byte-identical to what
 *  Electron derives from package.json `name` today. Anything else (even a
 *  case variant, which only works on case-insensitive volumes) resolves
 *  existing installs to a new empty dir and orphans their config, secrets,
 *  and pane layout. Note `name` also keys the macOS Safe Storage keychain
 *  item, which is why it stays 'harness' while productName becomes Ness. */
export function applyUserDataPathOverride(): void {
  app.setPath(
    'userData',
    join(app.getPath('appData'), app.isPackaged ? 'harness' : 'Harness (Dev)')
  )
}

/** First call that needs the store. Constructs the BrowserManager +
 *  Electron transport that index.ts wires into the compound transport.
 *  The userData path override happens earlier via
 *  `applyUserDataPathOverride()` — see that function for why. */
export function createDesktopShell(init: DesktopShellInit): DesktopShellEarlyHandle {
  const browserManager = new BrowserManager()
  const transport = new ElectronServerTransport(init.store, init.perfMonitor)
  return { browserManager, transport }
}

export interface DesktopShellStartDeps {
  store: Store
  transport: CompoundServerTransport
  ptyManager: PtyManager
  browserManager: BrowserManager
  worktreesFSM: WorktreesFSM
  config: Config
  /** Async boot work that runs inside app.whenReady — restoring panes,
   *  starting pollers, etc. Owned by index.ts because most of it is
   *  mode-agnostic. */
  runBoot: () => Promise<void> | void
  /** Dev-only: re-load config.json and re-seed the store + FSMs in place,
   *  used by the corrupt-config handlers when not packaged (relaunch blanks
   *  the screen under the dev server). Owned by index.ts (touches the store,
   *  FSMs, and shared config object). */
  reapplyConfigFromDisk: () => Promise<void>
  /** Reference held by index.ts so its handlers can stop the watcher
   *  during quitAndInstall. */
  getStopWatchingStatus: () => (() => void) | null
  setStopWatchingStatus: (next: (() => void) | null) => void
  /** index.ts owns the loaded RepoConfig dispatch path; we need to fire
   *  it for any folder added via the native picker. */
  onRepoAdded: (repoRoot: string) => void
  /** Extra teardown work to run inside before-quit, between killing
   *  PTYs and tearing down the BrowserManager. Owned by index.ts so
   *  feature managers (e.g. approval-bridge) that live there can clean
   *  up without desktop-shell needing to know about them. */
  onBeforeQuit?: () => void
  /** Persist + dispatch the "Warn Before Quitting" toggle. Shared with the
   *  Settings IPC handler so the app-menu checkbox stays in sync. */
  setWarnBeforeQuitting: (enabled: boolean) => void
}

export interface DesktopShellStartHandle {
  startAutoUpdateChecks: () => void
  stopAutoUpdateChecks: () => void
  getRendererProcessMetrics: () => RendererProcessMetrics | null
}

/** Real RSS/CPU for the app's own renderer process(es), for PerfMonitor.
 *
 *  Scoped to BrowserWindow webContents on purpose. Browser tabs are
 *  WebContentsViews with their own renderer processes, and folding those in
 *  would make the app's renderer look like it ballooned whenever the user
 *  opened a heavy page. */
function getRendererProcessMetrics(): RendererProcessMetrics | null {
  const pids = new Set<number>()
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue
    try {
      pids.add(w.webContents.getOSProcessId())
    } catch {
      // webContents torn down mid-iteration; nothing to attribute.
    }
  }
  if (pids.size === 0) return null

  let rssKB = 0
  let cpuPct = 0
  let matched = false
  for (const m of app.getAppMetrics()) {
    if (!pids.has(m.pid)) continue
    matched = true
    // workingSetSize is KB (Electron's ProcessMetric).
    rssKB += m.memory.workingSetSize
    cpuPct += m.cpu.percentCPUUsage
  }
  if (!matched) return null
  return { rssMB: Math.round(rssKB / 1024), cpuPct: Math.round(cpuPct) }
}

/** Second call. After index.ts has wired its mode-agnostic IPC handlers,
 *  this hooks app lifecycle, builds the menu, opens the first window,
 *  registers the desktop-only IPC handlers, and starts the auto-updater. */
export function startDesktopShell(deps: DesktopShellStartDeps): DesktopShellStartHandle {
  const {
    store,
    transport,
    ptyManager,
    browserManager,
    worktreesFSM,
    config,
    runBoot,
    reapplyConfigFromDisk,
    getStopWatchingStatus,
    setStopWatchingStatus,
    onRepoAdded,
    onBeforeQuit,
    setWarnBeforeQuitting
  } = deps

  registerDesktopHandlers()

  let autoUpdateTimer: NodeJS.Timeout | null = null

  function startAutoUpdateChecks(): void {
    if (!app.isPackaged) return
    if (config.autoUpdateEnabled === false) return
    if (autoUpdateTimer) return
    // Check on startup, then every 10 minutes. We use checkForUpdates (not
    // checkForUpdatesAndNotify) so there's no native OS notification — the
    // renderer shows an in-app banner based on the updater:status events.
    autoUpdater.checkForUpdates().catch((err) => log('updater', 'check failed', err.message))
    autoUpdateTimer = setInterval(() => {
      autoUpdater.checkForUpdates().catch(() => {})
    }, 10 * 60 * 1000)
  }

  function stopAutoUpdateChecks(): void {
    if (autoUpdateTimer) {
      clearInterval(autoUpdateTimer)
      autoUpdateTimer = null
    }
  }

  function setupAutoUpdater(): void {
    if (!app.isPackaged) return // No-op in dev

    const manualInstallRequired = isManualUpdateInstallType()
    if (manualInstallRequired) {
      // electron-updater would silently no-op the download/install on
      // packaging types that need root (dpkg, flatpak, snap). Skip the
      // round-trip and let the renderer show the manual-download banner.
      autoUpdater.autoDownload = false
    }

    autoUpdater.logger = {
      info: (msg: string) => log('updater', msg),
      warn: (msg: string) => log('updater', `[warn] ${msg}`),
      error: (msg: string) => log('updater', `[error] ${msg}`),
      debug: () => {}
    }

    autoUpdater.on('checking-for-update', () => {
      log('updater', 'checking for update')
      store.dispatch({ type: 'updater/statusChanged', payload: { state: 'checking' } })
    })
    let pendingUpdateVersion = ''
    autoUpdater.on('update-available', (info) => {
      log('updater', `update available ${info.version}${manualInstallRequired ? ' (manual install)' : ''}`)
      pendingUpdateVersion = info.version
      store.dispatch({
        type: 'updater/statusChanged',
        payload: {
          state: 'available',
          version: info.version,
          releaseUrl: `${HARNESS_REPO_URL}/releases/tag/v${info.version}`,
          manualInstallRequired
        }
      })
    })
    autoUpdater.on('update-not-available', () => {
      log('updater', 'no update available')
      store.dispatch({
        type: 'updater/statusChanged',
        payload: { state: 'not-available' }
      })
    })
    autoUpdater.on('error', (err) => {
      log('updater', 'error', err.message)
      store.dispatch({
        type: 'updater/statusChanged',
        payload: { state: 'error', error: err.message }
      })
    })
    autoUpdater.on('download-progress', (p) => {
      store.dispatch({
        type: 'updater/statusChanged',
        payload: { state: 'downloading', percent: p.percent, version: pendingUpdateVersion }
      })
    })
    autoUpdater.on('update-downloaded', (info) => {
      log('updater', 'update downloaded', info.version)
      store.dispatch({
        type: 'updater/statusChanged',
        payload: { state: 'downloaded', version: info.version }
      })
    })

    if (process.platform === 'darwin') {
      nativeAutoUpdater.on('error', (err) => {
        log('updater', `[error] Squirrel.Mac: ${err.message}`)
      })
    }

    startAutoUpdateChecks()
  }

  function createWindow(): BrowserWindow {
    // First-launch defaults: aim for 1600x1000, but clamp to the primary
    // display's work area so smaller screens (13" MBP = 1440x900 native)
    // don't get a window that spills off-screen. Returning users' saved
    // windowBounds pass through untouched.
    const work = screen.getPrimaryDisplay().workAreaSize
    const bounds = config.windowBounds || {
      width: Math.min(1600, work.width - 40),
      height: Math.min(1000, work.height - 40),
      x: undefined!,
      y: undefined!
    }

    const win = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      ...(bounds.x != null ? { x: bounds.x, y: bounds.y } : {}),
      title: 'Ness',
      // nativeImage path so reads work from inside app.asar and the WM
      // gets a real pixel buffer for _NET_WM_ICON on Linux. A bare string
      // path here silently fails when the file is asar-bundled.
      icon: nativeImage.createFromPath(join(__dirname, '../../resources/icon.png')),
      // Linux has no inset-titlebar concept; drop the OS frame entirely so
      // we get the same edge-to-edge canvas the macOS hiddenInset gives us.
      // The renderer's .drag-region zones handle window dragging.
      ...(process.platform === 'linux'
        ? { frame: false }
        : { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 12 } }),
      backgroundColor: resolveWindowBg(config),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })

    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('mailto:')) {
        shell.openExternal(url)
      }
      return { action: 'deny' }
    })

    // setWindowOpenHandler only fires for window.open / target=_blank.
    // A plain <a href="…"> click (e.g. a link inside ReactMarkdown-rendered
    // chat) hits will-navigate instead and would replace the entire app UI
    // with the target page. Route cross-origin navigations to the OS
    // browser; allow same-origin so Vite HMR / hash routing keep working.
    win.webContents.on('will-navigate', (event, url) => {
      let sameOrigin = false
      try {
        sameOrigin = new URL(url).origin === new URL(win.webContents.getURL()).origin
      } catch {
        // Malformed URL — treat as external.
      }
      if (sameOrigin) return
      event.preventDefault()
      if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('mailto:')) {
        shell.openExternal(url)
      }
    })

    win.webContents.on('console-message', (_event, level, message) => {
      const levelName = ['verbose', 'info', 'warn', 'error'][level] || 'log'
      log('renderer', `[win${win.id}] [${levelName}] ${message}`)
    })

    const saveBounds = (): void => {
      if (win.isDestroyed()) return
      config.windowBounds = win.getBounds()
      saveConfig(config)
    }
    win.on('resize', saveBounds)
    win.on('move', saveBounds)

    // macOS hides the traffic lights in native fullscreen, so the renderer
    // shouldn't reserve the 80px leading clearance for them. Notify on
    // transition and on initial paint so first render matches reality.
    const sendFullscreen = (): void => {
      transport.sendSignal('window:fullscreenChanged', win.isFullScreen())
    }
    win.on('enter-full-screen', sendFullscreen)
    win.on('leave-full-screen', sendFullscreen)
    win.webContents.once('did-finish-load', sendFullscreen)

    if (process.env['ELECTRON_RENDERER_URL']) {
      win.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
      win.loadFile(join(__dirname, '../renderer/index.html'))
    }

    return win
  }

  function buildMenu(): void {
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          {
            label: 'Settings…',
            accelerator: 'CmdOrCtrl+,',
            click: () => transport.sendSignal('app:openSettings')
          },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          // Toggles the hold-⌘Q-to-quit gesture (see before-input-event
          // below). `checked` reads live state; buildMenu() re-runs when
          // the setting changes (store subscription) so the menu and the
          // Settings toggle stay in sync.
          {
            label: 'Warn Before Quitting (⌘Q)',
            type: 'checkbox',
            checked: store.getSnapshot().state.settings.warnBeforeQuitting,
            click: (item) => setWarnBeforeQuitting(item.checked)
          },
          { type: 'separator' },
          // Custom Quit with NO accelerator: macOS ignores
          // registerAccelerator:false for app-menu items and binds ⌘Q
          // anyway, and that binding fires before-input-event with the
          // keyup suppressed — which breaks hold-to-quit. Leaving the
          // accelerator off entirely frees ⌘Q so the keystroke (keydown
          // AND keyup) flows to our handlers, where the hold gesture lives.
          // Menu click still quits immediately.
          {
            label: `Quit ${app.name}`,
            click: () => app.quit()
          }
        ]
      },
      {
        label: 'File',
        submenu: [
          {
            label: 'New Project…',
            click: () => transport.sendSignal('menu:newProject')
          },
          {
            label: 'New Window',
            accelerator: 'CmdOrCtrl+Shift+N',
            click: () => createWindow()
          },
          { type: 'separator' },
          {
            label: 'Add Backend…',
            click: () => transport.sendSignal('app:openAddBackend')
          },
          { type: 'separator' },
          {
            // Menu accelerator captures Cmd+W even when focus is inside
            // a WebContentsView (browser tab) — the renderer's keydown
            // listener doesn't see keystrokes from nested webContents.
            // Without this, macOS routes Cmd+W to the default "Close
            // Window" action and the user loses everything.
            label: 'Close Tab',
            accelerator: 'CmdOrCtrl+W',
            click: () => transport.sendSignal('app:closeFocusedTab')
          },
          {
            label: 'Close Window',
            accelerator: 'CmdOrCtrl+Shift+W',
            role: 'close'
          }
        ]
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' }
        ]
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          // Custom (not role: 'forceReload') so it carries NO accelerator — the
          // role's default ⌘⇧R is reserved for the renderer's Refresh Worktrees
          // hotkey. Still reloads when clicked.
          {
            label: 'Force Reload',
            click: () => BrowserWindow.getFocusedWindow()?.webContents.reloadIgnoringCache()
          },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          {
            label: 'Increase UI Size',
            accelerator: 'CmdOrCtrl+Plus',
            click: () => transport.sendSignal('app:uiScaleUp')
          },
          {
            label: 'Decrease UI Size',
            accelerator: 'CmdOrCtrl+-',
            click: () => transport.sendSignal('app:uiScaleDown')
          },
          {
            label: 'Reset UI Size',
            accelerator: 'CmdOrCtrl+=',
            click: () => transport.sendSignal('app:uiScaleReset')
          },
          { type: 'separator' },
          {
            label: 'Single Screen Mode',
            accelerator: 'F12',
            click: () => transport.sendSignal('app:toggleSingleScreen')
          }
          // macOS appends "Enter Full Screen" to the View menu
          // automatically — explicit togglefullscreen role would show up
          // a second time, so it's intentionally not listed here.
        ]
      },
      {
        label: 'Window',
        submenu: [
          { role: 'minimize' },
          { role: 'zoom' },
          { type: 'separator' },
          {
            label: 'Split Pane Right',
            accelerator: 'CmdOrCtrl+D',
            click: () => transport.sendSignal('app:splitPaneRight')
          },
          {
            label: 'Split Pane Down',
            accelerator: 'CmdOrCtrl+Shift+D',
            click: () => transport.sendSignal('app:splitPaneDown')
          },
          { type: 'separator' },
          { role: 'front' }
        ]
      },
      {
        label: 'Help',
        submenu: [
          {
            label: 'Keyboard Shortcuts',
            click: () => transport.sendSignal('app:openKeyboardShortcuts')
          },
          { type: 'separator' },
          {
            label: 'Report an Issue…',
            click: () => transport.sendSignal('app:openReportIssue')
          },
          { type: 'separator' },
          {
            label: 'Debug: Open Debug Log',
            click: () => {
              void shell.openPath(getLogFilePath())
            }
          },
          {
            label: 'Debug: Open GitHub API Log',
            click: () => transport.sendSignal('app:openGitHubApiLog')
          },
          {
            label: 'Debug: Performance Monitor',
            accelerator: 'CmdOrCtrl+Alt+P',
            click: () => transport.sendSignal('app:togglePerfMonitor')
          },
          {
            label: 'Debug: Crash Focused Tab',
            click: () => transport.sendSignal('app:debugCrashFocusedTab')
          },
          ...(!app.isPackaged
            ? [
                {
                  label: 'Debug: Preview Onboarding',
                  click: () => transport.sendSignal('app:debugPreviewOnboarding')
                } as const
              ]
            : [])
        ]
      }
    ]
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  }

  function registerDesktopHandlers(): void {
    registerWindowControlHandlers()

    transport.onRequest('repo:add', async (_ctx): Promise<AddRepoResult> => {
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
      const result = await dialog.showOpenDialog(win!, {
        properties: ['openDirectory'],
        title: 'Open Git Repository'
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { kind: 'canceled' }
      }
      const picked = result.filePaths[0]
      const resolution = await resolveRepoPath(picked)
      if (resolution.kind === 'ok') {
        const repoRoot = resolution.root
        if (registerRepoRoot(repoRoot, { config, store, worktreesFSM })) {
          onRepoAdded(repoRoot)
        }
        return { kind: 'added', repoRoot }
      }
      return resolution
    })

    transport.onRequest(
      'dialog:pickDirectory',
      async (_ctx, opts?: { defaultPath?: string; title?: string }) => {
        const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
        const result = await dialog.showOpenDialog(win!, {
          properties: ['openDirectory', 'createDirectory'],
          defaultPath: opts?.defaultPath,
          title: opts?.title ?? 'Pick a folder'
        })
        if (result.canceled || result.filePaths.length === 0) return null
        return result.filePaths[0]
      }
    )

    // updater:getVersion is registered in src/main/index.ts so it works
    // for both Electron windows and headless WS clients. The remaining
    // updater:* handlers stay here because they need electron-updater
    // and the before-quit teardown.

    transport.onRequest('updater:checkForUpdates', async (_ctx) => {
      if (!app.isPackaged) {
        return { ok: false, error: 'Updates are only available in packaged builds' }
      }
      try {
        const result = await autoUpdater.checkForUpdates()
        if (!result) {
          store.dispatch({
            type: 'updater/statusChanged',
            payload: { state: 'not-available' }
          })
          return { ok: true, available: false }
        }
        const updateInfo = result.updateInfo
        const current = app.getVersion()
        return {
          ok: true,
          available: updateInfo.version !== current,
          version: updateInfo.version,
          releaseDate: updateInfo.releaseDate
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        store.dispatch({
          type: 'updater/statusChanged',
          payload: { state: 'error', error: message }
        })
        return { ok: false, error: message }
      }
    })

    if (!app.isPackaged) {
      transport.onRequest('updater:devSimulate', (_ctx, state: string) => {
        const version = app.getVersion()
        if (state === 'available') {
          store.dispatch({ type: 'updater/statusChanged', payload: { state: 'available', version } })
        } else if (state === 'downloading') {
          store.dispatch({
            type: 'updater/statusChanged',
            payload: { state: 'downloading', percent: 42, version }
          })
        } else if (state === 'downloaded') {
          store.dispatch({ type: 'updater/statusChanged', payload: { state: 'downloaded', version } })
        } else {
          store.dispatch({ type: 'updater/statusChanged', payload: { state: 'not-available' } })
        }
        return true
      })
    }

    transport.onRequest('updater:quitAndInstall', (_ctx) => {
      log('updater', 'quitAndInstall requested — tearing down before handing off to Squirrel')
      try {
        getStopWatchingStatus()?.()
        setStopWatchingStatus(null)
      } catch (err) {
        log('updater', 'stopWatchingStatus failed', err instanceof Error ? err.message : String(err))
      }
      try {
        ptyManager.killAll('SIGKILL')
      } catch (err) {
        log('updater', 'ptyManager.killAll failed', err instanceof Error ? err.message : String(err))
      }
      try {
        sealAllActive()
        saveConfigSync(config)
      } catch (err) {
        log('updater', 'final persistence failed', err instanceof Error ? err.message : String(err))
      }

      app.removeAllListeners('before-quit')
      autoUpdater.quitAndInstall(true, true)
      return true
    })

    transport.onSignal('shell:openExternal', (_ctx, url: string) => {
      shell.openExternal(url)
    })

    // --- Corrupt-config recovery (see persistence.ts) ---
    // These fire while the renderer is showing InvalidConfigModal. Production
    // relaunches for a clean reboot off the fixed file; dev can't (relaunch
    // tears down the Vite dev server → blank screen) so it re-seeds in place
    // and reloads the renderer.
    const applyRecoveredConfig = async (): Promise<void> => {
      if (app.isPackaged) {
        app.relaunch()
        app.exit(0)
        return
      }
      await reapplyConfigFromDisk()
      for (const win of BrowserWindow.getAllWindows()) win.reload()
    }

    transport.onRequest('config:readRawConfig', (_ctx) => {
      return { text: readRawConfigText() }
    })

    transport.onRequest('config:saveRawConfigAndRetry', async (_ctx, text: string) => {
      const result = saveRawConfigText(text)
      if (!result.ok) return { ok: false as const, error: result.error }
      await applyRecoveredConfig()
      return { ok: true as const }
    })

    transport.onRequest('config:resetConfigToDefaults', async (_ctx) => {
      discardCorruptConfigAndReset()
      await applyRecoveredConfig()
      return { ok: true as const }
    })

    transport.onRequest('config:openThemesFolder', async (_ctx) => {
      const { themesDir } = await import('./themes-loader')
      const dir = themesDir()
      const err = await shell.openPath(dir)
      return err ? { ok: false as const, path: dir, message: err } : { ok: true as const, path: dir }
    })

    transport.onRequest('shell:openPath', async (_ctx, path: string) => {
      const error = await shell.openPath(path)
      if (error) return { ok: false as const, message: error }
      return { ok: true as const }
    })

    transport.onRequest('debug:openLog', async (_ctx) => {
      const path = getLogFilePath()
      const error = await shell.openPath(path)
      if (error) return { ok: false as const, message: error }
      return { ok: true as const }
    })

    transport.onRequest('debug:showLogInFolder', (_ctx) => {
      shell.showItemInFolder(getLogFilePath())
      return true
    })

    transport.onSignal(
      'browser:setBounds',
      (_ctx, tabId: string, bounds: { x: number; y: number; width: number; height: number } | null) => {
        if (!bounds) {
          browserManager.hide(tabId)
          return
        }
        const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
        if (!win) return
        browserManager.setBounds(tabId, win, bounds)
      }
    )
  }

  app.whenReady().then(() => {
    if (process.platform === 'darwin' && app.dock) {
      try {
        app.dock.setIcon(join(__dirname, '../../resources/icon.png'))
      } catch (err) {
        log('app', 'failed to set dock icon', err instanceof Error ? err.message : err)
      }
    }
    buildMenu()
    void runBoot()
    createWindow()
    setupAutoUpdater()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  // ── Hold-⌘Q-to-quit ────────────────────────────────────────────────
  // Chrome-style: a ⌘Q tap does nothing; holding it for HOLD_TO_QUIT_MS
  // quits. The whole gesture is detected here in main via
  // `before-input-event`, which fires for EVERY webContents — the main
  // window and each embedded browser tab (a WebContentsView has its own
  // input pipeline the renderer's window listener never sees) — so the
  // gesture, and the guard against an accidental quit, work no matter
  // what's focused.
  //
  // Two things make this work and are easy to regress:
  //   1. The Quit menu item has NO accelerator (see buildMenu). macOS
  //      ignores registerAccelerator:false for app-menu items and would
  //      otherwise bind ⌘Q and quit on keydown.
  //   2. We must NOT call event.preventDefault() here. Doing so suppresses
  //      the keyUp that cancels the hold (on both before-input-event and
  //      the DOM), which turns every tap into a quit. Leaking ⌘Q to the
  //      page is harmless — nothing else binds it.
  //
  // The chord must stay held the WHOLE time. Releasing ⌘ cancels via its
  // keyUp. Releasing Q is the tricky one: macOS suppresses the letter keyUp
  // while ⌘ is held, so a Q keyUp never arrives and ⌘ alone would keep the
  // timer running to a quit. So we lean on OS key-repeat instead — while ⌘Q
  // is physically held the autorepeat keyDowns for Q keep arriving; the
  // instant Q is released (⌘ still down) they stop. A watchdog longer than
  // the repeat interval but shorter than the hold catches that gap and
  // cancels, so the gesture genuinely requires BOTH ⌘ and Q, not ⌘ alone.
  // The 1s timer runs here; the renderer overlay is driven by the
  // start/cancel signals (CSS fill in styles.css matches HOLD_TO_QUIT_MS).
  //
  // Shortcut: two quick ⌘Q taps (each keydown within DOUBLE_TAP_MS of the
  // last) quit immediately, so power users don't have to wait out the hold.
  // OS key-repeat (isAutoRepeat) is never treated as a fresh tap so a single
  // held ⌘Q can't read as a double-tap.
  const HOLD_TO_QUIT_MS = 1000
  const DOUBLE_TAP_MS = 400
  const Q_REPEAT_GRACE_MS = 600
  let lastQuitTapAt = 0
  let holdQuitTimer: NodeJS.Timeout | null = null
  let qHeartbeatTimer: NodeJS.Timeout | null = null
  const armQHeartbeat = (): void => {
    if (qHeartbeatTimer) clearTimeout(qHeartbeatTimer)
    qHeartbeatTimer = setTimeout(() => {
      qHeartbeatTimer = null
      cancelHoldToQuit() // no Q autorepeat within the grace window → Q released
    }, Q_REPEAT_GRACE_MS)
  }
  const startHoldToQuit = (): void => {
    if (holdQuitTimer) return
    transport.sendSignal('app:holdToQuitStart')
    holdQuitTimer = setTimeout(() => {
      holdQuitTimer = null
      app.quit()
    }, HOLD_TO_QUIT_MS)
    armQHeartbeat()
  }
  const cancelHoldToQuit = (): void => {
    if (qHeartbeatTimer) {
      clearTimeout(qHeartbeatTimer)
      qHeartbeatTimer = null
    }
    if (!holdQuitTimer) return
    clearTimeout(holdQuitTimer)
    holdQuitTimer = null
    transport.sendSignal('app:holdToQuitCancel')
  }
  app.on('web-contents-created', (_e, contents) => {
    contents.on('before-input-event', (_event, input) => {
      const isQ = input.key === 'q' || input.key === 'Q'
      if (input.type === 'keyDown' && input.meta && isQ) {
        if (input.isAutoRepeat) {
          if (holdQuitTimer) armQHeartbeat() // Q still held — refresh the watchdog
          return
        }
        if (!store.getSnapshot().state.settings.warnBeforeQuitting) {
          app.quit() // gesture disabled — ⌘Q quits immediately
          return
        }
        const now = Date.now()
        if (now - lastQuitTapAt < DOUBLE_TAP_MS) {
          cancelHoldToQuit() // second quick tap — quit now, skip the hold
          app.quit()
          return
        }
        lastQuitTapAt = now
        startHoldToQuit()
      } else if (input.type === 'keyUp' && (input.key === 'Meta' || isQ)) {
        cancelHoldToQuit()
      } else if (input.type === 'keyDown' && holdQuitTimer) {
        cancelHoldToQuit() // any other key aborts a pending hold
      }
    })
  })
  // Safety net: losing window focus mid-hold (e.g. ⌘-Tab) cancels too.
  app.on('browser-window-blur', () => cancelHoldToQuit())

  // Keep the "Warn Before Quitting" menu checkbox in sync when the setting
  // is toggled from Settings (or anywhere). Cheap: re-derive one boolean
  // per store event and only rebuild the menu when it actually flips.
  let lastWarnBeforeQuitting = store.getSnapshot().state.settings.warnBeforeQuitting
  store.subscribe(() => {
    const warn = store.getSnapshot().state.settings.warnBeforeQuitting
    if (warn !== lastWarnBeforeQuitting) {
      lastWarnBeforeQuitting = warn
      buildMenu()
    }
  })

  app.on('before-quit', () => {
    getStopWatchingStatus()?.()
    setStopWatchingStatus(null)
    ptyManager.killAll('SIGKILL')
    onBeforeQuit?.()
    browserManager.destroyAll()
    sealAllActive()
    saveConfigSync(config)
  })

  return {
    startAutoUpdateChecks,
    stopAutoUpdateChecks,
    getRendererProcessMetrics
  }
}
