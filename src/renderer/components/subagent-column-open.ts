import type { SubagentsColumnDefault } from '../../shared/state/settings'

/** Sessions whose explicit open/close choice is remembered. Oldest first,
 *  so the cap drops the least recently changed. */
const CHOICE_CAP = 200

/** sessionId → true (opened) / false (closed). Only explicit choices:
 *  a session missing here follows the `subagentsColumnDefault` setting,
 *  so changing that setting reaches every chat the user hasn't touched. */
export type ColumnChoices = Readonly<Record<string, boolean>>

export function isColumnOpen(
  choices: ColumnChoices,
  sessionId: string,
  fallback: SubagentsColumnDefault
): boolean {
  const choice = choices[sessionId]
  return choice ?? fallback === 'expanded'
}

export function withColumnChoice(
  choices: ColumnChoices,
  sessionId: string,
  open: boolean
): ColumnChoices {
  const entries = Object.entries(choices).filter(([id]) => id !== sessionId)
  entries.push([sessionId, open])
  return Object.fromEntries(entries.slice(-CHOICE_CAP))
}

export function parseColumnChoices(raw: string | null): ColumnChoices {
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(([, v]) => typeof v === 'boolean')
    ) as ColumnChoices
  } catch {
    return {}
  }
}
