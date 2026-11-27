// The file / diff viewers' pure model: the unified diff the phone builds
// from the desktop's diff sides, and a whole commit's git patch.
import { describe, expect, it } from 'vitest'
import { parseGitDiff, unifiedDiff } from '../src/viewer/diff-model'
import { diffHtml, fileHtml } from '../src/viewer/code-html'

describe('unifiedDiff', () => {
  it('numbers both sides and counts changes', () => {
    const d = unifiedDiff('a\nb\nc\n', 'a\nB\nc\nd\n')
    expect(d.additions).toBe(2)
    expect(d.deletions).toBe(1)
    expect(d.rows[0]).toEqual({ kind: 'hunk', header: '@@ -1,3 +1,4 @@' })
    expect(d.rows.slice(1)).toEqual([
      { kind: 'line', type: 'ctx', oldNo: 1, newNo: 1, text: 'a' },
      { kind: 'line', type: 'del', oldNo: 2, newNo: null, text: 'b' },
      { kind: 'line', type: 'add', oldNo: null, newNo: 2, text: 'B' },
      { kind: 'line', type: 'ctx', oldNo: 3, newNo: 3, text: 'c' },
      { kind: 'line', type: 'add', oldNo: null, newNo: 4, text: 'd' }
    ])
  })

  it('keeps three lines of context, so far-apart changes are separate hunks', () => {
    const before = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n')
    const after = before.replace('l2\n', 'X\n').replace('l25\n', 'Y\n')
    const hunks = unifiedDiff(before, after).rows.filter((r) => r.kind === 'hunk')
    expect(hunks).toHaveLength(2)
  })

  it('is empty for identical sides', () => {
    expect(unifiedDiff('same\n', 'same\n').rows).toEqual([])
  })
})

describe('parseGitDiff', () => {
  it('splits a commit patch into file and hunk rows, dropping the preamble', () => {
    const raw = [
      'diff --git a/x.ts b/x.ts',
      'index 1..2 100644',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -10,2 +10,2 @@ fn()',
      ' keep',
      '-old',
      '+new',
      'diff --git a/old.md b/new.md',
      'similarity index 90%'
    ].join('\n')
    const d = parseGitDiff(raw)
    expect(d.rows).toEqual([
      { kind: 'file', path: 'x.ts' },
      { kind: 'hunk', header: '@@ -10,2 +10,2 @@ fn()' },
      { kind: 'line', type: 'ctx', oldNo: 10, newNo: 10, text: 'keep' },
      { kind: 'line', type: 'del', oldNo: 11, newNo: null, text: 'old' },
      { kind: 'line', type: 'add', oldNo: null, newNo: 11, text: 'new' },
      { kind: 'file', path: 'old.md → new.md' }
    ])
  })
})

describe('viewer pages', () => {
  it('escape file text and number lines without a phantom last line', () => {
    const html = fileHtml('<b>&</b>\nline2\n', 'notes.txt')
    expect(html).toContain('&lt;b&gt;&amp;&lt;/b&gt;')
    expect(html.match(/class="g"/g)).toHaveLength(2)
  })

  it('highlight diff lines from their own side', () => {
    const html = diffHtml(unifiedDiff('const a = 1\n', 'const a = 2\n'), { original: 'const a = 1\n', modified: 'const a = 2\n', filePath: 'a.ts' })
    expect(html).toContain('hljs-keyword')
    expect(html).toContain('class="r del"')
    expect(html).toContain('class="r add"')
  })
})
