import { describe, it, expect } from 'vitest'
import { getEntrySegments } from './JsonModeChatFind'
import type { JsonClaudeChatEntry } from '../../shared/state/json-claude'

function bashEntry(block: Record<string, unknown>): JsonClaudeChatEntry {
  return {
    entryId: 'e1',
    kind: 'assistant',
    timestamp: 0,
    blocks: [{ type: 'tool_use', id: 't1', name: 'Bash', ...block }]
  }
}

describe('getEntrySegments for Bash', () => {
  it('counts the command once when there is no intent', () => {
    const texts = getEntrySegments(bashEntry({ input: { command: 'ls -la' } })).map((s) => s.text)
    expect(texts).toEqual(['Bash', 'ls -la'])
  })

  it('searches the provider-set intent ahead of the command', () => {
    const texts = getEntrySegments(
      bashEntry({ input: { command: 'cat a.ts' }, intent: 'Read a.ts' })
    ).map((s) => s.text)
    expect(texts).toEqual(['Bash', 'Read a.ts', 'cat a.ts'])
  })
})

describe('getEntrySegments for user text', () => {
  it('searches the rendered text, not the markdown source', () => {
    const entry: JsonClaudeChatEntry = {
      entryId: 'u1',
      kind: 'user',
      timestamp: 0,
      text: '- **bold** and `code`'
    }
    expect(getEntrySegments(entry).map((s) => s.text)).toEqual(['bold and code'])
  })
})
