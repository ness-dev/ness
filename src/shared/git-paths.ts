/** Renamed entries from `git status --porcelain` are stored as
 * "old -> new"; returns the destination path. */
export function destOf(p: string): string {
  const idx = p.indexOf(' -> ')
  return idx >= 0 ? p.slice(idx + 4) : p
}
