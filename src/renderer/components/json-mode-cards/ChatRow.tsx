import type { CSSProperties, ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

/** Disclosure indicator for every expander in the chat transcript. An
 *  SVG rather than a ▸/▾ glyph: the glyph's ink sits in the top half of
 *  its em box, so it rides visibly above the label it's centred against. */
export function Chevron({
  open,
  className = ''
}: {
  open: boolean
  className?: string
}): JSX.Element {
  const Icon = open ? ChevronDown : ChevronRight
  return <Icon className={`icon-xs shrink-0 ${className}`} aria-hidden />
}

/** The flat, borderless expander row every transcript disclosure shares —
 *  the finished-turn fold, tool groups, tool calls, thoughts. Muted until
 *  hovered; colour is inherited so the chevron and icons follow it. */
export const CHAT_ROW_CLASS =
  'w-full flex items-center gap-2 cursor-pointer text-left text-muted hover:text-fg transition-colors'

export const CHAT_ROW_STYLE: CSSProperties = {
  paddingBlock: 'var(--chat-chrome-py)',
  fontSize: 'var(--chat-chrome-text)'
}

/** Body of an expanded row. Flush with the row above it rather than
 *  indented: nesting reads as more boxes, which is what the flat rows
 *  replaced. */
export function ChatRowChildren({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="mt-0.5 mb-1">
      {children}
    </div>
  )
}

/** Find-in-chat's current match on a flat row. The negative margin pays
 *  for the padding so the ring clears the chevron and text without
 *  shifting the row. */
export const CHAT_ROW_HIT_CLASS = 'rounded -mx-1.5 px-1.5 ring-1 ring-accent/70 bg-accent/10'
