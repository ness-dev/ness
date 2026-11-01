import { memo, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { rehypeHighlightShared } from '../rehype-highlight-shared'

/** GFM for review comments, replies, summaries and request context. Same
 *  `.markdown` typography as chat. No rehype-raw, so raw HTML stays inert,
 *  and the default urlTransform still blanks `javascript:` and friends. */

const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS = [rehypeHighlightShared]

// Rows that hold markdown are themselves clickable (jump to the diff), so
// a link click must not also bubble up to the row. target=_blank goes
// through setWindowOpenHandler, which opens http(s) in the OS browser.
const COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
      {children}
    </a>
  ),
  // A review isn't worth a network fetch on render; show the link instead.
  img: ({ src, alt }) =>
    typeof src === 'string' && src ? (
      <a href={src} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
        {alt || src}
      </a>
    ) : null
}

export const ReviewMarkdown = memo(function ReviewMarkdown({
  text,
  className = ''
}: {
  text: string
  className?: string
}): JSX.Element {
  return (
    <div className={`markdown text-fg ${className}`}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})

// `.markdown p` sets line-height 1.5, so N lines is N × 1.5em.
const CLAMP_CLASS = {
  3: 'max-h-[4.5em]',
  4: 'max-h-[6em]'
} as const

/** Markdown cut to its first few lines, with Show more when it overflows.
 *  Measured after layout rather than guessed from the source, since a
 *  code fence or table renders far taller than its line count. */
export function ExpandableMarkdown({
  text,
  lines = 3
}: {
  text: string
  lines?: keyof typeof CLAMP_CLASS
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || open) return
    const measure = (): void => setOverflows(el.scrollHeight > el.clientHeight + 1)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [text, open])

  const clamped = !open && overflows
  return (
    <div>
      <div
        ref={ref}
        className={
          open
            ? ''
            : `${CLAMP_CLASS[lines]} overflow-hidden ${
                clamped ? '[mask-image:linear-gradient(to_bottom,black_55%,transparent)]' : ''
              }`
        }
      >
        <ReviewMarkdown text={text} />
      </div>
      {(clamped || open) && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            setOpen((v) => !v)
          }}
          className="mt-1.5 text-faint hover:text-fg cursor-pointer"
        >
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}
