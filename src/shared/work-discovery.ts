// Types + pure selection rules for the "bring in your work" onboarding
// step. The scan itself runs in main (src/main/work-discovery.ts); this
// file is what the wizard and the import handler agree on.

export type DiscoveredAgentKind = 'claude' | 'codex'

/** How a session that is running in some other process right now reports
 *  itself. Mirrors the `status` field of `<claude home>/sessions/<pid>.json`. */
export type ExternalLiveStatus = 'busy' | 'waiting' | 'idle'

export interface DiscoveredSession {
  agentKind: DiscoveredAgentKind
  sessionId: string
  lastActiveAt: number
  lastPrompt?: string
  /** Set when a process Ness didn't start is running this session now. */
  live?: { pid: number; status: ExternalLiveStatus }
}

export interface DiscoveredWorktree {
  path: string
  branch: string
  isMain: boolean
  /** The conversation the import would open in this worktree: the one
   *  running elsewhere if there is one, else the most recent. */
  session?: DiscoveredSession
  sessionCount: number
  lastActiveAt: number | null
}

export interface DiscoveredRepo {
  repoRoot: string
  name: string
  worktrees: DiscoveredWorktree[]
  sessionCount: number
  liveCount: number
  lastActiveAt: number
  /** Lives under a temp dir — almost always a test fixture or a demo. */
  isTemp: boolean
  alreadyAdded: boolean
}

export interface DiscoveredWork {
  repos: DiscoveredRepo[]
  /** Whichever agent has more conversations in the found repos; null when
   *  nothing was found. */
  suggestedAgent: DiscoveredAgentKind | null
  /** True only when this install has never had an agent or interface
   *  chosen and never got as far as the quest — i.e. a genuine first run.
   *  The wizard also shows for an existing user who removed their last
   *  repo, and it must not rewrite that user's settings from a scan. */
  mayPreselectAgent: boolean
  scannedAt: number
}

export interface ImportWorkResult {
  addedRepoRoots: string[]
  /** The most recently active imported worktree — where to land. */
  focusWorktreePath: string | null
}

const DAY_MS = 24 * 60 * 60 * 1000
/** Repos touched this recently are worth showing up front… */
export const PRIMARY_WINDOW_MS = 30 * DAY_MS
/** …and ones touched this recently start checked. */
export const PRECHECK_WINDOW_MS = 14 * DAY_MS

const TEMP_PREFIXES = ['/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/']

export function isTempPath(path: string): boolean {
  return TEMP_PREFIXES.some((prefix) => path.startsWith(prefix))
}

/** Repos shown in the main list vs. tucked behind "N more". */
export function partitionRepos(
  repos: DiscoveredRepo[],
  now: number
): { primary: DiscoveredRepo[]; rest: DiscoveredRepo[] } {
  const primary: DiscoveredRepo[] = []
  const rest: DiscoveredRepo[] = []
  for (const repo of repos) {
    if (!repo.isTemp && now - repo.lastActiveAt <= PRIMARY_WINDOW_MS) primary.push(repo)
    else rest.push(repo)
  }
  return { primary, rest }
}

export function defaultSelectedRepoRoots(repos: DiscoveredRepo[], now: number): string[] {
  return repos
    .filter((r) => !r.isTemp && now - r.lastActiveAt <= PRECHECK_WINDOW_MS)
    .map((r) => r.repoRoot)
}

export function summarizeWork(repos: DiscoveredRepo[]): {
  repos: number
  worktrees: number
  conversations: number
  live: number
} {
  let worktrees = 0
  let conversations = 0
  let live = 0
  for (const repo of repos) {
    worktrees += repo.worktrees.length
    conversations += repo.sessionCount
    live += repo.liveCount
  }
  return { repos: repos.length, worktrees, conversations, live }
}

export function formatAge(ts: number, now: number): string {
  const diff = Math.max(0, now - ts)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  const months = Math.floor(days / 30)
  return months === 1 ? '1 month ago' : `${months} months ago`
}
