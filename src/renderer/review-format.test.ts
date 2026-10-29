import { describe, it, expect } from 'vitest'
import { formatReviewComments, reviewAuthorLabel } from './review-format'
import type { ReviewComment } from '../shared/state/reviews'

function comment(id: string, over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id,
    filePath: 'src/a.ts',
    side: 'new',
    line: 10,
    anchoredSha: 'abcdef1234567',
    anchor: { commitSha: 'abcdef1234567', line: 10, snippet: 'x' },
    author: { kind: 'human' },
    status: 'open',
    body: 'fix this',
    createdAt: 0,
    ...over
  }
}

describe('formatReviewComments', () => {
  it('returns empty when there are no open comments', () => {
    expect(
      formatReviewComments([comment('a', { status: 'resolved' }), comment('b', { status: 'outdated' })])
    ).toBe('')
  })

  it('sends only open comments, sorted by file and line, with side and sha', () => {
    const text = formatReviewComments([
      comment('a', { filePath: 'src/b.ts', line: 3 }),
      comment('b', { line: 20, status: 'resolved' }),
      comment('c', { line: 5, side: 'old', body: 'why remove' }),
      comment('d', {
        line: 12,
        replies: [
          { id: 'r', author: { kind: 'agent', tabId: 't', label: 'Reviewer' }, body: 'agreed', createdAt: 1 }
        ]
      })
    ])
    expect(text).toBe(
      [
        'Review feedback on your changes:',
        '',
        'src/a.ts:5 (removed line, @abcdef1) — why remove',
        'src/a.ts:12 @abcdef1 — fix this',
        '  ↳ Reviewer: agreed',
        'src/b.ts:3 @abcdef1 — fix this'
      ].join('\n')
    )
  })

  it('labels authors', () => {
    expect(reviewAuthorLabel({ kind: 'human' })).toBe('You')
    expect(reviewAuthorLabel({ kind: 'agent', tabId: 't' })).toBe('Agent')
  })
})
