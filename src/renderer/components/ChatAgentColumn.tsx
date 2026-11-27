import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { PanelRightClose, Sparkles } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import {
  agentElapsedMs,
  formatElapsed,
  type AgentStep,
  type AgentSummary
} from '../../shared/state/json-claude-agents'
import { AgentPeek } from './AgentPeek'
import { AgentApprovalCards } from './AgentApprovalCards'
import { Chevron } from './json-mode-cards/ChatRow'
import { AgentStatusDot, agentStatusLabel } from './AgentStatusDot'
import { AgentStepLine } from './AgentStepLine'
import { useLiveClock } from './JsonClaudeAgentsPanel'
import { ResizeHandle } from './ResizeHandle'
import { useSessionAgents } from '../hooks/useSessionAgents'
import { useSettings } from '../store'
import { isColumnOpen, parseColumnChoices, withColumnChoice } from './subagent-column-open'
import { getCardOverrides, setCardOverride } from './subagent-card-overrides'
import { fingerprint, flattenRows, type Row } from './agent-column-rows'

const WIDTH_KEY = 'harness:agentColumnWidth'
const CHOICES_KEY = 'harness:subagentsColumnOpen'
const DEFAULT_WIDTH = 360
const MIN_WIDTH = 240
const MAX_WIDTH = 720
/** Steps a card renders inline. The rest are one click away in the peek
 *  — an agent can make hundreds of calls, and a card that mounts all of
 *  them makes every poll pay for the whole history. */
const INLINE_STEPS = 40
const TEXT_PREVIEW = 600
const DEFAULT_SUBAGENT_TYPE = 'general-purpose'
const REPORT_LIMIT = 3000

function readWidth(): number {
  const saved = Number(localStorage.getItem(WIDTH_KEY))
  return saved >= MIN_WIDTH && saved <= MAX_WIDTH ? saved : DEFAULT_WIDTH
}

/** One step, memoized on its content. A running agent's steps are new
 *  objects on every poll, so the default shallow compare would re-parse
 *  every text step's markdown twice a second. */
const StepRow = memo(
  function StepRow({
    step,
    onPeekAgent
  }: {
    step: AgentStep
    onPeekAgent: (id: string) => void
  }): JSX.Element {
    if (step.kind === 'text') {
      return (
        <div className="py-0.5 pl-3 border-l-2 border-border/50 markdown">
          <ReactMarkdown>
            {step.text && step.text.length > TEXT_PREVIEW
              ? `${step.text.slice(0, TEXT_PREVIEW)}…`
              : (step.text ?? '')}
          </ReactMarkdown>
        </div>
      )
    }
    if (step.childAgentToolUseId) {
      const id = step.childAgentToolUseId
      return (
        <button
          type="button"
          onClick={() => onPeekAgent(id)}
          className="flex w-full min-w-0 text-left hover:bg-app/60 rounded px-1 py-0.5 cursor-pointer"
        >
          <AgentStepLine step={step} />
        </button>
      )
    }
    return (
      <div className="flex min-w-0 px-1 py-0.5">
        <AgentStepLine step={step} />
      </div>
    )
  },
  (a, b) =>
    a.onPeekAgent === b.onPeekAgent &&
    a.step.key === b.step.key &&
    a.step.kind === b.step.kind &&
    a.step.text === b.step.text &&
    a.step.isError === b.step.isError &&
    a.step.childAgentToolUseId === b.step.childAgentToolUseId
)

/** Keeps a scroll container pinned to its bottom while its content grows,
 *  until the user scrolls up — and again once they scroll back down.
 *
 *  Growth is observed on the content, not inferred from a dep list: a
 *  card's height changes when it settles, collapses, or streams text, and
 *  none of that shows up as a new row or step. Scroll anchoring is off on
 *  the container because the browser's own adjustment fires a scroll
 *  event that reads as the user leaving the bottom. */
function useFollowTail(slack: number, enabled = true) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  useLayoutEffect(() => {
    const el = scrollRef.current
    const content = contentRef.current
    if (!enabled || !el || !content) return
    const follow = (): void => {
      if (pinnedRef.current) el.scrollTop = el.scrollHeight
    }
    follow()
    const ro = new ResizeObserver(follow)
    ro.observe(content)
    return () => ro.disconnect()
  }, [enabled])
  const onScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget
      pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < slack
    },
    [slack]
  )
  return { scrollRef, contentRef, onScroll }
}

