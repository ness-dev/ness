import type { JsonClaudeChatEntry, JsonClaudeSession } from './json-claude'

/** Tool names that spawn a sub-agent. Claude Code 2.1.126+ renamed the
 *  historical "Task" tool to "Agent" but kept routing both names to the
 *  same subagent runner — match either so this works across versions. */
export const SUBAGENT_TOOL_NAMES = new Set<string>(['Task', 'Agent'])

export function isSubAgentToolName(name: string | undefined): boolean {
  return !!name && SUBAGENT_TOOL_NAMES.has(name)
}

/** `interrupted` is not a state Claude reports — it's what we infer when
 *  an agent has no result and the session is no longer busy. A synchronous
 *  sub-agent cannot outlive its parent's turn, so "no result, turn over"
 *  means the run was cut short (tab closed, process killed, /clear). The
 *  panel has to distinguish it from `running`: leaving a dead agent
 *  spinning forever is the exact thing an at-a-glance fleet view must not
 *  do. */
export type AgentRunStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted'

/** One entry in an agent's activity feed. Deliberately structural — the
 *  tool name and raw input travel as-is so the renderer can summarize
 *  them with the existing `tool-display` helpers (icons, action nouns,
 *  arg extraction) rather than this module duplicating that knowledge. */
export interface AgentStep {
  key: string
  kind: 'tool' | 'text' | 'thinking'
  /** For kind 'tool'. */
  toolName?: string
  /** For kind 'tool'. */
  input?: Record<string, unknown>
  /** For kind 'tool' — set when this call spawned a nested sub-agent, so
   *  the feed can link through instead of rendering it as a leaf. */
  childAgentToolUseId?: string
  /** For kind 'text' | 'thinking'. Markdown body. */
  text?: string
  isError?: boolean
  timestamp: number
}

export interface AgentSummary {
  /** tool_use id of the launching Task/Agent call. Unique per session,
   *  and the key every child entry carries as `parentToolUseId`. */
  toolUseId: string
  description: string
  subagentType?: string
  model?: string
  isBackground: boolean
  status: AgentRunStatus
  startedAt: number
  completedAt?: number
  /** 0 for an agent the main session launched, 1 for one launched by a
   *  depth-0 agent, and so on. */
  depth: number
  /** tool_use id of the agent that launched this one, when nested. */
  parentToolUseId?: string
  /** Description of the launching agent, for the "via …" hint. */
  parentDescription?: string
  /** Tool calls this agent made, including its nested Agent calls. */
  toolCount: number
  /** Nested agents this one launched. */
  childAgentCount: number
  /** Totals from the completion notification's usage block. Background
   *  agents only — a synchronous sub-agent reports none. */
  usage?: { totalTokens?: number; toolUses?: number; durationMs?: number }
  /** True when this agent, or anything below it, is awaiting approval. */
  hasPendingApproval: boolean
  /** Chronological activity feed. The peek view renders this directly;
   *  the panel renders only its last element as the "currently" line. */
  steps: AgentStep[]
  /** The agent's final report, once it landed. For a background agent
   *  this is the real summary — the launch stub has already been
   *  superseded by `toolResultAttached`. */
  result?: string
  resultIsError?: boolean
}

