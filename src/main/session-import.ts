import type { TerminalTab } from '../shared/state/terminals'
import type { SessionImportEvent } from '../shared/state/session-import'
import type { ImportOutcome } from '../shared/session-import-types'

export type { ImportOutcome } from '../shared/session-import-types'
import type {
  RepoImportPlan,
  RepoImportRequest,
  RepoImportBranchResult,
  RepoImportResult
} from '../shared/repo-import-types'
import { log } from './debug'
import { forkTranscript } from './json-claude-manager'
import { buildRepoImportPlan } from './repo-import'
import { scanSessions, type DiscoveredSession } from './session-scanner'
import { buildSessionTree, type SessionGroupNode } from './session-tree'
import type { BranchInventoryEntry } from './worktree'

/** Owns discovery and import of Claude Code sessions the user ran outside
 *  Ness.
 *
 *  The scan results are held here rather than in a slice: they are a
 *  multi-megabyte, re-derivable list that exactly one modal reads. Only the
 *  scan's status is dispatched (see shared/state/session-import.ts); the tree
 *  is handed over a request IPC when the browser opens. */

export interface CreateWorktreeParams {
  repoRoot: string
  branchName: string
  forkSource?: { sessionId: string; worktreePath: string; silent?: boolean }
}

export interface CreateWorktreeOutcome {
  ok: boolean
  path: string | null
  error?: string
}

export interface SessionImportDeps {
  dispatch: (event: SessionImportEvent) => void
  getRepoRoots: () => string[]
  addTab: (worktreePath: string, tab: TerminalTab) => void
  startSession: (sessionId: string, worktreePath: string) => void
  homeDir: () => string
  listBranchInventory: (repoRoot: string) => Promise<BranchInventoryEntry[]>
  createWorktree: (params: CreateWorktreeParams) => Promise<CreateWorktreeOutcome>
  now?: () => number
}

export class SessionImportManager {
  private sessions: DiscoveredSession[] = []
  private scanning = false
  private scanned = false
  private inFlight: Promise<{ sessionCount: number; groupCount: number }> | null = null

