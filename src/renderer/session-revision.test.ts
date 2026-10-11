import { describe, it, expect } from 'vitest'
import type {
  JsonClaudeChatEntry,
  JsonClaudeSession
} from '../shared/state/json-claude'
import { sessionSignature } from './session-revision'

function session(
  entries: JsonClaudeChatEntry[],
  sessionId = 's1'
): JsonClaudeSession {
  return {
    sessionId,
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
    backgroundAgents: {}
  } as JsonClaudeSession
}

const assistant = (
  entryId: string,
  blocks: JsonClaudeChatEntry['blocks']
): JsonClaudeChatEntry => ({
  entryId,
  kind: 'assistant',
  timestamp: 1,
  blocks
})

describe('sessionSignature', () => {
  it('is stable for no session and an empty session', () => {
    expect(sessionSignature(null)).toBe(':0')
    expect(sessionSignature(undefined)).toBe(':0')
    expect(sessionSignature(session([]))).toBe('s1:0')
  })

  it('is unchanged when nothing changed', () => {
    const entries = [assistant('e1', [{ type: 'text', text: 'hi' }])]
    expect(sessionSignature(session(entries))).toBe(
      sessionSignature(session(entries))
    )
  })

  // The regression this exists for: a TodoWrite / TaskCreate / Agent
  // tool_use block is appended to the assistant entry already in flight,
  // so entries.length never moves. A panel keyed on length alone sat
  // empty for the whole turn.
  it('changes when a block is appended to the entry already in flight', () => {
    const before = session([assistant('e1', [{ type: 'text', text: 'hi' }])])
    const after = session([
      assistant('e1', [
        { type: 'text', text: 'hi' },
        { type: 'tool_use', id: 't1', name: 'TodoWrite', input: {} }
      ])
    ])
    expect(before.entries.length).toBe(after.entries.length)
    expect(sessionSignature(before)).not.toBe(sessionSignature(after))
  })

  it('changes when an entry is appended', () => {
    const before = session([assistant('e1', [])])
    const after = session([assistant('e1', []), assistant('e2', [])])
    expect(sessionSignature(before)).not.toBe(sessionSignature(after))
  })

  it('changes when two sessions agree on shape but differ in id', () => {
    const entries = [assistant('e1', [{ type: 'text', text: 'hi' }])]
    expect(sessionSignature(session(entries, 'a'))).not.toBe(
      sessionSignature(session(entries, 'b'))
    )
  })

  it('tolerates an entry with no blocks', () => {
    expect(() =>
      sessionSignature(session([{ entryId: 'e1', kind: 'user', timestamp: 1 }]))
    ).not.toThrow()
  })
})
