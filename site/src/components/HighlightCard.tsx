import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

/** The compact card the numbered sections share: a small drawn preview,
 *  then icon, title and body. Previews are drawn in JSX, not screenshots. */
export function HighlightCard({
  icon: Icon,
  title,
  preview,
  children
}: {
  icon: LucideIcon
  title: string
  preview: ReactNode
  children: ReactNode
}) {
  return (
    <article className="bg-ink-950/60 border border-ink-800 rounded-xl p-5 flex flex-col">
      <div className="h-16 mb-5 flex items-center justify-center bg-ink-900/40 rounded-lg border border-ink-800/60 px-3">
        {preview}
      </div>
      <Icon className="w-5 h-5 text-brand mb-3" aria-hidden="true" />
      <h3 className="font-semibold text-ink-100 mb-1.5">{title}</h3>
      <p className="text-sm text-ink-500 leading-relaxed">{children}</p>
    </article>
  )
}
