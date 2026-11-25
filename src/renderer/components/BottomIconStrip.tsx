import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useMemo,
  Fragment,
  type ReactNode
} from 'react'
import {
  Menu,
  Check,
  ChevronUp,
  ChevronDown,
  FilePlus,
  FolderOpen,
  BarChart3,
  CalendarDays,
  Keyboard,
  MessageSquareHeart,
  Moon,
  Waypoints,
  Settings as SettingsIcon,
  type LucideIcon
} from 'lucide-react'
import { openReportIssue } from './ReportIssueScreen'
import { Tooltip } from './Tooltip'
import { PreventSleepStatusIcon } from './PreventSleepStatusIcon'
import { useSettings } from '../store'
import { useBackend } from '../backend'
import {
  BOTTOM_ICON_KEYS,
  resolveBottomIconOrder,
  type BottomIconKey,
  type HiddenBottomIcons
} from '../../shared/state/settings'

const LABELS: Record<BottomIconKey, string> = {
  newProject: 'New project',
  addRepo: 'Add repository',
  activity: 'Activity',
  subscriptionGraph: 'Subscription graph',
  myWeek: 'My week',
  hotkeys: 'Keyboard shortcuts',
  reportIssue: 'Report an issue',
  preventSleep: 'Prevent sleep',
  settings: 'Settings'
}

const MENU_ICONS: Record<BottomIconKey, LucideIcon> = {
  newProject: FilePlus,
  addRepo: FolderOpen,
  activity: BarChart3,
  subscriptionGraph: Waypoints,
  myWeek: CalendarDays,
  hotkeys: Keyboard,
  reportIssue: MessageSquareHeart,
  preventSleep: Moon,
  settings: SettingsIcon
}

export interface BottomIconStripProps {
  orientation: 'horizontal' | 'vertical'
  onOpenNewProject: () => void
  onAddRepo: () => void
  onOpenActivity: () => void
  onOpenSubscriptionGraph: () => void
  onOpenMyWeek: () => void
  onOpenHotkeyCheatsheet: () => void
  onOpenSettings: () => void
}

/** The bottom-launcher strip in the sidebar. Owns:
 *   - filtering by user's `hiddenBottomIcons`
 *   - rendering in the user's `bottomIconOrder`
 *   - adaptive overflow (horizontal only): auto-hides trailing icons that
 *     don't fit and surfaces them via the hamburger menu
 *   - the hamburger menu itself (pin/unpin + reorder chevrons)
 *
 *  The hamburger is a peer of the other icons — same styling, same slot in
 *  the flex row — but is *always* rendered regardless of overflow so the
 *  user always has an escape hatch to reveal / pin the auto-hidden icons.
 */
