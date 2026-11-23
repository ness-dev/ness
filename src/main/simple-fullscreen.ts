// EXPERIMENT: macOS "simple" (pre-Lion) full screen, so Ness fills the whole
// display — including the strips either side of the camera notch — instead
// of native full screen, which parks the window below the notch and blacks
// the menu-bar strip out. Flip USE_SIMPLE_FULLSCREEN to false to get the old
// behaviour back exactly; it's the single switch a future setting replaces.
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

export const USE_SIMPLE_FULLSCREEN = process.platform === 'darwin'

// Notched MacBooks report a ~37-38pt menu bar; every non-notched Mac is
// 22-25pt. Anything over 30 on the built-in panel is treated as a notch.
const NOTCH_MENU_BAR_MIN_PT = 30
// Electron doesn't expose the notch's width. The 14"/16" notch is roughly
// 180-190pt at the default scaled resolutions; 200 leaves a little air. Exact
// values would come from NSScreen.auxiliaryTopLeftArea/RightArea.
const NOTCH_WIDTH_PT = 200

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

function notchForDisplay(d: Display): NotchInset | null {
  if (!d.internal) return null
  const h = menuBarHeightByDisplay.get(d.id) ?? d.workArea.y - d.bounds.y
  if (h < NOTCH_MENU_BAR_MIN_PT) return null
  return { height: h, width: NOTCH_WIDTH_PT }
}

export function isWindowFullScreen(win: BrowserWindow): boolean {
  return win.isFullScreen() || win.isSimpleFullScreen()
}

export function toggleWindowFullScreen(win: BrowserWindow): void {
  if (!USE_SIMPLE_FULLSCREEN) {
    win.setFullScreen(!win.isFullScreen())
    return
  }
  if (win.isFullScreen()) {
    win.setFullScreen(false)
    return
  }
  if (!win.isSimpleFullScreen()) recordMenuBarHeights()
  win.setSimpleFullScreen(!win.isSimpleFullScreen())
  notifiers.get(win)?.()
}

/** Wires full-screen state + notch inset signals for one window, and bounces
 *  native full-screen entries (green button, AppKit menu item, fn-F) into
 *  simple full screen. `notify` fires after every transition. */
export function attachFullScreenHandling(win: BrowserWindow, notify: () => void): void {
  recordMenuBarHeights()
  if (!USE_SIMPLE_FULLSCREEN) {
    win.on('enter-full-screen', notify)
    win.on('leave-full-screen', notify)
    return
  }

  notifiers.set(win, notify)

  // No way to cancel a native entry, so let it land, leave it, then apply
  // what the user meant. Costs one extra animation; Ctrl+Cmd+F / View menu
  // go straight to simple mode. A native entry *from* simple mode (fn-F,
  // which bypasses our menu item) means "leave full screen".
  let bounceTo: boolean | null = null
  win.on('enter-full-screen', () => {
    bounceTo = !win.isSimpleFullScreen()
    win.setFullScreen(false)
  })
  win.on('leave-full-screen', () => {
    if (bounceTo !== null) {
      if (bounceTo) recordMenuBarHeights()
      win.setSimpleFullScreen(bounceTo)
      bounceTo = null
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
  return notchForDisplay(screen.getDisplayMatching(win.getBounds()))
}
