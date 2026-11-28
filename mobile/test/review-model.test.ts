// The Review tab's pure logic: comments → diff rows, counters, scope, the
// status icon mapping, and the review page's HTML hooks.
import { describe, expect, it } from 'vitest'
import type { ReviewComment, ReviewSubmission } from '../../src/shared/state/reviews'
import { unifiedDiff } from '../src/viewer/diff-model'
import { diffHtml, markRowJs, revealThreadJs, setThreadsJs } from '../src/viewer/code-html'
import {
  commentCounts,
  commentLocation,
  perFileCounts,
  placeCommentsInDiff,
  reviewIconSpec,
  reviewScope,
  reviewerActivity,
  sortThreads,
  submissionStatus
} from '../src/review/review-model'
import { commentCardHtml, threadBlocks } from '../src/review/review-html'

function comment(p: Partial<ReviewComment> & Pick<ReviewComment, 'id' | 'line'>): ReviewComment {
  return {
    filePath: 'a.ts',
    side: 'new',
    anchoredSha: 'head',
    anchor: { commitSha: 'head', line: p.line, snippet: p.anchor?.snippet ?? '' },
    author: { kind: 'human' },
    status: 'open',
    body: 'body',
    createdAt: 0,
    ...p
  }
}

const ORIGINAL = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
const MODIFIED = ORIGINAL.replace('line 10\n', 'line ten\n')

describe('placeCommentsInDiff', () => {
  const diff = unifiedDiff(ORIGINAL, MODIFIED)
  const rowOf = (newNo: number) => diff.rows.findIndex((r) => r.kind === 'line' && r.newNo === newNo)

  it('draws a comment under the row of its line', () => {
    const c = comment({ id: 'c1', line: 10, anchor: { commitSha: 'head', line: 10, snippet: 'line ten' } })
    const p = placeCommentsInDiff(diff.rows, MODIFIED, [c])
    expect([...p.byRow.entries()]).toEqual([[rowOf(10), [c]]])
    expect(p.unplaced).toEqual([])
  })

  it('follows the snippet when the stored line went stale', () => {
    // Written against line 9, but the code it's about is now on line 10.
    const c = comment({ id: 'c1', line: 9, anchor: { commitSha: 'old', line: 9, snippet: 'line ten' } })
    expect(placeCommentsInDiff(diff.rows, MODIFIED, [c]).byRow.get(rowOf(10))).toEqual([c])
  })

  it('lists a comment whose line is outside the hunks, with that line', () => {
    const c = comment({ id: 'c1', line: 1, anchor: { commitSha: 'head', line: 1, snippet: 'line 1' } })
    const p = placeCommentsInDiff(diff.rows, MODIFIED, [c])
    expect(p.byRow.size).toBe(0)
    expect(p.unplaced).toEqual([{ comment: c, line: 1 }])
  })

  it('lists old-side and vanished comments without a line', () => {
    const old = comment({ id: 'o', line: 10, side: 'old', anchor: { commitSha: 'base', line: 10, snippet: 'line 10' } })
    const gone = comment({ id: 'g', line: 3, anchor: { commitSha: 'head', line: 3, snippet: 'not in the file' } })
    const p = placeCommentsInDiff(diff.rows, MODIFIED, [old, gone])
    expect(p.unplaced).toEqual([
      { comment: old, line: null },
      { comment: gone, line: null }
    ])
  })

  it('stacks several comments on one row oldest first', () => {
    const later = comment({ id: 'b', line: 10, createdAt: 2, anchor: { commitSha: 'h', line: 10, snippet: 'line ten' } })
    const first = comment({ id: 'a', line: 10, createdAt: 1, anchor: { commitSha: 'h', line: 10, snippet: 'line ten' } })
    expect(placeCommentsInDiff(diff.rows, MODIFIED, [later, first]).byRow.get(rowOf(10))?.map((c) => c.id)).toEqual(['a', 'b'])
  })
})

describe('counters and ordering', () => {
  const cs = [
    comment({ id: '1', line: 5, filePath: 'b.ts' }),
    comment({ id: '2', line: 2, filePath: 'a.ts', status: 'resolved' }),
    comment({ id: '3', line: 9, filePath: 'a.ts' }),
    comment({ id: '4', line: 1, filePath: 'gone.ts', status: 'outdated' }),
    comment({ id: '5', line: 1, filePath: 'gone.ts' })
  ]

  it('counts open comments and the ones outside the selection', () => {
    expect(commentCounts(cs, new Set(['a.ts', 'b.ts']))).toEqual({ open: 3, total: 5, openElsewhere: 1 })
    expect(commentCounts([])).toEqual({ open: 0, total: 0, openElsewhere: 0 })
  })

  it('counts per file', () => {
    expect(perFileCounts(cs).get('a.ts')).toEqual({ open: 1, total: 2 })
    expect(perFileCounts(cs).get('gone.ts')).toEqual({ open: 1, total: 2 })
  })

  it('sorts open first, then by file and line', () => {
    expect(sortThreads(cs).map((c) => c.id)).toEqual(['3', '1', '5', '4', '2'])
  })

  it('names a location', () => {
    expect(commentLocation(cs[0])).toBe('b.ts:5')
    expect(commentLocation({ filePath: 'x.ts', line: 3, side: 'old' })).toBe('x.ts:3 (old)')
  })
})

