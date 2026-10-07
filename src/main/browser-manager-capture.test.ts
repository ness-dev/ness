// Regression tests for "screenshot_tab returned another tab's pixels".
//
// The fakes here model one specific piece of measured Chromium behaviour, and
// the tests are only as good as that model, so it's worth stating:
//
//   Page.captureScreenshot with `fromSurface: true` copies the *requesting
//   view's* compositor surface. With `fromSurface: false` it goes through
//   RenderWidgetHostImpl::GetSnapshotFromBrowser, which grabs the *native
//   window* and crops it to the view's rect — so it returns whatever is
//   composited on top in that window, which for a parked tab is a sibling tab.
//
// Verified against a real Electron 41 run: two tabs parked in the shared park
// window, one visible under an emulated viewport taller than its pane (which
// makes capturing it park the view briefly), captured concurrently. With
// `fromSurface: false` the parked tab came back holding the other tab's page
// 3/3 times; with `fromSurface: true`, 0/3. `captureFromWindow` below encodes
// that, so flipping the flag back fails these tests instead of shipping.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./debug', () => ({ log: () => {} }))

interface FakeImageMeta {
  marker: string
  width: number
  height: number
}

/** Stand-in for a frame: carries which page's pixels it holds. */
function encodeFrame(meta: FakeImageMeta): Buffer {
  return Buffer.from(JSON.stringify(meta))
}

function decodeFrame(base64: string): FakeImageMeta {
  return JSON.parse(Buffer.from(base64, 'base64').toString()) as FakeImageMeta
}

function makeImage(buf: Buffer, size?: { width: number; height: number }) {
  const meta = JSON.parse(buf.toString()) as FakeImageMeta
  const dims = size ?? { width: meta.width, height: meta.height }
  const img = {
    getSize: () => dims,
    isEmpty: () => false,
    resize: (next: { width: number; height: number }) => makeImage(buf, next),
    toPNG: () => buf,
    toJPEG: () => buf
  }
  return img
}

type Rect = { x: number; y: number; width: number; height: number }

/** Captures that the test can hold open, to observe overlap. */
const gate: { pending: Array<() => void>; hold: boolean; failCapture: boolean } = {
  pending: [],
  hold: false,
  failCapture: false
}

class FakeWebContents {
  url = 'about:blank'
  attached = false
  destroyed = false
  reloads = 0
  commands: string[] = []
  constructor(private view: FakeWebContentsView) {}

  getURL = (): string => this.url
  getTitle = (): string => this.url
  getUserAgent = (): string => 'fake-ua'
  isDestroyed = (): boolean => this.destroyed
  isCrashed = (): boolean => false
  close = (): void => {
    this.destroyed = true
  }
  on = (): void => {}
  once = (): void => {}
  removeAllListeners = (): void => {}
  sendInputEvent = (): void => {}
  isDevToolsOpened = (): boolean => false
  openDevTools = (): void => {}
  closeDevTools = (): void => {}
  reload = (): void => {
    this.reloads++
  }
  navigationHistory = {
    canGoBack: () => false,
    canGoForward: () => false,
    goBack: () => {},
    goForward: () => {}
  }
  loadURL = async (url: string): Promise<void> => {
    this.url = url
  }
  executeJavaScript = async (): Promise<unknown> => null

  /** The on-screen path: a per-widget surface copy, always this view's own. */
  capturePage = async () => makeImage(encodeFrame(this.view.frame()))

  debugger = {
    isAttached: (): boolean => this.attached,
    attach: (): void => {
      this.attached = true
    },
    detach: (): void => {
      this.attached = false
    },
    sendCommand: async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      this.commands.push(method)
      if (method !== 'Page.captureScreenshot') return {}
      if (gate.failCapture) throw new Error('UnknownVizError')
      if (!this.view.host) throw new Error('no surface: view is not parented')
      const fromSurface = params?.['fromSurface'] === true
      const meta = fromSurface ? this.view.frame() : this.view.host.captureFromWindow(this.view)
      if (gate.hold) {
        await new Promise<void>((resolve) => gate.pending.push(resolve))
      }
      return { data: encodeFrame(meta).toString('base64') }
    }
  }
}

class FakeWebContentsView {
  webContents = new FakeWebContents(this)
  host: FakeWindow | null = null
  private bounds: Rect = { x: 0, y: 0, width: 0, height: 0 }
  setBackgroundColor = (): void => {}
  setBounds = (b: Rect): void => {
    this.bounds = { ...b }
  }
  getBounds = (): Rect => ({ ...this.bounds })
  /** This view's own pixels. */
  frame(): FakeImageMeta {
    return {
      marker: this.webContents.url,
      width: this.bounds.width,
      height: this.bounds.height
    }
  }
}

class FakeWindow {
  static all: FakeWindow[] = []
  children: FakeWebContentsView[] = []
  private destroyed = false
  private content = { width: 1280, height: 800 }

  constructor(_opts?: unknown) {
    FakeWindow.all.push(this)
  }
  static getAllWindows = (): FakeWindow[] => FakeWindow.all.filter((w) => !w.isDestroyed())

