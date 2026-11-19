import { parseAutomatedMessage } from './state/json-claude'

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

/** What Ness adds per session from the transcript itself — loch's blame
 *  carries only the prompt of the turn that wrote the line, which on its own
 *  rarely says what the conversation was for. */
export interface LochSessionInfo {
  /** The session's first human (or kickoff) prompt, truncated. Not redacted
   *  by loch — it's read locally from the user's own transcript. */
  firstPrompt: string | null
}

export type LochBlameResult =
  | {
      ok: true
      conversations: LochConversation[]
      hunks: LochHunk[]
      /** Keyed by session id. Absent entries just mean "not found". */
      sessions?: Record<string, LochSessionInfo>
    }
  | { ok: false; code: LochFailureCode; error?: string }

export type LochRecordingResult =
  | {
      ok: true
      /** Worktrees Ness wrote hooks into. */
      installed: number
      /** Worktrees whose committed settings already run loch — left alone. */
      viaProject: number
      failed: number
    }
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

/** How much of a first prompt to ship to the card. Kickoff briefs run to
 *  pages; the card shows the opening and scrolls when pinned. */
export const FIRST_PROMPT_MAX_CHARS = 2000

/** Harness-injected turns that look like user messages but aren't what the
 *  conversation was started with. */
const NOT_A_PROMPT = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-caveat|task-notification|system-reminder|user-memory-input)\b/

function userText(record: Record<string, unknown>): string | null {
  if (record.type !== 'user' || record.isMeta === true || record.isSidechain === true) return null
  const message = record.message as { content?: unknown } | undefined
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  // A tool_result anywhere means this "user" record is the tool's reply.
  if (content.some((b) => (b as { type?: unknown })?.type === 'tool_result')) return null
  const text = content
    .filter((b) => (b as { type?: unknown })?.type === 'text')
    .map((b) => String((b as { text?: unknown }).text ?? ''))
    .join('\n')
  return text || null
}

/** The first prompt a person (or a Ness kickoff) started the session with,
 *  from transcript jsonl lines. Ness's automation sentinel is unwrapped so
 *  the card shows the brief, not the tag and the model-facing footer. */
export function extractFirstPrompt(lines: Iterable<string>): string | null {
  for (const line of lines) {
    if (!line.includes('"user"')) continue
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const raw = userText(record)
    if (!raw || NOT_A_PROMPT.test(raw)) continue
    const text = (parseAutomatedMessage(raw)?.body ?? raw).trim()
    if (!text) continue
    return text.length > FIRST_PROMPT_MAX_CHARS ? `${text.slice(0, FIRST_PROMPT_MAX_CHARS)}…` : text
  }
  return null
}

/** The line `loch install` writes for each hook: `<command> hook <name>
 *  2>/dev/null || true`. Matched on a command whose basename is `loch` so
 *  removal never touches anyone else's hook. */
const LOCH_HOOK_LINE = /^(\S+) hook (prompt|stop|end|pre-tool|post-tool) 2>\/dev\/null \|\| true$/

export function isLochHookCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false
  const m = LOCH_HOOK_LINE.exec(command.trim())
  if (!m) return false
  const bin = m[1].replace(/^["']|["']$/g, '')
  return bin === 'loch' || bin.endsWith('/loch')
}

/** Remove loch's hook lines from a Claude Code settings object, dropping any
 *  group, event or `hooks` key left empty. loch has no `uninstall`, and an
 *  install with a new binary path adds lines beside the old ones rather than
 *  replacing them, so Ness strips before every install as well as on opt-out.
 *  Returns the same object when nothing matched. */
export function stripLochHooks(settings: Record<string, unknown>): Record<string, unknown> {
  const hooks = settings.hooks
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return settings
  let changed = false
  const next: Record<string, unknown> = {}
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) {
      next[event] = groups
      continue
    }
    const keptGroups: unknown[] = []
    for (const group of groups) {
      const entries = (group as { hooks?: unknown })?.hooks
      if (!Array.isArray(entries)) {
        keptGroups.push(group)
        continue
      }
      const kept = entries.filter((e) => !isLochHookCommand((e as { command?: unknown })?.command))
      if (kept.length === entries.length) {
        keptGroups.push(group)
        continue
      }
      changed = true
      if (kept.length > 0) keptGroups.push({ ...(group as object), hooks: kept })
    }
    if (keptGroups.length > 0) next[event] = keptGroups
  }
  if (!changed) return settings
  const out = { ...settings }
  if (Object.keys(next).length > 0) out.hooks = next
  else delete out.hooks
  return out
}