export function BottomIconStrip(props: BottomIconStripProps): JSX.Element {
  const { orientation } = props
  const settings = useSettings()
  const backend = useBackend()
  const hidden = settings.hiddenBottomIcons
  const order = useMemo(
    () => resolveBottomIconOrder(settings.bottomIconOrder),
    [settings.bottomIconOrder]
  )
  const visibleKeys = useMemo(() => order.filter((k) => !hidden[k]), [order, hidden])

  const containerRef = useRef<HTMLDivElement | null>(null)
  const hamburgerRef = useRef<HTMLDivElement | null>(null)
  const [maxVisible, setMaxVisible] = useState<number>(visibleKeys.length)

  // Horizontal-only adaptive overflow. Measure once per resize using the
  // hamburger as the reference icon width — all bottom-icons share the same
  // padding + icon size, so one measurement covers them all. Reserving the
  // last flex slot for the hamburger guarantees it's always visible.
  useLayoutEffect(() => {
    if (orientation !== 'horizontal') {
      setMaxVisible(visibleKeys.length)
      return
    }
    const container = containerRef.current
    const hamburger = hamburgerRef.current
    if (!container || !hamburger) return
    const measure = (): void => {
      const iconWidth = hamburger.offsetWidth
      if (iconWidth === 0) return
      const gap = 4 // Tailwind gap-1
      const containerWidth = container.clientWidth
      // Slots that fit at (iconWidth + gap) each, then +gap of trailing
      // slack.  Reserve one for the always-present hamburger.
      const totalSlots = Math.max(
        0,
        Math.floor((containerWidth + gap) / (iconWidth + gap))
      )
      const iconSlots = Math.max(0, totalSlots - 1)
      setMaxVisible(Math.min(iconSlots, visibleKeys.length))
    }
    const ro = new ResizeObserver(measure)
    ro.observe(container)
    measure()
    return () => ro.disconnect()
  }, [orientation, visibleKeys.length])

  const shownKeys =
    orientation === 'horizontal' ? visibleKeys.slice(0, maxVisible) : visibleKeys

  const handlerFor = (key: BottomIconKey): (() => void) | null => {
    switch (key) {
      case 'newProject':
        return props.onOpenNewProject
      case 'addRepo':
        return props.onAddRepo
      case 'activity':
        return props.onOpenActivity
      case 'subscriptionGraph':
        return props.onOpenSubscriptionGraph
      case 'myWeek':
        return props.onOpenMyWeek
      case 'hotkeys':
        return props.onOpenHotkeyCheatsheet
      case 'reportIssue':
        return () => openReportIssue()
      case 'settings':
        return props.onOpenSettings
      case 'preventSleep':
        // Owns its own popover; can't be invoked from the menu row.
        return null
    }
  }

  const tooltipSide = orientation === 'horizontal' ? 'top' : 'right'

  const iconButton = (key: BottomIconKey): ReactNode => {
    const label = LABELS[key]
    const onClick = handlerFor(key)
    const Icon = MENU_ICONS[key]
    // PreventSleep is a self-contained component (owns its own popover).
    if (key === 'preventSleep') return <PreventSleepStatusIcon />
    // Wire hotkey-action tooltips for the icons that have hotkeys.
    const action =
      key === 'hotkeys'
        ? ('hotkeyCheatsheet' as const)
        : key === 'settings'
          ? ('openSettings' as const)
          : undefined
    return (
      <Tooltip label={label} side={tooltipSide} action={action}>
        <button
          onClick={onClick ?? undefined}
          className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
        >
          <Icon className="icon-sm" />
        </button>
      </Tooltip>
    )
  }

  // No `overflow-hidden` on the wrapper: the count-based measurement above
  // already prevents visual overflow, and `overflow-hidden` would clip the
  // hamburger's absolutely-positioned popover (containing block is inside
  // the wrapper, so it inherits the clip).
  const wrapperClass =
    orientation === 'horizontal'
      ? 'border-t border-border p-2 flex items-center justify-center gap-1 shrink-0 [&>*]:shrink-0'
      : 'no-drag flex flex-col items-center gap-1 py-3'

  return (
    <div ref={containerRef} className={wrapperClass}>
      {shownKeys.map((k) => (
        <Fragment key={k}>{iconButton(k)}</Fragment>
      ))}
      <HamburgerMenu
        rootRef={hamburgerRef}
        orientation={orientation}
        order={order}
        hidden={hidden}
        onChangeHidden={(next) => void backend.setHiddenBottomIcons(next)}
        onChangeOrder={(next) => void backend.setBottomIconOrder(next)}
        handlerFor={handlerFor}
      />
    </div>
  )
}

interface HamburgerMenuProps {
  rootRef: React.RefObject<HTMLDivElement | null>
  orientation: 'horizontal' | 'vertical'
  order: BottomIconKey[]
  hidden: HiddenBottomIcons
  onChangeHidden: (next: HiddenBottomIcons) => void
  onChangeOrder: (next: BottomIconKey[]) => void
  handlerFor: (key: BottomIconKey) => (() => void) | null
}

const POPOVER_MIN_W = 240
const POPOVER_GAP = 4
const VIEWPORT_PAD = 4

