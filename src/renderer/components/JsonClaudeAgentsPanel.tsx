import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CornerDownRight } from 'lucide-react'
import {
  useJsonClaudePendingApprovals,
  useJsonClaudeSession
} from '../store'
import {
  agentElapsedMs,
  buildAgentTree,
  collectAgents,
  countRunningAgents,
  formatElapsed,
  type AgentSummary,
  type AgentTree
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

/** Top-level agents shown before collapsing the rest behind a toggle. */
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

/** One agent, with its nested agents beneath it when expanded.
 *
 *  Two targets on the row: the ▸/▾ chevron reveals the children, the
 *  rest of the row opens that agent's history in the peek. The standard
 *  file-tree split — disclosure is structure, the label is the thing. */
function AgentRow({
  agent,
  tree,
  now,
  depth,
  isExpanded,
  onToggle,
  onPeek
}: {
  agent: AgentSummary
  tree: AgentTree
  now: number
  depth: number
  isExpanded: (id: string) => boolean
  onToggle: (id: string) => void
  onPeek: (id: string) => void
}): JSX.Element {
  const children = tree.childrenByParent.get(agent.toolUseId) ?? []
  const expanded = children.length > 0 && isExpanded(agent.toolUseId)
  const lastStep = agent.steps.length
    ? agent.steps[agent.steps.length - 1]
    : null
  const running = agent.status === 'running'
  const elapsed = formatElapsed(agentElapsedMs(agent, now))
  const kind = agent.subagentType ? `${agent.subagentType} agent` : 'agent'
  return (
    <li>
      <div
        className="flex items-start gap-1.5 min-w-0 pr-3 hover:bg-app/60"
        style={{ paddingLeft: `${0.75 + Math.min(depth, 4) * 0.75}rem` }}
      >
        {children.length > 0 ? (
          <button
            type="button"
            onClick={() => onToggle(agent.toolUseId)}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Hide' : 'Show'} ${children.length} nested`}
            title={`${children.length} nested ${
              children.length === 1 ? 'agent' : 'agents'
            }`}
            className="text-muted hover:text-fg-bright w-3 shrink-0 select-none cursor-pointer py-1"
          >
            {expanded ? '▾' : '▸'}
          </button>
        ) : (
          // Spacer, so labels line up with siblings that do have one.
          <span className="w-3 shrink-0" aria-hidden="true" />
        )}
        <button
          type="button"
          onClick={() => onPeek(agent.toolUseId)}
          title={
            `${agent.description}\n${kind} · ` +
            `${running ? `running for ${elapsed}` : `${agentStatusLabel(agent)} after ${elapsed}`}` +
            `\n${agent.toolCount} tool ${agent.toolCount === 1 ? 'call' : 'calls'}` +
            (children.length ? ` · ${children.length} nested` : '') +
            '\n\nClick to open its history'
          }
          className="flex-1 min-w-0 text-left py-1 cursor-pointer"
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
            {/* Only while collapsed — once open the children are right
                there and the badge is just restating them. */}
            {children.length > 0 && !expanded && (
              <span className="flex items-center gap-0.5 text-faint shrink-0 text-xs">
                <CornerDownRight className="icon-2xs shrink-0" />
                <span className="tabular-nums">{children.length}</span>
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
          {/* The one-line "currently", so the panel reads at a glance
              without opening anything. Running agents only: once one is
              done its last step is trivia, and showing it on every
              settled row doubles the panel's height for no information. */}
          {running && lastStep && (
            <div className="flex min-w-0 opacity-80 text-xs">
              <AgentStepLine step={lastStep} dim />
            </div>
          )}
        </button>
      </div>
      {expanded && (
        <ul>
          {children.map((child) => (
            <AgentRow
              key={child.toolUseId}
              agent={child}
              tree={tree}
              now={now}
              depth={depth + 1}
              isExpanded={isExpanded}
              onToggle={onToggle}
              onPeek={onPeek}
            />
          ))}
        </ul>
      )}
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
  // Explicit user choices only. Rows with a running descendant default to
  // open (see `expandedFor`), so this records the overrides rather than
  // the state — otherwise auto-expanding would fight anyone who closed a
  // row while its child was still going.
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(
    () => new Map()
  )

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

  const tree = useMemo(() => buildAgentTree(agents), [agents])
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

  // Default open when something below is still running, so a live agent
  // is never buried inside a collapsed parent; the user's own click wins
  // over that for as long as the panel is mounted.
  const expandedFor = useCallback(
    (id: string): boolean =>
      overrides.get(id) ?? tree.hasRunningDescendant.has(id),
    [overrides, tree]
  )
  const toggleExpanded = useCallback(
    (id: string): void =>
      setOverrides((cur) => {
        const next = new Map(cur)
        next.set(id, !(cur.get(id) ?? tree.hasRunningDescendant.has(id)))
        return next
      }),
    [tree]
  )

  // A peek whose agent vanished (session cleared, history truncated)
  // would render nothing and trap the overlay — drop it.
  const peeked = peekId ? agents.find((a) => a.toolUseId === peekId) : undefined
  useEffect(() => {
    if (peekId && !peeked) setPeekId(null)
  }, [peekId, peeked])

  if (agents.length === 0) return null

  // Only top-level agents are capped — a nested one is revealed by its
  // parent's chevron, so hiding it behind a second "show more" would
  // make the tree lie about what it contains. `roots` keeps the
  // running-first ordering, so this is a split, not a filter pass.
  const runningRoots = tree.roots.filter((a) => a.status === 'running').length
  const settledRoots = tree.roots.length - runningRoots
  const hiddenCount = showAllSettled
    ? 0
    : Math.max(0, settledRoots - SETTLED_PREVIEW)
  const shown =
    hiddenCount > 0
      ? tree.roots.slice(0, runningRoots + SETTLED_PREVIEW)
      : tree.roots

  return (
    <>
      <RightPanel
        id="agents"
        title="Agents"
        maxHeight="max-h-72"
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
              tree={tree}
              now={now}
              depth={0}
              isExpanded={expandedFor}
              onToggle={toggleExpanded}
              onPeek={setPeekId}
            />
          ))}
          {settledRoots > SETTLED_PREVIEW && (
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