interface CardProps {
  sessionId: string
  agent: AgentSummary
  depth: number
  /** Only passed to running cards. Settled elapsed times are fixed, so a
   *  settled card given the clock would re-render every second for a
   *  label that can't change. */
  now: number
  expanded: boolean
  onToggle: (id: string, expanded: boolean) => void
  onPeek: (id: string) => void
}

/** Chrome matches TaskCard — same border, radius, header padding and
 *  type scale — so an agent reads the same here as it does inline in the
 *  transcript. */
function AgentCardImpl({
  sessionId,
  agent,
  depth,
  now,
  expanded,
  onToggle,
  onPeek
}: CardProps): JSX.Element {
  const running = agent.status === 'running'
  const failed = agent.status === 'failed' || !!agent.resultIsError
  const stepCount = agent.steps.length
  const tail = useFollowTail(24, expanded && running)
  const meta = [
    `${agent.toolCount} ${agent.toolCount === 1 ? 'tool' : 'tools'}`,
    formatElapsed(agentElapsedMs(agent, now))
  ].join(' · ')
  const hidden = Math.max(0, stepCount - INLINE_STEPS)
  const inline = hidden ? agent.steps.slice(-INLINE_STEPS) : agent.steps

  return (
    <li style={{ marginLeft: `${Math.min(depth, 4) * 0.75}rem` }}>
      <div
        className={`border ${failed ? 'border-danger/50' : 'border-border/60'} bg-app/30 overflow-hidden transition-opacity ${
          running || agent.hasPendingApproval ? '' : 'opacity-60 hover:opacity-100'
        }`}
        style={{ borderRadius: 'var(--chat-bubble-radius)' }}
      >
        <button
          type="button"
          onClick={() => onToggle(agent.toolUseId, !expanded)}
          title={[agent.description, agent.prompt, agentStatusLabel(agent)]
            .filter(Boolean)
            .join('\n\n')}
          className="w-full flex items-center gap-2 cursor-pointer hover:bg-app/60 transition-colors text-left"
          style={{
            paddingInline: 'var(--chat-chrome-px)',
            paddingBlock: 'var(--chat-chrome-py)',
            fontSize: 'var(--chat-chrome-text)'
          }}
        >
          <Chevron open={expanded} className="text-muted" />
          <AgentStatusDot agent={agent} />
          {/* The purpose leads: in a column of near-identical cards, the
              title is the only thing that tells them apart at a glance. */}
          <span
            className={`truncate flex-1 min-w-0 ${running ? 'text-fg-bright' : 'text-fg'}`}
          >
            {agent.description}
          </span>
          {/* The default type says nothing — only a specialised agent
              earns the label, and it trails the title rather than
              preceding it. */}
          {agent.subagentType && agent.subagentType !== DEFAULT_SUBAGENT_TYPE && (
            <span
              className="text-muted shrink-0"
              style={{
                fontFamily: 'var(--chat-tool-name-family)',
                fontSize: 'var(--chat-meta-text)'
              }}
            >
              {agent.subagentType}
            </span>
          )}
          {agent.isBackground && (
            <span
              title="detached — runs past the end of the turn"
              className="uppercase tracking-wide text-muted bg-app/60 border border-border/50 rounded px-1 py-0.5 shrink-0"
              style={{ fontSize: 'var(--chat-meta-text)' }}
            >
              background
            </span>
          )}
          <span
            className="text-muted/70 shrink-0 tabular-nums"
            style={{ fontSize: 'var(--chat-meta-text)' }}
          >
            {meta}
          </span>
        </button>

        {/* Outside the disclosure: a blocked agent stays blocked whether
            or not its card is open, so the prompt can't hide behind the
            chevron. */}
        {agent.pendingApprovalToolUseIds.length > 0 && (
          <div className="px-2 pb-1">
            <AgentApprovalCards
              sessionId={sessionId}
              toolUseIds={agent.pendingApprovalToolUseIds}
            />
          </div>
        )}

        {expanded && (
          <div className="px-2 pb-1">
            {agent.prompt && (
              <div
                title={agent.prompt}
                className="mx-1 mt-0.5 mb-1 pl-2 border-l-2 border-border/50 text-xs text-muted whitespace-pre-wrap line-clamp-3"
              >
                {agent.prompt}
              </div>
            )}
            <div
              ref={tail.scrollRef}
              onScroll={tail.onScroll}
              className={`overflow-y-auto [overflow-anchor:none] text-xs ${
                running ? 'max-h-64' : 'max-h-48'
              }`}
            >
              <div ref={tail.contentRef} className="space-y-0.5 py-1">
                {hidden > 0 && (
                  <button
                    type="button"
                    onClick={() => onPeek(agent.toolUseId)}
                    className="text-faint hover:text-fg cursor-pointer px-1"
                  >
                    {hidden} earlier {hidden === 1 ? 'step' : 'steps'} — open history
                  </button>
                )}
                {stepCount === 0 && (
                  <div className="px-1 text-muted italic">
                    {running ? 'sub-agent is starting…' : 'no sub-agent activity recorded'}
                  </div>
                )}
                {inline.map((step) => (
                  <StepRow key={step.key} step={step} onPeekAgent={onPeek} />
                ))}
              </div>
            </div>
            {agent.result && !running && (
              <pre
                className={`my-1 px-2 py-1 text-xs font-mono whitespace-pre-wrap max-h-60 overflow-auto rounded bg-app/40 ${
                  agent.resultIsError ? 'text-danger' : 'opacity-80'
                }`}
              >
                {agent.result.length > REPORT_LIMIT
                  ? `${agent.result.slice(0, REPORT_LIMIT)}…`
                  : agent.result}
              </pre>
            )}
          </div>
        )}
      </div>
    </li>
  )
}