interface LaunchSite {
  toolUseId: string
  description: string
  subagentType?: string
  model?: string
  requestedBackground: boolean
  startedAt: number
  /** The launching entry's own parentToolUseId — i.e. the agent that
   *  made this call, or undefined for the main session. */
  launchedBy?: string
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function describeLaunch(input: Record<string, unknown> | undefined): string {
  return (
    str(input?.description) ?? str(input?.subagent_type) ?? 'Agent'
  )
}

/** Walks a session's entries once and returns every sub-agent it can see,
 *  synchronous or background, at any nesting depth.
 *
 *  This is a derived selector, not slice state: everything here comes out
 *  of `session.entries` + `session.backgroundAgents`, both of which are
 *  already mirrored to every client. Nothing new needs to go over the
 *  wire for a second viewer to render the same fleet.
 *
 *  Ordering is **running first** (oldest first, so the longest-running
 *  sits at the top and doesn't jump as siblings finish), then everything
 *  else newest-first. A nested agent still carries its `depth` and
 *  `parentDescription` so the panel can show the relationship without
 *  needing tree order.
 *
 *  `previous` is the caller's last result, and exists because this runs
 *  on a timer while anything is live. A settled agent's steps are
 *  immutable, so rebuilding them every tick is pure allocation churn
 *  that grows with session length — the list of agents is never purged.
 *  Passing the previous result back lets settled entries be handed
 *  through by reference instead, which also keeps their object identity
 *  stable so React skips re-rendering those rows. Omit it and the
 *  function is exactly as it was: a full, self-contained derivation. */
export function collectAgents(
  session: JsonClaudeSession | null | undefined,
  pendingToolUseIds?: ReadonlySet<string>,
  previous?: readonly AgentSummary[]
): AgentSummary[] {
  if (!session) return []
  const entries = session.entries
  if (!entries || entries.length === 0) return []

  // Only agents that have genuinely finished are reusable. The result
  // check matters for a background agent: `task_notification` dispatches
  // the settled status and the real result as two events, so a snapshot
  // taken between them would otherwise cache a completed agent with the
  // launch stub as its report, forever.
  const reusable = new Map<string, AgentSummary>()
  if (previous) {
    for (const p of previous) {
      if (p.status === 'running') continue
      if (p.result !== undefined || p.status === 'interrupted') {
        reusable.set(p.toolUseId, p)
      }
    }
  }

  const launches: LaunchSite[] = []
  const launchById = new Map<string, LaunchSite>()
  const childEntriesByParent = new Map<string, JsonClaudeChatEntry[]>()
  const resultsByToolUseId = new Map<
    string,
    { content: string; isError: boolean }
  >()

  for (const entry of entries) {
    const pid = entry.parentToolUseId
    if (pid) {
      const list = childEntriesByParent.get(pid)
      if (list) list.push(entry)
      else childEntriesByParent.set(pid, [entry])
    }
    if (!entry.blocks) continue
    for (const b of entry.blocks) {
      if (b.type === 'tool_result' && b.toolUseId) {
        // Last result wins: a background agent's launch stub is
        // superseded by its real summary under the same tool_use id.
        resultsByToolUseId.set(b.toolUseId, {
          content: b.content ?? '',
          isError: !!b.isError
        })
        continue
      }
      if (b.type !== 'tool_use' || !b.id) continue
      if (!isSubAgentToolName(b.name)) continue
      const site: LaunchSite = {
        toolUseId: b.id,
        description: describeLaunch(b.input),
        subagentType: str(b.input?.subagent_type),
        model: str(b.input?.model),
        requestedBackground: b.input?.run_in_background === true,
        startedAt: entry.timestamp,
        ...(pid ? { launchedBy: pid } : {})
      }
      launches.push(site)
      launchById.set(site.toolUseId, site)
    }
  }

  if (launches.length === 0) return []

  // Depth is resolved by walking up `launchedBy`. The chain is bounded by
  // the number of launches, and the `seen` guard keeps a malformed cycle
  // (shouldn't happen, but the ids come off a wire) from spinning.
  const depthCache = new Map<string, number>()
  const depthOf = (id: string): number => {
    const cached = depthCache.get(id)
    if (cached !== undefined) return cached
    let depth = 0
    let cursor = launchById.get(id)?.launchedBy
    const seen = new Set<string>([id])
    while (cursor && launchById.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor)
      depth += 1
      cursor = launchById.get(cursor)?.launchedBy
    }
    depthCache.set(id, depth)
    return depth
  }

  const childAgentCounts = new Map<string, number>()
  for (const site of launches) {
    if (!site.launchedBy) continue
    childAgentCounts.set(
      site.launchedBy,
      (childAgentCounts.get(site.launchedBy) ?? 0) + 1
    )
  }