  constructor(private readonly deps: SessionImportDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** Whether a scan is already running. A second caller joins it rather than
   *  starting a second concurrent walk of the same tree. */
  isScanning(): boolean {
    return this.scanning
  }

  /** Joining the in-flight scan matters, not just deduping it: the wizard
   *  probes several repos at once, and a caller that returned early would
   *  read `this.sessions` while it was still empty and conclude the repo had
   *  no history at all. */
  scan(): Promise<{ sessionCount: number; groupCount: number }> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.runScan().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async runScan(): Promise<{ sessionCount: number; groupCount: number }> {
    this.scanning = true
    this.deps.dispatch({ type: 'sessionImport/scanStarted' })
    try {
      // The scanner reports per file, which on a real corpus is 8000+ calls.
      // Dispatching each one would push that many events through the reducer
      // and out over IPC to every client -- the exact high-frequency-stream
      // anti-pattern the store is not for. A progress bar can't render more
      // than a few updates a second anyway, so coalesce to whole percent
      // changes and always let the final file through so the bar lands full.
      let lastPercent = -1
      const result = await scanSessions({
        onProgress: (scanned, total) => {
          const percent = total > 0 ? Math.floor((scanned / total) * 100) : 0
          if (percent === lastPercent && scanned !== total) return
          lastPercent = percent
          this.deps.dispatch({
            type: 'sessionImport/scanProgress',
            payload: { scanned, total }
          })
        }
      })
      this.sessions = result.sessions
      this.scanned = true
      const groupCount = this.getTree().length
      this.deps.dispatch({
        type: 'sessionImport/scanCompleted',
        payload: { sessionCount: result.sessions.length, groupCount, at: this.now() }
      })
      log(
        'session-import',
        `scan complete sessions=${result.sessions.length} groups=${groupCount} ` +
          `elapsed=${result.elapsedMs}ms cacheHits=${result.cacheHits}`
      )
      return { sessionCount: result.sessions.length, groupCount }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      this.deps.dispatch({ type: 'sessionImport/scanFailed', payload: reason })
      log('session-import', 'scan failed', reason)
      return { sessionCount: 0, groupCount: 0 }
    } finally {
      this.scanning = false
    }
  }

  getTree(): SessionGroupNode[] {
    return buildSessionTree(this.sessions, this.deps.getRepoRoots(), this.deps.homeDir())
  }

  findSession(sessionId: string): DiscoveredSession | null {
    return this.sessions.find((s) => s.sessionId === sessionId) ?? null
  }

  /** What Ness would offer to import for a repo the user just added.
   *
   *  Scans on first call (~5.5s over an 8000-session corpus, ~170ms once
   *  the mtime cache is warm) so the caller can fire this straight off a
   *  repo-add without sequencing a scan itself. */
  async probeRepo(repoRoot: string): Promise<RepoImportPlan> {
    if (!this.scanned) await this.scan()
    const inventory = await this.deps.listBranchInventory(repoRoot)
    return buildRepoImportPlan({ repoRoot, sessions: this.sessions, inventory, now: this.now() })
  }

  /** Recreate the chosen branches as worktrees with their chat history
   *  attached.
   *
   *  Serial on purpose. `git worktree add` takes a repo-wide lock, and each
   *  creation also runs the repo's setup script (`npm install` and friends);
   *  twenty of those in parallel would thrash the machine for no wall-clock
   *  win. One failure doesn't abort the batch — the user asked for fifteen
   *  branches and should get the fourteen that work, with the fifteenth
   *  named. */
  async importRepoBranches(request: RepoImportRequest): Promise<RepoImportResult> {
    const { repoRoot, branches } = request
    const plan = await this.probeRepo(repoRoot)
    const byBranch = new Map(plan.candidates.map((c) => [c.branch, c]))
    const results: RepoImportBranchResult[] = []

    for (const selection of branches) {
      const { branch } = selection
      const candidate = byBranch.get(branch)
      if (!candidate) {
        results.push({
          branch,
          ok: false,
          worktreePath: null,
          importedChats: 0,
          error: 'no importable chat history for this branch'
        })
        continue
      }

      // The picker sends what the user checked, but a stale plan or a hand-made
      // request could name chats this branch doesn't own. Intersect rather than
      // trust, and fall back to the newest chat when nothing survives — an
      // empty worktree isn't what "import my work" asked for.
      const owned = new Set(candidate.chats.map((c) => c.sessionId))
      const chosen = selection.sessionIds.filter((id) => owned.has(id))
      const ordered = candidate.chats
        .filter((c) => chosen.includes(c.sessionId))
        .map((c) => c.sessionId)
      const sessionIds = ordered.length > 0 ? ordered : [candidate.chats[0].sessionId]

      // The most recent chat rides in as the worktree's first agent tab via
      // the existing fork-on-create path, so the worktree opens on "where I
      // left off" rather than on an empty session nobody wanted.
      const lead = this.findSession(sessionIds[0])
      const created = await this.deps.createWorktree({
        repoRoot,
        branchName: branch,
        forkSource:
          lead?.cwd != null
            ? { sessionId: lead.sessionId, worktreePath: lead.cwd, silent: true }
            : undefined
      })

      if (!created.ok || !created.path) {
        results.push({
          branch,
          ok: false,
          worktreePath: null,
          importedChats: 0,
          error: created.error ?? 'worktree creation failed'
        })
        continue
      }

      let importedChats = lead?.cwd != null ? 1 : 0
      for (const sessionId of sessionIds.slice(1)) {
        // Asleep: a branch with 40 chats must not become 40 subprocesses.
        // The tab resumes when the user clicks it.
        const outcome = this.importSession(sessionId, created.path, { spawn: false })
        if (outcome.ok) importedChats++
      }

      results.push({ branch, ok: true, worktreePath: created.path, importedChats, error: null })
    }

    const created = results.filter((r) => r.ok).length
    log(
      'session-import',
      `repo import ${repoRoot} requested=${branches.length} created=${created} ` +
        `chats=${results.reduce((n, r) => n + r.importedChats, 0)}`
    )
    return {
      ok: created > 0,
      created,
      importedChats: results.reduce((n, r) => n + r.importedChats, 0),
      branches: results
    }
  }

  /** Attach a discovered session to a worktree as a chat tab.
   *
   *  When the session already ran in the target worktree the transcript is
   *  adopted in place — the CLI's `--resume` keys off the file existing in
   *  that worktree's encoded project dir, which it already does, so no copy
   *  is needed and the user keeps one continuous history.
   *
   *  Otherwise the transcript is forked into the target's project dir under
   *  a fresh session id. forkTranscript handles the per-line sessionId
   *  rewrite; the resumed agent learns it moved via the relocation preamble
   *  that the fork path already injects. The source transcript is untouched
   *  either way, so importing never mutates the user's existing history. */
  importSession(
    sessionId: string,
    targetWorktreePath: string,
    opts: { spawn?: boolean } = {}
  ): ImportOutcome {
    const spawn = opts.spawn ?? true
    const session = this.findSession(sessionId)
    if (!session) return { ok: false, reason: 'session not found' }
    if (!session.cwd) return { ok: false, reason: 'session has no recorded working directory' }

    const adopt = session.cwd === targetWorktreePath
    let attachedId = sessionId

    if (!adopt) {
      const forked = forkTranscript({
        sourceSessionId: sessionId,
        sourceWorktreePath: session.cwd,
        destWorktreePath: targetWorktreePath
      })
      if (!forked.ok || !forked.newSessionId) {
        return { ok: false, reason: forked.reason ?? 'fork failed' }
      }
      attachedId = forked.newSessionId
    }

    const tab: TerminalTab = {
      id: attachedId,
      type: 'json-claude',
      label: session.title ? session.title.slice(0, 40) : 'Imported chat',
      sessionId: attachedId,
      mode: spawn ? 'awake' : 'asleep'
    }
    this.deps.addTab(targetWorktreePath, tab)
    if (spawn) this.deps.startSession(attachedId, targetWorktreePath)

    log(
      'session-import',
      `imported ${sessionId} -> ${attachedId} mode=${adopt ? 'adopt' : 'fork'} ` +
        `target=${targetWorktreePath}`
    )
    return { ok: true, sessionId: attachedId, mode: adopt ? 'adopt' : 'fork' }
  }
}