const AgentCard = memo(AgentCardImpl, (a, b) => {
  if (
    a.sessionId !== b.sessionId ||
    a.depth !== b.depth ||
    a.expanded !== b.expanded ||
    a.onToggle !== b.onToggle ||
    a.onPeek !== b.onPeek
  ) {
    return false
  }
  if (a.agent === b.agent) return a.now === b.now
  return a.now === b.now && fingerprint(a.agent) === fingerprint(b.agent)
})

/** The cards, separated from the column chrome so the chrome's own
 *  re-renders (per streamed token, via the session hook) stop here when
 *  the row list hasn't changed. */
const AgentFeed = memo(function AgentFeed({
  sessionId,
  rows,
  now,
  isExpanded,
  onToggle,
  onPeek
}: {
  sessionId: string
  rows: readonly Row[]
  now: number
  isExpanded: (agent: AgentSummary) => boolean
  onToggle: (id: string, expanded: boolean) => void
  onPeek: (id: string) => void
}): JSX.Element {
  const tail = useFollowTail(32)

  return (
    <div
      ref={tail.scrollRef}
      onScroll={tail.onScroll}
      className="flex-1 min-h-0 overflow-y-auto [overflow-anchor:none] px-2 py-2"
    >
      <div ref={tail.contentRef}>
        <ul className="space-y-1.5">
          {rows.map(({ agent, depth }) => (
            <AgentCard
              key={agent.toolUseId}
              sessionId={sessionId}
              agent={agent}
              depth={depth}
              now={agent.status === 'running' ? now : 0}
              expanded={isExpanded(agent)}
              onToggle={onToggle}
              onPeek={onPeek}
            />
          ))}
        </ul>
      </div>
    </div>
  )
})

