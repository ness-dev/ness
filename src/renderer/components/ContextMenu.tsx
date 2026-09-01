import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'

export interface ContextMenuItem {
  label: string
  onClick: () => void
  danger?: boolean
  /** Renders the item as a radio/toggle choice with a leading tick. Any item
   *  in the menu setting this puts every item in the checked gutter, so the
   *  labels stay aligned. */
  checked?: boolean
}

interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y })
  const hasChecks = items.some((item) => item.checked !== undefined)

  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const margin = 4
    const maxLeft = window.innerWidth - width - margin
    const maxTop = window.innerHeight - height - margin
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

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-panel-raised border border-border-strong rounded shadow-lg text-xs py-1 min-w-[12rem]"
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((item, i) => (
        <button
          key={i}
          className={`w-full text-left px-3 py-1.5 hover:bg-panel cursor-pointer ${
            hasChecks ? 'flex items-center gap-2' : 'block'
          } ${item.danger ? 'text-danger' : 'text-fg-bright'}`}
          onClick={(e) => {
            e.stopPropagation()
            item.onClick()
            onClose()
          }}
        >
          {hasChecks && (
            <Check className={`icon-2xs shrink-0 ${item.checked ? 'text-accent' : 'opacity-0'}`} />
          )}
          {item.label}
        </button>
      ))}
    </div>
  )
}
