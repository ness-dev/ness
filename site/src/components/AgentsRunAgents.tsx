import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { useReducedMotion } from 'framer-motion'
import { Bot, GitBranchPlus, MessageSquareDiff, MessageSquareShare, Radio } from 'lucide-react'
import { InlineCode } from './InlineCode'
import { SectionIntro } from './SectionIntro'

const AgentGraphMock = lazy(() => import('./AgentGraphMock'))

const POINTS = [
  {
    icon: GitBranchPlus,
    title: 'Spawn worktrees',
    body: (
      <>
        An agent calls <InlineCode>create_worktree</InlineCode> with a briefing. A fresh agent picks it up on its own
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
        <InlineCode>subscribe_to_worktree</InlineCode> to follow a sibling too.
      </>
    )
  },
  {
    icon: MessageSquareDiff,
    title: 'Review agents',
    body: (
      <>
        <InlineCode>request_review</InlineCode> opens a reviewer next to the author. It leaves inline comments and hands
        its verdict straight back.
      </>
    )
  },
  {
    icon: MessageSquareShare,
    title: 'Message each other',
    body: (
      <>
        <InlineCode>send_message</InlineCode> lands as a turn in another worktree’s chat, waking it if it was asleep.
      </>
    )
  },
  {
    icon: Bot,
    title: 'Subagents too',
    body: <>Claude’s own subagents still work inside any chat, for the small stuff.</>
  }
]

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
    <section id="orchestration" className="max-w-6xl mx-auto px-6 py-14 sm:py-20">
      <SectionIntro step="02" eyebrow="Orchestration" title="Your agents, run agents.">
        Every agent in Ness can start, follow and review other agents through the Ness MCP. Hand one a big job
        and it splits the work across worktrees, then keeps track of all of them for you.
      </SectionIntro>

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