function ChatAgentColumnLive({
  sessionId,
  chipSlot
}: {
  sessionId: string
  chipSlot: HTMLElement | null
}): JSX.Element | null {
  const { agents, running } = useSessionAgents(sessionId)
  const { subagentsColumnDefault } = useSettings()
  const [choices, setChoices] = useState(() =>
    parseColumnChoices(localStorage.getItem(CHOICES_KEY))
  )
  const closed = !isColumnOpen(choices, sessionId, subagentsColumnDefault)
  const [width, setWidth] = useState(readWidth)
  // Explicit user choices only. A card defaults open while it's running
  // and closed once it settles, so this records overrides rather than the
  // state — otherwise a card would stay open after its agent finished.
  // Seeded from, and written through to, a store that outlives this
  // component, which unmounts whenever the tab is hidden.
  const [overrides, setOverrides] = useState(() => getCardOverrides(sessionId))
  // Deliberately not persisted: a modal over the chat shouldn't reappear
  // on returning to a tab.
  const [peekId, setPeekId] = useState<string | null>(null)

  // Written once the drag settles rather than per mousemove frame.
  useEffect(() => {
    const id = setTimeout(() => localStorage.setItem(WIDTH_KEY, String(width)), 250)
    return () => clearTimeout(id)
  }, [width])

  const rows = useMemo(() => flattenRows(agents), [agents])
  const now = useLiveClock(!closed && running > 0)

  const isExpanded = useCallback(
    (a: AgentSummary) =>
      overrides.get(a.toolUseId) ?? (a.status === 'running' || a.hasPendingApproval),
    [overrides]
  )
  const onToggle = useCallback(
    (id: string, next: boolean) =>
      setOverrides(setCardOverride(sessionId, id, next)),
    [sessionId]
  )
  const setColumnClosed = useCallback(
    (v: boolean) => {
      // Re-read so a choice made in another chat since this one mounted
      // isn't overwritten with this component's stale copy.
      const next = withColumnChoice(
        parseColumnChoices(localStorage.getItem(CHOICES_KEY)),
        sessionId,
        !v
      )
      localStorage.setItem(CHOICES_KEY, JSON.stringify(next))
      setChoices(next)
    },
    [sessionId]
  )
  const onResize = useCallback(
    (delta: number) =>
      setWidth((w) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w - delta))),
    []
  )

  const peeked = peekId ? agents.find((a) => a.toolUseId === peekId) : undefined
  useEffect(() => {
    if (peekId && !peeked) setPeekId(null)
  }, [peekId, peeked])

  if (agents.length === 0) return null

  const status = running > 0 ? `${running} running` : `${agents.length} done`
  // A blocked agent can't make progress until someone answers, and with
  // the column collapsed nothing else on screen says so.
  const blocked = agents.some((a) => a.pendingApprovalToolUseIds.length > 0)
  const peek = peeked && (
    <AgentPeek
      sessionId={sessionId}
      agent={peeked}
      now={now}
      onClose={() => setPeekId(null)}
      onPeekAgent={setPeekId}
    />
  )

  if (closed) {
    // Collapsed into the composer's status row, beside the session state
    // and permission-mode chips — the column's footprint goes back to the
    // transcript, and the way back sits where the eye already is.
    return (
      <>
        {chipSlot &&
          createPortal(
            <button
              type="button"
              onClick={() => setColumnClosed(false)}
              title={blocked ? 'A subagent needs approval — show subagents' : 'Show subagents'}
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-xs hover:text-fg-bright cursor-pointer ${
                blocked ? 'border-warning/60 text-warning' : 'border-border text-muted'
              }`}
            >
              {blocked ? (
                <span className="shrink-0" aria-label="needs approval">⚠</span>
              ) : running > 0 ? (
                <span className="json-claude-spinner shrink-0" />
              ) : (
                <Sparkles className="icon-2xs shrink-0" />
              )}
              <span>subagents</span>
              <span className="tabular-nums opacity-70">{status}</span>
            </button>,
            chipSlot
          )}
        {peek}
      </>
    )
  }

  return (
    <>
      <ResizeHandle onDelta={onResize} onDoubleClick={() => setWidth(DEFAULT_WIDTH)} />
      <div
        className="shrink-0 flex flex-col min-h-0"
        style={{ width }}
        data-subagents-column
      >
        <div className="flex items-center gap-2 px-3 h-8 shrink-0 border-b border-border/60">
          <span className="text-xs uppercase tracking-wide text-muted flex-1">
            Subagents
          </span>
          <span className="text-xs tabular-nums text-faint">{status}</span>
          <button
            type="button"
            onClick={() => setColumnClosed(true)}
            aria-label="Hide subagents"
            title="Hide subagents"
            className="p-0.5 text-muted hover:text-fg-bright cursor-pointer"
          >
            <PanelRightClose className="icon-sm" />
          </button>
        </div>
        <AgentFeed
          sessionId={sessionId}
          rows={rows}
          now={now}
          isExpanded={isExpanded}
          onToggle={onToggle}
          onPeek={setPeekId}
        />
      </div>
      {peek}
    </>
  )
}

/** Live subagent feed beside a Chat tab's transcript. Mounts nothing
 *  until the session has launched an agent, and nothing at all while the
 *  tab is hidden — a backgrounded tab would otherwise keep the revision
 *  poll and the clock running for a column nobody can see.
 *
 *  `chipSlot` is an element in the composer's status row; the collapsed
 *  column portals its reopen chip there. Portaling rather than lifting
 *  the agent list into JsonModeChat keeps the revision poll and the clock
 *  from re-rendering the whole chat. */
export function ChatAgentColumn({
  sessionId,
  active,
  chipSlot
}: {
  sessionId: string
  active: boolean
  chipSlot: HTMLElement | null
}): JSX.Element | null {
  if (!active) return null
  // Keyed so a session change remounts with that session's own closed
  // state and card choices instead of carrying the last one's.
  return <ChatAgentColumnLive key={sessionId} sessionId={sessionId} chipSlot={chipSlot} />
}
