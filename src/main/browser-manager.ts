import { WebContentsView, BrowserWindow, app, nativeImage, session } from 'electron'
import type { NativeImage } from 'electron'
import type { Store } from './store'
import type { BrowserManagerLike, CaptureResult, ConsoleLog } from './browser-manager-types'
import { log } from './debug'
import {
  encodedCaptureError,
  resolveScreenshotTarget,
  viewportCaptureError
} from './browser-screenshot'
import { normalizeBrowserUrl } from './browser-url'
import { evalWithTimeout, evalBlockedReason } from './browser-eval'
import { canSurfaceCapture, emulatedViewRect } from './browser-layout'
import type { BrowserViewport } from '../shared/browser-viewport'

export type { ConsoleLog }

export interface BrowserInstance {
  view: WebContentsView
  worktreePath: string
  attachedWindow: BrowserWindow | null
  logs: ConsoleLog[]
  /** Track the last-applied bounds so we can skip redundant setBounds calls. */
  lastBounds: { x: number; y: number; width: number; height: number } | null
  /** When false, the view is detached (removed from the window) and bounds
   * updates will re-attach it. */
  visible: boolean
  /** True while the view sits in the offscreen park window. */
  parked: boolean
  /** The pane rect the renderer last reported, or a default for a tab that has
   * never been displayed. The view fills it unless a viewport is emulated. */
  paneRect: { x: number; y: number; width: number; height: number }
  /** Emulated viewport (device mode), or null to render at the pane size. */
  viewport: BrowserViewport | null
  /** Last `attached` value pushed to the store, so the 150ms bounds loop only
   * dispatches when it actually changes. */
  attachedReported: boolean
  /** True while we hold a debugger attachment for the emulation overrides.
   * They only survive for as long as the session does, so this stays attached
   * until the emulation is cleared. */
  emulationAttached: boolean
  /** True once we've replaced the user agent, so clearing knows to restore. */
  uaOverridden: boolean
  /** True once any document has committed in the main frame. */
  hasDocument: boolean
  /** Description of the last main-frame load failure, cleared on commit. */
  lastLoadError: string | null
  /** Why the renderer process died, from `render-process-gone`. Cleared when a
   * fresh document commits. */
  crashReason: string | null
}

const CONSOLE_LOG_CAP = 200

/** Viewport for tabs that have never been the visible pane. Without it they'd
 * sit at 0×0, which yields an empty screenshot and an empty clickables list. */
const DEFAULT_VIEW_SIZE = { width: 1280, height: 800 }

const CAPTURE_TIMEOUT_MS = 10_000

function sanitizePartition(worktreePath: string): string {
  return worktreePath.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120)
}

const SPECIAL_KEYS: Record<string, string> = {
  enter: 'Return',
  return: 'Return',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  escape: 'Escape',
  esc: 'Escape',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  space: 'Space'
}

function mapSpecialKey(key: string): string | null {
  return SPECIAL_KEYS[key.trim().toLowerCase()] ?? null
}

