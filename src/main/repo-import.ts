import type { DiscoveredSession } from '../shared/session-import-types'
import type {
  RepoImportCandidate,
  RepoImportChat,
  RepoImportPlan
} from '../shared/repo-import-types'
import type { BranchInventoryEntry } from './worktree'
import { resolveRepoRoot } from './session-tree'

export type {
  RepoImportBranchResult,
  RepoImportCandidate,
  RepoImportChat,
  RepoImportPlan,
  RepoImportRequest,
  RepoImportResult,
  RepoImportSelection
} from '../shared/repo-import-types'

/** Turns "this repo has history on disk" into a checklist of branches worth
 *  recreating as Ness worktrees.
 *
 *  The question the picker asks is "which of these are you still working
 *  on?", and the honest answer comes from CHAT recency, not git. Measured on
 *  a real repo: 461 local branches, of which git could only prove 57 merged
 *  (the repo rebase-merges, so landed branches keep unreachable SHAs and
 *  read as live). Selecting on merge state would have pre-checked ~400
 *  branches. Chat recency cuts the same corpus to the couple of dozen the
 *  user actually touched this week, which is what they meant by the
 *  question.
 *
 *  Nothing is dropped for being old or merged — those rows are present and
 *  unchecked, per the same reasoning as session-tree.ts. The one exclusion is
 *  a branch with no local ref: there is no commit to check out. Those chats
 *  are counted (`strandedSessionCount`) so the total never silently shrinks.
 *
 *  A branch already checked out somewhere is NOT excluded. `git worktree add`
 *  would fail on it, but the destination already exists — Ness lists every
 *  `git worktree list` path, including the repo's own checkout — so the import
 *  attaches the chats there instead of creating anything. Dropping these took
 *  `main` off the list entirely, and on a repo with 17 open worktrees it left
 *  nothing at all. */

/** Chats touched inside this window pre-check their branch. A week is what
 *  separates "open loop" from "I remember doing that" for most people, and
 *  the picker exposes wider windows as one click. */
export const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** A branch at or under this many chats offers all of them. The recency rule
 *  exists to keep a 61-chat branch from opening 61 tabs; on the median branch,
 *  which has four, it would drop history that costs nothing to keep. */
export const FEW_CHATS = 5

function basename(path: string): string {
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
  const idx = trimmed.lastIndexOf('/')
  return idx === -1 ? trimmed : trimmed.slice(idx + 1) || trimmed
}

function sessionTime(session: DiscoveredSession): number {
  return session.lastTimestamp ?? session.mtimeMs
}

/** Whether a first-message title tells the reader anything the row doesn't
 *  already say. First messages here are frequently a Ness kickoff prompt
 *  (which just restates the branch name) or a bare "." — no title at all
 *  reads better than either. */
function isMeaningfulFallback(title: string | null, branch: string): boolean {
  const trimmed = title?.trim() ?? ''
  return trimmed.length > 2 && !trimmed.endsWith(branch)
}

function chatTitle(session: DiscoveredSession, branch: string): string | null {
  if (session.titleSource === 'custom' || session.titleSource === 'ai') return session.title
  return isMeaningfulFallback(session.title, branch) ? session.title : null
}

/** A named title beats a first-message fallback even from an older chat: a
 *  real title from two chats back tells the user far more about what the
 *  branch was for. */
function pickTitle(ordered: DiscoveredSession[], branch: string): string | null {
  const named = ordered.find((s) => s.titleSource === 'custom' || s.titleSource === 'ai')
  if (named?.title) return named.title
  return ordered.find((s) => isMeaningfulFallback(s.title, branch))?.title ?? null
}

/** Which of a branch's chats to pre-check.
 *
 *  Short branches offer everything. Long ones fall back to the same recency
 *  window the branch list uses, and always keep the most recent chat — a
 *  worktree that opens with no chat at all is not what "import my work" meant,
 *  however stale the branch is. */
function pickRecommendedChats(
  ordered: DiscoveredSession[],
  branch: string,
  now: number,
  activeWindowMs: number
): RepoImportChat[] {
  const offerAll = ordered.length <= FEW_CHATS
  return ordered.map((session, index) => ({
    sessionId: session.sessionId,
    title: chatTitle(session, branch),
    lastActivityMs: sessionTime(session),
    recommended: offerAll || index === 0 || now - sessionTime(session) <= activeWindowMs
  }))
}

export interface BuildPlanOptions {
  repoRoot: string
  sessions: DiscoveredSession[]
  inventory: BranchInventoryEntry[]
  now?: number
  activeWindowMs?: number
}

export function buildRepoImportPlan(options: BuildPlanOptions): RepoImportPlan {
  const { repoRoot, sessions, inventory } = options
  const now = options.now ?? Date.now()
  const activeWindowMs = options.activeWindowMs ?? ACTIVE_WINDOW_MS

  const byName = new Map(inventory.map((entry) => [entry.name, entry]))
  const grouped = new Map<string, DiscoveredSession[]>()
  let totalSessionCount = 0

  for (const session of sessions) {
    if (!session.cwd) continue
    if (resolveRepoRoot(session.cwd, [repoRoot]) !== repoRoot) continue
    totalSessionCount++
    if (!session.gitBranch) continue
    const existing = grouped.get(session.gitBranch)
    if (existing) existing.push(session)
    else grouped.set(session.gitBranch, [session])
  }

  const candidates: RepoImportCandidate[] = []
  let strandedSessionCount = 0

  for (const [branch, branchSessions] of grouped) {
    const entry = byName.get(branch)
    if (!entry) {
      // Branch was deleted after the work landed. The chats survive and stay
      // reachable through the session browser; they just can't be a worktree.
      strandedSessionCount += branchSessions.length
      continue
    }

    const ordered = [...branchSessions].sort((a, b) => sessionTime(b) - sessionTime(a))
    const latestActivityMs = sessionTime(ordered[0])
    const withPr = ordered.find((s) => s.prNumber !== null)

    candidates.push({
      branch,
      chats: pickRecommendedChats(ordered, branch, now, activeWindowMs),
      sessionCount: ordered.length,
      latestActivityMs,
      lastCommitMs: entry.lastCommitMs || null,
      merged: entry.merged,
      existingWorktreePath: entry.checkedOutAt,
      prNumber: withPr?.prNumber ?? null,
      latestTitle: pickTitle(ordered, branch),
      recommended: !entry.merged && now - latestActivityMs <= activeWindowMs
    })
  }

  candidates.sort((a, b) => b.latestActivityMs - a.latestActivityMs)

  return {
    repoRoot,
    repoLabel: basename(repoRoot),
    candidates,
    strandedSessionCount,
    totalSessionCount,
    recommendedCount: candidates.filter((c) => c.recommended).length
  }
}
