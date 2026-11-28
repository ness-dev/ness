// The comment cards the Review tab draws under diff lines: ReviewDiffPane's
// InlineComment as static HTML. Read-only in the page; a tap opens the
// thread sheet, where the text is selectable and the actions live.
import type { ReviewAuthor, ReviewComment } from '../../../src/shared/state/reviews'
import { esc, type ThreadBlock } from '../viewer/code-html'
import type { CommentPlacement } from './review-model'

const STATUS_WORD: Record<ReviewComment['status'], string> = { open: '', resolved: 'Resolved', outdated: 'Outdated' }

function attr(s: string): string {
  return esc(s).replace(/"/g, '&quot;')
}

export function commentCardHtml(c: ReviewComment, authorName: (a: ReviewAuthor) => string): string {
  const who = authorName(c.author)
  const status = STATUS_WORD[c.status]
  const replies = c.replies?.length ?? 0
  const foot = [replies > 0 ? `${replies} ${replies === 1 ? 'reply' : 'replies'}` : '', 'Tap to open'].filter(Boolean).join(' · ')
  const label = `Comment by ${who} on line ${c.line}${status ? `, ${status.toLowerCase()}` : ''}: ${c.body}${replies ? `. ${replies} ${replies === 1 ? 'reply' : 'replies'}` : ''}`
  return (
    `<div class="cm ${c.status}" data-c="${attr(c.id)}" role="button" aria-label="${attr(label)}">` +
    `<div class="cm-h"><span class="cm-a${c.author.kind === 'agent' ? ' agent' : ''}">${esc(who)}</span>${status ? ` · ${status}` : ''}</div>` +
    `<div class="cm-b">${esc(c.body)}</div>` +
    `<div class="cm-f">${foot}</div></div>`
  )
}

/** One block per row that has comments, for diffHtml / setThreadsJs. */
export function threadBlocks(placement: CommentPlacement, authorName: (a: ReviewAuthor) => string): ThreadBlock[] {
  const out: ThreadBlock[] = []
  for (const [row, comments] of placement.byRow) {
    out.push({ row, html: comments.map((c) => commentCardHtml(c, authorName)).join('') })
  }
  return out.sort((a, b) => a.row - b.row)
}
