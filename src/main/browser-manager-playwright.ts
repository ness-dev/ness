// Playwright-backed browser manager. Mirrors the WebContentsView-backed
// BrowserManager (src/main/browser-manager.ts) so every MCP tool, every
// control-server endpoint, and the pane-tree reconciler can call the
// same surface in either runtime.
//
// Loaded only in headless mode. The Electron path keeps using
// WebContentsView; nothing in this file is reachable from the Electron
// build at runtime even though the import graph stays static, because
// index.ts picks the implementation by `detectRuntime()`.
//
// Browser lifecycle: a single Chromium process launched lazily on the
// first `create()` call and shared across every tab. Each tab gets its
// own BrowserContext so cookies / localStorage stay isolated, matching
// the per-worktree session-partition split the Electron impl uses.
//
// Browser binary resolution: try `HARNESS_PLAYWRIGHT_BROWSER` first,
// then `channel: 'chrome'` (Playwright's auto-discovery of system
// Chrome). If neither resolves, the first create call throws with a
// message that tells the user how to fix it. We deliberately don't
// bundle a Chromium download — the headless build stays small.

import { createRequire } from 'module'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import type { BrowserManagerLike, CaptureResult, ConsoleLog } from './browser-manager-types'
import type { Store } from './store'
import { log } from './debug'
import { normalizeBrowserUrl } from './browser-url'
import { evalWithTimeout } from './browser-eval'

const CONSOLE_LOG_CAP = 200

const VIEWPORT = { width: 1280, height: 800 }