const CLICKABLES_SCRIPT = `(() => {
  const SEL = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=checkbox],[role=radio],[role=switch],[role=option],[role=combobox],[role=searchbox],[role=textbox],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"]),[onclick]';
  const MAX = 500;
  function clip(s) { return (s || '').replace(/\\s+/g, ' ').trim().slice(0, 100); }
  function getRole(el) {
    const ex = el.getAttribute('role');
    if (ex) return ex;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      const t = ((el.type || 'text') + '').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
      if (t === 'range') return 'slider';
      return 'textbox';
    }
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'summary') return 'button';
    return tag;
  }
  function getName(el) {
    const al = el.getAttribute('aria-label');
    if (al) return clip(al);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const txt = lb.split(/\\s+/).map(id => {
        const n = document.getElementById(id);
        return n ? n.textContent : '';
      }).join(' ');
      if (txt.trim()) return clip(txt);
    }
    if (el.id) {
      try {
        const lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (lbl && lbl.textContent) return clip(lbl.textContent);
      } catch (e) {}
    }
    const wrap = el.closest && el.closest('label');
    if (wrap && wrap.textContent) return clip(wrap.textContent);
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      if (el.placeholder) return clip(el.placeholder);
      if (el.value) return clip(el.value);
    }
    if (tag === 'img' && el.alt) return clip(el.alt);
    const txt = el.textContent;
    if (txt && txt.trim()) return clip(txt);
    if (el.title) return clip(el.title);
    return '';
  }
  function isVisible(el) {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const op = parseFloat(s.opacity);
    if (!isNaN(op) && op === 0) return false;
    return true;
  }
  // Under mobile emulation a page without a viewport meta tag lays out at 980
  // CSS px and is scaled down to fit the device width, so layout-viewport
  // coordinates (what getBoundingClientRect returns) are not the coordinates
  // click_tab takes or the screenshot shows. Map everything into visual-viewport
  // space, which is the screenshot's space. Identity when nothing is zoomed.
  const vv = window.visualViewport;
  const vs = vv ? vv.scale : 1;
  const vox = vv ? vv.offsetLeft : 0;
  const voy = vv ? vv.offsetTop : 0;
  const vw = vv ? vv.width : window.innerWidth;
  const vh = vv ? vv.height : window.innerHeight;
  const queue = [document];
  const items = [];
  const seen = new Set();
  let truncated = false;
  outer: while (queue.length) {
    const node = queue.shift();
    const matches = node.querySelectorAll(SEL);
    for (const el of matches) {
      if (seen.has(el)) continue;
      seen.add(el);
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (!isVisible(el)) continue;
      if (r.bottom <= voy || r.right <= vox || r.top >= voy + vh || r.left >= vox + vw) continue;
      items.push({
        role: getRole(el),
        name: getName(el),
        cx: Math.round((r.left + r.width / 2 - vox) * vs),
        cy: Math.round((r.top + r.height / 2 - voy) * vs),
        w: Math.round(r.width * vs),
        h: Math.round(r.height * vs)
      });
      if (items.length >= MAX) { truncated = true; break outer; }
    }
    const all = node.querySelectorAll('*');
    for (const el of all) {
      if (el.shadowRoot && el.shadowRoot.mode === 'open') queue.push(el.shadowRoot);
    }
  }
  return {
    viewport: { w: Math.round(vw * vs), h: Math.round(vh * vs), scale: vs },
    scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
    pageHeight: Math.round(document.documentElement.scrollHeight),
    items,
    truncated
  };
})()`;

/**
 * Owns `WebContentsView` instances keyed by browser tab id. Each tab gets
 * its own persistent session partition scoped to its worktree so cookies /
 * localStorage don't leak between worktrees.
 *
 * The renderer sends bounds updates (placeholder div geometry) via IPC; we
 * reposition the underlying view over the BrowserWindow's content area.
 *
 * A view that isn't the visible pane is *parked* in a never-shown window
 * rather than left parentless. A parentless WebContentsView reports a 0×0
 * viewport and has no compositor surface, so `capturePage()` either throws
 * `UnknownVizError` or hands back a stale frame, and viewport-scoped scripts
 * (get_tab_clickables) see an empty page. Parking keeps every tab laid out and
 * rendering, which is what makes screenshots work for background worktrees.
 * The park window is never shown, so nothing flashes and focus never moves.
 */
export class BrowserManager implements BrowserManagerLike {
  private instances = new Map<string, BrowserInstance>()
  private store: Store | null = null
  private parkWindow: BrowserWindow | null = null
  private quitGuardInstalled = false

  setStore(store: Store): void {
    this.store = store
  }

  private ensureParkWindow(): BrowserWindow | null {
    if (this.parkWindow && !this.parkWindow.isDestroyed()) return this.parkWindow
    try {
      this.parkWindow = new BrowserWindow({
        show: false,
        skipTaskbar: true,
        // Frameless + square so the host's title bar and macOS corner rounding
        // don't eat into the region a parked view can paint.
        frame: false,
        roundedCorners: false,
        width: DEFAULT_VIEW_SIZE.width,
        height: DEFAULT_VIEW_SIZE.height
      })
      this.installQuitGuard()
      return this.parkWindow
    } catch (err) {
      this.parkWindow = null
      log('browser', 'park window create failed', err instanceof Error ? err.message : err)
      return null
    }
  }

