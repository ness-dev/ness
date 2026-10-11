import { describe, it, expect } from 'vitest'
import type {
  JsonClaudeChatEntry,
  JsonClaudeSession
} from './json-claude'
import {
  collectTasks,
  countOpenTasks,
  isTaskBlocked,
  type TaskRecord
} from './json-claude-tasks'

let seq = 0

function session(entries: JsonClaudeChatEntry[]): JsonClaudeSession {
  return {
    sessionId: 's1',
    worktreePath: '/tmp/wt',
    state: 'running',
    exitCode: null,
    exitReason: null,
    entries,
    entriesHydrated: true,
    busy: false,
    permissionMode: 'default',
    slashCommands: [],
    autoApprovedDecisions: {},
    sessionToolApprovals: [],
    sessionAllowedDecisions: {},
    backgroundAgents: {}
  } as JsonClaudeSession
}

function call(
  name: string,
  input: Record<string, unknown>,
  toolUseId?: string
): JsonClaudeChatEntry {
  seq += 1
  return {
    entryId: `e${seq}`,
    kind: 'assistant',
    timestamp: seq,
    blocks: [
      { type: 'tool_use', id: toolUseId ?? `tu${seq}`, name, input }
    ]
  }
}

function created(toolUseId: string, id: string, subject = 'x'): JsonClaudeChatEntry {
  seq += 1
  return {
    entryId: `r${seq}`,
    kind: 'tool_result',
    timestamp: seq,
    blocks: [
      {
        type: 'tool_result',
        toolUseId,
        content: `Task #${id} created successfully: ${subject}`
      }
    ]
  }
}

describe('collectTasks', () => {
  it('returns nothing without a session or without Task tool calls', () => {
    expect(collectTasks(null)).toEqual([])
    expect(collectTasks(session([]))).toEqual([])
    expect(
      collectTasks(session([call('TodoWrite', { todos: [] })]))
    ).toEqual([])
  })

  it('takes the created id from the tool result', () => {
    const tasks = collectTasks(
      session([
        call('TaskCreate', { subject: 'Do a thing', description: 'detail' }, 'tu-a'),
        created('tu-a', '7', 'Do a thing')
      ])
    )
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).toBe('7')
    expect(tasks[0].subject).toBe('Do a thing')
    expect(tasks[0].description).toBe('detail')
    expect(tasks[0].status).toBe('pending')
  })

  it('falls back to create order while the result is still in flight', () => {
    const tasks = collectTasks(
      session([
        call('TaskCreate', { subject: 'First', description: '' }),
        call('TaskCreate', { subject: 'Second', description: '' })
      ])
    )
    expect(tasks.map((t) => [t.id, t.subject])).toEqual([
      ['1', 'First'],
      ['2', 'Second']
    ])
  })

  it('applies a status update', () => {
    const tasks = collectTasks(
      session([
        call('TaskCreate', { subject: 'A', description: '' }, 'tu-a'),
        created('tu-a', '1', 'A'),
        call('TaskUpdate', { taskId: '1', status: 'in_progress' })
      ])
    )
    expect(tasks[0].status).toBe('in_progress')
  })

  it('keeps the latest of several updates to the same task', () => {
    const tasks = collectTasks(
      session([
        call('TaskCreate', { subject: 'A', description: '' }, 'tu-a'),
        created('tu-a', '1', 'A'),
        call('TaskUpdate', { taskId: '1', status: 'in_progress' }),
        call('TaskUpdate', { taskId: '1', status: 'completed' })
      ])
    )
    expect(tasks[0].status).toBe('completed')
  })

  it('applies subject / description / activeForm / owner edits', () => {
    const tasks = collectTasks(
      session([
        call('TaskCreate', { subject: 'A', description: 'old' }, 'tu-a'),
        created('tu-a', '1', 'A'),
        call('TaskUpdate', {
          taskId: '1',
          subject: 'B',
          description: 'new',
          activeForm: 'Bing',
          owner: 'explorer'
        })
      ])
    )
    expect(tasks[0]).toMatchObject({
      subject: 'B',
      description: 'new',
      activeForm: 'Bing',
      owner: 'explorer'
    })
  })

  it('removes a task set to deleted', () => {
    const tasks = collectTasks(
      session([
        call('TaskCreate', { subject: 'A', description: '' }, 'tu-a'),
        created('tu-a', '1', 'A'),
        call('TaskCreate', { subject: 'B', description: '' }, 'tu-b'),
        created('tu-b', '2', 'B'),
        call('TaskUpdate', { taskId: '1', status: 'deleted' })
      ])
    )
    expect(tasks.map((t) => t.id)).toEqual(['2'])
  })

  it('mirrors addBlockedBy onto the blocker’s blocks list', () => {
    const tasks = collectTasks(
      session([
        call('TaskCreate', { subject: 'A', description: '' }, 'tu-a'),
        created('tu-a', '1', 'A'),
        call('TaskCreate', { subject: 'B', description: '' }, 'tu-b'),
        created('tu-b', '2', 'B'),
        call('TaskUpdate', { taskId: '2', addBlockedBy: ['1'] })
      ])
    )
    expect(tasks.find((t) => t.id === '2')!.blockedBy).toEqual(['1'])
    expect(tasks.find((t) => t.id === '1')!.blocks).toEqual(['2'])
  })

  it('mirrors addBlocks onto the blocked task’s blockedBy list', () => {
    const tasks = collectTasks(
      session([
        call('TaskCreate', { subject: 'A', description: '' }, 'tu-a'),
        created('tu-a', '1', 'A'),
        call('TaskCreate', { subject: 'B', description: '' }, 'tu-b'),
        created('tu-b', '2', 'B'),
        call('TaskUpdate', { taskId: '1', addBlocks: ['2'] })
      ])
    )
    expect(tasks.find((t) => t.id === '2')!.blockedBy).toEqual(['1'])
    expect(tasks.find((t) => t.id === '1')!.blocks).toEqual(['2'])
  })

  it('resolves an edge declared before the other task was created', () => {
    const tasks = collectTasks(
      session([
        call('TaskCreate', { subject: 'A', description: '' }, 'tu-a'),
        created('tu-a', '1', 'A'),
        call('TaskUpdate', { taskId: '1', addBlocks: ['2'] }),
        call('TaskCreate', { subject: 'B', description: '' }, 'tu-b'),
        created('tu-b', '2', 'B')
      ])
    )
    expect(tasks.find((t) => t.id === '2')!.blockedBy).toEqual(['1'])
  })

  it('stubs a task whose create was truncated out of the buffer', () => {
    const tasks = collectTasks(
      session([call('TaskUpdate', { taskId: '4', status: 'in_progress' })])
    )
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ id: '4', status: 'in_progress' })
  })

  it('sorts numerically, not lexicographically', () => {
    const entries: JsonClaudeChatEntry[] = []
    for (let i = 1; i <= 11; i++) {
      entries.push(call('TaskCreate', { subject: `T${i}`, description: '' }))
    }
    const tasks = collectTasks(session(entries))
    expect(tasks.map((t) => t.id)).toEqual([
      '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'
    ])
  })
})

