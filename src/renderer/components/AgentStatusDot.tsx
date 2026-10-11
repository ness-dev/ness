import type { AgentSummary } from '../../shared/state/json-claude-agents'

export function agentStatusLabel(agent: AgentSummary): string {
  if (agent.hasPendingApproval) return 'needs approval'
  switch (agent.status) {
    case 'running':
      return 'running'
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
    case 'interrupted':
      return 'interrupted'
  }
}

/** Status glyph for an agent. A spinner while running so a fleet of them
 *  reads as alive at a glance; a static mark once settled. */
export function AgentStatusDot({
  agent
}: {
  agent: AgentSummary
}): JSX.Element {
  if (agent.hasPendingApproval) {
    return (
      <span
        className="text-warning shrink-0"
        title="needs approval"
        aria-label="needs approval"
      >
        ⚠
      </span>
    )
  }
  if (agent.status === 'running') {
    return (
      <span
        className="json-claude-spinner shrink-0"
        title="running"
        aria-label="running"
      />
    )
  }
  const cls =
    agent.status === 'completed'
      ? 'text-success'
      : agent.status === 'failed'
        ? 'text-danger'
        : 'text-faint'
  const glyph =
    agent.status === 'completed' ? '✓' : agent.status === 'failed' ? '✕' : '⊘'
  return (
    <span
      className={`${cls} shrink-0`}
      title={agentStatusLabel(agent)}
      aria-label={agentStatusLabel(agent)}
    >
      {glyph}
    </span>
  )
}
