import { structuredPatch } from 'diff'

export type DiffLine =
  | { kind: 'add'; text: string; oldLn: null; newLn: number }
  | { kind: 'remove'; text: string; oldLn: number; newLn: null }
  | { kind: 'context'; text: string; oldLn: number; newLn: number }
  | { kind: 'hunk-sep'; text: string; oldLn: null; newLn: null }

export function unifiedDiff(oldStr: string, newStr: string, context = 3): DiffLine[] {
  const patch = structuredPatch('a', 'b', oldStr, newStr, '', '', { context })
  const out: DiffLine[] = []
  patch.hunks.forEach((hunk, hi) => {
    if (hi > 0) out.push({ kind: 'hunk-sep', text: '…', oldLn: null, newLn: null })
    let oldLn = hunk.oldStart
    let newLn = hunk.newStart
    for (const ln of hunk.lines) {
      const marker = ln[0]
      if (marker === '\\') continue
      const text = ln.slice(1)
      if (marker === '-') {
        out.push({ kind: 'remove', text, oldLn, newLn: null })
        oldLn++
      } else if (marker === '+') {
        out.push({ kind: 'add', text, oldLn: null, newLn })
        newLn++
      } else {
        out.push({ kind: 'context', text, oldLn, newLn })
        oldLn++
        newLn++
      }
    }
  })
  return out
}

/** Parse an already-computed patch, as Codex reports per file. An update
 *  carries unified-diff hunks (`@@ -a,b +c,d @@` headers); an add carries
 *  the new file's contents and a delete the old file's, with no markers. */
export function parsePatchLines(diff: string, kind: 'add' | 'delete' | 'update'): DiffLine[] {
  const body = diff.endsWith('\n') ? diff.slice(0, -1) : diff
  if (body.length === 0) return []
  const raw = body.split('\n')
  if (kind === 'add') return raw.map((text, i) => ({ kind: 'add', text, oldLn: null, newLn: i + 1 }))
  if (kind === 'delete') return raw.map((text, i) => ({ kind: 'remove', text, oldLn: i + 1, newLn: null }))
  const out: DiffLine[] = []
  let oldLn = 1
  let newLn = 1
  let hunks = 0
  for (const ln of raw) {
    const header = ln.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (header) {
      if (hunks++ > 0) out.push({ kind: 'hunk-sep', text: '…', oldLn: null, newLn: null })
      oldLn = Number(header[1])
      newLn = Number(header[2])
      continue
    }
    const marker = ln[0]
    if (marker === '\\') continue
    const text = ln.slice(1)
    if (marker === '-') {
      out.push({ kind: 'remove', text, oldLn, newLn: null })
      oldLn++
    } else if (marker === '+') {
      out.push({ kind: 'add', text, oldLn: null, newLn })
      newLn++
    } else {
      out.push({ kind: 'context', text, oldLn, newLn })
      oldLn++
      newLn++
    }
  }
  return out
}

export {
  detectLanguage as langForPath,
  highlightLine,
  highlightToLines
} from '../../syntax'
