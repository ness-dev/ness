import { describe, it, expect } from 'vitest'
import {
  collectParkedForks,
  formatForkResult,
  isForkChatTool,
  parseForkChatInput,
  parseForkSessionId
} from './fork-chat'
import type { JsonClaudeChatEntry } from './state/json-claude'

const UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
const UUID2 = '9c1e77aa-1111-4222-8333-444455556666'

function forkCall(toolUseId: string, topic: string): JsonClaudeChatEntry {
  return {
    entryId: `a-${toolUseId}`,
    kind: 'assistant',
    timestamp: 0,
    blocks: [
      {
        type: 'tool_use',
        id: toolUseId,
        name: 'mcp__ness-control__fork_chat',
        input: { topic, prompt: `look into ${topic}` }
      }
    ]
  }
}

function forkResult(
  toolUseId: string,
  forkSessionId: string,
  opts?: { isError?: boolean }
): JsonClaudeChatEntry {
  return {
    entryId: `r-${toolUseId}`,
    kind: 'tool_result',
    timestamp: 0,
    blocks: [
      {
        type: 'tool_result',
        toolUseId,
        content: formatForkResult({ forkSessionId, topic: 't', remaining: 1 }),
        isError: opts?.isError
      }
    ]
  }
}

describe('isForkChatTool', () => {
  it('matches the ness-control tool', () => {
    expect(isForkChatTool('mcp__ness-control__fork_chat')).toBe(true)
  })

  it('matches transcripts written before the Ness rename', () => {
    expect(isForkChatTool('mcp__harness-control__fork_chat')).toBe(true)
  })

  it('rejects other tools and missing names', () => {
    expect(isForkChatTool('mcp__ness-control__create_worktree')).toBe(false)
    expect(isForkChatTool('fork_chat')).toBe(false)
    expect(isForkChatTool(undefined)).toBe(false)
  })
})

describe('fork id round trip', () => {
  it('recovers the session id the result was formatted with', () => {
    const text = formatForkResult({
      forkSessionId: UUID,
      topic: 'drop the cron',
      remaining: 2
    })
    expect(parseForkSessionId(text)).toBe(UUID)
  })

  it('names the topic and the remaining budget for the model', () => {
    const text = formatForkResult({
      forkSessionId: UUID,
      topic: 'drop the cron',
      remaining: 2
    })
    expect(text).toContain('"drop the cron"')
    expect(text).toContain('2 more')
  })

  it('says so when the budget is spent', () => {
    const text = formatForkResult({
      forkSessionId: UUID,
      topic: 'x',
      remaining: 0
    })
    expect(text).toContain('last one')
  })

  it('returns null for results with no marker', () => {
    expect(parseForkSessionId('forking is disabled')).toBeNull()
    expect(parseForkSessionId(undefined)).toBeNull()
    expect(parseForkSessionId('(fork id: not-a-uuid)')).toBeNull()
  })
})

describe('collectParkedForks', () => {
  it('pairs each fork call with the session id from its result', () => {
    const forks = collectParkedForks([
      forkCall('t1', 'cron'),
      forkResult('t1', UUID),
      forkCall('t2', 'flaky test'),
      forkResult('t2', UUID2)
    ])
    expect(forks.map((f) => f.forkSessionId)).toEqual([UUID, UUID2])
    expect(forks.map((f) => f.topic)).toEqual(['cron', 'flaky test'])
    expect(forks[0].prompt).toBe('look into cron')
  })

  it('skips a call whose result has not landed yet', () => {
    expect(collectParkedForks([forkCall('t1', 'cron')])).toEqual([])
  })

  it('skips a call whose result errored', () => {
    const forks = collectParkedForks([
      forkCall('t1', 'cron'),
      forkResult('t1', UUID, { isError: true })
    ])
    expect(forks).toEqual([])
  })

  it('ignores other ness-control tool calls', () => {
    const other: JsonClaudeChatEntry = {
      entryId: 'x',
      kind: 'assistant',
      timestamp: 0,
      blocks: [
        {
          type: 'tool_use',
          id: 't9',
          name: 'mcp__ness-control__create_worktree',
          input: {}
        }
      ]
    }
    expect(collectParkedForks([other])).toEqual([])
  })
})

describe('parseForkChatInput', () => {
  it('trims both fields', () => {
    expect(parseForkChatInput({ topic: '  cron  ', prompt: '  look  ' })).toEqual({
      topic: 'cron',
      prompt: 'look'
    })
  })

  it('falls back to a placeholder topic rather than rendering blank', () => {
    expect(parseForkChatInput({ prompt: 'look' }).topic).toBe('Untitled fork')
    expect(parseForkChatInput(undefined).topic).toBe('Untitled fork')
  })

  it('drops non-string fields', () => {
    expect(parseForkChatInput({ topic: 12, prompt: null }).prompt).toBe('')
  })
})
