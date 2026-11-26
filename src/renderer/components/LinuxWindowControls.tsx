import { Minus, Square, X } from 'lucide-react'
import { useBackend } from '../backend'

// Replicates the macOS traffic-light slot on Linux, where the OS frame is
// hidden (see desktop-shell.ts: `frame: false` on linux). Position mirrors
// macOS `trafficLightPosition: { x: 12, y: 12 }` so the shared `titlebar-lead*`
// padding on titles in the drag-region stays correct on both platforms.
// Marked `no-drag` so clicks aren't swallowed by the surrounding drag zone.
export function LinuxWindowControls(): JSX.Element | null {
  // useBackend must be called unconditionally; the early return below
  // is gated on the platform global which is invariant for the life of
  // the renderer, so React's rules-of-hooks invariant still holds.
  const backend = useBackend()
  if (typeof window === 'undefined') return null
  if (window.__HARNESS_PLATFORM__ !== 'linux') return null

  const button =
    'no-drag w-5 h-5 rounded flex items-center justify-center text-muted hover:text-fg-bright hover:bg-panel-raised transition-colors cursor-pointer'

  return (
    <div
      className="fixed top-0 left-0 z-50 h-10 flex items-center gap-0.5 pl-2 pointer-events-none"
      aria-label="Window controls"
    >
      <div className="flex items-center gap-0.5 pointer-events-auto">
        <button
          type="button"
          aria-label="Close"
          onClick={() => backend.windowClose()}
          className={`${button} hover:!bg-danger/20 hover:!text-danger`}
        >
          <X strokeWidth={2.25} className="icon-xs" />
        </button>
        <button
          type="button"
          aria-label="Minimize"
          onClick={() => backend.windowMinimize()}
          className={button}
        >
          <Minus strokeWidth={2.25} className="icon-xs" />
        </button>
        <button
          type="button"
          aria-label="Maximize"
          onClick={() => backend.windowToggleMaximize()}
          className={button}
        >
          <Square strokeWidth={2.25} className="icon-2xs" />
        </button>
      </div>
    </div>
  )
}