describe('reviewScope', () => {
  it('reads the tab’s selection like ReviewPane', () => {
    expect(reviewScope({})).toEqual({ kind: 'branch' })
    expect(reviewScope({ reviewFromCommit: 'a' })).toEqual({ kind: 'branch' })
    expect(reviewScope({ reviewFromCommit: 'a', reviewToCommit: 'a' })).toEqual({ kind: 'commit', hash: 'a' })
    expect(reviewScope({ reviewFromCommit: 'a', reviewToCommit: 'b' })).toEqual({ kind: 'range', from: 'a', to: 'b' })
  })
})

describe('reviewIconSpec', () => {
  it('maps a verdict like ReviewStatusIcon', () => {
    expect(reviewIconSpec({ kind: 'approve', unsent: false }, undefined)).toMatchObject({ icon: 'CircleCheck', tone: 'success', label: 'Approved' })
    expect(reviewIconSpec({ kind: 'changes-requested', unsent: true }, undefined)).toMatchObject({
      icon: 'CircleAlert',
      tone: 'warning',
      unsent: true,
      label: 'Changes requested · not sent'
    })
    expect(reviewIconSpec({ kind: 'comment', unsent: false }, undefined)).toMatchObject({ icon: 'MessageSquare', tone: 'info' })
  })

  it('follows the reviewer while a review is in progress', () => {
    expect(reviewIconSpec({ kind: 'reviewing', unsent: false }, 'processing')).toMatchObject({ icon: 'Loader2', spin: true })
    expect(reviewIconSpec({ kind: 'reviewing', unsent: false }, 'needs-approval')).toMatchObject({ icon: 'ListChecks', tone: 'danger', pulse: true })
    // An idle reviewer has stalled: no spinner that would never stop.
    expect(reviewIconSpec({ kind: 'reviewing', unsent: false }, 'waiting')).toMatchObject({ icon: 'ListChecks', faded: true })
  })

  it('draws nothing for no review unless asked to', () => {
    expect(reviewIconSpec({ kind: 'none', unsent: false }, undefined)).toBeNull()
    expect(reviewIconSpec({ kind: 'none', unsent: false }, undefined, true)).toMatchObject({ icon: 'ListChecks', tone: 'dim' })
  })

  it('describes the reviewer', () => {
    expect(reviewerActivity('processing')).toMatchObject({ busy: true, text: 'Reviewer is working' })
    expect(reviewerActivity('needs-approval').text).toBe('Reviewer needs your approval')
    expect(reviewerActivity(undefined).text).toBe('Reviewer is idle')
  })
})

describe('submissionStatus', () => {
  const base: ReviewSubmission = {
    id: 's',
    author: { kind: 'agent', tabId: 'r' },
    verdict: 'comment',
    summary: '',
    commentIds: [],
    createdAt: 0,
    state: 'draft',
    targetTabId: 't'
  }
  const labelOf = (id: string) => (id === 't' ? 'Chat' : null)
  it('says where a review goes or went, like SubmissionCard', () => {
    expect(submissionStatus(base, labelOf)).toEqual({ text: 'Draft · will go to Chat', tone: 'dim' })
    expect(submissionStatus({ ...base, targetTabId: undefined }, labelOf).text).toBe('Draft · no Chat tab to send to')
    expect(submissionStatus({ ...base, state: 'sent' }, labelOf)).toEqual({ text: 'Sent to Chat', tone: 'success' })
    expect(submissionStatus({ ...base, state: 'failed', targetTabId: 'gone' }, labelOf)).toEqual({ text: 'Not sent to a closed tab', tone: 'danger' })
  })
})

describe('review page', () => {
  const diff = unifiedDiff(ORIGINAL, MODIFIED)
  const name = () => 'Reviewer'

  it('makes new-side rows tappable and every row addressable', () => {
    const html = diffHtml(diff, { original: ORIGINAL, modified: MODIFIED, filePath: 'a.ts' }, { review: { threads: [] } })
    const added = diff.rows.findIndex((r) => r.kind === 'line' && r.type === 'add')
    const removed = diff.rows.findIndex((r) => r.kind === 'line' && r.type === 'del')
    expect(html).toContain(`id="r${added}" data-n="10"`)
    expect(html).toContain(`id="r${removed}">`)
    expect(html).toContain('window.__setThreads')
    // The plain viewer is unchanged.
    expect(diffHtml(diff)).not.toContain('data-n=')
  })

  it('escapes comment text and marks the status', () => {
    const c = comment({ id: 'x"y', line: 10, body: '<b>& "hi"</b>', status: 'resolved', replies: [{ id: 'r', author: { kind: 'human' }, body: 'ok', createdAt: 1 }] })
    const card = commentCardHtml(c, name)
    expect(card).toContain('class="cm resolved"')
    expect(card).toContain('data-c="x&quot;y"')
    expect(card).toContain('&lt;b&gt;&amp; "hi"&lt;/b&gt;')
    expect(card).toContain('1 reply')
    expect(card).not.toContain('<b>')
  })

  it('builds one block per commented row, in row order', () => {
    const p = placeCommentsInDiff(diff.rows, MODIFIED, [
      comment({ id: 'b', line: 12, anchor: { commitSha: 'h', line: 12, snippet: 'line 12' } }),
      comment({ id: 'a', line: 10, anchor: { commitSha: 'h', line: 10, snippet: 'line ten' } })
    ])
    expect(threadBlocks(p, name).map((b) => b.row)).toEqual([...p.byRow.keys()].sort((x, y) => x - y))
  })

  it('injects data that can’t break out of the script', () => {
    const js = setThreadsJs([{ row: 1, html: '</script><script>alert(1)</script>' }])
    expect(js).not.toContain('</script>')
    expect(markRowJs(null)).toContain('__mark(null)')
    expect(revealThreadJs('a"b')).toContain('"a\\"b"')
  })
})
