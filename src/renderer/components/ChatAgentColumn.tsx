import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, PanelRightClose, Sparkles } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import {
  useJsonClaudePendingApprovals,
  useJsonClaudeSession
} from '../store'
import {
  agentElapsedMs,
  collectAgents,
  countRunningAgents,
  formatElapsed,
  type AgentStep,
  type AgentSummary
} from '../../shared/state/json-claude-agents'
import { AgentPeek } from './AgentPeek'
import { AgentStatusDot, agentStatusLabel } from './AgentStatusDot'
import { AgentStepLine } from './AgentStepLine'
import { useLiveClock } from './JsonClaudeAgentsPanel'
import { ResizeHandle } from './ResizeHandle'
import { useSessionRevision } from '../session-revision'
import { fingerprint, flattenRows, type Row } from './agent-column-rows'

const WIDTH_KEY = 'harness:agentColumnWidth'
const CLOSED_KEY = 'harness:agentColumnClosed'
const DEFAULT_WIDTH = 360
const MIN_WIDTH = 240
const MAX_WIDTH = 720
/** Steps a running card renders inline. The rest are one click away in
 *  the peek — an agent can make hundreds of calls, and a card that
 *  mounts all of them makes every poll pay for the whole history. */
const INLINE_STEPS = 40
const TEXT_PREVIEW = 600
const REPORT_PREVIEW = 220
/** Closed-column choices are remembered per session; this bounds the
 *  list so it can't grow without limit across months of sessions. */
const CLOSED_CAP = 200

function readWidth(): number {
  const saved = Number(localStorage.getItem(WIDTH_KEY))
  return saved >= MIN_WIDTH && saved <= MAX_WIDTH ? saved : DEFAULT_WIDTH
}

