// Pure helpers behind the finished-turn fold: split the transcript's
// rows into turns, decide which turns may fold, and summarize the work
// that folds away. Kept out of JsonModeChat.tsx so it's testable without
// React.

import type { TimelineRow } from './tool-timeline'

export interface TurnRow extends TimelineRow {
  type: 'text' | 'tool'
  entryId?: string
  timestamp?: number
  /** A delivered user prompt (typed or automated) — the only thing that
   *  starts a turn. Queued prompts haven't entered the conversation yet. */
  isTurnStart?: boolean
  /** A turn-level failure card (agent error, rate-limit stop, auth
   *  failure, subprocess exit). Ordinary tool errors don't count — a
   *  failed Bash mid-turn is routine and the turn can still land. */
  isTurnError?: boolean
  hasPendingApproval?: boolean
  /** Files this tool call wrote. */
  editedPaths?: string[]
}

export interface TurnSummary {
  /** Prompt to the start of the final answer. Undefined when timestamps
   *  are missing or out of order. */
  durationMs?: number
  toolCount: number
  editedFileCount: number
}

export type TurnItem<R extends TurnRow> =
  | { kind: 'rows'; rows: R[] }
  | { kind: 'turn'; key: string; rows: R[]; summary: TurnSummary }

export interface FoldOptions {
  busy: boolean
  /** When the in-flight turn began; see JsonClaudeSession.turnStartedAt. */
  turnStartedAt?: number
}

/** Folds each finished turn's work into one `turn` item, leaving the
 *  prompt and the final answer (every text row after the last tool row)
 *  outside it as plain rows.
 *
 *  A turn is left alone when any of these hold:
 *  - it's still in flight. While busy that's any turn with a row at or
 *    after `turnStartedAt`, which also covers the part of a live turn
 *    before a mid-turn interjection (that message starts a new segment
 *    but not a new turn).
 *  - it has no final answer, i.e. it ended on a tool call. That's what an
 *    interrupted turn usually looks like.
 *  - it holds a pending approval or a turn-level error.
 *  - it made no tool calls, so there's nothing worth folding.
 *  - its prompt is outside the render window. */
export function foldFinishedTurns<R extends TurnRow>(
  rows: R[],
  opts: FoldOptions
): TurnItem<R>[] {
  const segments: R[][] = []
  for (const r of rows) {
    if (r.isTurnStart || segments.length === 0) segments.push([r])
    else segments[segments.length - 1].push(r)
  }

  const out: TurnItem<R>[] = []
  const pushRows = (rs: R[]): void => {
    if (rs.length === 0) return
    const last = out[out.length - 1]
    if (last && last.kind === 'rows') last.rows.push(...rs)
    else out.push({ kind: 'rows', rows: [...rs] })
  }

  segments.forEach((seg, i) => {
    const isLast = i === segments.length - 1
    const fold = planFold(seg, isLast, opts)
    if (!fold) {
      pushRows(seg)
      return
    }
    const [start, ...rest] = seg
    const body = rest.slice(0, fold.answerStart)
    const answer = rest.slice(fold.answerStart)
    pushRows([start])
    out.push({
      kind: 'turn',
      key: `turn-${start.key}`,
      rows: body,
      summary: summarizeTurn(start, body, answer)
    })
    pushRows(answer)
  })
  return out
}

function planFold<R extends TurnRow>(
  seg: R[],
  isLast: boolean,
  opts: FoldOptions
): { answerStart: number } | null {
  const [start, ...rest] = seg
  if (!start?.isTurnStart) return null
  if (isLive(seg, isLast, opts)) return null
  if (rest.some((r) => r.hasPendingApproval || r.isTurnError)) return null
  let lastTool = -1
  for (let j = rest.length - 1; j >= 0; j--) {
    if (rest[j].type === 'tool') {
      lastTool = j
      break
    }
  }
  if (lastTool === -1 || lastTool === rest.length - 1) return null
  const body = rest.slice(0, lastTool + 1)
  if (!body.some((r) => r.type === 'tool' && !r.isThinking && r.toolName)) {
    return null
  }
  return { answerStart: lastTool + 1 }
}

function isLive<R extends TurnRow>(
  seg: R[],
  isLast: boolean,
  opts: FoldOptions
): boolean {
  if (!opts.busy) return false
  if (opts.turnStartedAt === undefined) return isLast
  const lastTs = seg[seg.length - 1].timestamp
  if (lastTs === undefined) return isLast
  return lastTs >= opts.turnStartedAt
}

function summarizeTurn<R extends TurnRow>(
  start: R,
  body: R[],
  answer: R[]
): TurnSummary {
  const tools = body.filter((r) => r.type === 'tool' && !r.isThinking && r.toolName)
  const files = new Set<string>()
  for (const r of tools) for (const p of r.editedPaths ?? []) files.add(p)
  const from = start.timestamp
  const to = answer[0]?.timestamp
  const durationMs =
    from !== undefined && to !== undefined && to >= from ? to - from : undefined
  return { durationMs, toolCount: tools.length, editedFileCount: files.size }
}

/** Paths a tool call writes, for the files-edited count. Claude's Edit /
 *  MultiEdit / Write / NotebookEdit carry one path; Codex's ApplyPatch
 *  carries a `changes` list. */
export function getEditedPaths(
  toolName: string | undefined,
  input: Record<string, unknown> | undefined
): string[] | undefined {
  if (!input) return undefined
  switch (toolName) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write': {
      const p = input.file_path
      return typeof p === 'string' ? [p] : undefined
    }
    case 'NotebookEdit': {
      const p = input.notebook_path
      return typeof p === 'string' ? [p] : undefined
    }
    case 'ApplyPatch': {
      const changes = input.changes
      if (!Array.isArray(changes)) return undefined
      const paths = changes.flatMap((c) => {
        const p = c && typeof c === 'object' ? (c as Record<string, unknown>).path : undefined
        return typeof p === 'string' ? [p] : []
      })
      return paths.length > 0 ? paths : undefined
    }
    default:
      return undefined
  }
}

export function formatTurnDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) {
    const rem = s % 60
    return rem === 0 ? `${m}m` : `${m}m ${rem}s`
  }
  const h = Math.floor(m / 60)
  const remM = m % 60
  return remM === 0 ? `${h}h` : `${h}h ${remM}m`
}
