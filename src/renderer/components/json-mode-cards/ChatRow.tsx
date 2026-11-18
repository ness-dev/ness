import type { CSSProperties, ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

/** Disclosure indicator for every expander in the chat transcript. An
 *  SVG rather than a ▸/▾ glyph: the glyph's ink sits in the top half of
 *  its em box, so it rides visibly above the label it's centred against. */
export function Chevron({
  open,
  className = 'text-muted'
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

/** Body of an expanded row. A thin rule under the chevron's centre line
 *  carries the hierarchy that nested boxes used to. */
export function ChatRowChildren({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="mt-0.5 mb-1 ml-1.5 pl-3 border-l border-border">
      {children}
    </div>
  )
}