function readClosed(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(CLOSED_KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

function writeClosed(sessionId: string, closed: boolean): void {
  const rest = readClosed().filter((id) => id !== sessionId)
  const next = closed ? [...rest, sessionId].slice(-CLOSED_CAP) : rest
  localStorage.setItem(CLOSED_KEY, JSON.stringify(next))
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

function reportPreview(result: string): string {
  const flat = result.replace(/[#*`>_]+/g, '').replace(/\s+/g, ' ').trim()
  return flat.length > REPORT_PREVIEW ? `${flat.slice(0, REPORT_PREVIEW)}…` : flat
}

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
  agent: AgentSummary
  depth: number
  /** Only passed to running cards. Settled elapsed times are fixed, so a
   *  settled card given the clock would re-render every second for a
   *  label that can't change. */
  now: number
  expanded: boolean
  onToggle: (id: string) => void
  onPeek: (id: string) => void
}

function AgentCardImpl({
  agent,
  depth,
  now,
  expanded,
  onToggle,
  onPeek
}: CardProps): JSX.Element {
  const running = agent.status === 'running'
  const elapsed = formatElapsed(agentElapsedMs(agent, now))
  const kind = agent.subagentType ?? 'agent'
  const stepCount = agent.steps.length
  const tail = useFollowTail(24, running)

  const accent = agent.hasPendingApproval
    ? 'border-warning bg-warning/5'
    : running
      ? 'border-success bg-success/5'
      : 'border-border/60 opacity-60 hover:opacity-100'

  const hidden = Math.max(0, stepCount - INLINE_STEPS)
  const inline = hidden ? agent.steps.slice(-INLINE_STEPS) : agent.steps

  return (
    <li style={{ marginLeft: `${Math.min(depth, 4) * 0.75}rem` }}>
      <div
        className={`border-l-2 rounded-r transition-opacity ${accent} ${
          depth > 0 ? 'ml-1' : ''
        }`}
      >
        <button
          type="button"
          onClick={() => (running ? onPeek(agent.toolUseId) : onToggle(agent.toolUseId))}
          title={running ? 'Click to open its full history' : expanded ? 'Collapse' : 'Expand'}
          className="flex w-full min-w-0 items-center gap-1.5 px-2 pt-1.5 pb-1 text-left cursor-pointer"
        >
          {!running && (
            <ChevronRight
              className={`icon-2xs text-faint shrink-0 transition-transform ${
                expanded ? 'rotate-90' : ''
              }`}
            />
          )}
          <AgentStatusDot agent={agent} />
          <span
            className={`truncate flex-1 min-w-0 text-xs ${
              running ? 'text-fg-bright' : 'text-fg'
            }`}
          >
            {agent.description}
          </span>
          {agent.isBackground && (
            <span
              title="detached — runs past the end of the turn"
              className="text-faint uppercase tracking-wide shrink-0 text-xs"
            >
              bg
            </span>
          )}
          <span className="text-faint tabular-nums shrink-0 text-xs">{elapsed}</span>
        </button>
        <div className="flex items-center gap-2 px-2 pb-1 text-xs text-faint min-w-0">
          <span className="truncate">{kind}</span>
          <span className="tabular-nums shrink-0">
            {agent.toolCount} {agent.toolCount === 1 ? 'tool' : 'tools'}
          </span>
          {!running && (
            <span className="shrink-0">{agentStatusLabel(agent)}</span>
          )}
        </div>

        {running && (
          <div
            ref={tail.scrollRef}
            onScroll={tail.onScroll}
            className="max-h-64 overflow-y-auto [overflow-anchor:none] px-2 pb-1.5 text-xs"
          >
            <div ref={tail.contentRef} className="space-y-0.5">
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
                <div className="text-muted italic px-1">agent is starting…</div>
              )}
              {inline.map((step) => (
                <StepRow key={step.key} step={step} onPeekAgent={onPeek} />
              ))}
              <div className="flex items-center gap-2 px-1 py-0.5">
                <span className="json-claude-spinner shrink-0" />
                <span className="text-muted italic">working…</span>
              </div>
            </div>
          </div>
        )}

        {!running && !expanded && agent.result && (
          <div
            className={`px-2 pb-1.5 text-xs line-clamp-2 ${
              agent.resultIsError ? 'text-danger' : 'text-muted'
            }`}
          >
            {reportPreview(agent.result)}
          </div>
        )}

        {!running && expanded && (
          <div className="px-2 pb-2 text-xs">
            {agent.result ? (
              <div
                className={`markdown max-h-96 overflow-y-auto ${
                  agent.resultIsError ? 'text-danger' : ''
                }`}
              >
                <ReactMarkdown>{agent.result}</ReactMarkdown>
              </div>
            ) : (
              <div className="text-muted italic">no report</div>
            )}
            <button
              type="button"
              onClick={() => onPeek(agent.toolUseId)}
              className="mt-1 text-faint hover:text-fg cursor-pointer"
            >
              open history ({stepCount} {stepCount === 1 ? 'step' : 'steps'})
            </button>
          </div>
        )}
      </div>
    </li>
  )
}

const AgentCard = memo(AgentCardImpl, (a, b) => {
  if (
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
  rows,
  now,
  isExpanded,
  onToggle,
  onPeek
}: {
  rows: readonly Row[]
  now: number
  isExpanded: (id: string) => boolean
  onToggle: (id: string) => void
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
              agent={agent}
              depth={depth}
              now={agent.status === 'running' ? now : 0}
              expanded={isExpanded(agent.toolUseId)}
              onToggle={onToggle}
              onPeek={onPeek}
            />
          ))}
        </ul>
      </div>
    </div>
  )
})