  contentView = {
    addChildView: (view: FakeWebContentsView): void => {
      if (view.host) view.host.children = view.host.children.filter((v) => v !== view)
      this.children = this.children.filter((v) => v !== view)
      // Last one added composites on top — which is the whole problem.
      this.children.push(view)
      view.host = this
    },
    removeChildView: (view: FakeWebContentsView): void => {
      this.children = this.children.filter((v) => v !== view)
      if (view.host === this) view.host = null
    }
  }

  /** What an OS-level grab of this window, cropped to `view`'s rect, holds:
   * the topmost child's pixels, not necessarily the requested view's. */
  captureFromWindow(view: FakeWebContentsView): FakeImageMeta {
    const top = this.children[this.children.length - 1] ?? view
    const own = view.frame()
    return { marker: top.frame().marker, width: own.width, height: own.height }
  }

  getContentBounds = (): { width: number; height: number } => ({ ...this.content })
  setContentSize = (width: number, height: number): void => {
    this.content = { width, height }
  }
  isDestroyed = (): boolean => this.destroyed
  destroy = (): void => {
    this.destroyed = true
  }
  once = (): void => {}
  on = (): void => {}
  hide = (): void => {}
  show = (): void => {}
}

vi.mock('electron', () => ({
  WebContentsView: FakeWebContentsView,
  BrowserWindow: FakeWindow,
  app: { on: () => {} },
  session: { fromPartition: () => ({}) },
  nativeImage: {
    createFromBuffer: (buf: Buffer) => makeImage(buf)
  }
}))

const { BrowserManager } = await import('./browser-manager')

const WT = '/tmp/wt-a'
const RED = 'https://red.test/'
const BLUE = 'https://blue.test/'

const tick = async (n = 4): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
}

async function markerOf(
  bm: InstanceType<typeof BrowserManager>,
  tabId: string
): Promise<string> {
  const shot = await bm.capturePage(tabId, { format: 'png' })
  if (!shot?.data) throw new Error(`no image: ${shot?.error}`)
  return decodeFrame(shot.data).marker
}

describe('capturePage tab isolation', () => {
  beforeEach(() => {
    FakeWindow.all = []
    gate.pending = []
    gate.hold = false
    gate.failCapture = false
  })

  it('captures a parked tab from its own surface, not from the shared park window', async () => {
    const bm = new BrowserManager()
    bm.create('red', WT, RED)
    // Parked second, so it composites on top of red in the park window.
    bm.create('blue', WT, BLUE)

    expect(await markerOf(bm, 'red')).toBe(RED)
    expect(await markerOf(bm, 'blue')).toBe(BLUE)
  })

  it('keeps a parked tab clean while a sibling capture parks a visible view', async () => {
    const bm = new BrowserManager()
    bm.create('red', WT, RED)
    bm.create('blue', WT, BLUE)

    const win = new FakeWindow()
    bm.setBounds('blue', win as unknown as Electron.BrowserWindow, {
      x: 0,
      y: 0,
      width: 800,
      height: 600
    })
    // Emulated taller than the pane, so capturing blue has to park it first.
    await bm.setViewport('blue', {
      width: 1280,
      height: 1600,
      deviceScaleFactor: 0,
      mobile: false
    })

    const [red, blue] = await Promise.all([markerOf(bm, 'red'), markerOf(bm, 'blue')])
    expect(red).toBe(RED)
    expect(blue).toBe(BLUE)

    // And blue is handed back to its window afterwards.
    expect(bm.getViewport('blue')).toMatchObject({ width: 1280, height: 1600 })
    expect(await markerOf(bm, 'blue')).toBe(BLUE)
  })

  it('serializes captures so one cannot reparent another mid-shot', async () => {
    const bm = new BrowserManager()
    bm.create('red', WT, RED)
    bm.create('blue', WT, BLUE)
    await tick()

    gate.hold = true
    const first = bm.capturePage('red', { format: 'png' })
    const second = bm.capturePage('blue', { format: 'png' })
    await tick()
    expect(gate.pending).toHaveLength(1)

    gate.pending.pop()?.()
    await tick()
    expect(gate.pending).toHaveLength(1)
    gate.pending.pop()?.()

    const [a, b] = await Promise.all([first, second])
    expect(decodeFrame(a!.data!).marker).toBe(RED)
    expect(decodeFrame(b!.data!).marker).toBe(BLUE)
  })

  it('reports the failure instead of falling back to a window-level grab', async () => {
    const bm = new BrowserManager()
    bm.create('red', WT, RED)
    bm.create('blue', WT, BLUE)
    await tick()

    gate.failCapture = true
    const shot = await bm.capturePage('red', { format: 'png' })
    expect(shot?.data).toBeUndefined()
    expect(shot?.error).toMatch(/capture failed/)
  })

  it('re-parks and still captures the right tab after the park window is gone', async () => {
    const bm = new BrowserManager()
    bm.create('red', WT, RED)
    bm.create('blue', WT, BLUE)
    await tick()

    // macOS closes every window without quitting the app.
    for (const win of [...FakeWindow.all]) win.destroy()

    expect(await markerOf(bm, 'red')).toBe(RED)
    expect(await markerOf(bm, 'blue')).toBe(BLUE)
  })
})
