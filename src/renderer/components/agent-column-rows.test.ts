import { describe, expect, it } from 'vitest'
import type { AgentSummary } from '../../shared/state/json-claude-agents'
import { fingerprint, flattenRows } from './agent-column-rows'

function agent(
  toolUseId: string,
  startedAt: number,
  extra: Partial<AgentSummary> = {}
): AgentSummary {
  return {
    toolUseId,
    description: toolUseId,
    isBackground: false,
    status: 'completed',
    startedAt,
    depth: 0,
    toolCount: 0,
    childAgentCount: 0,
    hasPendingApproval: false,
    pendingApprovalToolUseIds: [],
    steps: [],
    ...extra
  }
}

describe('flattenRows', () => {
  it('orders siblings oldest first regardless of running state', () => {
    const rows = flattenRows([
      agent('running', 30, { status: 'running' }),
      agent('newer', 20),
      agent('oldest', 10)
    ])
    expect(rows.map((r) => r.agent.toolUseId)).toEqual(['oldest', 'newer', 'running'])
  })

  it('places nested agents directly under their parent, one level deeper', () => {
    const rows = flattenRows([
      agent('b', 20),
      agent('a-child', 15, { parentToolUseId: 'a', depth: 1 }),
      agent('a', 10)
    ])
    expect(rows.map((r) => [r.agent.toolUseId, r.depth])).toEqual([
      ['a', 0],
      ['a-child', 1],
      ['b', 0]
    ])
  })

  it('keeps an orphan whose parent is missing as a root', () => {
    const rows = flattenRows([agent('orphan', 5, { parentToolUseId: 'gone' })])
    expect(rows).toEqual([{ agent: expect.objectContaining({ toolUseId: 'orphan' }), depth: 0 }])
  })
})

describe('fingerprint', () => {
  const step = { key: 'k1', kind: 'tool' as const, toolName: 'Read', timestamp: 1 }

  it('is equal for a rebuilt but unchanged agent', () => {
    const a = agent('x', 1, { status: 'running', steps: [step] })
    const b = agent('x', 1, { status: 'running', steps: [{ ...step }] })
    expect(fingerprint(a)).toBe(fingerprint(b))
  })

  it('changes when an earlier step is flagged as an error', () => {
    const a = agent('x', 1, { status: 'running', steps: [step, { ...step, key: 'k2' }] })
    const b = agent('x', 1, {
      status: 'running',
      steps: [{ ...step, isError: true }, { ...step, key: 'k2' }]
    })
    expect(fingerprint(a)).not.toBe(fingerprint(b))
  })

  it('changes when the streaming text step grows', () => {
    const t = { key: 't', kind: 'text' as const, text: 'hel', timestamp: 1 }
    const a = agent('x', 1, { status: 'running', steps: [t] })
    const b = agent('x', 1, { status: 'running', steps: [{ ...t, text: 'hello' }] })
    expect(fingerprint(a)).not.toBe(fingerprint(b))
  })
})
