// Classifies how an agent's turn ended from its final message text, for
// the inbox. Pure so main (which has the text) and tests share it.
//
// "Asked you something" is a heuristic: the final paragraph contains a
// sentence ending in '?'. Only the final paragraph counts, because agents
// routinely ask themselves rhetorical questions mid-reply ("Why does this
// fail? Because …") and then finish with a plain summary.

import type { InboxTurnKind } from './state/inbox'

const MAX_LINE = 140

/** Drop markdown noise that would otherwise lead the line: list bullets,
 *  heading hashes, emphasis markers, inline-code backticks. */
function plain(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^#+\s*/, '')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function clamp(s: string): string {
  return s.length > MAX_LINE ? s.slice(0, MAX_LINE - 1) + '…' : s
}

export function classifyTurnText(text: string): { kind: InboxTurnKind; text: string } {
  // Fenced code can contain '?' (regexes, ternaries) and is never the
  // sentence you want to read in a one-line summary.
  const prose = text.replace(/```[\s\S]*?(?:```|$)/g, '\n')
  const lines = prose.split('\n').map(plain).filter(Boolean)
  if (lines.length === 0) return { kind: 'finished', text: '' }

  const paragraphs = prose
    .split(/\n\s*\n/)
    .map((p) => p.split('\n').map(plain).filter(Boolean).join(' '))
    .filter(Boolean)
  const last = paragraphs[paragraphs.length - 1] ?? ''
  const sentences = last.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? []
  for (let i = sentences.length - 1; i >= 0; i--) {
    const s = sentences[i].trim()
    if (s.endsWith('?')) return { kind: 'question', text: clamp(s) }
  }
  return { kind: 'finished', text: clamp(lines[0]) }
}