  /** The park window is a real BrowserWindow, so on Linux/Windows it would
   * suppress 'window-all-closed' and leave the app running headless after the
   * user closes the last real window. Drop it once no real window is left. */
  private installQuitGuard(): void {
    if (this.quitGuardInstalled) return
    this.quitGuardInstalled = true
    const check = (): void => {
      const real = BrowserWindow.getAllWindows().filter(
        (w) => w !== this.parkWindow && !w.isDestroyed()
      )
      if (real.length === 0) this.destroyParkWindow()
    }
    const watch = (w: BrowserWindow): void => {
      if (w !== this.parkWindow) w.once('closed', check)
    }
    for (const w of BrowserWindow.getAllWindows()) watch(w)
    app.on('browser-window-created', (_e, w) => watch(w))
  }

  private destroyParkWindow(): void {
    const win = this.parkWindow
    this.parkWindow = null
    if (!win || win.isDestroyed()) return
    for (const inst of this.instances.values()) {
      if (!inst.parked) continue
      try {
        win.contentView.removeChildView(inst.view)
      } catch {
        // window already tearing down
      }
      inst.parked = false
    }
    win.destroy()
  }

  /** The size a parked view should render at: the emulated viewport when one
   * is set, otherwise whatever the pane last measured. */
  private renderSize(inst: BrowserInstance): { width: number; height: number } {
    if (inst.viewport) {
      return { width: inst.viewport.width, height: inst.viewport.height }
    }
    return { width: inst.paneRect.width, height: inst.paneRect.height }
  }

  /** Put a hidden view into the park window so it keeps a viewport + surface. */
  private park(inst: BrowserInstance, force = false): void {
    if (!force && inst.parked && this.parkWindow && !this.parkWindow.isDestroyed()) return
    const host = this.ensureParkWindow()
    if (!host) return
    const size = this.renderSize(inst)
    try {
      // A view only paints the part of itself that fits inside its host window,
      // so a tab parked at pane size in a smaller host comes back half black.
      const { width, height } = host.getContentBounds()
      if (width < size.width || height < size.height) {
        host.setContentSize(Math.max(width, size.width), Math.max(height, size.height))
      }
      host.contentView.addChildView(inst.view)
      inst.view.setBounds({ x: 0, y: 0, ...size })
      inst.parked = true
    } catch (err) {
      inst.parked = false
      log('browser', 'park failed', err instanceof Error ? err.message : err)
    }
  }

  private unpark(inst: BrowserInstance): void {
    if (!inst.parked) return
    inst.parked = false
    const win = this.parkWindow
    if (!win || win.isDestroyed()) return
    try {
      win.contentView.removeChildView(inst.view)
    } catch {
      // window already gone
    }
  }

  hasTab(tabId: string): boolean {
    return this.instances.has(tabId)
  }

  listAllTabIds(): string[] {
    return [...this.instances.keys()]
  }

  getWorktreePath(tabId: string): string | null {
    return this.instances.get(tabId)?.worktreePath ?? null
  }

  /** Return all tab ids whose worktreePath matches. */
  listTabsForWorktree(worktreePath: string): string[] {
    const out: string[] = []
    for (const [id, inst] of this.instances) {
      if (inst.worktreePath === worktreePath) out.push(id)
    }
    return out
  }

  getConsoleLogs(tabId: string): ConsoleLog[] {
    return this.instances.get(tabId)?.logs.slice() ?? []
  }

  getUrl(tabId: string): string | null {
    const inst = this.instances.get(tabId)
    if (!inst) return null
    return inst.view.webContents.getURL()
  }

  create(tabId: string, worktreePath: string, url: string): void {
    if (this.instances.has(tabId)) return
    log('browser', `create tab=${tabId} wt=${worktreePath} url=${url}`)
    const part = `persist:wt-${sanitizePartition(worktreePath)}`
    const ses = session.fromPartition(part)
    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    view.setBackgroundColor('#00000000')

    const inst: BrowserInstance = {
      view,
      worktreePath,
      attachedWindow: null,
      logs: [],
      lastBounds: null,
      visible: false,
      parked: false,
      paneRect: { x: 0, y: 0, ...DEFAULT_VIEW_SIZE },
      viewport: null,
      attachedReported: false,
      emulationAttached: false,
      uaOverridden: false,
      hasDocument: false,
      lastLoadError: null,
      crashReason: null
    }
    this.instances.set(tabId, inst)
    this.wireEvents(tabId, inst)
    // Park before the first load so the page lays out against a real viewport
    // even if this tab is never displayed.
    this.park(inst)

    const initialUrl = normalizeBrowserUrl(url) ?? 'about:blank'
    this.dispatchState(tabId, { url: initialUrl, loading: true })
    view.webContents.loadURL(initialUrl).catch((err) => {
      log('browser', `loadURL failed tab=${tabId}`, err instanceof Error ? err.message : err)
    })
  }

