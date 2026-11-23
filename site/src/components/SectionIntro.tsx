import type { ReactNode } from 'react'

/** The centred eyebrow + heading + lede shared by the Highlights →
 *  Orchestration → Conversation blame run. The step number is what makes the
 *  three read as one sequence rather than three unrelated blocks. */
export function SectionIntro({
  step,
  eyebrow,
  title,
  children
}: {
  step: string
  eyebrow: string
  title: string
  children: ReactNode
}) {
  return (
    <div className="max-w-2xl mx-auto text-center mb-12">
      <div className="text-xs uppercase tracking-[0.2em] font-semibold mb-4">
        <span className="text-ink-600 tabular-nums">{step}</span>
        <span className="text-ink-700 mx-2" aria-hidden="true">
          /
        </span>
        <span className="text-brand/80">{eyebrow}</span>
      </div>
      <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">{title}</h2>
      <p className="text-ink-400 leading-relaxed">{children}</p>
    </div>
  )
}
