import { describe, expect, it } from 'vitest'
import { parsePatchLines, unifiedDiff } from './diff-util'

describe('unifiedDiff', () => {
  it('returns empty array for identical input', () => {
    expect(unifiedDiff('foo\nbar\n', 'foo\nbar\n')).toEqual([])
  })

  it('marks added lines as +, with newLn line number set', () => {
    const out = unifiedDiff('a\nb\n', 'a\nb\nc\n')
    const adds = out.filter((l) => l.kind === 'add')
    expect(adds.length).toBe(1)
    expect(adds[0]).toMatchObject({ kind: 'add', text: 'c', newLn: 3, oldLn: null })
  })

  it('marks removed lines as -, with oldLn line number set', () => {
    const out = unifiedDiff('a\nb\nc\n', 'a\nc\n')
    const removes = out.filter((l) => l.kind === 'remove')
    expect(removes.length).toBe(1)
    expect(removes[0]).toMatchObject({ kind: 'remove', text: 'b', oldLn: 2, newLn: null })
  })

  it('emits context lines around a single-line change with both line numbers', () => {
    const oldStr = 'a\nb\nc\nd\ne\n'
    const newStr = 'a\nb\nC\nd\ne\n'
    const out = unifiedDiff(oldStr, newStr)
    const ctx = out.filter((l) => l.kind === 'context')
    expect(ctx.length).toBeGreaterThan(0)
    for (const c of ctx) {
      expect(c.oldLn).toBeGreaterThan(0)
      expect(c.newLn).toBeGreaterThan(0)
    }
    const remove = out.find((l) => l.kind === 'remove')
    const add = out.find((l) => l.kind === 'add')
    expect(remove?.text).toBe('c')
    expect(add?.text).toBe('C')
  })

  it('emits a hunk-sep between disjoint hunks', () => {
    const oldStr = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join('\n')
    const newLines = oldStr.split('\n')
    newLines[2] = 'CHANGED-3'
    newLines[27] = 'CHANGED-28'
    const newStr = newLines.join('\n')
    const out = unifiedDiff(oldStr, newStr)
    const seps = out.filter((l) => l.kind === 'hunk-sep')
    expect(seps.length).toBe(1)
  })
})

describe('parsePatchLines', () => {
  it('numbers lines from the hunk header for an update', () => {
    expect(parsePatchLines('@@ -1,3 +1,3 @@\n line one\n-line two\n+line 2\n line three\n', 'update')).toEqual([
      { kind: 'context', text: 'line one', oldLn: 1, newLn: 1 },
      { kind: 'remove', text: 'line two', oldLn: 2, newLn: null },
      { kind: 'add', text: 'line 2', oldLn: null, newLn: 2 },
      { kind: 'context', text: 'line three', oldLn: 3, newLn: 3 }
    ])
  })

  it('separates multiple hunks', () => {
    const lines = parsePatchLines('@@ -1 +1 @@\n-a\n+b\n@@ -10 +10 @@\n-c\n+d\n', 'update')
    expect(lines.map((l) => l.kind)).toEqual(['remove', 'add', 'hunk-sep', 'remove', 'add'])
    expect(lines[3]).toMatchObject({ oldLn: 10 })
  })

  it('treats an add as all-new and a delete as all-removed', () => {
    expect(parsePatchLines('brand new\n', 'add')).toEqual([{ kind: 'add', text: 'brand new', oldLn: null, newLn: 1 }])
    expect(parsePatchLines('x\ny\n', 'delete').map((l) => l.kind)).toEqual(['remove', 'remove'])
  })
})
