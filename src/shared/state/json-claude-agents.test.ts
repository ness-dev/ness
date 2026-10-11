import { describe, it, expect } from 'vitest'
import type {
  JsonClaudeChatEntry,
  JsonClaudeSession
} from './json-claude'
import {
  agentElapsedMs,
  collectAgents,
  countRunningAgents,
  formatElapsed
} from './json-claude-agents'

function session(
  entries: JsonClaudeChatEntry[],
  over: Partial<JsonClaudeSession> = {}
): JsonClaudeSession {
  return {
    sessionId: 's1',
    worktreePath: '/tmp/wt',
    state: 'running',
    exitCode: null,
    exitReason: null,
    entries,
    entriesHydrated: true,
    busy: true,
    permissionMode: 'default',
    slashCommands: [],
    autoApprovedDecisions: {},
    sessionToolApprovals: [],
    sessionAllowedDecisions: {},
    backgroundAgents: {},
    ...over
  } as JsonClaudeSession
}

/** An assistant entry launching a sub-agent. */
function launch(
  id: string,
  description: string,
  opts: {
    at?: number
    entryId?: string
    parentToolUseId?: string
    background?: boolean
    subagentType?: string
    name?: string
  } = {}
): JsonClaudeChatEntry {
  return {
    entryId: opts.entryId ?? `e-${id}`,
    kind: 'assistant',
    timestamp: opts.at ?? 1000,
    ...(opts.parentToolUseId
      ? { parentToolUseId: opts.parentToolUseId }
      : {}),
    blocks: [
      {
        type: 'tool_use',
        id,
        name: opts.name ?? 'Agent',
        input: {
          description,
          ...(opts.subagentType ? { subagent_type: opts.subagentType } : {}),
          ...(opts.background ? { run_in_background: true } : {})
        }
      }
    ]
  }
}

/** A child entry attributed to an agent, carrying tool calls / text. */
function childWork(
  parentToolUseId: string,
  blocks: JsonClaudeChatEntry['blocks'],
  at = 2000,
  entryId = 'c1'
): JsonClaudeChatEntry {
  return { entryId, kind: 'assistant', timestamp: at, parentToolUseId, blocks }
}

function toolResult(
  toolUseId: string,
  content: string,
  isError = false
): JsonClaudeChatEntry {
  return {
    entryId: `r-${toolUseId}-${content.slice(0, 4)}`,
    kind: 'tool_result',
    timestamp: 3000,
    blocks: [{ type: 'tool_result', toolUseId, content, isError }]
  }
}

