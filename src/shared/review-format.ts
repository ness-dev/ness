import type {
  ReviewAuthor,
  ReviewComment,
  ReviewSubmission,
  ReviewVerdict
} from './state/reviews'

export function reviewAuthorLabel(author: ReviewAuthor): string {
  return author.kind === 'human' ? 'You' : author.label || 'Agent'
}

/** Same as reviewAuthorLabel, for text an agent reads: "You" there would
 *  mean the agent itself. */
function agentFacingAuthorLabel(author: ReviewAuthor): string {
  return author.kind === 'human' ? 'User' : author.label || 'Agent'
}

export const REVIEW_VERDICT_LABELS: Record<ReviewVerdict, string> = {
  approve: 'Approved',
  'changes-requested': 'Changes requested',
  comment: 'Comment'
}

/** Short handle printed next to each comment. The review MCP tools accept
 *  it in place of the full id. */
export function shortCommentId(id: string): string {
  return id.slice(0, 8)
}

function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

function formatCommentLines(comments: ReviewComment[]): string[] {
  const open = comments
    .filter((c) => c.status === 'open')
    .sort((a, b) =>
      a.filePath === b.filePath ? a.line - b.line : a.filePath.localeCompare(b.filePath)
    )
  const lines: string[] = []
  for (const c of open) {
    const where =
      c.side === 'old'
        ? `${c.filePath}:${c.line} (removed line, @${shortSha(c.anchoredSha)})`
        : `${c.filePath}:${c.line} @${shortSha(c.anchoredSha)}`
    lines.push(`${where} [${shortCommentId(c.id)}] — ${c.body}`)
    for (const r of c.replies ?? []) {
      lines.push(`  ↳ ${agentFacingAuthorLabel(r.author)}: ${r.body}`)
    }
  }
  return lines
}

/** Text for "Send to Agent" / "Copy". Open comments only — resolved ones
 *  are done and outdated ones point at code that no longer exists, so
 *  sending either would just make the agent chase ghosts. Line numbers
 *  are given against the commit named after `@` so the agent can
 *  `git show <sha>:<path>` if HEAD has moved since. */
export function formatReviewComments(comments: ReviewComment[]): string {
  const lines = formatCommentLines(comments)
  if (lines.length === 0) return ''
  return ['Review feedback on your changes:', '', ...lines].join('\n')
}

/** Body of a submitted review as delivered to the author agent. Only the
 *  submission's comments that are still open go out — the human may have
 *  resolved or deleted some while it sat as a draft. */
export function formatReviewSubmission(
  submission: ReviewSubmission,
  comments: ReviewComment[]
): string {
  const ids = new Set(submission.commentIds)
  const lines = formatCommentLines(comments.filter((c) => ids.has(c.id)))
  const count = lines.filter((l) => !l.startsWith('  ↳')).length
  const out = [`Verdict: ${REVIEW_VERDICT_LABELS[submission.verdict]}`]
  const summary = submission.summary.trim()
  if (summary) out.push('', summary)
  if (count > 0) {
    out.push('', `${count} open comment${count === 1 ? '' : 's'}:`, ...lines)
  }
  return out.join('\n')
}