function HamburgerMenu({
  rootRef,
  orientation,
  order,
  hidden,
  onChangeHidden,
  onChangeOrder,
  handlerFor
}: HamburgerMenuProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ top?: number; left: number; maxHeight: number } | null>(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent): void => {
      const target = e.target as Node
      if (rootRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, rootRef])

  // Compute viewport-fixed popover coordinates when it opens. `position:
  // fixed` bypasses ancestor overflow / narrow-sidebar clipping. We anchor
  // by hamburger geometry (horizontal → above; vertical → to the right) and
  // clamp against the viewport so the popover never spills off-screen.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const anchor = rootRef.current
    if (!anchor) return
    const compute = (): void => {
      const rect = anchor.getBoundingClientRect()
      const popover = popoverRef.current
      const popW = Math.max(POPOVER_MIN_W, popover?.offsetWidth ?? POPOVER_MIN_W)
      const popH = popover?.offsetHeight ?? 0
      const vw = window.innerWidth
      const vh = window.innerHeight
      if (orientation === 'horizontal') {
        // Sit above the hamburger; clamp horizontally.
        const left = Math.max(
          VIEWPORT_PAD,
          Math.min(rect.left, vw - popW - VIEWPORT_PAD)
        )
        const desiredTop = rect.top - POPOVER_GAP - popH
        const top = Math.max(VIEWPORT_PAD, desiredTop)
        const maxHeight = rect.top - POPOVER_GAP - VIEWPORT_PAD
        setPos({ top, left, maxHeight: Math.max(80, maxHeight) })
      } else {
        // Sit to the right of the hamburger; bottom-align with it, clamped.
        const left = Math.min(rect.right + POPOVER_GAP, vw - popW - VIEWPORT_PAD)
        const desiredTop = rect.bottom - popH
        const top = Math.max(VIEWPORT_PAD, Math.min(desiredTop, vh - popH - VIEWPORT_PAD))
        const maxHeight = vh - VIEWPORT_PAD * 2
        setPos({ top, left, maxHeight })
      }
    }
    compute()
    // Second pass once popoverRef has a real size (needed for popH-dependent
    // top calc). React double-flush after the first paint.
    const id = window.requestAnimationFrame(compute)
    window.addEventListener('resize', compute)
    return () => {
      window.cancelAnimationFrame(id)
      window.removeEventListener('resize', compute)
    }
  }, [open, orientation, rootRef])

  const togglePinned = (key: BottomIconKey): void => {
    const next: HiddenBottomIcons = { ...hidden }
    if (next[key]) delete next[key]
    else next[key] = true
    onChangeHidden(next)
  }

  const moveIcon = (index: number, delta: number): void => {
    const target = index + delta
    if (target < 0 || target >= order.length) return
    const next = [...order]
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved)
    onChangeOrder(next)
  }

  const tooltipSide = orientation === 'horizontal' ? 'top' : 'right'

  return (
    <div ref={rootRef} className="relative">
      <Tooltip label="Customize menu" side={tooltipSide}>
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
          aria-label="Customize bottom menu"
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <Menu className="icon-sm" />
        </button>
      </Tooltip>
      {open && (
        <div
          ref={popoverRef}
          className="fixed z-50 min-w-[240px] rounded border border-border bg-panel-raised shadow-lg py-1 overflow-y-auto"
          style={{
            top: pos?.top ?? -9999,
            left: pos?.left ?? -9999,
            maxHeight: pos?.maxHeight
          }}
          role="menu"
        >
          <div className="px-3 py-1.5 text-xs uppercase tracking-wide text-faint font-medium">
            Menu items
          </div>
          {order.map((key, index) => {
            const Icon = MENU_ICONS[key]
            const visible = !hidden[key]
            const onOpen = handlerFor(key)
            const isFirst = index === 0
            const isLast = index === order.length - 1
            return (
              <div
                key={key}
                className="flex items-center gap-1 px-2 py-1 hover:bg-panel/60"
              >
                <button
                  onClick={() => {
                    // Clicking the row runs the action. If the item is
                    // hidden, also pin it back — the user just proved they
                    // want access.
                    if (!visible) togglePinned(key)
                    if (onOpen) {
                      onOpen()
                      setOpen(false)
                    }
                  }}
                  disabled={!onOpen}
                  className="flex-1 flex items-center gap-2 px-1 py-0.5 text-xs text-fg-bright cursor-pointer text-left rounded disabled:opacity-50 disabled:cursor-not-allowed"
                  role="menuitem"
                >
                  <Icon className="icon-xs text-dim shrink-0" />
                  <span className="flex-1 truncate">{LABELS[key]}</span>
                </button>
                <button
                  onClick={() => moveIcon(index, -1)}
                  disabled={isFirst}
                  className="flex items-center justify-center w-5 h-5 rounded text-muted hover:bg-panel/80 hover:text-fg-bright disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                  aria-label={`Move ${LABELS[key]} up`}
                >
                  <ChevronUp className="icon-xs" />
                </button>
                <button
                  onClick={() => moveIcon(index, 1)}
                  disabled={isLast}
                  className="flex items-center justify-center w-5 h-5 rounded text-muted hover:bg-panel/80 hover:text-fg-bright disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                  aria-label={`Move ${LABELS[key]} down`}
                >
                  <ChevronDown className="icon-xs" />
                </button>
                <button
                  onClick={() => togglePinned(key)}
                  className="flex items-center justify-center w-5 h-5 rounded text-muted hover:bg-panel/80 hover:text-fg-bright cursor-pointer"
                  aria-label={`${visible ? 'Unpin' : 'Pin'} ${LABELS[key]}`}
                  title={visible ? 'Pinned — click to unpin' : 'Click to pin'}
                  role="menuitemcheckbox"
                  aria-checked={visible}
                >
                  <span className="w-3 h-3 flex items-center justify-center">
                    {visible && <Check className="icon-xs text-accent" />}
                  </span>
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
