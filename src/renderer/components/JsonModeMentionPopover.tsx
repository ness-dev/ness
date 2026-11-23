import { useEffect, useRef, type ReactNode } from 'react'

export interface MentionPopoverItem {
  key: string
  label: string
  /** What picking the row inserts, when that isn't the label. */
  insertText?: string
  labelMatchIndices?: number[]
  description?: string
  hint?: string
  icon?: ReactNode
}

interface MentionPopoverProps {
  items: MentionPopoverItem[]
  selectedIdx: number
  onHover: (idx: number) => void
  onPick: (item: MentionPopoverItem, idx: number) => void
  emptyText?: string
  header?: ReactNode
  footer?: ReactNode
}

function highlight(label: string, indices?: number[]): ReactNode {
  if (!indices || indices.length === 0) return label
  const set = new Set(indices)
  const out: ReactNode[] = []
  for (let i = 0; i < label.length; i++) {
    out.push(
      <span
        key={i}
        className={set.has(i) ? 'text-accent font-semibold' : undefined}
      >
        {label[i]}
      </span>
    )
  }
  return out
}

export function JsonModeMentionPopover({
  items,
  selectedIdx,
  onHover,
  onPick,
  emptyText,
  header,
  footer
}: MentionPopoverProps): JSX.Element {
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = listRef.current?.querySelector(
      `[data-mention-idx="${selectedIdx}"]`
    ) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 bg-surface border border-border rounded-md shadow-xl overflow-hidden z-30">
      {header && (
        <div className="px-3 py-1.5 border-b border-border text-xs uppercase tracking-wider text-faint">
          {header}
        </div>
      )}
      <div ref={listRef} className="max-h-60 overflow-y-auto py-1">
        {items.length === 0 ? (
          <div className="px-3 py-3 text-xs text-dim text-center">
            {emptyText ?? 'No matches'}
          </div>
        ) : (
          items.map((item, idx) => {
            const isSelected = idx === selectedIdx
            return (
              <button
                key={item.key}
                data-mention-idx={idx}
                onMouseEnter={() => onHover(idx)}
                onMouseDown={(e) => {
                  // mousedown (not click) so the textarea doesn't blur first.
                  e.preventDefault()
                  onPick(item, idx)
                }}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm cursor-pointer transition-colors ${
                  isSelected ? 'bg-accent/15 text-fg-bright' : 'text-fg hover:bg-surface-hover'
                }`}
              >
                {item.icon && <span className="shrink-0 text-dim">{item.icon}</span>}
                <span className="font-mono text-xs text-fg-bright truncate">
                  {highlight(item.label, item.labelMatchIndices)}
                </span>
                {item.description && (
                  <span className="truncate text-xs text-faint min-w-0 flex-1">
                    {item.description}
                  </span>
                )}
                {item.hint && (
                  <kbd className="text-xs text-faint bg-bg px-1 py-0.5 rounded border border-border font-mono shrink-0">
                    {item.hint}
                  </kbd>
                )}
              </button>
            )
          })
        )}
      </div>
      {footer && (
        <div className="px-3 py-1 border-t border-border text-xs text-faint">
          {footer}
        </div>
      )}
    </div>
  )
}
