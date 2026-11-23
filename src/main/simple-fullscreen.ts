// macOS "simple" (pre-Lion) full screen, so Ness fills the whole display —
// including the strips either side of the camera notch — instead of native
// full screen, which parks the window below the notch and blacks the
// menu-bar strip out. Governed by the `simpleFullScreen` setting (default
// on); with it off, every path here falls through to native full screen.
//
// Why not BrowserWindow's `simpleFullscreen: true` option: in Electron 41 it
// only redirects `toggleFullScreenMode:` (win.setFullScreen and the
// `togglefullscreen` menu role). The green button and AppKit's auto-added
// "Enter Full Screen" item call `toggleFullScreen:` directly and still go
// native — and with the option set, win.setFullScreen(false) *enters* simple
// mode instead of leaving native, so the native session can't be backed out
// of. We leave the option off and own the toggle here instead.
import { screen, type BrowserWindow, type Display } from 'electron'
import type { NotchInset } from '../shared/notch'
import { log } from './debug'

// Read live at each transition, so toggling the setting applies to the next
// entry without re-wiring windows. desktop-shell supplies it (macOS only).
let simpleEnabled: () => boolean = () => false

export function configureSimpleFullScreen(isEnabled: () => boolean): void {
  simpleEnabled = isEnabled
}

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
// A native exit that never arrives (AppKit dropped the setFullScreen(false))
// must not let the bounce fire on some unrelated, later leave.
const BOUNCE_TIMEOUT_MS = 3000

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

export function toggleWindowFullScreen(win: BrowserWindow): void {
  if (win.isFullScreen() || (!win.isSimpleFullScreen() && !simpleEnabled())) {
    win.setFullScreen(!win.isFullScreen())
    return
  }
  if (!win.isSimpleFullScreen()) recordMenuBarHeights()
  win.setSimpleFullScreen(!win.isSimpleFullScreen())
  notifiers.get(win)?.()
}

/** Wires full-screen state + notch inset signals for one window and, while
 *  the setting is on, bounces native full-screen entries (green button,
 *  fn-F) into simple full screen. `notify` fires after every transition. */
export function attachFullScreenHandling(win: BrowserWindow, notify: () => void): void {
  recordMenuBarHeights()
  notifiers.set(win, notify)

  // No way to cancel a native entry, so let it land, leave it, then apply
  // what the user meant. Costs one extra animation; Ctrl+Cmd+F / View menu
  // go straight to simple mode. A native entry *from* simple mode (fn-F,
  // which bypasses our menu item) means "leave full screen".
  let bounceTo: boolean | null = null
  let bounceTimer: ReturnType<typeof setTimeout> | null = null
  const clearBounce = (): void => {
    bounceTo = null
    if (bounceTimer) clearTimeout(bounceTimer)
    bounceTimer = null
  }
  win.on('enter-full-screen', () => {
    clearBounce()
    if (!simpleEnabled() && !win.isSimpleFullScreen()) {
      notify()
      return
    }
    bounceTo = !win.isSimpleFullScreen()
    bounceTimer = setTimeout(clearBounce, BOUNCE_TIMEOUT_MS)
    win.setFullScreen(false)
  })
  win.on('leave-full-screen', () => {
    const target = bounceTo
    clearBounce()
    if (target !== null && target !== win.isSimpleFullScreen()) {
      if (target) recordMenuBarHeights()
      win.setSimpleFullScreen(target)
    }
    notify()
  })
  win.on('closed', clearBounce)

  // Resolution / scaling changes move the notch band; Electron already
  // re-frames the simple-full-screen window for these.
  const onMetrics = (): void => {
    if (!win.isSimpleFullScreen()) recordMenuBarHeights()
    notify()
  }
  screen.on('display-metrics-changed', onMetrics)
  win.on('closed', () => screen.off('display-metrics-changed', onMetrics))
}

/** Setting turned off: take a window out of simple full screen so it isn't
 *  left in a mode the user just disabled. */
export function leaveSimpleFullScreen(win: BrowserWindow): void {
  if (!win.isSimpleFullScreen()) return
  win.setSimpleFullScreen(false)
  notifiers.get(win)?.()
}

export function notchInsetFor(win: BrowserWindow): NotchInset | null {
  if (!win.isSimpleFullScreen()) return null
  const d = screen.getDisplayMatching(win.getBounds())
  return notchForDisplay(d, menuBarHeightByDisplay.get(d.id))
}
