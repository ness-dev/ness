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
import { AgentStatusDot } from './AgentStatusDot'
import { AgentStepLine } from './AgentStepLine'

/** How often the panel re-derives while anything is live. `collectAgents`
 *  walks the whole entries array, and the focused session's object
 *  identity changes on every streamed token — deriving off that directly
 *  means one full walk per token, which is anti-pattern #4 in CLAUDE.md
 *  with extra allocations. This is a status display; sub-second freshness
 *  buys nothing, and the cap holds regardless of token rate. */
const LIVE_REFRESH_MS = 500

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
  return (
    <li>
      <button
        type="button"
        onClick={onPeek}
        title={`${agent.description} — peek inside`}
        className="w-full text-left px-3 py-1 hover:bg-app/60 cursor-pointer"
        style={{ paddingLeft: `${0.75 + Math.min(agent.depth, 3) * 0.75}rem` }}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          {agent.depth > 0 && (
            <CornerDownRight className="icon-2xs text-faint shrink-0" />
          )}
          <AgentStatusDot agent={agent} />
          <span
            className={`truncate flex-1 min-w-0 ${
              running ? 'text-fg-bright' : 'text-fg'
            } ${agent.status === 'interrupted' ? 'opacity-60' : ''}`}
          >
            {agent.description}
          </span>
          {agent.isBackground && (
            <span
              title="background agent"
              className="text-faint uppercase tracking-wide shrink-0 text-xs"
            >
              bg
            </span>
          )}
          <span className="text-faint tabular-nums shrink-0 text-xs">
            {formatElapsed(agentElapsedMs(agent, now))}
          </span>
        </div>
        {/* The "currently" line. Only for running agents: once an agent is
            done its last step is trivia, and showing it for every settled
            row doubles the panel's height for no information. */}
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

  const agents = useMemo(
    () => collectAgents(sessionRef.current, pendingToolUseIds),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, tick, entryCount, pendingToolUseIds]
  )
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

  return (
    <>
      <RightPanel
        id="agents"
        title="Agents"
        maxHeight="max-h-64"
        actions={
          <span className="text-xs text-faint tabular-nums">
            {running > 0 ? `${running} running` : `${agents.length}`}
          </span>
        }
      >
        <ul className="py-1 text-xs overflow-y-auto">
          {agents.map((a) => (
            <AgentRow
              key={a.toolUseId}
              agent={a}
              now={now}
              onPeek={() => setPeekId(a.toolUseId)}
            />
          ))}
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
