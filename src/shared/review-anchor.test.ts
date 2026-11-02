import { describe, it, expect } from 'vitest'
import { locateSnippet, reanchor, snippetAt, splitLines } from './review-anchor'
import type { ReviewComment } from './state/reviews'

function comment(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 'c',
    filePath: 'a.ts',
    side: 'new',
    line: 2,
    anchoredSha: 's1',
    anchor: { commitSha: 's1', line: 2, snippet: 'const answer = 42' },
    author: { kind: 'human' },
    status: 'open',
    body: 'why 42',
    createdAt: 0,
    ...over
  }
}

describe('review-anchor', () => {
  it('snippetAt trims and rejects out-of-range lines', () => {
    const lines = splitLines('a\n  b  \r\nc')
    expect(snippetAt(lines, 2)).toBe('b')
    expect(snippetAt(lines, 0)).toBeNull()
    expect(snippetAt(lines, 4)).toBeNull()
  })

  it('keeps the comment in place when the line is unchanged', () => {
    const lines = splitLines('import x\nconst answer = 42\n')
    expect(reanchor(lines, comment())).toEqual({ line: 2, status: 'open' })
  })

  it('follows the snippet when lines are inserted above it', () => {
    const lines = splitLines('import x\n// new\n// more\nconst answer = 42\n')
    expect(reanchor(lines, comment())).toEqual({ line: 4, status: 'open' })
  })

  it('picks the occurrence nearest the previous line', () => {
    const lines = splitLines(
      ['const answer = 42', 'a', 'b', 'c', 'd', 'e', 'f', 'const answer = 42'].join('\n')
    )
    expect(locateSnippet(lines, 'const answer = 42', [7])).toBe(8)
    expect(locateSnippet(lines, 'const answer = 42', [3])).toBe(1)
  })

  it('does not search for short snippets like a lone brace', () => {
    const lines = splitLines('a\nb\n}\n')
    expect(locateSnippet(lines, '}', [1])).toBeNull()
    expect(locateSnippet(lines, '}', [3])).toBe(3)
  })

  it('marks the comment outdated when the snippet is gone or the file is deleted', () => {
    const lines = splitLines('import x\nconst answer = 43\n')
    expect(reanchor(lines, comment())).toEqual({ line: 2, status: 'outdated' })
    expect(reanchor(null, comment())).toEqual({ line: 2, status: 'outdated' })
  })

  it('leaves resolved comments resolved and reopens outdated ones that match again', () => {
    expect(reanchor(null, comment({ status: 'resolved' })).status).toBe('resolved')
    const lines = splitLines('import x\nconst answer = 42\n')
    expect(reanchor(lines, comment({ status: 'outdated' })).status).toBe('open')
  })
})
