import type { ReviewAuthor, ReviewComment } from '../shared/state/reviews'

export function reviewAuthorLabel(author: ReviewAuthor): string {
  return author.kind === 'human' ? 'You' : author.label || 'Agent'
}

function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

/** Text for "Send to Agent" / "Copy". Open comments only — resolved ones
 *  are done and outdated ones point at code that no longer exists, so
 *  sending either would just make the agent chase ghosts. Line numbers
 *  are given against the commit named after `@` so the agent can
 *  `git show <sha>:<path>` if HEAD has moved since. */
export function formatReviewComments(comments: ReviewComment[]): string {
  const open = comments
    .filter((c) => c.status === 'open')
    .sort((a, b) =>
      a.filePath === b.filePath ? a.line - b.line : a.filePath.localeCompare(b.filePath)
    )
  if (open.length === 0) return ''
  const lines = ['Review feedback on your changes:', '']
  for (const c of open) {
    const where =
      c.side === 'old'
        ? `${c.filePath}:${c.line} (removed line, @${shortSha(c.anchoredSha)})`
        : `${c.filePath}:${c.line} @${shortSha(c.anchoredSha)}`
    lines.push(`${where} — ${c.body}`)
    for (const r of c.replies ?? []) {
      lines.push(`  ↳ ${reviewAuthorLabel(r.author)}: ${r.body}`)
    }
  }
  return lines.join('\n')
}
