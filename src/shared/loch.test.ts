import { describe, expect, it } from 'vitest'
import {
  assignTurnColors,
  buildBlameAskBody,
  hunkAtLine,
  isQuietBlameFailure,
  parseBlameDocument,
  type LochConversation,
  type LochHunk
} from './loch'

function conv(session: string, index = 1, extra: Partial<LochConversation> = {}): LochConversation {
  return {
    mark: 'A',
    session,
    agent: 'claude-code',
    index,
    ended: '2026-11-18T15:54:48.364Z',
    available: true,
    turn: `sha256:${session}-${index}`,
    conversation: `sha256:${session}`,
    title: 'loch/rust-rewrite',
    prompt: 'Port all of it',
    backfilled: false,
    ...extra
  }
}

const hunks: LochHunk[] = [
  { start: 1, end: 1, mark: 'A', conversation: conv('s1', 4) },
  { start: 2, end: 114, mark: 'B', conversation: conv('s2', 1) },
  { start: 115, end: 115, mark: '·', conversation: null },
  { start: 116, end: 120, mark: 'C', conversation: conv('s1', 2) }
]

describe('parseBlameDocument', () => {
  it('accepts a schema-2 success document', () => {
    const r = parseBlameDocument({ schema: 2, ok: true, command: 'blame', conversations: [], hunks })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.hunks).toHaveLength(4)
  })

  it('carries loch failure codes through', () => {
    expect(parseBlameDocument({ ok: false, code: 'file-unreadable', error: 'nope' })).toEqual({
      ok: false,
      code: 'file-unreadable',
      error: 'nope'
    })
  })

  it('rejects documents without hunks', () => {
    expect(parseBlameDocument({ ok: true })).toEqual({ ok: false, code: 'bad-output' })
    expect(parseBlameDocument(null)).toEqual({ ok: false, code: 'bad-output' })
  })

  it('treats a malformed conversation as unattributed', () => {
    const r = parseBlameDocument({ ok: true, conversations: [], hunks: [{ start: 1, end: 2, conversation: {} }] })
    expect(r.ok && r.hunks[0].conversation).toBe(null)
  })
})

describe('hunkAtLine', () => {
  it('finds the covering hunk at boundaries', () => {
    expect(hunkAtLine(hunks, 1)?.mark).toBe('A')
    expect(hunkAtLine(hunks, 2)?.mark).toBe('B')
    expect(hunkAtLine(hunks, 114)?.mark).toBe('B')
    expect(hunkAtLine(hunks, 115)?.mark).toBe('·')
    expect(hunkAtLine(hunks, 120)?.mark).toBe('C')
  })

  it('returns null outside every hunk', () => {
    expect(hunkAtLine(hunks, 0)).toBe(null)
    expect(hunkAtLine(hunks, 121)).toBe(null)
    expect(hunkAtLine([], 1)).toBe(null)
  })
})

describe('assignTurnColors', () => {
  it('colours by turn in order of first appearance, skipping unattributed', () => {
    const colors = assignTurnColors([...hunks, { start: 121, end: 121, mark: 'A', conversation: conv('s1', 4) }])
    expect([...colors.entries()]).toEqual([
      ['sha256:s1-4', 0],
      ['sha256:s2-1', 1],
      ['sha256:s1-2', 2]
    ])
  })
})

describe('isQuietBlameFailure', () => {
  it('keeps not-installed and untracked files quiet but not real errors', () => {
    expect(isQuietBlameFailure('not-installed')).toBe(true)
    expect(isQuietBlameFailure('file-unreadable')).toBe(true)
    expect(isQuietBlameFailure('internal')).toBe(false)
  })
})

describe('buildBlameAskBody', () => {
  it('puts the relocation preamble first and quotes the line', () => {
    const body = buildBlameAskBody({
      relPath: 'src/rewrite.rs',
      line: 10,
      lineText: 'fn main() {}',
      conversation: conv('s1', 4),
      relocationPreamble: '[Ness] moved'
    })
    expect(body.startsWith('[Ness] moved')).toBe(true)
    expect(body).toContain('`src/rewrite.rs` line 10')
    expect(body).toContain('turn 4')
    expect(body).toContain('fn main() {}')
  })

  it('flags backfilled attribution as approximate', () => {
    const body = buildBlameAskBody({
      relPath: 'a.ts',
      line: 1,
      lineText: null,
      conversation: conv('s1', 1, { backfilled: true })
    })
    expect(body).toContain('backfilled')
    expect(body).not.toContain('```')
  })
})
