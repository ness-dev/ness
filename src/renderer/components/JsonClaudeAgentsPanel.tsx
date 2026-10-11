import { useEffect, useMemo, useRef, useState } from 'react'
import { CornerDownRight } from 'lucide-react'
import {
  useJsonClaudePendingApprovals,
  useJsonClaudeSession
} from '../store'
import {
  agentElapsedMs,
  collectAgents,
  countRunningAgents,
  formatElapsed,
  type AgentSummary
} from '../../shared/state/json-claude-agents'
import { RightPanel } from './RightPanel'
import { AgentPeek } from './AgentPeek'
import { AgentStatusDot, agentStatusLabel } from './AgentStatusDot'
import { AgentStepLine } from './AgentStepLine'

/** How often the panel re-derives while anything is live. `collectAgents`
 *  walks the whole entries array, and the focused session's object
 *  identity changes on every streamed token — deriving off that directly
 *  means one full walk per token, which is anti-pattern #4 in CLAUDE.md
 *  with extra allocations. This is a status display; sub-second freshness
 *  buys nothing, and the cap holds regardless of token rate. */
const LIVE_REFRESH_MS = 500

/** Finished agents shown before collapsing the rest behind a toggle. */
const SETTLED_PREVIEW = 5

/** One clock for the whole panel. Elapsed times are the only thing here
 *  that changes without a state event, so they get a single shared tick
 *  rather than a timer per row — and it only runs while something is
 *  actually running. 1s because these are second-granularity labels. */
function useLiveClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

function AgentRow({
  agent,
  now,
  onPeek
}: {
  agent: AgentSummary
  now: number
  onPeek: () => void
}): JSX.Element {
  const lastStep = agent.steps.length
    ? agent.steps[agent.steps.length - 1]
    : null
  const running = agent.status === 'running'
  const elapsed = formatElapsed(agentElapsedMs(agent, now))
  const kind = agent.subagentType ? `${agent.subagentType} agent` : 'agent'
  return (
    <li>
      <button
        type="button"
        onClick={onPeek}
        title={
          `${agent.description}\n${kind} · ` +
          `${running ? `running for ${elapsed}` : `${agentStatusLabel(agent)} after ${elapsed}`}` +
          `\n${agent.toolCount} tool ${agent.toolCount === 1 ? 'call' : 'calls'}` +
          (agent.childAgentCount
            ? ` · ${agent.childAgentCount} nested`
            : '') +
          '\n\nClick to peek inside'
        }
        className="w-full text-left px-3 py-1 hover:bg-app/60 cursor-pointer"
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <AgentStatusDot agent={agent} />
          <span
            className={`truncate flex-1 min-w-0 ${
              running ? 'text-fg-bright' : 'text-fg'
            } ${agent.status === 'interrupted' ? 'opacity-60' : ''}`}
          >
            {agent.description}
          </span>
          {agent.childAgentCount > 0 && (
            <span
              title={`launched ${agent.childAgentCount} nested ${
                agent.childAgentCount === 1 ? 'agent' : 'agents'
              }`}
              className="flex items-center gap-0.5 text-faint shrink-0 text-xs"
            >
              <CornerDownRight className="icon-2xs shrink-0" />
              <span className="tabular-nums">{agent.childAgentCount}</span>
            </span>
          )}
          {agent.isBackground && (
            <span
              title="detached — runs past the end of the turn"
              className="text-faint uppercase tracking-wide shrink-0 text-xs"
            >
              bg
            </span>
          )}
          <span className="text-faint tabular-nums shrink-0 text-xs">
            {elapsed}
          </span>
        </div>
        {/* Secondary line. Only for running agents: once one is done its
            last step is trivia, and showing it on every settled row
            doubles the panel's height for no information. A running
            nested agent is listed out of tree order, so it names its
            parent instead — that's the only place the hierarchy shows. */}
        {running &&
          (agent.parentDescription ? (
            <div className="flex min-w-0 pl-4 text-xs text-faint truncate">
              ↳ via {agent.parentDescription}
            </div>
          ) : null)}
        {running && lastStep && (
          <div className="flex min-w-0 pl-4 opacity-80 text-xs">
            <AgentStepLine step={lastStep} dim />
          </div>
        )}
      </button>
    </li>
  )
}

