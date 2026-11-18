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
