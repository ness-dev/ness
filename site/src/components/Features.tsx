import { type ReactNode } from 'react'

export function Features() {
  return (
    <section id="features" className="max-w-6xl mx-auto px-6 py-24">
      <h2 className="text-3xl sm:text-4xl font-bold text-center mb-4">Built for parallel work</h2>
      <p className="text-ink-500 text-center mb-16 max-w-xl mx-auto">
        The rest of what keeps a team of Claudes pointed at the right things.
      </p>

      <div className="grid md:grid-cols-3 gap-6">
        <FeatureCard
          title="Full editor built in"
          description="Click any file for a Monaco-powered editor with syntax highlighting for every language, multi-cursor, find-and-replace, and ⌘S to save. Diffs auto-collapse unchanged regions and expand on click."
          preview={
            <div className="flex flex-col justify-center gap-0.5 font-mono text-[10px] w-full">
              <div className="flex items-center gap-2">
                <span className="text-ink-700 w-3 text-right">1</span>
                <span className="text-purple-400">const</span>
                <span className="text-blue-300">user</span>
                <span className="text-ink-500">=</span>
                <span className="text-amber-300">await</span>
                <span className="text-green-400">fetch</span>
                <span className="text-ink-500">(</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-ink-700 w-3 text-right">2</span>
                <span className="text-ink-500 ml-2">'/api/me'</span>
                <span className="text-ink-500">)</span>
                <span className="inline-block w-[1px] h-3 bg-ink-200 ml-0.5 caret-blink" />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-ink-700 w-3 text-right">3</span>
                <span className="text-ink-600 italic ml-2">// signed in</span>
              </div>
            </div>
          }
        />

        <FeatureCard
          title="Multi-repo"
          description="Manage multiple repos in a single window. Each repo is a project in the sidebar: click it to open its main workspace, or merge them into one list to see everything at once."
          preview={
            <div className="flex items-center justify-center gap-3">
              <RepoPill label="api" color="text-amber-300" dots={['bg-green-500', 'bg-amber-400']} />
              <RepoPill
                label="web"
                color="text-blue-300"
                dots={['bg-green-500', 'bg-green-500', 'bg-red-500']}
              />
              <RepoPill label="infra" color="text-purple-300" dots={['bg-green-500']} />
            </div>
          }
        />

        <FeatureCard
          title="Command center"
          description="Bird's-eye view of every worktree in one grid, with mini activity timelines showing which agents have been productive and which got stuck."
          preview={
            <div className="grid grid-cols-3 gap-1 w-full h-full p-2">
              {[
                { dot: 'bg-green-500', label: 'auth', pulse: true },
                { dot: 'bg-red-500', label: 'api', pulse: true },
                { dot: 'bg-amber-400', label: 'tests', pulse: false },
                { dot: 'bg-green-500', label: 'docs', pulse: true },
                { dot: 'bg-green-500', label: 'login', pulse: true },
                { dot: 'bg-amber-400', label: 'perf', pulse: false }
              ].map((c, i) => (
                <div
                  key={i}
                  className="rounded bg-ink-800/60 border border-ink-700/40 flex flex-col items-center justify-center gap-0.5"
                >
                  <span className={`w-2 h-2 rounded-full ${c.dot} ${c.pulse ? 'pulse-dot' : ''}`} />
                  <span className="text-[7px] text-ink-500">{c.label}</span>
                </div>
              ))}
            </div>
          }
        />
      </div>
    </section>
  )
}

function FeatureCard({
  title,
  description,
  preview
}: {
  title: string
  description: string
  preview: ReactNode
}) {
  return (
    <div className="bg-ink-950/60 border border-ink-800 rounded-xl p-6 hover:border-ink-700 transition-colors">
      <div className="h-16 mb-4 flex items-center justify-center bg-ink-900/40 rounded-lg border border-ink-800/60 px-3">
        {preview}
      </div>
      <h3 className="text-lg font-semibold mb-2">{title}</h3>
      <p className="text-sm text-ink-500 leading-relaxed">{description}</p>
    </div>
  )
}

function RepoPill({ label, color, dots }: { label: string; color: string; dots: string[] }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <div
        className={`px-2 py-0.5 rounded bg-ink-800 border border-ink-700 text-[9px] font-mono ${color}`}
      >
        {label}
      </div>
      <div className="flex gap-0.5">
        {dots.map((d, i) => (
          <span key={i} className={`w-1.5 h-1.5 rounded-full ${d}`} />
        ))}
      </div>
    </div>
  )
}
