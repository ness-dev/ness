import type { ReviewComment, ReviewCommentStatus } from './state/reviews'

const SNIPPET_MAX = 500

// Short snippets like `}` or `)` match half the file, so relocating on
// them would jump the comment to an arbitrary brace.
const MIN_SEARCHABLE_SNIPPET = 4

function normalize(line: string): string {
  return line.replace(/\r$/, '').trim().slice(0, SNIPPET_MAX)
}

export function splitLines(content: string): string[] {
  return content.split('\n')
}

/** Normalized text of 1-indexed `line`, or null when out of range. */
export function snippetAt(lines: string[], line: number): string | null {
  if (!Number.isInteger(line) || line < 1 || line > lines.length) return null
  return normalize(lines[line - 1])
}

/** Find where `snippet` lives in `lines`. Tries the given candidate lines
 *  first (in order), then the nearest exact match to the first candidate.
 *  Returns null when the snippet is gone. */
export function locateSnippet(
  lines: string[],
  snippet: string,
  candidates: number[]
): number | null {
  for (const c of candidates) {
    if (snippetAt(lines, c) === snippet) return c
  }
  if (snippet.length < MIN_SEARCHABLE_SNIPPET) return null
  const origin = candidates[0] ?? 1
  let best: number | null = null
  for (let i = 0; i < lines.length; i++) {
    if (normalize(lines[i]) !== snippet) continue
    const ln = i + 1
    if (best === null || Math.abs(ln - origin) < Math.abs(best - origin)) best = ln
  }
  return best
}

/** Where a comment should render in a given revision of its file. */
export function placeComment(lines: string[], comment: ReviewComment): number | null {
  return locateSnippet(lines, comment.anchor.snippet, [comment.line, comment.anchor.line])
}

/** Re-anchor a comment against a newer revision. `lines` null means the
 *  file no longer exists there. Resolved comments keep their status;
 *  outdated comments whose snippet reappears reopen. */
export function reanchor(
  lines: string[] | null,
  comment: ReviewComment
): { line: number; status: ReviewCommentStatus } {
  const found = lines ? placeComment(lines, comment) : null
  if (found === null) {
    return {
      line: comment.line,
      status: comment.status === 'resolved' ? 'resolved' : 'outdated'
    }
  }
  return {
    line: found,
    status: comment.status === 'outdated' ? 'open' : comment.status
  }
}
