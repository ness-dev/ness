// True when something occupies the top-left of the window: macOS traffic
// lights or LinuxWindowControls. The preload only exposes the platform in
// Electron, so the web client (a plain browser tab) has none.
export function hasWindowControls(): boolean {
  return typeof window !== 'undefined' && window.__HARNESS_PLATFORM__ !== undefined
}
