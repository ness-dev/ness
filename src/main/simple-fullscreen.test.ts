import { EventEmitter } from 'events'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, Display } from 'electron'

vi.mock('electron', () => ({
  screen: {
    getAllDisplays: () => [],
    getDisplayMatching: () => undefined,
    on: () => {},
    off: () => {}
  }
}))
vi.mock('./debug', () => ({ log: () => {} }))

let mod: typeof import('./simple-fullscreen')
beforeAll(async () => {
  mod = await import('./simple-fullscreen')
})

/** Mimics AppKit: native transitions report back via events, a tick later. */
class FakeWindow extends EventEmitter {
  native = false
  simple = false
  isFullScreen = (): boolean => this.native
  isSimpleFullScreen = (): boolean => this.simple
  setSimpleFullScreen = vi.fn((flag: boolean) => {
    this.simple = flag
  })
  setFullScreen = vi.fn((flag: boolean) => {
    if (flag === this.native) return
    setTimeout(() => {
      this.native = flag
      this.emit(flag ? 'enter-full-screen' : 'leave-full-screen')
    }, 0)
  })
  /** The green button / fn-F: AppKit enters native full screen directly. */
  clickGreenButton(): void {
    this.native = true
    this.emit('enter-full-screen')
  }
}

function setup(): { win: FakeWindow; w: BrowserWindow; notify: ReturnType<typeof vi.fn> } {
  const win = new FakeWindow()
  const notify = vi.fn()
  const w = win as unknown as BrowserWindow
  mod.attachFullScreenHandling(w, notify)
  return { win, w, notify }
}

describe('full screen modes', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('the green button stays native', () => {
    const { win, notify } = setup()
    win.clickGreenButton()
    vi.runAllTimers()
    expect(win.native).toBe(true)
    expect(win.simple).toBe(false)
    expect(win.setFullScreen).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('Ctrl+Cmd+F toggles native full screen', () => {
    const { win, w } = setup()
    mod.toggleWindowFullScreen(w)
    vi.runAllTimers()
    expect(win.native).toBe(true)
    mod.toggleWindowFullScreen(w)
    vi.runAllTimers()
    expect(win.native).toBe(false)
    expect(win.simple).toBe(false)
  })

  it('Ctrl+Cmd+Shift+F toggles whole screen directly and notifies', () => {
    const { win, w, notify } = setup()
    mod.toggleWholeScreen(w)
    expect(win.simple).toBe(true)
    expect(win.setFullScreen).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledTimes(1)
    mod.toggleWholeScreen(w)
    expect(win.simple).toBe(false)
  })

  it('Ctrl+Cmd+F leaves whole screen', () => {
    const { win, w } = setup()
    mod.toggleWholeScreen(w)
    mod.toggleWindowFullScreen(w)
    vi.runAllTimers()
    expect(win.simple).toBe(false)
    expect(win.native).toBe(false)
  })

  it('whole screen from native waits for native to leave first', () => {
    const { win, w } = setup()
    win.clickGreenButton()
    mod.toggleWholeScreen(w)
    expect(win.simple).toBe(false)
    vi.runAllTimers()
    expect(win.native).toBe(false)
    expect(win.simple).toBe(true)
  })

  it('a native entry while in whole screen leaves both', () => {
    const { win, w } = setup()
    mod.toggleWholeScreen(w)
    win.clickGreenButton()
    vi.runAllTimers()
    expect(win.simple).toBe(false)
    expect(win.native).toBe(false)
  })
})

describe('notchForDisplay', () => {
  const display = (w: number, h: number, menuBar: number, internal = true): Display =>
    ({
      id: 1,
      internal,
      bounds: { x: 0, y: 0, width: w, height: h },
      workArea: { x: 0, y: menuBar, width: w, height: h - menuBar }
    }) as unknown as Display

  it('detects a notch from a tall menu bar on the built-in display', () => {
    expect(mod.notchForDisplay(display(1920, 1243, 38))).toEqual({ height: 38, width: 200 })
  })

  it('ignores a normal menu bar and external displays', () => {
    expect(mod.notchForDisplay(display(1440, 900, 24))).toBeNull()
    expect(mod.notchForDisplay(display(1920, 1243, 38, false))).toBeNull()
  })

  it('falls back on panel shape when the menu bar is auto-hidden', () => {
    expect(mod.notchForDisplay(display(1512, 982, 0))).toEqual({ height: 37, width: 200 })
    expect(mod.notchForDisplay(display(1440, 900, 0))).toBeNull()
  })
})
