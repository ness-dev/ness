// Wire types for loch (https://github.com/ness-dev/loch), the CLI that
// records which agent turn wrote each line. Only the fields Ness reads are
// typed; loch's JSON contract (schema 2) adds fields without bumping the
// schema, so unknown keys are expected and ignored.

export interface LochConversation {
  /** Per-blame letter, stable only within one blame document. */
  mark: string
  session: string
  agent: string
  /** 1-based turn number within the session. */
  index: number
  /** ISO-8601 time the turn ended. */
  ended: string
  /** Whether the transcript can be resumed (and so `ask` can fork it). */
  available: boolean
  turn: string
  conversation: string
  title?: string | null
  /** Truncated, redacted by loch. May hold raw harness markup — plain text only. */
  prompt?: string | null
  /** Reconstructed after the fact by `loch backfill`; coarser attribution. */
  backfilled: boolean
}

export interface LochHunk {
  /** 1-based inclusive line range. */
  start: number
  end: number
  mark: string
  /** null = unattributed (a person wrote it, or nothing recorded it). */
  conversation: LochConversation | null
}

/** Ness's own codes, alongside loch's (`file-unreadable`, `internal`, …). */
export type LochFailureCode = 'not-installed' | 'bad-output' | 'timeout' | string

export type LochBlameResult =
  | { ok: true; conversations: LochConversation[]; hunks: LochHunk[] }
  | { ok: false; code: LochFailureCode; error?: string }

export type LochAskResult =
  | { ok: true; sessionId: string; relocated: boolean }
  | { ok: false; code: LochFailureCode; error?: string }

/** Failures that mean "this file has no blame to show" rather than "something
 *  broke" — the gutter just stays empty and nobody gets a toast. */
export function isQuietBlameFailure(code: LochFailureCode): boolean {
  return code === 'not-installed' || code === 'file-unreadable'
}

/** Ten distinguishable hues for the gutter bars. Assigned per turn (loch's
 *  `mark`), not per session: a file is often written by a single session, and
 *  colouring by session paints it one solid bar with no visible boundaries.
 *  The hover card names the session. */
export const LOCH_PALETTE_SIZE = 10

/** Map each attributed turn to a palette slot in order of first appearance
 *  down the file, so the top of a file always starts at the same colour. */
export function assignTurnColors(hunks: LochHunk[]): Map<string, number> {
  const slots = new Map<string, number>()
  for (const h of hunks) {
    const s = h.conversation?.turn
    if (!s || slots.has(s)) continue
    slots.set(s, slots.size % LOCH_PALETTE_SIZE)
  }
  return slots
}

/** Which hunk covers a 1-based line, or null. Hunks arrive sorted and
 *  non-overlapping, so a binary search keeps per-mousemove lookups cheap. */
export function hunkAtLine(hunks: LochHunk[], line: number): LochHunk | null {
  let lo = 0
  let hi = hunks.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const h = hunks[mid]
    if (line < h.start) hi = mid - 1
    else if (line > h.end) lo = mid + 1
    else return h
  }
  return null
}

/** Validate a parsed `loch blame --json` document into Ness's shape. Anything
 *  that doesn't look like schema-2 output becomes `bad-output` rather than a
 *  half-trusted payload. */
export function parseBlameDocument(doc: unknown): LochBlameResult {
  if (!doc || typeof doc !== 'object') return { ok: false, code: 'bad-output' }
  const d = doc as Record<string, unknown>
  if (d.ok !== true) {
    return {
      ok: false,
      code: typeof d.code === 'string' ? d.code : 'bad-output',
      error: typeof d.error === 'string' ? d.error : undefined
    }
  }
  if (!Array.isArray(d.hunks) || !Array.isArray(d.conversations)) {
    return { ok: false, code: 'bad-output' }
  }
  const hunks: LochHunk[] = []
  for (const raw of d.hunks as unknown[]) {
    if (!raw || typeof raw !== 'object') continue
    const h = raw as Record<string, unknown>
    if (typeof h.start !== 'number' || typeof h.end !== 'number') continue
    const conv = h.conversation as LochConversation | null | undefined
    hunks.push({
      start: h.start,
      end: h.end,
      mark: typeof h.mark === 'string' ? h.mark : '·',
      conversation: conv && typeof conv === 'object' && typeof conv.session === 'string' ? conv : null
    })
  }
  return { ok: true, conversations: d.conversations as LochConversation[], hunks }
}

/** The body of the first turn in a forked Chat opened from the gutter. The
 *  relocation preamble (if the fork moved worktrees) goes first so the agent
 *  re-resolves paths before it reads anything. */
export function buildBlameAskBody(args: {
  relPath: string
  line: number
  lineText: string | null
  conversation: LochConversation
  relocationPreamble?: string
}): string {
  const { relPath, line, lineText, conversation, relocationPreamble } = args
  const parts: string[] = []
  if (relocationPreamble) parts.push(relocationPreamble)
  parts.push(
    `The user is looking at \`${relPath}\` line ${line} and wants to ask about it. loch attributes this line to turn ${conversation.index} of this conversation${conversation.backfilled ? ' (backfilled — reconstructed after the fact, so treat it as approximate)' : ''}.`
  )
  if (lineText != null) {
    parts.push(`The line as it is now:\n\n\`\`\`\n${lineText}\n\`\`\``)
  }
  return parts.join('\n\n')
}