// Same script the Electron BrowserManager uses; kept inline so this file
// can't accidentally pull browser-manager.ts (which imports `electron`)
// into the headless bundle.
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
      if (r.bottom <= 0 || r.right <= 0 || r.top >= window.innerHeight || r.left >= window.innerWidth) continue;
      items.push({
        role: getRole(el),
        name: getName(el),
        cx: Math.round(r.left + r.width / 2),
        cy: Math.round(r.top + r.height / 2),
        w: Math.round(r.width),
        h: Math.round(r.height)
      });
      if (items.length >= MAX) { truncated = true; break outer; }
    }
    const all = node.querySelectorAll('*');
    for (const el of all) {
      if (el.shadowRoot && el.shadowRoot.mode === 'open') queue.push(el.shadowRoot);
    }
  }
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
    pageHeight: Math.round(document.documentElement.scrollHeight),
    items,
    truncated
  };
})()`

const CURSOR_SCRIPT = (px: number, py: number, pulse: number): string => `(() => {
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

const SPECIAL_KEYS: Record<string, string> = {
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  escape: 'Escape',
  esc: 'Escape',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  space: 'Space'
}

function mapSpecialKey(key: string): string | null {
  return SPECIAL_KEYS[key.trim().toLowerCase()] ?? null
}

interface BrowserInstance {
  context: BrowserContext
  page: Page
  worktreePath: string
  logs: ConsoleLog[]
  lastTitle: string
}

type PlaywrightModule = typeof import('playwright-core')

let cachedPlaywright: PlaywrightModule | null = null
function loadPlaywright(): PlaywrightModule {
  if (cachedPlaywright) return cachedPlaywright
  // createRequire keeps the import out of any bundler graph that doesn't
  // already mark playwright-core as external — same pattern paths.ts
  // uses for `electron`.
  const dynamicRequire = createRequire(__filename)
  cachedPlaywright = dynamicRequire('playwright-core') as PlaywrightModule
  return cachedPlaywright
}

export class PlaywrightBrowserManager implements BrowserManagerLike {
  private instances = new Map<string, BrowserInstance>()
  private pendingTabIds = new Set<string>()
  private store: Store | null = null
  private browser: Browser | null = null
  private launching: Promise<Browser> | null = null

  setStore(store: Store): void {
    this.store = store
  }

  hasTab(tabId: string): boolean {
    return this.instances.has(tabId) || this.pendingTabIds.has(tabId)
  }

  listAllTabIds(): string[] {
    return [...this.instances.keys()]
  }

  listTabsForWorktree(worktreePath: string): string[] {
    const out: string[] = []
    for (const [id, inst] of this.instances) {
      if (inst.worktreePath === worktreePath) out.push(id)
    }
    return out
  }

  getWorktreePath(tabId: string): string | null {
    return this.instances.get(tabId)?.worktreePath ?? null
  }

  getConsoleLogs(tabId: string): ConsoleLog[] {
    return this.instances.get(tabId)?.logs.slice() ?? []
  }

  getUrl(tabId: string): string | null {
    const inst = this.instances.get(tabId)
    if (!inst) return null
    try {
      return inst.page.url()
    } catch {
      return null
    }
  }

  getTabInfo(tabId: string): { id: string; url: string; title: string } | null {
    const inst = this.instances.get(tabId)
    if (!inst) return null
    let url = ''
    try {
      url = inst.page.url()
    } catch {
      url = ''
    }
    return { id: tabId, url, title: inst.lastTitle }
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser
    if (this.launching) return this.launching

    this.launching = (async () => {
      const { chromium } = loadPlaywright()
      const explicit = process.env['HARNESS_PLAYWRIGHT_BROWSER']
      const launchErrors: string[] = []
      try {
        if (explicit && explicit.trim()) {
          log('browser-playwright', `launching browser via HARNESS_PLAYWRIGHT_BROWSER=${explicit}`)
          return await chromium.launch({ headless: true, executablePath: explicit.trim() })
        }
        log('browser-playwright', 'launching system Chrome via channel:chrome')
        return await chromium.launch({ headless: true, channel: 'chrome' })
      } catch (err) {
        launchErrors.push(err instanceof Error ? err.message : String(err))
        throw new Error(
          'Playwright browser not found. Install Chrome or set HARNESS_PLAYWRIGHT_BROWSER ' +
            'to a Chromium executable path. Underlying error: ' +
            launchErrors.join('; ')
        )
      }
    })()
      .then((browser) => {
        this.browser = browser
        this.launching = null
        browser.on('disconnected', () => {
          if (this.browser === browser) this.browser = null
        })
        return browser
      })
      .catch((err) => {
        this.launching = null
        throw err
      })

    return this.launching
  }

  create(tabId: string, worktreePath: string, url: string): void {
    if (this.hasTab(tabId)) return
    log('browser-playwright', `create tab=${tabId} wt=${worktreePath} url=${url}`)
    this.pendingTabIds.add(tabId)
    const initialUrl = normalizeBrowserUrl(url) ?? 'about:blank'
    this.dispatchState(tabId, { url: initialUrl, loading: true })
    void this.createAsync(tabId, worktreePath, initialUrl).catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      log('browser-playwright', `create failed tab=${tabId}`, message)
      this.dispatchState(tabId, { loading: false, error: message })
    })
  }

  private async createAsync(tabId: string, worktreePath: string, initialUrl: string): Promise<void> {
    let browser: Browser
    try {
      browser = await this.ensureBrowser()
    } finally {
      // ensureBrowser may have failed; if so we need to clear the
      // pending marker so a retry can re-attempt.
    }
    if (!this.pendingTabIds.has(tabId)) {
      // destroy() was called while we were waiting for the browser.
      return
    }
    let context: BrowserContext
    try {
      context = await browser.newContext({ viewport: VIEWPORT })
    } catch (err) {
      this.pendingTabIds.delete(tabId)
      throw err
    }
    if (!this.pendingTabIds.has(tabId)) {
      void context.close().catch(() => {})
      return
    }
    let page: Page
    try {
      page = await context.newPage()
    } catch (err) {
      void context.close().catch(() => {})
      this.pendingTabIds.delete(tabId)
      throw err
    }
    const inst: BrowserInstance = {
      context,
      page,
      worktreePath,
      logs: [],
      lastTitle: ''
    }
    this.instances.set(tabId, inst)
    this.pendingTabIds.delete(tabId)
    this.wireEvents(tabId, inst)

    page.goto(initialUrl).catch((err) => {
      log(
        'browser-playwright',
        `goto failed tab=${tabId}`,
        err instanceof Error ? err.message : err
      )
      this.dispatchState(tabId, { loading: false })
    })
  }

  private wireEvents(tabId: string, inst: BrowserInstance): void {
    inst.page.on('framenavigated', (frame) => {
      if (frame !== inst.page.mainFrame()) return
      const url = frame.url()
      this.dispatchState(tabId, { url, loading: true })
    })
    inst.page.on('load', () => {
      const url = inst.page.url()
      this.dispatchState(tabId, { loading: false, url })
      void inst.page
        .title()
        .then((title) => {
          inst.lastTitle = title
          this.dispatchState(tabId, { title })
        })
        .catch(() => {})
    })
    inst.page.on('console', (msg) => {
      const levelMap: Record<string, ConsoleLog['level']> = {
        verbose: 'debug',
        info: 'info',
        warning: 'warn',
        warn: 'warn',
        error: 'error',
        log: 'log',
        debug: 'debug'
      }
      const level = levelMap[msg.type()] ?? 'log'
      inst.logs.push({ ts: Date.now(), level, message: msg.text() })
      while (inst.logs.length > CONSOLE_LOG_CAP) inst.logs.shift()
    })
    inst.page.on('crash', () => {
      log('browser-playwright', `page crashed tab=${tabId}`)
    })
    inst.page.on('close', () => {
      this.dispatchState(tabId, { loading: false })
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
      error: string | undefined
    }>
  ): void {
    this.store?.dispatch({
      type: 'browser/tabStateChanged',
      payload: { tabId, state: patch }
    })
  }

  destroy(tabId: string): void {
    if (this.pendingTabIds.has(tabId)) {
      // create is still in-flight; mark cancelled so createAsync will
      // discard the BrowserContext when it resolves.
      this.pendingTabIds.delete(tabId)
      this.store?.dispatch({ type: 'browser/tabRemoved', payload: tabId })
      return
    }
    const inst = this.instances.get(tabId)
    if (!inst) return
    log('browser-playwright', `destroy tab=${tabId}`)
    this.instances.delete(tabId)
    inst.context.close().catch((err) => {
      log(
        'browser-playwright',
        `context close failed tab=${tabId}`,
        err instanceof Error ? err.message : err
      )
    })
    this.store?.dispatch({ type: 'browser/tabRemoved', payload: tabId })
  }

  destroyAllForWorktree(worktreePath: string): void {
    for (const [id, inst] of [...this.instances]) {
      if (inst.worktreePath === worktreePath) this.destroy(id)
    }
  }

  destroyAll(): void {
    for (const id of [...this.instances.keys()]) this.destroy(id)
    if (this.browser) {
      const b = this.browser
      this.browser = null
      b.close().catch(() => {})
    }
  }

  navigate(tabId: string, url: string): void {
    const inst = this.instances.get(tabId)
    if (!inst) return
    const normalized = normalizeBrowserUrl(url)
    if (!normalized) return
    this.dispatchState(tabId, { loading: true })
    inst.page.goto(normalized).catch((err) => {
      log(
        'browser-playwright',
        `navigate failed tab=${tabId}`,
        err instanceof Error ? err.message : err
      )
      this.dispatchState(tabId, { loading: false })
    })
  }

  back(tabId: string): void {
    const inst = this.instances.get(tabId)
    if (!inst) return
    inst.page.goBack().catch(() => {})
  }

  forward(tabId: string): void {
    const inst = this.instances.get(tabId)
    if (!inst) return
    inst.page.goForward().catch(() => {})
  }

  reload(tabId: string): void {
    const inst = this.instances.get(tabId)
    if (!inst) return
    inst.page.reload().catch(() => {})
  }

  openDevTools(_tabId: string): void {
    // Headless Chromium can't display devtools UI. The MCP-driven
    // workflow doesn't need it; users debug via screenshots + DOM dumps.
  }

  hide(_tabId: string): void {
    // No native overlay to detach in headless mode.
  }

  setBounds(
    _tabId: string,
    _targetWindow: unknown,
    _bounds: { x: number; y: number; width: number; height: number }
  ): void {
    // Viewport stays at the fixed VIEWPORT size; renderer scales
    // screenshots to the panel area.
  }

  clickTab(
    tabId: string,
    x: number,
    y: number,
    options?: { button?: 'left' | 'right' | 'middle'; clickCount?: number }
  ): void {
    const inst = this.instances.get(tabId)
    if (!inst) return
    const button = options?.button ?? 'left'
    const clickCount = Math.max(1, Math.min(3, options?.clickCount ?? 1))
    inst.page.mouse
      .click(x, y, { button, clickCount })
      .catch((err) =>
        log(
          'browser-playwright',
          `click failed tab=${tabId}`,
          err instanceof Error ? err.message : err
        )
      )
    void this.showCursor(tabId, x, y, { pulse: true })
  }

  typeTab(tabId: string, text: string, key?: string): void {
    const inst = this.instances.get(tabId)
    if (!inst) return
    void (async () => {
      try {
        if (key) {
          const mapped = mapSpecialKey(key)
          if (mapped) await inst.page.keyboard.press(mapped)
        }
        if (text) {
          await inst.page.keyboard.type(text)
        }
      } catch (err) {
        log(
          'browser-playwright',
          `type failed tab=${tabId}`,
          err instanceof Error ? err.message : err
        )
      }
    })()
  }

  async scrollTab(tabId: string, deltaX: number, deltaY: number): Promise<void> {
    const inst = this.instances.get(tabId)
    if (!inst) return
    await evalWithTimeout(
      () =>
        inst.page.evaluate(({ dx, dy }) => window.scrollBy(dx, dy), {
          dx: Number(deltaX) || 0,
          dy: Number(deltaY) || 0
        }),
      `scroll tab=${tabId}`
    ).catch((err: unknown) => {
      log(
        'browser-playwright',
        `scroll failed tab=${tabId}`,
        err instanceof Error ? err.message : err
      )
    })
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
    await evalWithTimeout(
      () => inst.page.evaluate(CURSOR_SCRIPT(px, py, pulse)),
      `showCursor tab=${tabId}`
    ).catch((err: unknown) => {
      log(
        'browser-playwright',
        `showCursor failed tab=${tabId}`,
        err instanceof Error ? err.message : err
      )
    })
  }

  // A Playwright page always has a committed document (about:blank at worst),
  // so the frameless never-settles hang the Electron backend guards against
  // can't happen here — but page.evaluate has no timeout of its own, so bound
  // it anyway to keep the two backends behaving the same under a wedged page.
  async getClickables(tabId: string): Promise<unknown | null> {
    const inst = this.instances.get(tabId)
    if (!inst) return null
    return await evalWithTimeout(
      () => inst.page.evaluate(CLICKABLES_SCRIPT),
      `getClickables tab=${tabId}`
    ).catch((err: unknown) => {
      log(
        'browser-playwright',
        `getClickables failed tab=${tabId}`,
        err instanceof Error ? err.message : err
      )
      throw err
    })
  }

  async capturePage(
    tabId: string,
    opts?: { format?: 'jpeg' | 'png'; quality?: number }
  ): Promise<CaptureResult | null> {
    const inst = this.instances.get(tabId)
    if (!inst) return null
    try {
      const format = opts?.format === 'png' ? 'png' : 'jpeg'
      const q = Math.max(1, Math.min(100, Math.round(opts?.quality ?? 70)))
      const buf =
        format === 'png'
          ? await inst.page.screenshot({ type: 'png' })
          : await inst.page.screenshot({ type: 'jpeg', quality: q })
      if (buf.length < 1) {
        log('browser-playwright', `capturePage produced no image tab=${tabId}`)
        return { error: 'capture encoded to 0 bytes' }
      }
      return { data: buf.toString('base64'), format }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log('browser-playwright', `capturePage failed tab=${tabId}`, message)
      return { error: `capture failed: ${message}` }
    }
  }

  async getDom(tabId: string): Promise<string | null> {
    const inst = this.instances.get(tabId)
    if (!inst) return null
    return await evalWithTimeout(() => inst.page.content(), `getDom tab=${tabId}`).catch(
      (err: unknown) => {
        log(
          'browser-playwright',
          `getDom failed tab=${tabId}`,
          err instanceof Error ? err.message : err
        )
        throw err
      }
    )
  }
}
