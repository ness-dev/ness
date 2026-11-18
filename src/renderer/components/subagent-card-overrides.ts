/** Per-session expand/collapse choices for subagent cards.
 *
 *  Module-level rather than component state because the column unmounts
 *  whenever its tab is hidden (so the revision poll and clock stop), and
 *  a card someone collapsed shouldn't pop back open when they return.
 *  Renderer-only UI state — another client has its own opinion about
 *  which cards it wants open, so this stays out of the slices. In memory
 *  only: across a reload, cards falling back to their defaults is fine. */

/** Sessions remembered. Least-recently-touched is dropped first. */
const SESSION_CAP = 50

const bySession = new Map<string, ReadonlyMap<string, boolean>>()

const EMPTY: ReadonlyMap<string, boolean> = new Map()

export function getCardOverrides(sessionId: string): ReadonlyMap<string, boolean> {
  return bySession.get(sessionId) ?? EMPTY
}

export function setCardOverride(
  sessionId: string,
  toolUseId: string,
  expanded: boolean
): ReadonlyMap<string, boolean> {
  const next = new Map(getCardOverrides(sessionId)).set(toolUseId, expanded)
  // Delete first so re-inserting moves it to the most-recent end.
  bySession.delete(sessionId)
  bySession.set(sessionId, next)
  while (bySession.size > SESSION_CAP) {
    const oldest = bySession.keys().next().value
    if (oldest === undefined) break
    bySession.delete(oldest)
  }
  return next
}

/** Test seam. */
export function resetCardOverrides(): void {
  bySession.clear()
}
