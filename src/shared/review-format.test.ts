import { describe, it, expect } from 'vitest'
import {
  formatReviewComments,
  formatReviewSubmission,
  reviewAuthorLabel
} from './review-format'
import type { ReviewComment, ReviewSubmission } from './state/reviews'

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
        'src/a.ts:5 (removed line, @abcdef1) [c] — why remove',
        'src/a.ts:12 @abcdef1 [d] — fix this',
        '  ↳ Reviewer: agreed',
        'src/b.ts:3 @abcdef1 [a] — fix this'
      ].join('\n')
    )
  })

  it('labels authors', () => {
    expect(reviewAuthorLabel({ kind: 'human' })).toBe('You')
    expect(reviewAuthorLabel({ kind: 'agent', tabId: 't' })).toBe('Agent')
  })

  it('prints a short id and calls the human "User" in replies', () => {
    const text = formatReviewComments([
      comment('0123456789abcdef', {
        replies: [{ id: 'r', author: { kind: 'human' }, body: 'yes', createdAt: 1 }]
      })
    ])
    expect(text).toContain('[01234567] — fix this')
    expect(text).toContain('  ↳ User: yes')
  })
})

describe('formatReviewSubmission', () => {
  const sub: ReviewSubmission = {
    id: 's',
    author: { kind: 'agent', tabId: 'rev', label: 'Reviewer' },
    verdict: 'changes-requested',
    summary: '  Two problems.  ',
    commentIds: ['a', 'b', 'gone'],
    createdAt: 0,
    state: 'draft'
  }

  it('includes the verdict, summary and only the still-open comments it covers', () => {
    const text = formatReviewSubmission(sub, [
      comment('a', { line: 1 }),
      comment('b', { line: 2, status: 'resolved' }),
      comment('other', { line: 3 })
    ])
    expect(text).toBe(
      [
        'Verdict: Changes requested',
        '',
        'Two problems.',
        '',
        '1 open comment:',
        'src/a.ts:1 @abcdef1 [a] — fix this'
      ].join('\n')
    )
  })

  it('omits the comment section when none are left', () => {
    expect(formatReviewSubmission({ ...sub, verdict: 'approve', summary: '' }, [])).toBe(
      'Verdict: Approved'
    )
  })
})
