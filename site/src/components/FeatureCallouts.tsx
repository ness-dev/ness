import { Globe, MousePointer2, Smartphone } from 'lucide-react'
import { HighlightCard } from './HighlightCard'
import { SectionIntro } from './SectionIntro'

export function FeatureCallouts() {
  return (
    <section id="anywhere" className="max-w-6xl mx-auto px-6 py-14 sm:py-20">
      <SectionIntro step="04" eyebrow="Anywhere" title="Off your desk, into the browser.">
        Keep an eye on your agents from your phone, and let them drive a real browser when they need to see what
        they built.
      </SectionIntro>

      <div className="grid sm:grid-cols-2 gap-5">
        <HighlightCard icon={Smartphone} title="Mobile mode" preview={<PhonePreview />}>
          Control your agents from your phone. Guaranteed to be better than Claude's shitty remote UI.
        </HighlightCard>
        <HighlightCard icon={Globe} title="Browser control" preview={<BrowserPreview />}>
          Give agents control of your browser. Useful for testing your code locally, or just ordering groceries.
        </HighlightCard>
      </div>
    </section>
  )
}

const PHONE_ROWS = [
  { dot: 'bg-green-500 pulse-dot', bar: 'w-5' },
  { dot: 'bg-amber-400', bar: 'w-4' },
  { dot: 'bg-red-500 pulse-dot', bar: 'w-6' }
]

function PhonePreview() {
  return (
    <div className="flex items-center gap-3" aria-hidden="true">
      <div className="w-8 h-14 rounded-md border border-ink-700 bg-ink-950 px-1 pt-2 flex flex-col gap-1.5">
        {PHONE_ROWS.map(({ dot, bar }, i) => (
          <div key={i} className="flex items-center gap-1">
            <span className={`w-1 h-1 rounded-full shrink-0 ${dot}`} />
            <span className={`h-0.5 rounded-full bg-ink-700 ${bar}`} />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-1 text-[10px] font-mono">
        <span className="text-ink-300">bug/login-flash</span>
        <span className="flex items-center gap-1.5">
          <span className="rounded bg-red-500/15 text-red-400 px-1.5 py-px">approve</span>
          <span className="text-ink-600">from your phone</span>
        </span>
      </div>
    </div>
  )
}

function BrowserPreview() {
  return (
    <div className="w-full max-w-56 rounded-md border border-ink-700 bg-ink-950 overflow-hidden" aria-hidden="true">
      <div className="flex items-center gap-1 px-1.5 py-1 border-b border-ink-800">
        <span className="w-1 h-1 rounded-full bg-ink-600" />
        <span className="w-1 h-1 rounded-full bg-ink-600" />
        <span className="w-1 h-1 rounded-full bg-ink-600" />
        <span className="ml-1.5 flex-1 truncate rounded bg-ink-850 px-1.5 text-[9px] font-mono text-ink-400">
          localhost:5173/login
        </span>
      </div>
      <div className="relative flex items-center gap-1.5 px-2 py-1.5">
        <span className="h-1 w-10 rounded-full bg-ink-700" />
        <span className="ml-auto rounded bg-brand/20 border border-brand/40 px-1.5 text-[9px] text-brand">
          Sign in
        </span>
        <MousePointer2 className="absolute right-1 top-3 w-3 h-3 text-ink-100 fill-ink-100" />
      </div>
    </div>
  )
}