function ChatAgentColumnLive({ sessionId }: { sessionId: string }): JSX.Element | null {
  const session = useJsonClaudeSession(sessionId)
  const pendingApprovals = useJsonClaudePendingApprovals()
  const [closed, setClosed] = useState(() => readClosed().includes(sessionId))
  const [width, setWidth] = useState(readWidth)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [peekId, setPeekId] = useState<string | null>(null)

  useEffect(() => {
    localStorage.setItem(WIDTH_KEY, String(width))
  }, [width])

  const pendingToolUseIds = useMemo(() => {
    const ids = new Set<string>()
    for (const p of Object.values(pendingApprovals)) {
      if (p.sessionId === session?.sessionId && p.toolUseId) ids.add(p.toolUseId)
    }
    return ids
  }, [pendingApprovals, session?.sessionId])

  // Same derivation contract as JsonClaudeAgentsPanel: keyed on the
  // session revision rather than the session object, which churns per
  // streamed token, and fed its previous result so settled agents come
  // back by reference.
  const sessionRef = useRef(session)
  sessionRef.current = session
  const runningRef = useRef(0)
  const revision = useSessionRevision(session, runningRef.current > 0)
  const prevAgentsRef = useRef<readonly AgentSummary[]>([])
  const agents = useMemo(() => {
    const next = collectAgents(sessionRef.current, pendingToolUseIds, prevAgentsRef.current)
    prevAgentsRef.current = next
    return next
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, pendingToolUseIds])

  const rows = useMemo(() => flattenRows(agents), [agents])
  const running = countRunningAgents(agents)
  runningRef.current = running
  const now = useLiveClock(running > 0)

  const isExpanded = useCallback((id: string) => expanded.has(id), [expanded])
  const onToggle = useCallback(
    (id: string) =>
      setExpanded((cur) => {
        const next = new Set(cur)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      }),
    []
  )
  const setColumnClosed = useCallback(
    (v: boolean) => {
      setClosed(v)
      writeClosed(sessionId, v)
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

  const peek = peeked && (
    <AgentPeek
      agent={peeked}
      now={now}
      onClose={() => setPeekId(null)}
      onPeekAgent={setPeekId}
    />
  )

  if (closed) {
    return (
      <>
        <button
          type="button"
          onClick={() => setColumnClosed(false)}
          title={`Show agents (${running > 0 ? `${running} running` : `${agents.length} done`})`}
          className="shrink-0 flex flex-col items-center gap-1.5 w-7 py-2 border-l border-border-strong bg-panel text-muted hover:text-fg-bright cursor-pointer"
        >
          <Sparkles className={`icon-sm ${running > 0 ? 'text-success' : ''}`} />
          <span className="text-xs tabular-nums">{running > 0 ? running : agents.length}</span>
        </button>
        {peek}
      </>
    )
  }

  return (
    <>
      <ResizeHandle onDelta={onResize} onDoubleClick={() => setWidth(DEFAULT_WIDTH)} />
      <div
        className="shrink-0 flex flex-col min-h-0 bg-panel"
        style={{ width }}
        data-agent-column
      >
        <div className="flex items-center gap-2 px-3 h-8 shrink-0 border-b border-border/60">
          <Sparkles className="icon-sm text-muted shrink-0" />
          <span className="text-xs text-fg-bright flex-1">Agents</span>
          <span className={`text-xs tabular-nums ${running > 0 ? 'text-success' : 'text-faint'}`}>
            {running > 0 ? `${running} running` : `${agents.length} done`}
          </span>
          <button
            type="button"
            onClick={() => setColumnClosed(true)}
            aria-label="Hide agents column"
            title="Hide agents column"
            className="p-0.5 text-muted hover:text-fg-bright cursor-pointer"
          >
            <PanelRightClose className="icon-sm" />
          </button>
        </div>
        <AgentFeed
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

/** Live sub-agent feed beside a Chat tab: `| chat | agents |`. Mounts
 *  nothing until the session has launched an agent, and nothing at all
 *  while the tab is hidden — a backgrounded tab would otherwise keep the
 *  revision poll and the clock running for a column nobody can see. */
export function ChatAgentColumn({
  sessionId,
  active
}: {
  sessionId: string
  active: boolean
}): JSX.Element | null {
  if (!active) return null
  return <ChatAgentColumnLive sessionId={sessionId} />
}
