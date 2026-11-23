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
let enabled = true
beforeAll(async () => {
  mod = await import('./simple-fullscreen')
  mod.configureSimpleFullScreen(() => enabled)
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
  /** The green button: AppKit enters native full screen directly. */
  clickGreenButton(): void {
    this.native = true
    this.emit('enter-full-screen')
  }
}

function setup(): { win: FakeWindow; notify: ReturnType<typeof vi.fn> } {
  const win = new FakeWindow()
  const notify = vi.fn()
  mod.attachFullScreenHandling(win as unknown as BrowserWindow, notify)
  return { win, notify }
}

describe('simple full screen bounce', () => {
  beforeEach(() => {
    enabled = true
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  it('green button: windowed → native → simple', () => {
    const { win, notify } = setup()
    win.clickGreenButton()
    expect(win.setFullScreen).toHaveBeenCalledWith(false)
    vi.runAllTimers()
    expect(win.native).toBe(false)
    expect(win.simple).toBe(true)
    expect(notify).toHaveBeenCalled()
  })

  it('native entry from simple mode leaves full screen entirely', () => {
    const { win } = setup()
    win.simple = true
    win.clickGreenButton()
    vi.runAllTimers()
    expect(win.native).toBe(false)
    expect(win.simple).toBe(false)
  })

  it('Ctrl+Cmd+F toggles simple mode directly and notifies', () => {
    const { win, notify } = setup()
    mod.toggleWindowFullScreen(win as unknown as BrowserWindow)
    expect(win.simple).toBe(true)
    expect(win.setFullScreen).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledTimes(1)
    mod.toggleWindowFullScreen(win as unknown as BrowserWindow)
    expect(win.simple).toBe(false)
  })

  it('with the setting off, the green button and Ctrl+Cmd+F stay native', () => {
    enabled = false
    const { win, notify } = setup()
    win.clickGreenButton()
    vi.runAllTimers()
    expect(win.native).toBe(true)
    expect(win.setFullScreen).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledTimes(1)
    mod.toggleWindowFullScreen(win as unknown as BrowserWindow)
    vi.runAllTimers()
    expect(win.native).toBe(false)
    mod.toggleWindowFullScreen(win as unknown as BrowserWindow)
    vi.runAllTimers()
    expect(win.native).toBe(true)
    expect(win.simple).toBe(false)
  })

  it('turning the setting off takes a window out of simple full screen', () => {
    const { win, notify } = setup()
    mod.toggleWindowFullScreen(win as unknown as BrowserWindow)
    enabled = false
    mod.leaveSimpleFullScreen(win as unknown as BrowserWindow)
    expect(win.simple).toBe(false)
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('a stale bounce does not fire on a later, unrelated leave', () => {
    const { win } = setup()
    win.setFullScreen.mockImplementation(() => {}) // AppKit drops the exit
    win.clickGreenButton()
    vi.advanceTimersByTime(5000)
    win.native = false
    win.emit('leave-full-screen')
    expect(win.setSimpleFullScreen).not.toHaveBeenCalled()
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
