// The phone's unified diff, built from the same before/after sides the
// desktop's diff tab hands Monaco (getFileDiffSides /
// getCommitFileDiffSides). Monaco diffs them itself; here jsdiff does, so
// the server needs no new endpoint and both clients diff the same text.
import { structuredPatch } from 'diff'

export type DiffRow =
  | { kind: 'file'; path: string }
  | { kind: 'hunk'; header: string }
  | { kind: 'line'; type: 'add' | 'del' | 'ctx'; oldNo: number | null; newNo: number | null; text: string }

export interface UnifiedDiff {
  rows: DiffRow[]
  additions: number
  deletions: number
}

/** Hunks with `context` unchanged lines around each change. jsdiff's
 *  "\ No newline at end of file" markers are dropped: the phone has no room
 *  for a row that isn't a line of either side. */
export function unifiedDiff(original: string, modified: string, context = 3): UnifiedDiff {
  const patch = structuredPatch('a', 'b', original, modified, undefined, undefined, { context })
  const rows: DiffRow[] = []
  let additions = 0
  let deletions = 0
  for (const h of patch.hunks) {
    rows.push({ kind: 'hunk', header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@` })
    let oldNo = h.oldStart
    let newNo = h.newStart
    for (const raw of h.lines) {
      const mark = raw[0]
      const text = raw.slice(1)
      if (mark === '+') {
        rows.push({ kind: 'line', type: 'add', oldNo: null, newNo: newNo++, text })
        additions++
      } else if (mark === '-') {
        rows.push({ kind: 'line', type: 'del', oldNo: oldNo++, newNo: null, text })
        deletions++
      } else if (mark === ' ') {
        rows.push({ kind: 'line', type: 'ctx', oldNo: oldNo++, newNo: newNo++, text })
      }
    }
  }
  return { rows, additions, deletions }
}

/** A whole commit's `git show` patch (getCommitDiff, the desktop's commit
 *  tab) as the same rows: a file row per `diff --git`, git's own hunks.
 *  The index/mode/---/+++ preamble is dropped, as the desktop's parseDiff
 *  does. */
export function parseGitDiff(raw: string): UnifiedDiff {
  const rows: DiffRow[] = []
  let additions = 0
  let deletions = 0
  let oldNo = 0
  let newNo = 0
  let inHunk = false
  for (const line of raw.split('\n')) {
    const file = /^diff --git a\/(.*) b\/(.*)$/.exec(line)
    if (file) {
      rows.push({ kind: 'file', path: file[1] === file[2] ? file[2] : `${file[1]} → ${file[2]}` })
      inHunk = false
      continue
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      rows.push({ kind: 'hunk', header: line })
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      inHunk = true
      continue
    }
    if (!inHunk) continue
    const mark = line[0]
    if (mark === '+') {
      rows.push({ kind: 'line', type: 'add', oldNo: null, newNo: newNo++, text: line.slice(1) })
      additions++
    } else if (mark === '-') {
      rows.push({ kind: 'line', type: 'del', oldNo: oldNo++, newNo: null, text: line.slice(1) })
      deletions++
    } else if (mark === ' ') {
      rows.push({ kind: 'line', type: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) })
    }
  }
  return { rows, additions, deletions }
}
