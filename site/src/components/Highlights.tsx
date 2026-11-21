import type { ReactNode } from 'react'
import { Activity, GitBranch, Loader2, MessageSquarePlus, PanelRight } from 'lucide-react'
import { SectionIntro } from './SectionIntro'

/** The four things Ness is for, in one ordinary section. The full app
 *  window is already on screen in the HeroMock just above, so each card gets
 *  a small static illustration instead of another mock. */

const HIGHLIGHTS: { icon: typeof Activity; title: string; body: ReactNode; preview: ReactNode }[] = [
  {
    icon: GitBranch,
    title: 'Every agent on its own branch',
    body: (
      <>
        Each task gets its own git worktree: its own branch, its own folder, its own Claude (or Codex). Agents
        never fight over the same file, and you switch between them in a keystroke.
      </>
    ),
    preview: <WorktreeTree />
  },
  {
    icon: Activity,
    title: 'See who needs you',
    body: (
      <>
        Every row’s dot says whether its agent is working, waiting on you or asking permission. It comes from
        Claude Code hooks, not from guessing at terminal output.
      </>
    ),
    preview: (
      <div className="flex items-center justify-center gap-4">
        <StatusBadge color="bg-green-500" label="working" pulsing />
        <StatusBadge color="bg-amber-400" label="waiting" />
        <StatusBadge color="bg-red-500" label="approve" pulsing />
      </div>
    )
  },
  {
    icon: MessageSquarePlus,
    title: 'New work in a sentence',
    body: (
      <>
        Ask your project’s main workspace for something and it starts a worktree with an agent on it, or press{' '}
        <Kbd>⌘N</Kbd>. Ness handles the git worktree from creation to cleanup.
      </>
    ),
    preview: (
      <div className="flex flex-col gap-1.5 w-full text-[10px]">
        <div className="self-end max-w-full truncate rounded-md bg-ink-800 px-2 py-0.5 text-ink-300">
          Let admins invite teammates.
        </div>
        <div className="flex items-center gap-1.5 font-mono text-ink-400 min-w-0">
          <Loader2 className="w-3 h-3 shrink-0 text-brand animate-spin motion-reduce:animate-none" />
          <span className="truncate">feat/team-invites</span>
          <span className="text-ink-600 shrink-0">creating…</span>
        </div>
      </div>
    )
  },
  {
    icon: PanelRight,
    title: 'The whole branch beside the chat',
    body: (
      <>
        PR and CI status, the branch’s commits, changed files and an editor sit next to the agent. Failing checks
        and conflicts float to the top of the sidebar. <Kbd>⌘⇧G</Kbd> opens the PR.
      </>
    ),
    preview: (
      <div className="flex flex-col justify-center gap-1 w-full">
        <PRRow dot="bg-green-500" branch="feat/onboarding" checks="bg-green-500" />
        <PRRow dot="bg-amber-400" branch="bug/login-flash" checks="bg-amber-400" checksPulse />
      </div>
    )
  }
]

export function Highlights() {
  return (
    <section id="highlights" className="max-w-6xl mx-auto px-6 pt-4 pb-14 sm:pb-20">
      <SectionIntro step="01" eyebrow="Highlights" title="One window for every agent.">
        Run a whole team of agents in parallel without losing track of any of them. Here’s what that looks like
        day to day.
      </SectionIntro>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
        {HIGHLIGHTS.map(({ icon: Icon, title, body, preview }) => (
          <article key={title} className="bg-ink-950/60 border border-ink-800 rounded-xl p-5 flex flex-col">
            <div className="h-16 mb-5 flex items-center justify-center bg-ink-900/40 rounded-lg border border-ink-800/60 px-3">
              {preview}
            </div>
            <Icon className="w-5 h-5 text-brand mb-3" aria-hidden="true" />
            <h3 className="font-semibold text-ink-100 mb-1.5">{title}</h3>
            <p className="text-sm text-ink-500 leading-relaxed">{body}</p>
          </article>
        ))}
      </div>
    </section>
  )
}

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="font-mono text-[0.85em] text-ink-300 bg-ink-850 px-1 py-px rounded">{children}</kbd>
  )
}

function WorktreeTree() {
  return (
    <div className="flex flex-col items-center" aria-hidden="true">
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
  )
}

function StatusBadge({ color, label, pulsing }: { color: string; label: string; pulsing?: boolean }) {
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
