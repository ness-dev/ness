import { useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { X, Sparkles, GitBranch, Loader2 } from 'lucide-react'
import type { TourState } from '../../shared/state/onboarding'

/** Where the popout's arrow should point: the anchor row's vertical centre
 *  at the sidebar's right edge. Null while the row isn't on screen. */
interface AnchorPoint {
  x: number
  y: number
}

const GAP_PX = 12
/** Distance from the popout's top to its arrow tip, when nothing clamps it. */
const ARROW_OFFSET_PX = 28
const VIEWPORT_MARGIN_PX = 8

/** Track a sidebar row's position. Re-measures (once per frame at most) on
 *  scroll anywhere, window resize, the sidebar resizing, and rows being
 *  added, removed or reordered; plus a slow tick for the cases none of
 *  those catch, like the sidebar itself remounting. Per-client layout, so
 *  this is renderer state, not slice state. */
function useSidebarAnchor(path: string | null): AnchorPoint | null {
  const [point, setPoint] = useState<AnchorPoint | null>(null)
  useEffect(() => {
    if (!path) {
      setPoint(null)
      return
    }
    let frame = 0
    let observed: Element | null = null
    const resize = new ResizeObserver(() => schedule())
    const mutation = new MutationObserver(() => schedule())
    const measure = (): void => {
      frame = 0
      const scroller = document.querySelector('[data-sidebar-scroll]')
      if (scroller !== observed) {
        resize.disconnect()
        mutation.disconnect()
        if (scroller) {
          resize.observe(scroller)
          mutation.observe(scroller, { childList: true, subtree: true })
        }
        observed = scroller
      }
      const row = scroller?.querySelector(`[data-sidebar-row="${CSS.escape(path)}"]`)
      if (!scroller || !row) return update(null)
      const r = row.getBoundingClientRect()
      const s = scroller.getBoundingClientRect()
      const y = r.top + r.height / 2
      // Hidden when the row is scrolled out of the sidebar's viewport (or
      // the sidebar is collapsed to nothing).
      if (r.height === 0 || s.width === 0 || y < s.top || y > s.bottom) return update(null)
      update({ x: Math.round(s.right), y: Math.round(y) })
    }
    const update = (next: AnchorPoint | null): void =>
      setPoint((prev) =>
        prev === next || (prev && next && prev.x === next.x && prev.y === next.y) ? prev : next
      )
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    measure()
    window.addEventListener('scroll', schedule, { capture: true, passive: true })
    window.addEventListener('resize', schedule)
    const tick = window.setInterval(schedule, 1000)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule, { capture: true })
      window.removeEventListener('resize', schedule)
      window.clearInterval(tick)
      resize.disconnect()
      mutation.disconnect()
    }
  }, [path])
  return point
}

function Popout({
  anchor,
  icon,
  eyebrow,
  onDismiss,
  children,
  action
}: {
  anchor: AnchorPoint
  icon: ReactNode
  eyebrow: string
  onDismiss: () => void
  children: ReactNode
  action: ReactNode
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(0)
  useLayoutEffect(() => {
    if (ref.current) setHeight(ref.current.offsetHeight)
  })
  const maxTop = window.innerHeight - height - VIEWPORT_MARGIN_PX
  const top = Math.max(VIEWPORT_MARGIN_PX, Math.min(anchor.y - ARROW_OFFSET_PX, maxTop))
  const arrowTop = anchor.y - top
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={eyebrow}
      className="fixed z-40 w-72 max-w-[calc(100vw-2rem)]"
      style={{ left: anchor.x + GAP_PX, top }}
    >
      <div className="tour-popout-enter relative">
        {/* Arrow: a rotated square sharing the card's fill and border, so
            only its two outer edges show. */}
        <div
          aria-hidden
          className="absolute -left-1.5 w-3 h-3 rotate-45 bg-panel-raised border-l border-b border-border-strong"
          style={{ top: arrowTop - 6 }}
        />
        <div className="relative bg-panel-raised border border-border-strong rounded-2xl shadow-2xl overflow-hidden">
          <div className="p-4">
            <div className="flex items-start justify-between mb-2">
              <div className="flex items-center gap-2">
                {icon}
                <span className="text-xs font-semibold uppercase tracking-wider text-dim">{eyebrow}</span>
              </div>
              <button
                onClick={onDismiss}
                title="End the tour"
                aria-label="End the tour"
                className="text-faint hover:text-fg p-0.5 rounded transition-colors cursor-pointer -mt-1 -mr-1"
              >
                <X className="icon-sm" />
              </button>
            </div>
            <div className="text-sm text-fg leading-relaxed">{children}</div>
            <div className="mt-4">{action}</div>
          </div>
        </div>
      </div>
    </div>
  )
}

const primaryButton =
  'inline-flex items-center justify-center gap-2 brand-gradient-bg text-white font-semibold text-sm px-4 py-2 rounded-lg hover:brightness-110 transition-all cursor-pointer disabled:opacity-70 disabled:cursor-default'

/** The tour's "Start something new" action. Shared with the center empty
 *  state so the two surfaces can't drift in look or busy behaviour. */
export function TourStartButton({
  onStart,
  className = ''
}: {
  onStart: () => Promise<void>
  className?: string
}): JSX.Element {
  const [starting, setStarting] = useState(false)
  return (
    <button
      className={`${primaryButton} ${className}`}
      disabled={starting}
      onClick={() => {
        setStarting(true)
        void onStart().finally(() => setStarting(false))
      }}
    >
      {starting && <Loader2 className="icon-sm animate-spin" />}
      Start something new
    </button>
  )
}

/** The two first-run popouts. `homePath` is the tour project's main
 *  workspace row, resolved by the caller from the worktree list. */
export function FirstRunTour({
  tour,
  homePath,
  onStart,
  onDismiss
}: {
  tour: TourState
  homePath: string | null
  onStart: () => Promise<void>
  onDismiss: () => void
}): JSX.Element | null {
  const anchorPath =
    tour.step === 'home' ? homePath : tour.step === 'new-worktree' ? (tour.worktreePath ?? null) : null
  const anchor = useSidebarAnchor(anchorPath)
  if (!anchor) return null

  if (tour.step === 'home') {
    return (
      <Popout
        key="home"
        anchor={anchor}
        icon={<Sparkles className="icon-base text-accent" />}
        eyebrow="Main workspace"
        onDismiss={onDismiss}
        action={<TourStartButton onStart={onStart} className="w-full" />}
      >
        This is your main workspace for this project. Agents here can spin up worktrees for any
        work that you might want to do.
      </Popout>
    )
  }

  return (
    <Popout
      key="new-worktree"
      anchor={anchor}
      icon={<GitBranch className="icon-base text-accent" />}
      eyebrow="New worktree"
      onDismiss={onDismiss}
      action={
        <button className={`${primaryButton} w-full`} onClick={onDismiss}>
          Got it
        </button>
      }
    >
      Your agent created a new worktree. This is a <em>copy</em> of the project, where a new agent
      will work on a new feature. Chat with the agent to get your feature built. Once you are done,
      the agent can guide you through a pull request.
    </Popout>
  )
}