  const summaries: AgentSummary[] = launches.map((site) => {
    // Settled last time, and still present in entries — nothing about it
    // can have changed, so skip rebuilding its step feed entirely.
    const cached = reusable.get(site.toolUseId)
    if (cached) return cached

    const childEntries = childEntriesByParent.get(site.toolUseId) ?? []
    const steps: AgentStep[] = []
    let toolCount = 0
    let hasPendingApproval = false

    for (const entry of childEntries) {
      if (!entry.blocks) continue
      for (let i = 0; i < entry.blocks.length; i++) {
        const b = entry.blocks[i]
        const key = `${entry.entryId}-${b.id ?? b.toolUseId ?? i}`
        if (b.type === 'tool_use') {
          toolCount += 1
          if (b.id && pendingToolUseIds?.has(b.id)) hasPendingApproval = true
          const nested =
            isSubAgentToolName(b.name) && b.id && launchById.has(b.id)
              ? b.id
              : undefined
          steps.push({
            key,
            kind: 'tool',
            toolName: b.name,
            ...(b.input ? { input: b.input } : {}),
            ...(nested ? { childAgentToolUseId: nested } : {}),
            ...(b.id && resultsByToolUseId.get(b.id)?.isError
              ? { isError: true }
              : {}),
            timestamp: entry.timestamp
          })
          continue
        }
        if (b.type === 'text' || b.type === 'thinking') {
          const text = b.text?.trim()
          if (!text) continue
          steps.push({
            key,
            kind: b.type,
            text,
            timestamp: entry.timestamp
          })
        }
      }
    }

    const result = resultsByToolUseId.get(site.toolUseId)
    const bg = session.backgroundAgents?.[site.toolUseId]
    const isBackground = !!bg || site.requestedBackground

    let status: AgentRunStatus
    let completedAt: number | undefined
    if (isBackground) {
      // The task_started / task_notification pair is the only honest
      // lifecycle for a background agent — its tool_result resolves
      // immediately with a launch stub, so `result` means nothing here.
      if (bg) {
        status = bg.status
        completedAt = bg.completedAt
      } else if (session.busy) {
        status = 'running'
      } else {
        // Seeded from a transcript that predates the notification, or
        // the process died before it arrived.
        status = result ? 'completed' : 'interrupted'
      }
    } else if (result) {
      status = result.isError ? 'failed' : 'completed'
      // A synchronous agent has no completion event of its own; the
      // arrival of its result is the best timestamp available, and the
      // last child entry is the closest proxy for that.
      completedAt = childEntries.length
        ? childEntries[childEntries.length - 1].timestamp
        : undefined
    } else {
      status = session.busy ? 'running' : 'interrupted'
    }

    const parent = site.launchedBy
      ? launchById.get(site.launchedBy)
      : undefined

    return {
      toolUseId: site.toolUseId,
      description: site.description,
      ...(site.subagentType ? { subagentType: site.subagentType } : {}),
      ...(site.model ? { model: site.model } : {}),
      isBackground,
      status,
      startedAt: site.startedAt,
      ...(completedAt !== undefined ? { completedAt } : {}),
      depth: depthOf(site.toolUseId),
      ...(parent
        ? {
            parentToolUseId: parent.toolUseId,
            parentDescription: parent.description
          }
        : {}),
      toolCount,
      childAgentCount: childAgentCounts.get(site.toolUseId) ?? 0,
      ...(bg?.usage ? { usage: bg.usage } : {}),
      hasPendingApproval,
      steps,
      ...(result ? { result: result.content, resultIsError: result.isError } : {})
    }
  })

  // Pending approvals bubble up the launch chain — a parent whose
  // descendant is blocked is itself blocked, and that's what the panel
  // needs to surface. Computed into a set and then applied, rather than
  // assigned onto the summaries in place: a reused entry is the *same
  // object* the caller is still holding, so mutating it would write
  // through to the previous result and defeat the identity check below.
  // (A settled parent can still acquire one this way — a background
  // child outlives its parent's turn.)
  const byId = new Map(summaries.map((s) => [s.toolUseId, s]))
  const blocked = new Set<string>()
  for (const s of summaries) {
    if (!s.hasPendingApproval) continue
    blocked.add(s.toolUseId)
    let cursor = s.parentToolUseId
    const seen = new Set<string>([s.toolUseId])
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor)
      const parent = byId.get(cursor)
      if (!parent) break
      blocked.add(cursor)
      cursor = parent.parentToolUseId
    }
  }

  const resolved = summaries.map((s) => {
    const want = blocked.has(s.toolUseId)
    return s.hasPendingApproval === want ? s : { ...s, hasPendingApproval: want }
  })

  return resolved.sort((a, b) => {
    const aRunning = a.status === 'running'
    const bRunning = b.status === 'running'
    if (aRunning !== bRunning) return aRunning ? -1 : 1
    // Running: oldest first, so the longest-running pins to the top and
    // doesn't reshuffle as siblings settle. Settled: newest first.
    return aRunning ? a.startedAt - b.startedAt : b.startedAt - a.startedAt
  })
}

export function countRunningAgents(agents: AgentSummary[]): number {
  let n = 0
  for (const a of agents) if (a.status === 'running') n += 1
  return n
}

/** Elapsed wall time for an agent, in ms. Uses the usage-reported
 *  duration when Claude gave us one (background agents), since that's
 *  measured inside the agent rather than across our event plumbing. */
export function agentElapsedMs(agent: AgentSummary, now: number): number {
  if (agent.usage?.durationMs !== undefined) return agent.usage.durationMs
  const end = agent.status === 'running' ? now : (agent.completedAt ?? now)
  return Math.max(0, end - agent.startedAt)
}

export function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min < 60) return `${min}m ${sec}s`
  const hr = Math.floor(min / 60)
  return `${hr}h ${min % 60}m`
}
