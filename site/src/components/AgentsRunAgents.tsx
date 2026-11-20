import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { useReducedMotion } from 'framer-motion'
import { Bot, GitBranchPlus, MessageSquareDiff, MessageSquareShare, Radio } from 'lucide-react'

const AgentGraphMock = lazy(() => import('./AgentGraphMock'))

const POINTS = [
  {
    icon: GitBranchPlus,
    title: 'Spawn worktrees',
    body: (
      <>
        An agent calls <Code>create_worktree</Code> with a briefing. A fresh agent picks it up on its own
        branch, in its own folder.
      </>
    )
  },
  {
    icon: Radio,
    title: 'Follow them',
    body: (
      <>
        The creator automatically follows what it spawned: PR, CI and review updates, plus progress reports.
        Routine news waits for its next turn. Urgent news interrupts. Any agent can{' '}
        <Code>subscribe_to_worktree</Code> to follow a sibling too.
      </>
    )
  },
  {
    icon: MessageSquareDiff,
    title: 'Review agents',
    body: (
      <>
        <Code>request_review</Code> opens a reviewer next to the author. It leaves inline comments and hands
        its verdict straight back.
      </>
    )
  },
  {
    icon: MessageSquareShare,
    title: 'Message each other',
    body: (
      <>
        <Code>send_message</Code> lands as a turn in another worktree’s chat, waking it if it was asleep.
      </>
    )
  },
  {
    icon: Bot,
    title: 'Subagents too',
    body: <>Claude’s own subagents still work inside any chat, for the small stuff.</>
  }
]

function Code({ children }: { children: string }) {
  return (
    <code className="font-mono text-[0.85em] text-ink-300 bg-ink-850 px-1 py-px rounded">{children}</code>
  )
}

/** Same chrome and rough height as the loaded mock, so the page doesn't
 *  jump when the graph chunk arrives. */
function Placeholder() {
  return (
    <div className="rounded-xl overflow-hidden border border-border-strong bg-app">
      <div className="h-10 border-b border-border bg-panel" />
      <div className="h-9 border-b border-border bg-panel" />
      <div className="h-[340px] sm:h-[420px]" />
      <div className="h-[3.25rem] border-t border-border bg-panel" />
    </div>
  )
}

export function AgentsRunAgents() {
  const reduced = !!useReducedMotion()
  const graphRef = useRef<HTMLDivElement>(null)
  // Fetch the graph chunk a screen or so before it's needed; play the story
  // only while it's actually visible.
  const [near, setNear] = useState(false)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const el = graphRef.current
    if (!el) return
    const nearIo = new IntersectionObserver(([e]) => e.isIntersecting && setNear(true), {
      rootMargin: '800px 0px'
    })
    const visIo = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.35 })
    nearIo.observe(el)
    visIo.observe(el)
    return () => {
      nearIo.disconnect()
      visIo.disconnect()
    }
  }, [])

  return (
    <section id="orchestration" className="max-w-6xl mx-auto px-6 py-24">
      <div className="max-w-2xl mx-auto text-center mb-12">
        <div className="text-xs uppercase tracking-[0.2em] text-brand/80 font-semibold mb-4">
          Orchestration
        </div>
        <h2 className="text-4xl font-bold tracking-tight mb-4">Your agents, run agents.</h2>
        <p className="text-ink-400 leading-relaxed">
          Every agent in Ness can start, follow and review other agents through the Ness MCP. Hand one a big
          job and it splits the work across worktrees, then keeps track of all of them for you.
        </p>
      </div>

      <div
        ref={graphRef}
        role="img"
        aria-label="Ness's subscription graph: an orchestrator agent on main has created three worktrees and follows each one. One has a pull request with CI running, one is being reviewed by a reviewer agent, and one subscribes to a sibling worktree."
      >
        <div aria-hidden="true">
          {near ? (
            <Suspense fallback={<Placeholder />}>
              <AgentGraphMock reduced={reduced} playing={visible} />
            </Suspense>
          ) : (
            <Placeholder />
          )}
        </div>
      </div>
      <p className="text-xs text-ink-500 text-center mt-4">
        The subscription graph in Ness. Every agent in a project, and who follows whom.
      </p>

      <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-x-8 gap-y-8 mt-14">
        {POINTS.map(({ icon: Icon, title, body }) => (
          <div key={title}>
            <Icon className="w-5 h-5 text-brand mb-3" aria-hidden="true" />
            <h3 className="font-semibold text-ink-100 mb-1.5">{title}</h3>
            <p className="text-sm text-ink-500 leading-relaxed">{body}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
