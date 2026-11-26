import { useState, useEffect, useRef, ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

interface RightPanelProps {
  /** Stable id used as the localStorage key for collapse state. */
  id: string
  title: string
  children: ReactNode
  /** Rendered on the right side of the header. Clicks don't toggle collapse. */
  actions?: ReactNode
  /** If true, the panel claims remaining vertical space (flex-1). */
  grow?: boolean
  /** Tailwind max-height class applied to the body when !grow (e.g. 'max-h-56'). */
  maxHeight?: string
  defaultCollapsed?: boolean
  headerClassName?: string
  containerClassName?: string
  /** Fires on mount with the resolved initial state and on every toggle. */
  onCollapsedChange?: (collapsed: boolean) => void
}

const STORAGE_PREFIX = 'right-panel-collapsed:'

export function RightPanel({
  id,
  title,
  children,
  actions,
  grow = false,
  maxHeight,
  defaultCollapsed = false,
  headerClassName = '',
  containerClassName = '',
  onCollapsedChange
}: RightPanelProps): JSX.Element {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_PREFIX + id)
      if (saved !== null) return saved === '1'
    } catch {
      /* ignore */
    }
    return defaultCollapsed
  })

  // Held in a ref so callers don't have to memoize the callback —
  // re-firing on every parent re-render would be wrong.
  const onCollapsedChangeRef = useRef(onCollapsedChange)
  useEffect(() => {
    onCollapsedChangeRef.current = onCollapsedChange
  })

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_PREFIX + id, collapsed ? '1' : '0')
    } catch {
      /* ignore */
    }
    onCollapsedChangeRef.current?.(collapsed)
  }, [id, collapsed])

  // External nudge: the collapsed right-sidebar icons fire this event so
  // clicking, say, the Commits icon expands both the column AND the
  // matching section even if the section was previously collapsed.
  useEffect(() => {
    const handler = (e: Event): void => {
      const ce = e as CustomEvent<{ id?: string }>
      if (ce.detail?.id === id) setCollapsed(false)
    }
    window.addEventListener('harness:expand-right-panel', handler)
    return () => window.removeEventListener('harness:expand-right-panel', handler)
  }, [id])

  // On unmount, signal collapsed so consumers (e.g. CostPanel's interest
  // gate) treat the panel as no longer visible — otherwise tearing the
  // panel down via parent reconciliation would leak interest.
  useEffect(() => {
    return () => {
      onCollapsedChangeRef.current?.(true)
    }
  }, [])

  const outerSize = grow && !collapsed ? 'flex-1 min-h-0' : 'shrink-0'
  const bodyClasses = collapsed
    ? ''
    : grow
      ? 'flex-1 min-h-0 flex flex-col'
      : `${maxHeight ?? ''} flex flex-col`

  return (
    <div
      className={`flex flex-col border-b border-border bg-panel ${outerSize} ${containerClassName}`}
    >
      <div
        className={`drag-region flex items-stretch h-9 pointer-coarse:h-11 shrink-0 ${
          collapsed ? '' : 'border-b border-border'
        } ${headerClassName}`}
      >
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="no-drag flex-1 flex items-center gap-1.5 px-3 hover:bg-panel-raised/40 cursor-pointer text-left min-w-0"
        >
          <ChevronRight
            className={`icon-xs shrink-0 text-faint transition-transform ${collapsed ? '' : 'rotate-90'}`} />
          <span className="text-xs font-medium text-muted uppercase tracking-wide truncate">
            {title}
          </span>
        </button>
        {actions && (
          // On touch screens every header action gets a 44px target (the
          // icons themselves stay icon-xs) — they're 12px squares otherwise.
          <div className="no-drag flex items-center gap-2 pr-3 pointer-coarse:gap-0 pointer-coarse:pr-0 pointer-coarse:[&_button]:p-4">
            {actions}
          </div>
        )}
      </div>
      {!collapsed && <div className={bodyClasses}>{children}</div>}
    </div>
  )
}
