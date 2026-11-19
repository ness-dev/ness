// What occupies the top-left of the window, for the titlebar clearance.
// 'mac' — native traffic lights (hidden by macOS in fullscreen).
// 'linux' — LinuxWindowControls, which stay rendered in fullscreen.
// 'none' — the web client: the preload only exposes the platform in Electron.
export type WindowControlsKind = 'mac' | 'linux' | 'none'

export function windowControlsKind(): WindowControlsKind {
  if (typeof window === 'undefined' || window.__HARNESS_PLATFORM__ === undefined) return 'none'
  return window.__HARNESS_PLATFORM__ === 'linux' ? 'linux' : 'mac'
}