  private wireEvents(tabId: string, inst: BrowserInstance): void {
    const wc = inst.view.webContents
    const nav = (): void => {
      this.dispatchState(tabId, {
        url: wc.getURL(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward()
      })
    }
    wc.on('did-navigate', nav)
    wc.on('did-navigate-in-page', nav)
    wc.on('dom-ready', () => {
      inst.hasDocument = true
      inst.lastLoadError = null
      inst.crashReason = null
      // Emulation survives ordinary navigations, but not a renderer that was
      // replaced after a crash. Re-asserting it is one idempotent CDP call on
      // the few tabs that have an override at all.
      if (inst.viewport) {
        void this.applyEmulation(inst).catch(() => {})
      }
    })
    wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // ERR_ABORTED means a newer navigation superseded this one, not a failure.
      if (!isMainFrame || errorCode === -3) return
      inst.lastLoadError = `${errorDescription} (${errorCode}) loading ${validatedURL}`
      log('browser', `did-fail-load tab=${tabId}`, inst.lastLoadError)
    })
    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return
      inst.crashReason = details.reason
      log('browser', `render-process-gone tab=${tabId}`, details.reason)
    })
    wc.on('did-start-loading', () => {
      this.dispatchState(tabId, { loading: true })
    })
    wc.on('did-stop-loading', () => {
      this.dispatchState(tabId, {
        loading: false,
        url: wc.getURL(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward()
      })
    })
    wc.on('page-title-updated', (_e, title) => {
      this.dispatchState(tabId, { title })
    })
    wc.on('console-message', (event) => {
      const levelMap: Record<string, ConsoleLog['level']> = {
        verbose: 'debug',
        info: 'info',
        warning: 'warn',
        error: 'error'
      }
      const level = levelMap[event.level] ?? 'log'
      inst.logs.push({ ts: Date.now(), level, message: event.message })
      while (inst.logs.length > CONSOLE_LOG_CAP) inst.logs.shift()
    })
  }

  private dispatchState(
    tabId: string,
    patch: Partial<{
      url: string
      title: string
      canGoBack: boolean
      canGoForward: boolean
      loading: boolean
      attached: boolean
      viewport: BrowserViewport | null
    }>
  ): void {
    this.store?.dispatch({
      type: 'browser/tabStateChanged',
      payload: { tabId, state: patch }
    })
  }

  destroy(tabId: string): void {
    const inst = this.instances.get(tabId)
    if (!inst) return
    log('browser', `destroy tab=${tabId}`)
    this.detachView(tabId, inst)
    if (inst.emulationAttached) {
      inst.emulationAttached = false
      try {
        if (inst.view.webContents.debugger.isAttached()) inst.view.webContents.debugger.detach()
      } catch {
        // already gone
      }
    }
    try {
      inst.view.webContents.close()
    } catch {
      // already gone
    }
    this.instances.delete(tabId)
    this.store?.dispatch({ type: 'browser/tabRemoved', payload: tabId })
  }

  destroyAllForWorktree(worktreePath: string): void {
    for (const [id, inst] of [...this.instances]) {
      if (inst.worktreePath === worktreePath) this.destroy(id)
    }
  }

  navigate(tabId: string, url: string): void {
    const inst = this.instances.get(tabId)
    if (!inst) return
    const normalized = normalizeBrowserUrl(url)
    if (!normalized) return
    inst.view.webContents.loadURL(normalized).catch((err) => {
      log('browser', `navigate failed tab=${tabId}`, err instanceof Error ? err.message : err)
    })
  }

  back(tabId: string): void {
    const inst = this.instances.get(tabId)
    if (!inst) return
    if (inst.view.webContents.navigationHistory.canGoBack()) {
      inst.view.webContents.navigationHistory.goBack()
    }
  }

  forward(tabId: string): void {
    const inst = this.instances.get(tabId)
    if (!inst) return
    if (inst.view.webContents.navigationHistory.canGoForward()) {
      inst.view.webContents.navigationHistory.goForward()
    }
  }

  reload(tabId: string): void {
    this.instances.get(tabId)?.view.webContents.reload()
  }

  openDevTools(tabId: string): void {
    const inst = this.instances.get(tabId)
    if (!inst) return
    if (inst.view.webContents.isDevToolsOpened()) {
      inst.view.webContents.closeDevTools()
    } else {
      inst.view.webContents.openDevTools({ mode: 'detach' })
    }
  }

  getViewport(tabId: string): BrowserViewport | null {
    return this.instances.get(tabId)?.viewport ?? null
  }

  /**
   * Emulate a viewport (device mode) for this tab, or clear it with null.
   *
   * This is Chromium's own device emulation over CDP, not a window resize: the
   * page lays out at exactly `viewport` no matter how big the pane is, honours
   * `<meta name="viewport">` when `mobile` is set, and reports the emulated
   * size to `window.innerWidth` — which is what makes get_tab_clickables and
   * screenshots agree with each other.
   *
   * The overrides live on the CDP session, so the debugger attachment is held
   * for as long as the emulation is active and dropped when it's cleared.
   */
  async setViewport(
    tabId: string,
    viewport: BrowserViewport | null,
    opts?: { reload?: boolean }
  ): Promise<void> {
    const inst = this.instances.get(tabId)
    if (!inst) throw new Error('tab not found')
    const prev = inst.viewport
    // The UA and touch support are read by pages at load time, so the document
    // already on screen won't reflect either until it is fetched again — which
    // is the difference between seeing a site's mobile page and seeing its
    // desktop page shrunk into a phone-sized window.
    const needsReload =
      (prev?.userAgent ?? '') !== (viewport?.userAgent ?? '') ||
      (prev?.mobile ?? false) !== (viewport?.mobile ?? false)
    inst.viewport = viewport
    await this.applyEmulation(inst)
    this.dispatchState(tabId, { viewport })
    // Re-letterbox (or restore) the native view under the new size.
    if (inst.visible && inst.attachedWindow) {
      this.setBounds(tabId, inst.attachedWindow, inst.paneRect)
    } else {
      this.park(inst, true)
    }
    if (opts?.reload || needsReload) inst.view.webContents.reload()
  }

  private async applyEmulation(inst: BrowserInstance): Promise<void> {
    const wc = inst.view.webContents
    if (wc.isDestroyed()) return
    const dbg = wc.debugger
    const vp = inst.viewport

    if (!vp) {
      if (!inst.emulationAttached) return
      try {
        if (dbg.isAttached()) {
          await dbg.sendCommand('Emulation.clearDeviceMetricsOverride')
          await dbg.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false })
          if (inst.uaOverridden) {
            await dbg.sendCommand('Emulation.setUserAgentOverride', {
              userAgent: wc.getUserAgent()
            })
          }
        }
      } finally {
        inst.emulationAttached = false
        inst.uaOverridden = false
        try {
          if (dbg.isAttached()) dbg.detach()
        } catch {
          // webContents already gone
        }
      }
      return
    }

    if (!dbg.isAttached()) {
      try {
        dbg.attach('1.3')
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(
          `could not start viewport emulation (${message}) — close this tab's DevTools and retry`
        )
      }
    }
    inst.emulationAttached = true
    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: vp.deviceScaleFactor,
      mobile: vp.mobile,
      screenWidth: vp.width,
      screenHeight: vp.height
    })
    await dbg.sendCommand('Emulation.setTouchEmulationEnabled', {
      enabled: vp.mobile,
      maxTouchPoints: vp.mobile ? 5 : 1
    })
    if (vp.userAgent) {
      await dbg.sendCommand('Emulation.setUserAgentOverride', { userAgent: vp.userAgent })
      inst.uaOverridden = true
    } else if (inst.uaOverridden) {
      await dbg.sendCommand('Emulation.setUserAgentOverride', { userAgent: wc.getUserAgent() })
      inst.uaOverridden = false
    }
  }

  setBounds(
    tabId: string,
    targetWindow: unknown,
    bounds: { x: number; y: number; width: number; height: number }
  ): void {
    const inst = this.instances.get(tabId)
    if (!inst) return
    const win = targetWindow as BrowserWindow
    const pane = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height))
    }
    if (!inst.visible || inst.attachedWindow !== win) {
      this.detachView(tabId, inst)
      win.contentView.addChildView(inst.view)
      inst.attachedWindow = win
      inst.visible = true
    }
    if (pane.width >= 1 && pane.height >= 1) {
      inst.paneRect = pane
    }
    const rounded = emulatedViewRect(pane, inst.viewport)
    if (
      !inst.lastBounds ||
      inst.lastBounds.x !== rounded.x ||
      inst.lastBounds.y !== rounded.y ||
      inst.lastBounds.width !== rounded.width ||
      inst.lastBounds.height !== rounded.height
    ) {
      inst.view.setBounds(rounded)
      inst.lastBounds = rounded
    }
    this.reportAttached(tabId, inst, true)
  }

  hide(tabId: string): void {
    const inst = this.instances.get(tabId)
    if (!inst) return
    this.detachView(tabId, inst)
    this.park(inst)
  }

  /** Report whether the native view is currently parented to a real window.
   * Dispatches only on change — setBounds runs several times a second. */
  private reportAttached(tabId: string, inst: BrowserInstance, attached: boolean): void {
    if (inst.attachedReported === attached) return
    inst.attachedReported = attached
    this.dispatchState(tabId, { attached })
  }

  private detachView(tabId: string, inst: BrowserInstance): void {
    this.reportAttached(tabId, inst, false)
    this.unpark(inst)
    if (!inst.visible || !inst.attachedWindow) return
    try {
      inst.attachedWindow.contentView.removeChildView(inst.view)
    } catch {
      // window may have been destroyed
    }
    inst.attachedWindow = null
    inst.visible = false
    inst.lastBounds = null
  }

  clickTab(
    tabId: string,
    x: number,
    y: number,
    options?: { button?: 'left' | 'right' | 'middle'; clickCount?: number }
  ): void {
    const inst = this.instances.get(tabId)
    if (!inst) return
    const wc = inst.view.webContents
    const button = options?.button ?? 'left'
    const clickCount = Math.max(1, Math.min(3, options?.clickCount ?? 1))
    wc.sendInputEvent({ type: 'mouseMove', x, y })
    wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount })
    wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount })
    void this.showCursor(tabId, x, y, { pulse: true })
  }

  typeTab(tabId: string, text: string, key?: string): void {
    const inst = this.instances.get(tabId)
    if (!inst) return
    const wc = inst.view.webContents

    if (key) {
      const mapped = mapSpecialKey(key)
      if (mapped) {
        wc.sendInputEvent({ type: 'keyDown', keyCode: mapped })
        wc.sendInputEvent({ type: 'keyUp', keyCode: mapped })
      }
    }

    if (text) {
      for (const ch of text) {
        if (ch === '\n') {
          wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
          wc.sendInputEvent({ type: 'char', keyCode: '\r' })
          wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
          continue
        }
        if (ch === '\t') {
          wc.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
          wc.sendInputEvent({ type: 'char', keyCode: '\t' })
          wc.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
          continue
        }
        wc.sendInputEvent({ type: 'keyDown', keyCode: ch })
        wc.sendInputEvent({ type: 'char', keyCode: ch })
        wc.sendInputEvent({ type: 'keyUp', keyCode: ch })
      }
    }
  }

  async scrollTab(tabId: string, deltaX: number, deltaY: number): Promise<void> {
    const inst = this.instances.get(tabId)
    if (!inst) return
    await this.evalInTab(
      tabId,
      inst,
      `window.scrollBy(${Number(deltaX) || 0}, ${Number(deltaY) || 0})`,
      'scrollTab'
    ).catch(() => {})
  }

  async showCursor(
    tabId: string,
    x: number,
    y: number,
    opts?: { pulse?: boolean }
  ): Promise<void> {
    const inst = this.instances.get(tabId)
    if (!inst) return
    const px = Math.round(Number(x) || 0)
    const py = Math.round(Number(y) || 0)
    const pulse = opts?.pulse ? 1 : 0
    const script = `(() => {
      const ID = '__harness_cursor__';
      let el = document.getElementById(ID);
      if (!el) {
        el = document.createElement('div');
        el.id = ID;
        el.style.cssText = 'position:fixed;left:0;top:0;width:24px;height:24px;pointer-events:none;z-index:2147483647;transition:transform 60ms linear;will-change:transform;';
        el.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))"><path d="M3 2 L17 13 L11 14 L8 21 Z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>';
        (document.body || document.documentElement).appendChild(el);
      }
      el.style.transform = 'translate(${px}px,${py}px)';
      if (${pulse}) {
        const ringId = '__harness_cursor_ring__';
        let ring = document.getElementById(ringId);
        if (!ring) {
          ring = document.createElement('div');
          ring.id = ringId;
          ring.style.cssText = 'position:fixed;left:0;top:0;width:20px;height:20px;border-radius:9999px;pointer-events:none;z-index:2147483646;border:2px solid rgba(56,189,248,.9);background:rgba(56,189,248,.2);';
          (document.body || document.documentElement).appendChild(ring);
        }
        ring.style.transform = 'translate(${px - 10}px,${py - 10}px) scale(.4)';
        ring.style.opacity = '1';
        ring.animate(
          [
            { transform: 'translate(${px - 10}px,${py - 10}px) scale(.4)', opacity: 1 },
            { transform: 'translate(${px - 20}px,${py - 20}px) scale(2)', opacity: 0 }
          ],
          { duration: 380, easing: 'ease-out', fill: 'forwards' }
        );
      }
    })()`
    await this.evalInTab(tabId, inst, script, 'showCursor').catch(() => {})
  }

  /** Every executeJavaScript call goes through here. A tab with a dead
   * renderer can never run script, and one that is merely slow must not wedge
   * the caller forever — see browser-eval.ts. Rejects so the control server
   * turns the reason into a 500 the agent can act on. */
  private async evalInTab(
    tabId: string,
    inst: BrowserInstance,
    script: string,
    what: string
  ): Promise<unknown> {
    const wc = inst.view.webContents
    const blocked = evalBlockedReason({
      hasDocument: inst.hasDocument,
      lastLoadError: inst.lastLoadError,
      crashed: inst.crashReason !== null || (!wc.isDestroyed() && wc.isCrashed()),
      crashReason: inst.crashReason
    })
    if (blocked) {
      log('browser', `${what} unusable tab=${tabId}`, blocked)
      throw new Error(blocked)
    }
    try {
      return await evalWithTimeout(() => wc.executeJavaScript(script), `${what} tab=${tabId}`)
    } catch (err) {
      log('browser', `${what} failed tab=${tabId}`, err instanceof Error ? err.message : err)
      throw err
    }
  }

  async getClickables(tabId: string): Promise<unknown | null> {
    const inst = this.instances.get(tabId)
    if (!inst) return null
    if (!inst.visible) this.park(inst)
    const result = await this.evalInTab(tabId, inst, CLICKABLES_SCRIPT, 'getClickables')
    // The script only reports in-viewport elements, so a 0×0 viewport looks
    // like "this page has no buttons" rather than a failure.
    const viewport = (result as { viewport?: { w: number; h: number } } | null)?.viewport
    if (viewport && (viewport.w < 1 || viewport.h < 1)) {
      log('browser', `getClickables tab=${tabId} has a ${viewport.w}x${viewport.h} viewport`)
    }
    return result ?? null
  }

  /** Render a view that isn't on screen.
   *
   * `webContents.capturePage()` reads the compositor surface, which a hidden
   * view doesn't have — it throws, or worse returns the last frame from before
   * the tab was hidden. CDP's Page.captureScreenshot with `fromSurface: false`
   * renders in the renderer process instead, so it stays correct for a parked
   * tab. It does still need the view to be parented, hence the park window.
   */
  private async captureOffscreen(inst: BrowserInstance): Promise<NativeImage> {
    const dbg = inst.view.webContents.debugger
    const wasAttached = dbg.isAttached()
    if (!wasAttached) dbg.attach('1.3')
    let timer: NodeJS.Timeout | undefined
    try {
      const shot = dbg.sendCommand('Page.captureScreenshot', {
        format: 'png',
        fromSurface: false,
        captureBeyondViewport: false
      }) as Promise<{ data?: string }>
      const result = await Promise.race([
        shot,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Page.captureScreenshot timed out after ${CAPTURE_TIMEOUT_MS}ms`)),
            CAPTURE_TIMEOUT_MS
          )
        })
      ])
      return nativeImage.createFromBuffer(Buffer.from(result?.data ?? '', 'base64'))
    } finally {
      clearTimeout(timer)
      // Leaving the debugger attached would block DevTools on this tab.
      if (!wasAttached && dbg.isAttached()) {
        try {
          dbg.detach()
        } catch {
          // webContents already gone
        }
      }
    }
  }

  async capturePage(
    tabId: string,
    opts?: { format?: 'jpeg' | 'png'; quality?: number }
  ): Promise<CaptureResult | null> {
    const inst = this.instances.get(tabId)
    if (!inst) return null
    // Self-heal a tab whose park window went away (macOS closes all windows
    // without quitting) so capture isn't permanently broken afterwards.
    if (!inst.visible) this.park(inst)
    const vp = inst.viewport
    // Under emulation the page is the emulated size, not the widget's.
    const bounds = vp ? { width: vp.width, height: vp.height } : inst.view.getBounds()
    const viewportError = viewportCaptureError(bounds)
    if (viewportError) {
      log('browser', `capturePage unusable tab=${tabId}`, viewportError)
      return { error: viewportError }
    }
    // An emulated viewport taller than the pane only paints down to the window
    // edge, so an on-screen capture would come back part blank. Park it in the
    // offscreen window (which grows to fit) for the shot and hand it back after.
    const restoreTo =
      inst.visible && !canSurfaceCapture(inst.view.getBounds(), vp)
        ? { win: inst.attachedWindow, rect: inst.paneRect }
        : null
    if (restoreTo) {
      this.detachView(tabId, inst)
      this.park(inst, true)
    }
    try {
      let image: NativeImage | null = null
      if (inst.visible) {
        try {
          image = await inst.view.webContents.capturePage()
        } catch (err) {
          // Minimized / occluded windows lose their surface too; the offscreen
          // path below still works because the view is parented.
          log(
            'browser',
            `capturePage surface miss tab=${tabId}`,
            err instanceof Error ? err.message : err
          )
        }
      }
      if (!image || image.isEmpty()) image = await this.captureOffscreen(inst)

      const { outputSize } = resolveScreenshotTarget(bounds)
      const captured = image.getSize()
      const normalized =
        captured.width === outputSize.width && captured.height === outputSize.height
          ? image
          : image.resize({ width: outputSize.width, height: outputSize.height })
      const format = opts?.format === 'png' ? 'png' : 'jpeg'
      const q = Math.max(1, Math.min(100, Math.round(opts?.quality ?? 70)))
      const buf = format === 'png' ? normalized.toPNG() : normalized.toJPEG(q)
      const encodedError = encodedCaptureError(normalized.getSize(), buf.length)
      if (encodedError) {
        log('browser', `capturePage produced no image tab=${tabId}`, encodedError)
        return { error: encodedError }
      }
      return { data: buf.toString('base64'), format }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log('browser', `capturePage failed tab=${tabId}`, message)
      return { error: `capture failed: ${message}` }
    } finally {
      if (restoreTo?.win && !restoreTo.win.isDestroyed()) {
        this.setBounds(tabId, restoreTo.win, restoreTo.rect)
      }
    }
  }

  async getDom(tabId: string): Promise<string | null> {
    const inst = this.instances.get(tabId)
    if (!inst) return null
    const result = await this.evalInTab(
      tabId,
      inst,
      'document.documentElement.outerHTML',
      'getDom'
    )
    return typeof result === 'string' ? result : null
  }

  getTabInfo(tabId: string): {
    id: string
    url: string
    title: string
    viewport: BrowserViewport | null
  } | null {
    const inst = this.instances.get(tabId)
    if (!inst) return null
    return {
      id: tabId,
      url: inst.view.webContents.getURL(),
      title: inst.view.webContents.getTitle(),
      viewport: inst.viewport
    }
  }

  destroyAll(): void {
    for (const id of [...this.instances.keys()]) this.destroy(id)
    this.destroyParkWindow()
  }
}
