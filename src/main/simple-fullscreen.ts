// "Whole screen" mode: macOS "simple" (pre-Lion) full screen, so Ness fills
// the entire display, including the strips either side of the camera notch.
// It sits alongside native full screen rather than replacing it: the green
// button and Ctrl+Cmd+F keep macOS's own full screen (own Space, below the
// notch); View > Whole Screen (Ctrl+Cmd+Shift+F) toggles this one.
//
// Why not BrowserWindow's `simpleFullscreen: true` option: in Electron 41 it
// only redirects `toggleFullScreenMode:` (win.setFullScreen and the
// `togglefullscreen` menu role), so it can't coexist with native full screen
// — with it set, win.setFullScreen(false) *enters* simple mode instead of
// leaving native. We leave the option off and own both toggles here.
import { screen, type BrowserWindow, type Display } from 'electron'
import type { NotchInset } from '../shared/notch'
import { log } from './debug'

// Notched MacBooks report a ~37-38pt menu bar; every non-notched Mac is
// 22-25pt. Anything over 30 on the built-in panel is treated as a notch.
const NOTCH_MENU_BAR_MIN_PT = 30
// Electron doesn't expose the notch's width. The 14"/16" notch is roughly
// 180-190pt at the default scaled resolutions; 200 leaves a little air. Exact
// values would come from NSScreen.auxiliaryTopLeftArea/RightArea.
const NOTCH_WIDTH_PT = 200
// With "Automatically hide and show the menu bar" on, workArea never
// excludes a menu bar, so the height reading is 0. Fall back on shape:
// notched panels are a 16:10 area plus the menu-bar strip (1512x982,
// 1728x1117, 1470x956, 1710x1112, 1920x1243... all ~1.54), while every
// non-notched MacBook panel is 16:10 (1.6) at any scaling.
const NOTCHED_ASPECT_MIN = 1.52
const NOTCHED_ASPECT_MAX = 1.56
const NOTCH_FALLBACK_HEIGHT_PT = 37

// Menu-bar height is measured while windowed and cached per display: once
// simple full screen auto-hides the menu bar, workArea may no longer
// include it, so measuring then would under-report.
const menuBarHeightByDisplay = new Map<number, number>()

// setSimpleFullScreen fires no window event, so toggles notify directly.
const notifiers = new WeakMap<BrowserWindow, () => void>()

function recordMenuBarHeights(): void {
  for (const d of screen.getAllDisplays()) {
    const h = d.workArea.y - d.bounds.y
    // A display with no menu bar (secondary display with "Displays have
    // separate Spaces" off, or auto-hide on) reports 0; don't overwrite a
    // good earlier reading with that.
    if (h > 0) menuBarHeightByDisplay.set(d.id, h)
  }
}

export function notchForDisplay(d: Display, menuBarHeight?: number): NotchInset | null {
  if (!d.internal) return null
  const h = menuBarHeight ?? d.workArea.y - d.bounds.y
  if (h >= NOTCH_MENU_BAR_MIN_PT) return { height: h, width: NOTCH_WIDTH_PT }
  if (h > 0) return null
  const aspect = d.bounds.width / d.bounds.height
  if (aspect < NOTCHED_ASPECT_MIN || aspect > NOTCHED_ASPECT_MAX) return null
  log('fullscreen', `no menu bar reading on internal display ${d.bounds.width}x${d.bounds.height}; assuming a notch from its shape`)
  return { height: NOTCH_FALLBACK_HEIGHT_PT, width: NOTCH_WIDTH_PT }
}

export function isWindowFullScreen(win: BrowserWindow): boolean {
  return win.isFullScreen() || win.isSimpleFullScreen()
}

/** Ctrl+Cmd+F / View > Toggle Full Screen: native full screen, or out of
 *  whole-screen mode if that's what the window is in. */
export function toggleWindowFullScreen(win: BrowserWindow): void {
  if (win.isSimpleFullScreen()) {
    win.setSimpleFullScreen(false)
    notifiers.get(win)?.()
    return
  }
  win.setFullScreen(!win.isFullScreen())
}

/** Ctrl+Cmd+Shift+F / View > Whole Screen. From native full screen it
 *  switches modes: native has to finish leaving before simple can start. */
export function toggleWholeScreen(win: BrowserWindow): void {
  if (win.isFullScreen()) {
    pendingWholeScreen.add(win)
    win.setFullScreen(false)
    return
  }
  if (!win.isSimpleFullScreen()) recordMenuBarHeights()
  win.setSimpleFullScreen(!win.isSimpleFullScreen())
  notifiers.get(win)?.()
}

// Whole screen requested from native full screen: entered once native has
// finished leaving.
const pendingWholeScreen = new WeakSet<BrowserWindow>()

/** Wires full-screen state + notch inset signals for one window. `notify`
 *  fires after every transition. */
export function attachFullScreenHandling(win: BrowserWindow, notify: () => void): void {
  recordMenuBarHeights()
  notifiers.set(win, notify)

  win.on('enter-full-screen', () => {
    // fn-F and the AppKit/Window-menu entries call toggleFullScreen:
    // directly, so they can land here while in whole-screen mode, which
    // AppKit doesn't model. Treat that as "leave full screen". Simple mode
    // has to go first: while it's on, Electron's setFullScreen(false) only
    // leaves simple mode and leaves a native transition marked in flight.
    if (win.isSimpleFullScreen()) {
      win.setSimpleFullScreen(false)
      win.setFullScreen(false)
    }
    notify()
  })
  win.on('leave-full-screen', () => {
    if (pendingWholeScreen.delete(win)) {
      recordMenuBarHeights()
      win.setSimpleFullScreen(true)
    }
    notify()
  })

  // Resolution / scaling changes move the notch band; Electron already
  // re-frames the simple-full-screen window for these.
  const onMetrics = (): void => {
    if (!win.isSimpleFullScreen()) recordMenuBarHeights()
    notify()
  }
  screen.on('display-metrics-changed', onMetrics)
  win.on('closed', () => screen.off('display-metrics-changed', onMetrics))
}

export function notchInsetFor(win: BrowserWindow): NotchInset | null {
  if (!win.isSimpleFullScreen()) return null
  const d = screen.getDisplayMatching(win.getBounds())
  return notchForDisplay(d, menuBarHeightByDisplay.get(d.id))
}
