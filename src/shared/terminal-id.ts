// Terminal tab id prefix for a worktree. Shared by the desktop renderer
// (useTabHandlers) and the mobile app so a restarted or new agent tab gets
// the same id shape from either client.
export function makeTerminalId(prefix: string, worktreePath: string): string {
  const safe = worktreePath.replace(/[/\\]/g, '-').replace(/^-+/, '').replace(/-+/g, '-')
  return `${prefix}-${safe}`
}