describe('collectAgents', () => {
  it('returns nothing for an empty or absent session', () => {
    expect(collectAgents(null)).toEqual([])
    expect(collectAgents(session([]))).toEqual([])
  })

  it('ignores sessions with no sub-agent launches', () => {
    const e: JsonClaudeChatEntry = {
      entryId: 'e1',
      kind: 'assistant',
      timestamp: 1,
      blocks: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]
    }
    expect(collectAgents(session([e]))).toEqual([])
  })

  it('treats a launch with no result as running while the session is busy', () => {
    const agents = collectAgents(session([launch('t1', 'Map the data model')]))
    expect(agents).toHaveLength(1)
    expect(agents[0].status).toBe('running')
    expect(agents[0].description).toBe('Map the data model')
    expect(agents[0].isBackground).toBe(false)
    expect(agents[0].depth).toBe(0)
  })

  it('reports interrupted — not running — when the turn ended with no result', () => {
    const agents = collectAgents(
      session([launch('t1', 'Map the data model')], { busy: false })
    )
    expect(agents[0].status).toBe('interrupted')
  })

  it('matches the legacy Task tool name as well as Agent', () => {
    const agents = collectAgents(
      session([launch('t1', 'Legacy', { name: 'Task' })])
    )
    expect(agents).toHaveLength(1)
  })

  it('falls back to subagent_type when no description was given', () => {
    const e = launch('t1', '', { subagentType: 'Explore' })
    e.blocks![0].input = { subagent_type: 'Explore' }
    const agents = collectAgents(session([e]))
    expect(agents[0].description).toBe('Explore')
    expect(agents[0].subagentType).toBe('Explore')
  })

  it('completes on a result, and marks an error result failed', () => {
    const ok = collectAgents(
      session([launch('t1', 'A'), toolResult('t1', 'all done')])
    )
    expect(ok[0].status).toBe('completed')
    expect(ok[0].result).toBe('all done')

    const bad = collectAgents(
      session([launch('t1', 'A'), toolResult('t1', 'boom', true)])
    )
    expect(bad[0].status).toBe('failed')
    expect(bad[0].resultIsError).toBe(true)
  })

  it('builds a step feed from the agent’s child entries', () => {
    const agents = collectAgents(
      session([
        launch('t1', 'A'),
        childWork('t1', [
          { type: 'thinking', text: 'hmm' },
          { type: 'tool_use', id: 'x1', name: 'Read', input: { file_path: '/a' } },
          { type: 'text', text: 'Found it' }
        ])
      ])
    )
    expect(agents[0].toolCount).toBe(1)
    expect(agents[0].steps.map((s) => s.kind)).toEqual([
      'thinking',
      'tool',
      'text'
    ])
    expect(agents[0].steps[1].input).toEqual({ file_path: '/a' })
  })

  it('skips empty text and thinking blocks', () => {
    const agents = collectAgents(
      session([
        launch('t1', 'A'),
        childWork('t1', [
          { type: 'text', text: '   ' },
          { type: 'thinking', text: '' }
        ])
      ])
    )
    expect(agents[0].steps).toEqual([])
  })

  it('flags a step whose tool result errored', () => {
    const agents = collectAgents(
      session([
        launch('t1', 'A'),
        childWork('t1', [
          { type: 'tool_use', id: 'x1', name: 'Bash', input: { command: 'nope' } }
        ]),
        toolResult('x1', 'command not found', true)
      ])
    )
    expect(agents[0].steps[0].isError).toBe(true)
  })

  it('nests an agent launched by another agent and records depth', () => {
    const agents = collectAgents(
      session([
        launch('t1', 'Parent'),
        launch('t2', 'Child', { parentToolUseId: 't1', entryId: 'e2', at: 1100 })
      ])
    )
    const child = agents.find((a) => a.toolUseId === 't2')!
    const parent = agents.find((a) => a.toolUseId === 't1')!
    expect(child.depth).toBe(1)
    expect(child.parentToolUseId).toBe('t1')
    expect(child.parentDescription).toBe('Parent')
    expect(parent.childAgentCount).toBe(1)
    expect(parent.depth).toBe(0)
  })

  it('links a nested launch from the parent’s step feed', () => {
    const agents = collectAgents(
      session([
        launch('t1', 'Parent'),
        launch('t2', 'Child', { parentToolUseId: 't1', entryId: 'e2' })
      ])
    )
    const parent = agents.find((a) => a.toolUseId === 't1')!
    expect(parent.steps[0].childAgentToolUseId).toBe('t2')
  })

  it('takes a background agent’s status from the lifecycle record, not its result', () => {
    const agents = collectAgents(
      session(
        [
          launch('t1', 'Bg', { background: true }),
          // The launch stub resolves immediately and means nothing.
          toolResult('t1', 'Async agent launched successfully')
        ],
        {
          backgroundAgents: {
            t1: {
              agentId: 'a1',
              toolUseId: 't1',
              description: 'Bg',
              status: 'running',
              startedAt: 1000
            }
          }
        }
      )
    )
    expect(agents[0].isBackground).toBe(true)
    expect(agents[0].status).toBe('running')
  })

  it('carries a settled background agent’s usage totals', () => {
    const agents = collectAgents(
      session([launch('t1', 'Bg', { background: true })], {
        busy: false,
        backgroundAgents: {
          t1: {
            agentId: 'a1',
            toolUseId: 't1',
            description: 'Bg',
            status: 'completed',
            startedAt: 1000,
            completedAt: 9000,
            usage: { totalTokens: 12345, toolUses: 7, durationMs: 8000 }
          }
        }
      })
    )
    expect(agents[0].status).toBe('completed')
    expect(agents[0].completedAt).toBe(9000)
    expect(agents[0].usage?.toolUses).toBe(7)
  })

  it('treats run_in_background as background even before task_started lands', () => {
    const agents = collectAgents(
      session([launch('t1', 'Bg', { background: true })])
    )
    expect(agents[0].isBackground).toBe(true)
    expect(agents[0].status).toBe('running')
  })

  it('lets a later result supersede a background launch stub', () => {
    const agents = collectAgents(
      session([
        launch('t1', 'Bg', { background: true }),
        toolResult('t1', 'launch stub'),
        toolResult('t1', 'the real report')
      ])
    )
    expect(agents[0].result).toBe('the real report')
  })

  it('bubbles a pending approval up the launch chain', () => {
    const agents = collectAgents(
      session([
        launch('t1', 'Parent'),
        launch('t2', 'Child', { parentToolUseId: 't1', entryId: 'e2' }),
        childWork('t2', [
          { type: 'tool_use', id: 'x9', name: 'Bash', input: { command: 'rm' } }
        ])
      ]),
      new Set(['x9'])
    )
    expect(agents.find((a) => a.toolUseId === 't2')!.hasPendingApproval).toBe(
      true
    )
    expect(agents.find((a) => a.toolUseId === 't1')!.hasPendingApproval).toBe(
      true
    )
  })

  it('sorts running agents first (oldest first), then settled newest-first', () => {
    const agents = collectAgents(
      session([
        launch('t1', 'old running', { at: 100 }),
        launch('t2', 'new running', { at: 300, entryId: 'e2' }),
        launch('t3', 'old done', { at: 50, entryId: 'e3' }),
        launch('t4', 'new done', { at: 200, entryId: 'e4' }),
        toolResult('t3', 'x'),
        toolResult('t4', 'y')
      ])
    )
    expect(agents.map((a) => a.description)).toEqual([
      'old running',
      'new running',
      'new done',
      'old done'
    ])
  })

  it('counts only running agents', () => {
    const agents = collectAgents(
      session([
        launch('t1', 'a'),
        launch('t2', 'b', { entryId: 'e2' }),
        toolResult('t2', 'done')
      ])
    )
    expect(countRunningAgents(agents)).toBe(1)
  })
})

describe('agentElapsedMs', () => {
  it('measures to now while running', () => {
    const [a] = collectAgents(session([launch('t1', 'A', { at: 1000 })]))
    expect(agentElapsedMs(a, 6000)).toBe(5000)
  })

  it('prefers the usage-reported duration when Claude gave us one', () => {
    const [a] = collectAgents(
      session([launch('t1', 'A', { at: 1000, background: true })], {
        busy: false,
        backgroundAgents: {
          t1: {
            agentId: 'a1',
            toolUseId: 't1',
            description: 'A',
            status: 'completed',
            startedAt: 1000,
            completedAt: 99_000,
            usage: { durationMs: 4200 }
          }
        }
      })
    )
    expect(agentElapsedMs(a, 500_000)).toBe(4200)
  })

  it('never goes negative on a clock that lags the start timestamp', () => {
    const [a] = collectAgents(session([launch('t1', 'A', { at: 5000 })]))
    expect(agentElapsedMs(a, 1000)).toBe(0)
  })
})

describe('formatElapsed', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(45_000)).toBe('45s')
    expect(formatElapsed(65_000)).toBe('1m 5s')
    expect(formatElapsed(3_600_000 + 120_000)).toBe('1h 2m')
  })
})
