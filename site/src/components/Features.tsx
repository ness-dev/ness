import { type ReactNode } from 'react'

export function Features() {
  return (
    <section id="features" className="max-w-6xl mx-auto px-6 py-24">
      <h2 className="text-4xl font-bold text-center mb-4">Built for parallel work</h2>
      <p className="text-ink-500 text-center mb-16 max-w-xl mx-auto">
        Everything you need to keep a team of Claudes pointed at the right things.
      </p>

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
        <FeatureCard
          title="Reliable status dots"
          description="Each worktree's sidebar dot shows exactly what Claude is doing — working, waiting on you, or asking permission. Powered by Claude Code hooks, not flaky output parsing."
          preview={
            <div className="flex items-center justify-center gap-4">
              <StatusBadge color="bg-green-500" label="working" pulsing />
              <StatusBadge color="bg-amber-400" label="waiting" />
              <StatusBadge color="bg-red-500" label="approve" pulsing />
            </div>
          }
        />

        <FeatureCard
          title="One worktree per task"
          description="Ask your project's main workspace for the work and it creates the worktrees, or start one yourself with ⌘N. Each task gets its own folder and branch so agents never trip over each other's edits."
          preview={
            <div className="flex flex-col items-center">
              <div className="px-2 py-0.5 rounded bg-ink-800 border border-ink-700 text-[9px] font-mono text-ink-300">
                .git
              </div>
              <svg width="80" height="14" viewBox="0 0 80 14">
                <path
                  d="M40 0 L40 6 L12 6 L12 14 M40 6 L40 14 M40 6 L68 6 L68 14"
                  stroke="#525252"
                  strokeWidth="1"
                  fill="none"
                />
              </svg>
              <div className="flex gap-2">
                <div className="w-3.5 h-3.5 rounded bg-green-500/20 border border-green-500/50" />
                <div className="w-3.5 h-3.5 rounded bg-blue-500/20 border border-blue-500/50" />
                <div className="w-3.5 h-3.5 rounded bg-amber-500/20 border border-amber-500/50" />
              </div>
            </div>
          }
        />

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
          title="Live PR status"
          description="See open PRs and CI checks for every worktree. The list re-sorts so the one that needs your attention floats to the top. ⌘⇧G opens it in the browser."
          preview={
            <div className="flex flex-col justify-center gap-1 w-full">
              <PRRow dot="bg-green-500" branch="feat/onboarding" checks="bg-green-500" />
              <PRRow
                dot="bg-amber-400"
                branch="bug/login-flash"
                checks="bg-amber-400"
                checksPulse
              />
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

function StatusBadge({
  color,
  label,
  pulsing
}: {
  color: string
  label: string
  pulsing?: boolean
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`w-2.5 h-2.5 rounded-full ${color} ${pulsing ? 'pulse-dot' : ''}`} />
      <span className="text-[10px] text-ink-500 font-mono">{label}</span>
    </div>
  )
}

function PRRow({
  dot,
  branch,
  checks,
  checksPulse
}: {
  dot: string
  branch: string
  checks: string
  checksPulse?: boolean
}) {
  return (
    <div className="flex items-center gap-2">
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      <span className="text-[10px] font-mono text-ink-300 flex-1 truncate">{branch}</span>
      <svg
        className="text-purple-400"
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="18" cy="18" r="3" />
        <circle cx="6" cy="6" r="3" />
        <path d="M13 6h3a2 2 0 0 1 2 2v7" />
        <line x1="6" y1="9" x2="6" y2="21" />
      </svg>
      <span className={`w-1.5 h-1.5 rounded-full ${checks} ${checksPulse ? 'pulse-dot' : ''}`} />
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
