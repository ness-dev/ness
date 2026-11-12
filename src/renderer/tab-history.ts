// Browser-style back/forward history of focused tabs across worktrees.
// Per-client focus bookkeeping, so it lives in the renderer, not a slice.

export interface TabHistoryEntry {
  worktreePath: string
  tabId: string
}

export interface TabHistory {
  entries: TabHistoryEntry[]
  // Position of the currently focused entry; -1 when empty.
  index: number
}

export const MAX_TAB_HISTORY = 100

export const emptyTabHistory: TabHistory = { entries: [], index: -1 }

export function sameEntry(a: TabHistoryEntry | undefined, b: TabHistoryEntry | undefined): boolean {
  return !!a && !!b && a.worktreePath === b.worktreePath && a.tabId === b.tabId
}

export function currentEntry(h: TabHistory): TabHistoryEntry | undefined {
  return h.entries[h.index]
}

// A fresh visit drops any forward entries, like following a link after Back.
export function recordVisit(h: TabHistory, entry: TabHistoryEntry): TabHistory {
  if (sameEntry(currentEntry(h), entry)) return h
  const entries = [...h.entries.slice(0, h.index + 1), entry]
  const overflow = Math.max(0, entries.length - MAX_TAB_HISTORY)
  return { entries: entries.slice(overflow), index: entries.length - 1 - overflow }
}

// Drops entries whose tab no longer exists and collapses the adjacent
// duplicates that leaves behind, keeping `index` on the same logical spot.
export function pruneTabHistory(
  h: TabHistory,
  isLive: (e: TabHistoryEntry) => boolean
): TabHistory {
  const entries: TabHistoryEntry[] = []
  let index = -1
  h.entries.forEach((e, i) => {
    if (isLive(e) && !sameEntry(entries[entries.length - 1], e)) entries.push(e)
    if (i <= h.index) index = entries.length - 1
  })
  if (entries.length > 0 && index < 0) index = 0
  if (entries.length === h.entries.length && index === h.index) return h
  return { entries, index }
}

export function stepTabHistory(
  h: TabHistory,
  direction: -1 | 1,
  isLive: (e: TabHistoryEntry) => boolean
): { history: TabHistory; target: TabHistoryEntry | null } {
  const pruned = pruneTabHistory(h, isLive)
  const index = pruned.index + direction
  if (index < 0 || index >= pruned.entries.length) return { history: pruned, target: null }
  return { history: { ...pruned, index }, target: pruned.entries[index] }
}