export function JsonClaudeAgentsPanel({
  focusedTabId
}: {
  focusedTabId: string | null
}): JSX.Element | null {
  const session = useJsonClaudeSession(focusedTabId ?? '')
  const pendingApprovals = useJsonClaudePendingApprovals()
  const [peekId, setPeekId] = useState<string | null>(null)
  const [showAllSettled, setShowAllSettled] = useState(false)

  const pendingToolUseIds = useMemo(() => {
    const ids = new Set<string>()
    for (const p of Object.values(pendingApprovals)) {
      if (p.sessionId === session?.sessionId && p.toolUseId) ids.add(p.toolUseId)
    }
    return ids
  }, [pendingApprovals, session?.sessionId])

  // Read through a ref so the derivation isn't keyed on the session's
  // identity (which churns per token). `entries.length` is the cheap
  // structural signal — a launch, a tool call or a result always appends
  // — and `tick` covers in-place mutation of an entry that's streaming.
  //
  // `sessionId` is in the deps because two sessions can have the same
  // entry count — without it, switching between them could keep showing
  // the previous session's agents.
  const sessionRef = useRef(session)
  sessionRef.current = session
  const entryCount = session?.entries.length ?? 0
  const sessionId = session?.sessionId
  const [tick, setTick] = useState(0)

  // Feeding the last result back lets settled agents be handed through
  // by reference — see collectAgents. Without it, every tick rebuilds
  // the step feed of every agent the session ever launched, and that
  // list only grows.
  const prevAgentsRef = useRef<readonly AgentSummary[]>([])
  const agents = useMemo(() => {
    const next = collectAgents(
      sessionRef.current,
      pendingToolUseIds,
      prevAgentsRef.current
    )
    prevAgentsRef.current = next
    return next
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, tick, entryCount, pendingToolUseIds])
  const running = countRunningAgents(agents)
  // A background agent outlives its parent's turn, so `busy` alone would
  // stop ticking while one is still working.
  const live = running > 0 || !!session?.busy
  useEffect(() => {
    if (!live) return
    const id = setInterval(() => setTick((t) => t + 1), LIVE_REFRESH_MS)
    return () => clearInterval(id)
  }, [live])
  const now = useLiveClock(running > 0)

  // A peek whose agent vanished (session cleared, history truncated)
  // would render nothing and trap the overlay — drop it.
  const peeked = peekId ? agents.find((a) => a.toolUseId === peekId) : undefined
  useEffect(() => {
    if (peekId && !peeked) setPeekId(null)
  }, [peekId, peeked])

  if (agents.length === 0) return null

  // Nested agents are not listed alongside their parents. Sorting is by
  // status then recency, so a child routinely sorted *above* its parent
  // — an indented row pointing at nothing, implying a tree the order
  // doesn't deliver. Nesting is legible in the peek, which links through
  // parent → child, so the list stays flat: top-level agents, plus
  // anything still running at any depth (nothing live is ever hidden).
  const listed = agents.filter((a) => a.depth === 0 || a.status === 'running')

  // `listed` is sorted running-first, so this is a split, not a filter
  // pass. Finished agents are history — the transcript keeps their Task
  // cards — and a long session accumulates dozens, so only the most
  // recent few are shown by default. Without this the live agents the
  // panel exists to surface get pushed off the top.
  const settledCount = listed.length - running
  const hiddenCount = showAllSettled
    ? 0
    : Math.max(0, settledCount - SETTLED_PREVIEW)
  const shown = hiddenCount > 0 ? listed.slice(0, running + SETTLED_PREVIEW) : listed

  return (
    <>
      <RightPanel
        id="agents"
        title="Agents"
        maxHeight="max-h-64"
        actions={
          // A bare count reads as nothing in particular. The panel is
          // about what's live, so say so — and when nothing is, say that
          // instead of leaving a number to be guessed at.
          <span className="text-xs text-faint tabular-nums">
            {running > 0 ? `${running} running` : `${agents.length} done`}
          </span>
        }
      >
        <ul className="py-1 text-xs overflow-y-auto">
          {shown.map((a) => (
            <AgentRow
              key={a.toolUseId}
              agent={a}
              now={now}
              onPeek={() => setPeekId(a.toolUseId)}
            />
          ))}
          {(hiddenCount > 0 || showAllSettled) && settledCount > SETTLED_PREVIEW && (
            <li>
              <button
                type="button"
                onClick={() => setShowAllSettled((v) => !v)}
                className="w-full text-left px-3 py-1 text-faint hover:text-fg hover:bg-app/60 cursor-pointer"
              >
                {hiddenCount > 0
                  ? `show ${hiddenCount} more finished`
                  : 'show fewer'}
              </button>
            </li>
          )}
        </ul>
      </RightPanel>
      {peeked && (
        <AgentPeek
          agent={peeked}
          now={now}
          onClose={() => setPeekId(null)}
          onPeekAgent={setPeekId}
        />
      )}
    </>
  )
}
