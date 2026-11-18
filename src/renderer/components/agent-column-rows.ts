import { buildAgentTree, type AgentSummary } from '../../shared/state/json-claude-agents'

export interface Row {
  agent: AgentSummary
  depth: number
}

/** Tree order, flattened: every agent oldest-first among its siblings,
 *  with its nested agents directly beneath it. Flat so each card is a
 *  sibling that memoizes on its own agent — a recursive card would take
 *  the tree as a prop, and the tree is rebuilt on every poll. */
export function flattenRows(agents: readonly AgentSummary[]): Row[] {
  const tree = buildAgentTree(agents)
  const byStart = (a: AgentSummary, b: AgentSummary): number =>
    a.startedAt - b.startedAt
  const out: Row[] = []
  const seen = new Set<string>()
  const walk = (list: AgentSummary[], depth: number): void => {
    for (const a of [...list].sort(byStart)) {
      if (seen.has(a.toolUseId)) continue
      seen.add(a.toolUseId)
      out.push({ agent: a, depth })
      const kids = tree.childrenByParent.get(a.toolUseId)
      if (kids) walk(kids, depth + 1)
    }
  }
  walk(tree.roots, 0)
  return out
}

/** What a running card visibly depends on. `collectAgents` rebuilds a
 *  running agent on every poll, so its identity changes twice a second
 *  whether or not anything happened; comparing this instead lets an
 *  agent that's waiting on a slow tool skip the re-render. Error count is
 *  in here because a tool_result can flag an earlier step as failed
 *  without the step list growing. */
export function fingerprint(a: AgentSummary): string {
  const last = a.steps.length ? a.steps[a.steps.length - 1] : undefined
  let errors = 0
  for (const s of a.steps) if (s.isError) errors += 1
  return [
    a.status,
    a.hasPendingApproval ? 1 : 0,
    a.steps.length,
    last?.key ?? '',
    last?.text?.length ?? 0,
    errors,
    a.toolCount,
    a.childAgentCount,
    a.result?.length ?? -1,
    a.usage?.totalTokens ?? -1
  ].join('|')
}
