import { useMemo, useRef } from 'react'
import { useAppState, useJsonClaudeSession } from '../store'
import {
  collectAgents,
  countRunningAgents,
  type AgentSummary
} from '../../shared/state/json-claude-agents'
import type { JsonClaudePendingApproval } from '../../shared/state/json-claude'
import { useSessionRevision } from '../session-revision'

/** Tool-use ids awaiting approval in one session, as a sorted string.
 *  A string so `useSyncExternalStore` compares by value: an approval in
 *  any other session changes the whole map's identity but not this key,
 *  so it no longer re-runs the derivation below. */
export function pendingToolUseIdsKey(
  approvals: Record<string, JsonClaudePendingApproval>,
  sessionId: string | undefined
): string {
  if (!sessionId) return ''
  const ids: string[] = []
  for (const p of Object.values(approvals)) {
    if (p.sessionId === sessionId && p.toolUseId) ids.push(p.toolUseId)
  }
  return ids.sort().join('\n')
}

/** Every sub-agent the session has launched, re-derived only when it can
 *  have changed. Shared by the Agents panel and the Subagents column so
 *  the contract below lives in one place:
 *
 *  - Keyed on `useSessionRevision`, never the session object, whose
 *    identity churns per streamed token.
 *  - `runningRef` keeps the revision poll alive while a background agent
 *    is still working after `busy` drops. It's a ref because it's derived
 *    from the very memo that consumes it.
 *  - The previous result is fed back so settled agents pass through by
 *    reference — without it every poll rebuilds the step feed of every
 *    agent the session ever launched, and React can't skip their rows. */
export function useSessionAgents(tabSessionId: string): {
  agents: AgentSummary[]
  running: number
} {
  const session = useJsonClaudeSession(tabSessionId)
  const sessionId = session?.sessionId
  const pendingKey = useAppState((s) =>
    pendingToolUseIdsKey(s.jsonClaude.pendingApprovals, sessionId)
  )
  const pendingToolUseIds = useMemo(
    () => new Set(pendingKey ? pendingKey.split('\n') : []),
    [pendingKey]
  )

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

  const running = countRunningAgents(agents)
  runningRef.current = running
  return { agents, running }
}
