// Pure helpers behind ToolGroup's collapsed header: the count label
// ("2 screenshots · 4 clicks") and the timeline step list the strip
// renders. Kept out of ToolGroup.tsx so they're testable without
// dragging in React and the whole icon registry.

import type { JsonClaudeImageRef } from '../../../shared/state/json-claude'
import {
  formatActionCount,
  getToolAction,
  type ToolAction
} from './tool-display'

/** The subset of a ToolGroup row these helpers need. ToolGroupRow
 *  extends it, so callers pass their rows straight through. */
export interface TimelineRow {
  key: string
  toolName?: string
  hasError?: boolean
  images?: JsonClaudeImageRef[]
  isThinking?: boolean
}

/** Most distinct action nouns to name before lumping the rest into the
 *  generic bucket. Four already makes for a long header. */
const MAX_NAMED_COUNTS = 4

/** The group header's count label. Tools we know the shape of get
 *  counted by what they did — "2 screenshots · 4 clicks · 1 keystroke"
 *  — which is far more use than "7 tool calls" for a browser run.
 *  Everything else still falls into one "N tool calls" bucket, so a
 *  group of Reads and Edits reads exactly as it did before.
 *
 *  Named groups keep first-appearance order so the label tracks the
 *  timeline strip below it rather than re-sorting by frequency. */
export function summarizeTools(toolRows: TimelineRow[]): string[] {
  const named: Array<{ action: ToolAction; count: number }> = []
  const byNoun = new Map<string, { action: ToolAction; count: number }>()
  let generic = 0

  for (const r of toolRows) {
    const action = getToolAction(r.toolName)
    if (!action) {
      generic += 1
      continue
    }
    const existing = byNoun.get(action.many)
    if (existing) {
      existing.count += 1
      continue
    }
    const entry = { action, count: 1 }
    byNoun.set(action.many, entry)
    named.push(entry)
  }

  const shown = named.slice(0, MAX_NAMED_COUNTS)
  // Anything past the cap joins the generic bucket rather than getting
  // its own "+N" — it's still a tool call, so the total stays honest.
  for (const e of named.slice(MAX_NAMED_COUNTS)) generic += e.count

  const out = shown.map((e) => formatActionCount(e.action, e.count))
  if (generic > 0) {
    // "3 tool calls" on its own, but "2 clicks · 3 more calls" when it's
    // the remainder — "tool calls" alongside named actions would read as
    // if those weren't tool calls.
    out.push(
      out.length > 0
        ? `${generic} more call${generic === 1 ? '' : 's'}`
        : `${generic} tool call${generic === 1 ? '' : 's'}`
    )
  }
  return out
}

export type TimelineStep =
  | { kind: 'images'; key: string; images: JsonClaudeImageRef[] }
  | {
      kind: 'tool'
      key: string
      toolName?: string
      count: number
      hasError: boolean
    }

/** Consecutive calls to the same tool fold into one step with a count
 *  (`scroll ×4`), so eight scrolls between two screenshots don't push
 *  the second one off the end of the strip. Rows that returned an image
 *  never fold — each screenshot is its own beat in the timeline.
 *  Thinking rows are skipped; the header counts them separately. */
export function buildTimeline(rows: TimelineRow[]): TimelineStep[] {
  const steps: TimelineStep[] = []
  for (const r of rows) {
    if (r.isThinking) continue
    if (r.images && r.images.length > 0) {
      steps.push({ kind: 'images', key: r.key, images: r.images })
      continue
    }
    const prev = steps[steps.length - 1]
    if (prev && prev.kind === 'tool' && prev.toolName === r.toolName) {
      prev.count += 1
      prev.hasError = prev.hasError || !!r.hasError
      continue
    }
    steps.push({
      kind: 'tool',
      key: r.key,
      toolName: r.toolName,
      count: 1,
      hasError: !!r.hasError
    })
  }
  return steps
}
