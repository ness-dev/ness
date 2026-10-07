import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronRight } from 'lucide-react'

export interface ContextMenuSubItem {
  label: string
  onClick: () => void
  /** Renders a checkmark in the gutter — used for radio-style choices. */
  checked?: boolean
  disabled?: boolean
}

export interface ContextMenuItem {
  label: string
  /** Omitted on items that only open a submenu. */
  onClick?: () => void
  danger?: boolean
  /** When present the item opens a nested menu on hover instead of firing. */
  submenu?: ContextMenuSubItem[]
}

/** A horizontal rule fencing off a run of entries — used to keep the
 *  irreversible actions away from the everyday ones. */
export interface ContextMenuSeparator {
  separator: true
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuSeparator

interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuEntry[]
  onClose: () => void
}

const SUBMENU_WIDTH = 176

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y })
  const [width, setWidth] = useState(192)
  const [openSub, setOpenSub] = useState<number | null>(null)
  const subRef = useRef<HTMLDivElement>(null)
  const [subShift, setSubShift] = useState(0)

  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const { width: w, height } = el.getBoundingClientRect()
    const margin = 4
    const maxLeft = window.innerWidth - w - margin
    const maxTop = window.innerHeight - height - margin
    setWidth(w)
    setPos({
      left: Math.max(margin, Math.min(x, maxLeft)),
      top: Math.max(margin, Math.min(y, maxTop))
    })
  }, [x, y, items.length])

  useEffect(() => {
    const close = (): void => onClose()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    // No 'blur' listener: macOS fires one at the window the moment Command
    // arms the native menu bar, which dismissed the menu out from under
    // anyone reaching for a Cmd-chord.
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // A submenu opens level with its parent item, which runs off the bottom of
  // the screen when the row right-clicked is near it. Measure once open and
  // lift it by the overflow. Computing against the UNSHIFTED bottom is what
  // makes this converge — comparing the already-shifted rect would find no
  // overflow, reset to 0, and oscillate.
  useLayoutEffect(() => {
    if (openSub === null) {
      setSubShift(0)
      return
    }
    const el = subRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const overflow = rect.bottom - subShift - (window.innerHeight - 4)
    const next = overflow > 0 ? -overflow : 0
    if (next !== subShift) setSubShift(next)
  }, [openSub, subShift])

  // Submenus fly out to the right unless that would run off-screen.
  const flipSub = pos.left + width + SUBMENU_WIDTH > window.innerWidth - 4

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-panel-raised border border-border-strong rounded shadow-lg text-xs py-1 min-w-[12rem]"
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((item, i) =>
        'separator' in item ? (
          <div key={i} role="separator" className="my-1 border-t border-border-strong" />
        ) : item.submenu ? (
          <div
            key={i}
            className="relative"
            onMouseEnter={() => setOpenSub(i)}
            onMouseLeave={() => setOpenSub((cur) => (cur === i ? null : cur))}
          >
            <div
              className={`flex items-center gap-2 w-full text-left px-3 py-1.5 cursor-default text-fg-bright ${
                openSub === i ? 'bg-panel' : ''
              }`}
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={openSub === i}
            >
              <span className="flex-1">{item.label}</span>
              <ChevronRight className="icon-2xs shrink-0 opacity-60" />
            </div>
            {openSub === i && item.submenu.length > 0 && (
              <div
                ref={subRef}
                className="absolute bg-panel-raised border border-border-strong rounded shadow-lg py-1 max-h-[80vh] overflow-y-auto"
                style={{
                  width: SUBMENU_WIDTH,
                  top: subShift,
                  left: flipSub ? undefined : width - 4,
                  right: flipSub ? width - 4 : undefined
                }}
                role="menu"
              >
                {item.submenu.map((sub, j) => (
                  <button
                    key={j}
                    disabled={sub.disabled}
                    className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-fg-bright hover:bg-panel cursor-pointer disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent"
                    role="menuitemradio"
                    aria-checked={!!sub.checked}
                    onClick={(e) => {
                      e.stopPropagation()
                      sub.onClick()
                      onClose()
                    }}
                  >
                    <span className="w-3 h-3 flex items-center justify-center shrink-0">
                      {sub.checked && <Check className="icon-2xs text-accent" />}
                    </span>
                    <span className="flex-1 truncate">{sub.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <button
            key={i}
            className={`block w-full text-left px-3 py-1.5 hover:bg-panel cursor-pointer ${
              item.danger ? 'text-danger' : 'text-fg-bright'
            }`}
            onMouseEnter={() => setOpenSub(null)}
            onClick={(e) => {
              e.stopPropagation()
              item.onClick?.()
              onClose()
            }}
          >
            {item.label}
          </button>
        )
      )}
    </div>
  )
}