describe('isTaskBlocked', () => {
  const make = (over: Partial<TaskRecord>): TaskRecord => ({
    id: '1',
    subject: 's',
    description: '',
    status: 'pending',
    blocks: [],
    blockedBy: [],
    ...over
  })

  it('is false with no dependencies', () => {
    expect(isTaskBlocked(make({}), new Map())).toBe(false)
  })

  it('is true while a blocker is still open', () => {
    const blocker = make({ id: '1', status: 'in_progress' })
    const blocked = make({ id: '2', blockedBy: ['1'] })
    const byId = new Map([
      ['1', blocker],
      ['2', blocked]
    ])
    expect(isTaskBlocked(blocked, byId)).toBe(true)
  })

  it('is false once every blocker completed', () => {
    const blocker = make({ id: '1', status: 'completed' })
    const blocked = make({ id: '2', blockedBy: ['1'] })
    const byId = new Map([
      ['1', blocker],
      ['2', blocked]
    ])
    expect(isTaskBlocked(blocked, byId)).toBe(false)
  })

  it('treats an unknown blocker as still open', () => {
    const blocked = make({ id: '2', blockedBy: ['99'] })
    expect(isTaskBlocked(blocked, new Map([['2', blocked]]))).toBe(true)
  })

  it('never reports a task that already started as blocked', () => {
    const blocker = make({ id: '1', status: 'pending' })
    const started = make({ id: '2', status: 'in_progress', blockedBy: ['1'] })
    const byId = new Map([
      ['1', blocker],
      ['2', started]
    ])
    expect(isTaskBlocked(started, byId)).toBe(false)
  })
})

describe('countOpenTasks', () => {
  it('counts everything that is not completed', () => {
    const tasks = collectTasks(
      session([
        call('TaskCreate', { subject: 'A', description: '' }, 'tu-a'),
        created('tu-a', '1', 'A'),
        call('TaskCreate', { subject: 'B', description: '' }, 'tu-b'),
        created('tu-b', '2', 'B'),
        call('TaskUpdate', { taskId: '1', status: 'completed' })
      ])
    )
    expect(countOpenTasks(tasks)).toBe(1)
  })
})
