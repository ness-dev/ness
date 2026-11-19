import { ArrowLeft, GitBranch, Layers, Eye, Workflow, Lightbulb, ArrowRight, Folder, GitPullRequest, AlertTriangle, Smartphone } from 'lucide-react'

interface GuideProps {
  onClose: () => void
}

export function Guide({ onClose }: GuideProps): JSX.Element {
  return (
    <div className="flex flex-col h-full bg-panel">
      <div className="drag-region h-10 shrink-0 border-b border-border relative">
        <button
          onClick={onClose}
          className="no-drag absolute titlebar-lead-inset top-1/2 -translate-y-1/2 flex items-center gap-1.5 text-xs text-muted hover:text-fg-bright transition-colors cursor-pointer"
        >
          <ArrowLeft className="icon-sm" />
          Back
        </button>
        <span className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 text-sm font-medium text-fg pointer-events-none">
          Worktree Guide
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-8 py-12">
          {/* Hero */}
          <div className="mb-14">
            <h1 className="text-3xl font-bold text-fg-bright mb-3 tracking-tight">
              Run many Claudes in parallel
            </h1>
            <p className="text-lg text-muted leading-relaxed">
              A short guide to git worktrees, why they matter for agentic coding,
              and how Ness turns them into a workflow you&apos;ll actually use.
            </p>
          </div>

          {/* Intro framing */}
          <Section icon={Smartphone} title="Wait, why am I doing this?">
            <SoloFlow />
            <p>
              Be honest. How much of this week did you spend scrolling Instagram reels
              while a single Claude crunched through one task? Five minutes here, ten
              minutes there. Your screen-time report is doing things it has never done
              before, and the only person who knows is you and Apple.
            </p>
            <p>
              Meanwhile every AI influencer on your feed is breathlessly explaining{' '}
              <em>&ldquo;agent swarms&rdquo;</em> and <em>&ldquo;multi-agent orchestration&rdquo;</em>{' '}
              like it&apos;s a sacred incantation. The actual idea under the buzzwords is much
              simpler than they let on: stop running one Claude. Run several, on different
              problems, at the same time.
            </p>
            <p>
              The reason you&apos;re not already doing this isn&apos;t that it&apos;s hard — it&apos;s that
              nothing makes it easy. One terminal, one folder, one Claude. Two Claudes
              pointed at the same folder will trip over each other&apos;s edits within thirty
              seconds. So you wait. And scroll.
            </p>
            <p>
              Here&apos;s the alternative. While Claude #1 is grinding through that auth
              refactor, Claude #2 is fixing yesterday&apos;s bug, and Claude #3 is writing the
              tests you&apos;ve been procrastinating on. You glance over occasionally, unblock
              whichever one is waiting on you, and ship three things in the time it used
              to take to ship one. <strong className="text-fg-bright">You become the bottleneck only when you want to be.</strong>
            </p>
            <p className="text-dim">
              Doing this safely takes one small git primitive most people have never
              touched. That&apos;s the rest of this guide.
            </p>
          </Section>

          {/* Section 1 */}
          <Section icon={GitBranch} title="What is a git worktree?">
            <p>
              You know branches. Normally a repo has one working directory — the folder
              you <code>cd</code> into — and swapping branches rewrites the files on disk.
              That&apos;s fine until you want to work on two branches at once. Stash, checkout,
              stash-pop, forget which stash was which.
            </p>
            <p>
              <code>git worktree</code> solves this. A worktree is a{' '}
              <strong className="text-fg-bright">second (or third, or tenth) working copy</strong>{' '}
              of the same repo, checked out to a different branch, sharing the same
              underlying <code>.git</code> directory. Create one like this:
            </p>
            <CodeBlock>{`git worktree add ../myrepo-feature-x -b feature-x`}</CodeBlock>
            <WorktreeDiagram />
            <p>
              Now <code>../myrepo-feature-x</code> exists on disk, living on{' '}
              <code>feature-x</code>, while your main clone stays on <code>main</code>.
              Both are real checkouts. Both can be edited, built, and tested
              independently. Commits and fetches in one are immediately visible to the
              other because they share the same git objects.
            </p>
            <p className="text-dim">
              The one rule: the same branch can&apos;t be checked out in two worktrees
              at once. That&apos;s it.
            </p>
          </Section>

          {/* Section 2 */}
          <Section icon={Layers} title="Why worktrees unlock parallel agents">
            <p>
              Claude Code edits files on disk. If five Claude sessions share one working
              directory, they will stomp on each other — half-written files, conflicting
              edits, broken builds you can&apos;t attribute to anyone.
            </p>
            <p>
              One worktree per task fixes this completely. Five sessions, five folders,
              five isolated sandboxes. You become an orchestrator: kick off task A,
              kick off task B, walk away, come back, review A while Claude is still
              thinking about B.
            </p>
            <CollisionDiagram />
            <p>
              This is the single biggest change to how coding feels once you adopt it.
              You stop being the throughput bottleneck.
            </p>
          </Section>

          {/* Section 3 */}
          <Section icon={Workflow} title="The raw flow — and where it breaks down">
            <CodeBlock>{`git worktree add ../myrepo-bug-123 -b bug-123
cd ../myrepo-bug-123
npm install
claude`}</CodeBlock>
            <p>
              Repeat in a new terminal for every task. This works — for about two tasks.
              Then you lose track of which terminal is running which branch, you can&apos;t
              tell from across the room which Claudes are waiting for input, reviewing
              diffs means <code>git diff</code> in yet another pane, PR status lives
              on github.com, and cleaning up orphan <code>node_modules</code> eats a
              Sunday afternoon.
            </p>
            <p>
              Worktrees are the right primitive. They just need a frontend.
            </p>
          </Section>

          {/* Section 4 */}
          <Section icon={Eye} title="What Ness does for you">
            <HarnessMockup />
            <ul className="space-y-3 list-none pl-0">
              <Bullet title="One-click worktrees">
                Create and delete them from the sidebar. Ness runs the{' '}
                <code>git worktree</code> commands, handles the path naming, and
                selects the new worktree for you.
              </Bullet>
              <Bullet title="Tabs per worktree">
                Each worktree gets its own Claude terminal. Open extra shell tabs
                alongside for your dev server, test runner, or whatever else you need
                running in that checkout.
              </Bullet>
              <Bullet title="Reliable status dots">
                A sidebar dot tells you exactly what each session is doing — working,
                waiting on input, or asking for approval. Powered by Claude Code hooks,
                not flaky output parsing. Glance, don&apos;t click.
              </Bullet>
              <Bullet title="Inline diffs">
                A changed-files panel lives next to the terminal. Click a file to open
                it as a diff tab. No context switch to a separate tool.
              </Bullet>
              <Bullet title="Live PR status">
                See open PR state and CI check status for every worktree. Worktrees
                are sorted so the one that needs your attention floats to the top.
              </Bullet>
              <Bullet title="Hotkeys for everything">
                <code>⌘ 1</code>–<code>⌘ 9</code> jumps between worktrees.{' '}
                <code>⌘ T</code> opens a new shell. <code>⇧ ⌘ G</code> opens the active
                worktree&apos;s PR in your browser. <code>⌘ B</code> hides the sidebar.
                All rebindable in Settings.
              </Bullet>
            </ul>
          </Section>

          {/* Section 5 */}
          <Section icon={Workflow} title="A workflow that actually works">
            <ParallelTimeline />
            <ol className="space-y-3 list-decimal pl-5 marker:text-dim">
              <li>
                <strong className="text-fg-bright">One worktree, one task.</strong>{' '}
                Keep each worktree scoped to a single discrete unit of work — one bug,
                one feature, one refactor.
              </li>
              <li>
                <strong className="text-fg-bright">Start two or three in parallel.</strong>{' '}
                Begin small. Kick off a couple of Claudes with clear instructions, then
                let them cook.
              </li>
              <li>
                <strong className="text-fg-bright">Let the dots drive you.</strong>{' '}
                When a dot turns yellow, that Claude needs you. Jump over, unblock it,
                move on.
              </li>
              <li>
                <strong className="text-fg-bright">Review in the side panel.</strong>{' '}
                Before telling Claude to push, scan the changed files. Catch surprises
                early, while the context is still fresh.
              </li>
              <li>
                <strong className="text-fg-bright">Ship and clean up.</strong>{' '}
                When Claude opens a PR, CI kicks in — watch it from the PR panel. After
                merge, delete the worktree from the sidebar to free disk space and keep
                things tidy.
              </li>
            </ol>
          </Section>

          {/* Section 6 */}
          <Section icon={Lightbulb} title="Tips from running this every day">
            <ul className="space-y-2 list-disc pl-5 marker:text-dim">
              <li>
                <strong className="text-fg-bright">Independent tasks win.</strong>{' '}
                Parallel work pays off most when tasks don&apos;t touch the same files.
                Merge conflicts erase the time you saved.
              </li>
              <li>
                <strong className="text-fg-bright">Keep one worktree on <code>main</code>.</strong>{' '}
                Use it for reviewing PRs, running experiments, or sanity-checking
                something without disturbing any running agents.
              </li>
              <li>
                <strong className="text-fg-bright">Delete aggressively.</strong>{' '}
                Each worktree holds its own <code>node_modules</code>, build outputs,
                and disk space. Old ones pile up fast.
              </li>
              <li>
                <strong className="text-fg-bright">Fresh worktrees are fresh folders.</strong>{' '}
                Dependencies install from scratch in each one. A script that detects
                this and auto-installs is worth the hour it takes to write.
              </li>
              <li>
                <strong className="text-fg-bright">Give Claude enough rope.</strong>{' '}
                The whole point is to not babysit. Write instructions detailed enough
                that you can walk away for ten minutes without worrying.
              </li>
            </ul>
          </Section>

          {/* CTA */}
          <div className="mt-14 pt-8 border-t border-border flex items-center justify-between gap-4">
            <p className="text-sm text-dim">
              You can re-open this guide any time from Settings.
            </p>
            <button
              onClick={onClose}
              className="flex items-center gap-2 px-5 py-2.5 bg-accent/20 hover:bg-accent/30 border border-accent/40 rounded-lg text-sm font-medium text-fg-bright transition-colors cursor-pointer"
            >
              Close
              <ArrowRight className="icon-sm" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Section({
  icon: Icon,
  title,
  children
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>
  title: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <section className="mb-12">
      <div className="flex items-center gap-2.5 mb-4">
        <div className="w-8 h-8 rounded-lg bg-surface flex items-center justify-center text-accent shrink-0">
          <Icon className="icon-base" />
        </div>
        <h2 className="text-lg font-semibold text-fg-bright">{title}</h2>
      </div>
      <div className="text-sm text-fg leading-relaxed space-y-3 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:bg-surface [&_code]:rounded [&_code]:text-xs [&_code]:text-fg-bright [&_code]:font-mono">
        {children}
      </div>
    </section>
  )
}

function CodeBlock({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <pre className="bg-app border border-border rounded-lg p-4 text-xs text-fg-bright font-mono overflow-x-auto leading-relaxed">
      <code>{children}</code>
    </pre>
  )
}

function Bullet({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <li className="pl-0">
      <div className="font-medium text-fg-bright mb-0.5">{title}</div>
      <div className="text-sm text-muted leading-relaxed">{children}</div>
    </li>
  )
}

function Figure({ caption, children }: { caption: string; children: React.ReactNode }): JSX.Element {
  return (
    <figure className="my-6 bg-app/50 border border-border rounded-xl p-6">
      {children}
      <figcaption className="mt-4 text-xs text-dim text-center italic">{caption}</figcaption>
    </figure>
  )
}

/** One Claude grinding while you scroll. The whole problem in one figure. */
function SoloFlow(): JSX.Element {
  type State = 'kick' | 'scroll' | 'review' | 'work'
  const rows: { label: string; icon?: typeof Smartphone; segments: [number, State][] }[] = [
    { label: 'You', icon: Smartphone, segments: [[1, 'kick'], [9, 'scroll'], [1, 'review']] },
    { label: 'Claude', segments: [[11, 'work']] }
  ]
  const segColor = (s: State): string => {
    if (s === 'kick') return 'bg-info/60'
    if (s === 'scroll') return 'bg-faint/30'
    if (s === 'review') return 'bg-warning/60'
    return 'bg-success/70'
  }
  return (
    <Figure caption='One Claude. You "wait." Your screen-time report knows the truth.'>
      <div className="space-y-3">
        {rows.map((r) => {
          const Icon = r.icon
          return (
            <div key={r.label} className="flex items-center gap-3">
              <div className="flex items-center gap-1.5 w-20 shrink-0">
                {Icon && <Icon className="icon-xs text-muted" />}
                <span className="text-xs text-muted font-mono">{r.label}</span>
              </div>
              <div className="flex-1 flex h-6 rounded-md overflow-hidden border border-border">
                {r.segments.map((seg, i) => (
                  <div
                    key={i}
                    className={`${segColor(seg[1])} border-r border-app/40 last:border-r-0`}
                    style={{ flex: seg[0] }}
                  />
                ))}
              </div>
            </div>
          )
        })}
        <div className="flex items-center gap-4 pt-2 text-xs text-dim justify-center flex-wrap">
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-info/60" />kick off</span>
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-faint/30" />scrolling reels</span>
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-warning/60" />review</span>
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-success/70" />Claude working</span>
        </div>
      </div>
    </Figure>
  )
}

/** Central .git with branches out to multiple working directories. */
function WorktreeDiagram(): JSX.Element {
  const trees = [
    { label: 'myrepo/', branch: 'main', color: 'text-success', ring: 'border-success/40' },
    { label: 'myrepo-feature-x/', branch: 'feature-x', color: 'text-info', ring: 'border-info/40' },
    { label: 'myrepo-bug-123/', branch: 'bug-123', color: 'text-warning', ring: 'border-warning/40' }
  ]
  return (
    <Figure caption="One shared .git directory, three independent working copies on disk.">
      <div className="flex flex-col items-center">
        {/* .git node */}
        <div className="px-4 py-2 rounded-lg bg-surface border border-border-strong flex items-center gap-2">
          <GitBranch className="icon-sm text-accent" />
          <code className="text-xs text-fg-bright font-mono">.git</code>
        </div>
        {/* Connecting lines */}
        <svg width="100%" height="32" viewBox="0 0 300 32" preserveAspectRatio="none" className="max-w-md">
          <path d="M 150 0 L 150 12 L 50 12 L 50 32" stroke="currentColor" strokeWidth="1" fill="none" className="text-border-strong" />
          <path d="M 150 12 L 150 32" stroke="currentColor" strokeWidth="1" fill="none" className="text-border-strong" />
          <path d="M 150 12 L 250 12 L 250 32" stroke="currentColor" strokeWidth="1" fill="none" className="text-border-strong" />
        </svg>
        {/* Worktree boxes */}
        <div className="grid grid-cols-3 gap-3 w-full max-w-md">
          {trees.map((t) => (
            <div key={t.label} className={`px-2.5 py-3 rounded-lg bg-panel-raised border ${t.ring} flex flex-col items-center gap-1.5 min-w-0`}>
              <Folder className={`icon-base ${t.color}`} />
              <code className="text-xs text-fg-bright font-mono truncate max-w-full">{t.label}</code>
              <span className={`text-xs ${t.color} font-mono`}>{t.branch}</span>
            </div>
          ))}
        </div>
      </div>
    </Figure>
  )
}

/** Before/after: single shared dir with colliding agents vs isolated worktrees. */
function CollisionDiagram(): JSX.Element {
  return (
    <Figure caption="One working copy means collisions. One worktree per task means isolation.">
      <div className="grid grid-cols-2 gap-4">
        {/* Before — collision */}
        <div>
          <div className="text-xs uppercase tracking-wider text-danger mb-2 font-semibold flex items-center gap-1">
            <AlertTriangle className="icon-2xs" />
            <span>Without worktrees</span>
          </div>
          <div className="p-4 rounded-lg bg-danger/10 border border-danger/30 relative">
            <div className="flex items-center gap-1.5 mb-3">
              <Folder className="icon-sm text-danger" />
              <code className="text-xs text-fg-bright font-mono">myrepo/</code>
            </div>
            <div className="space-y-1.5">
              {['claude #1', 'claude #2', 'claude #3'].map((c, i) => (
                <div
                  key={c}
                  className="px-2 py-1 rounded bg-danger/20 border border-danger/40 text-xs text-fg-bright font-mono"
                  style={{ transform: `translateX(${i * 4}px) rotate(${i - 1}deg)` }}
                >
                  {c} ✎ src/api.ts
                </div>
              ))}
            </div>
          </div>
        </div>
        {/* After — isolation */}
        <div>
          <div className="text-xs uppercase tracking-wider text-success mb-2 font-semibold flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-success" />
            <span>With worktrees</span>
          </div>
          <div className="space-y-1.5">
            {[
              { folder: 'myrepo-a/', agent: 'claude #1' },
              { folder: 'myrepo-b/', agent: 'claude #2' },
              { folder: 'myrepo-c/', agent: 'claude #3' }
            ].map((row) => (
              <div key={row.folder} className="p-2 rounded-lg bg-success/10 border border-success/30 flex items-center gap-2">
                <Folder className="icon-xs text-success shrink-0" />
                <code className="text-xs text-fg-bright font-mono truncate">{row.folder}</code>
                <div className="flex-1" />
                <div className="px-1.5 py-0.5 rounded bg-success/20 text-xs text-success font-mono">{row.agent}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Figure>
  )
}

/** Miniature preview of the Ness sidebar with status dots and PR badges. */
function HarnessMockup(): JSX.Element {
  const rows = [
    { name: 'feature/onboarding', status: 'needs', pr: 'open', checks: 'pass' },
    { name: 'bug/login-flash', status: 'waiting', pr: 'open', checks: 'pending' },
    { name: 'refactor/types', status: 'working', pr: null, checks: null },
    { name: 'main', status: 'idle', pr: null, checks: null }
  ] as const

  const dotColor = (s: string): string => {
    if (s === 'working') return 'bg-success animate-pulse'
    if (s === 'waiting') return 'bg-warning'
    if (s === 'needs') return 'bg-danger'
    return 'bg-faint'
  }

  return (
    <Figure caption="A peek at the sidebar: every worktree, every status, one window.">
      <div className="rounded-lg bg-app border border-border overflow-hidden max-w-sm mx-auto">
        {/* fake title bar */}
        <div className="h-6 bg-panel border-b border-border flex items-center gap-1.5 px-2">
          <span className="w-2 h-2 rounded-full bg-danger/70" />
          <span className="w-2 h-2 rounded-full bg-warning/70" />
          <span className="w-2 h-2 rounded-full bg-success/70" />
        </div>
        <div className="flex">
          {/* fake sidebar */}
          <div className="w-full bg-panel py-2">
            {rows.map((row) => (
              <div key={row.name} className="flex items-center gap-2 px-3 py-2 hover:bg-surface/40 transition-colors">
                <span className={`w-2 h-2 rounded-full shrink-0 ${dotColor(row.status)}`} />
                <code className="text-xs text-fg-bright font-mono truncate flex-1">{row.name}</code>
                {row.pr && (
                  <div className="flex items-center gap-1 shrink-0">
                    <GitPullRequest className="icon-2xs text-success" />
                    {row.checks === 'pass' && <span className="w-1.5 h-1.5 rounded-full bg-success" />}
                    {row.checks === 'pending' && <span className="w-1.5 h-1.5 rounded-full bg-warning animate-pulse" />}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </Figure>
  )
}

/** Gantt-style parallel workflow: three tasks with alternating working/waiting/done states. */
function ParallelTimeline(): JSX.Element {
  // Each segment: [flex weight, state]
  const tasks: { label: string; segments: [number, 'work' | 'wait' | 'done'][] }[] = [
    { label: 'Task A', segments: [[3, 'work'], [1, 'wait'], [4, 'work'], [2, 'done']] },
    { label: 'Task B', segments: [[2, 'work'], [3, 'wait'], [3, 'work'], [2, 'done']] },
    { label: 'Task C', segments: [[1, 'wait'], [4, 'work'], [2, 'wait'], [3, 'work']] }
  ]

  const segColor = (s: 'work' | 'wait' | 'done'): string => {
    if (s === 'work') return 'bg-success/70'
    if (s === 'wait') return 'bg-warning/70'
    return 'bg-info/50'
  }

  return (
    <Figure caption="Three tasks running in parallel. You jump to whichever is waiting on you.">
      <div className="space-y-3">
        {tasks.map((t) => (
          <div key={t.label} className="flex items-center gap-3">
            <span className="text-xs text-muted font-mono w-14 shrink-0">{t.label}</span>
            <div className="flex-1 flex h-6 rounded-md overflow-hidden border border-border">
              {t.segments.map((seg, i) => (
                <div
                  key={i}
                  className={`${segColor(seg[1])} border-r border-app/40 last:border-r-0`}
                  style={{ flex: seg[0] }}
                />
              ))}
            </div>
          </div>
        ))}
        <div className="flex items-center gap-4 pt-2 text-xs text-dim justify-center">
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-success/70" />working</span>
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-warning/70" />waiting on you</span>
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-info/50" />merged</span>
        </div>
      </div>
    </Figure>
  )
}
