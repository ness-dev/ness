// Pure geometry for browser tabs with an emulated viewport. Kept out of
// browser-manager.ts so it can be unit-tested without `electron`.

import type { BrowserViewport } from '../shared/browser-viewport'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Where to put the native view inside the pane the renderer measured.
 *
 * With no emulation the view fills the pane. With emulation it shrinks to the
 * emulated size and centres horizontally, so the user sees a phone-shaped
 * viewport letterboxed in the pane rather than a page rendered into the
 * top-left corner of a much wider widget.
 *
 * When the emulated viewport is larger than the pane we keep the pane rect:
 * Chromium still lays the page out at the emulated size (that part is the CDP
 * override, not the widget), the pane just shows as much of it as fits.
 */
export function emulatedViewRect(pane: Rect, viewport: BrowserViewport | null): Rect {
  if (!viewport) return pane
  if (viewport.width > pane.width || viewport.height > pane.height) return pane
  return {
    x: pane.x + Math.round((pane.width - viewport.width) / 2),
    y: pane.y,
    width: viewport.width,
    height: viewport.height
  }
}

/**
 * Whether an on-screen (compositor surface) capture would produce the emulated
 * viewport exactly.
 *
 * Chromium only paints the part of a view that lies inside its host window, and
 * `webContents.capturePage()` hands back the *widget*, not the emulated
 * viewport — so a 390×844 emulation inside a 700×500 widget captures 700×500
 * with the page crammed into the corner. Only when the widget was letterboxed
 * to exactly the emulated size do the two agree; otherwise the caller has to
 * park the view in a window grown to fit and render offscreen.
 */
export function canSurfaceCapture(view: Rect, viewport: BrowserViewport | null): boolean {
  if (!viewport) return true
  return view.width === viewport.width && view.height === viewport.height
}
