export interface Worktree {
  path: string
  branch: string
  head: string
  isBare: boolean
  isMain: boolean
  /** Directory birthtime in ms since epoch; 0 if unavailable. */
  createdAt: number
  /** Repo this worktree belongs to. Set after a cross-repo listWorktrees merge. */
  repoRoot: string
  /** True when `git worktree list --porcelain` marked this entry
   *  prunable — i.e. the on-disk directory has been deleted but the
   *  worktree ref is still registered in the parent repo's `.git/worktrees/`.
   *  Kept in the list (rather than filtered out) so the sidebar can
   *  surface a "stale, click to prune" affordance instead of the entry
   *  silently ghosting until the user runs `git worktree prune` manually.
   *  Skips downstream spawn paths (PanesFSM.ensureInitialized) so we don't
   *  spawn a Claude tab against a missing cwd — see issue #185. */
  prunable?: boolean
  /** Reason git reports for the prunable state (e.g. "gitdir file
   *  points to non-existent location"). Optional — shown as a tooltip
   *  next to the stale badge. */
  prunableReason?: string
  /** True when git has the entry locked (`git worktree lock`). Claude
   *  Code's own worktree isolation locks the worktrees it creates in its
   *  scratchpad, so a locked entry usually means another session owns it.
   *  A locked entry whose directory is gone is also reported as
   *  `prunable`, since git itself won't flag it. */
  locked?: boolean
  /** Reason passed to `git worktree lock --reason`, if any. */
  lockedReason?: string
}

/** Handle for a worktree in agent-facing text: `<repo>/<branch>`. Branch
 *  alone collides the moment two repos are open — every repo has a `main` —
 *  and an ambiguous handle is a hard error at resolve time, not a guess.
 *  Shared so the composer's @-mention and resolveWorktreeQuery agree. */
export function worktreeHandle(repoRoot: string, branch: string): string {
  return `${repoRoot.split('/').pop() || repoRoot}/${branch}`
}

/** Merge per-repo `listWorktrees` results into a flat list, preserving the
 * caller's prior slice for any repo whose lookup failed (indicated by null).
 * Purpose: a transient `git worktree list` failure for one repo shouldn't
 * blank every worktree in that repo out of the UI — with the branch-sync
 * watcher now driving refreshList off fs events, a per-repo transient error
 * would otherwise flicker visibly. Successful results fully replace their
 * repo's slice (deletions still propagate). */
export function mergeWorktreesPreservingFailures(
  roots: string[],
  perRoot: (Worktree[] | null)[],
  previous: Worktree[]
): Worktree[] {
  const priorByRoot = new Map<string, Worktree[]>()
  for (const wt of previous) {
    const bucket = priorByRoot.get(wt.repoRoot)
    if (bucket) bucket.push(wt)
    else priorByRoot.set(wt.repoRoot, [wt])
  }
  const out: Worktree[] = []
  for (let i = 0; i < roots.length; i++) {
    const res = perRoot[i]
    if (res === null) {
      const prior = priorByRoot.get(roots[i])
      if (prior) out.push(...prior)
    } else {
      out.push(...res)
    }
  }
  return out
}

/** Structural equality over a flat worktree list, so high-frequency
 * re-derivers (the PR poller tick, the branch-sync watcher) can skip the
 * `worktrees/listChanged` dispatch when nothing actually changed. Without
 * this guard, blindly dispatching would churn the array reference on every
 * tick and re-render every consumer (CLAUDE.md slice anti-pattern #3).
 * Order-sensitive — every producer builds the list by iterating repoRoots
 * in the same order, so positional compare is sound. */
export function worktreeListsEqual(a: Worktree[], b: Worktree[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.path !== y.path ||
      x.branch !== y.branch ||
      x.head !== y.head ||
      x.isBare !== y.isBare ||
      x.isMain !== y.isMain ||
      x.createdAt !== y.createdAt ||
      x.repoRoot !== y.repoRoot ||
      x.prunable !== y.prunable ||
      x.prunableReason !== y.prunableReason ||
      x.locked !== y.locked ||
      x.lockedReason !== y.lockedReason
    ) {
      return false
    }
  }
  return true
}

export type PendingStatus = 'creating' | 'setup' | 'setup-failed' | 'error'

export interface PendingWorktree {
  /** Prefixed id like `pending:<uuid>` so the renderer can use it as an
   * activeWorktreeId during the creating/setup screens. */
  id: string
  repoRoot: string
  branchName: string
  status: PendingStatus
  error?: string
  setupLog?: string
  setupExitCode?: number
  /** Real on-disk path once addWorktree resolves. Set before status
   * transitions to 'setup-failed' so the "Continue anyway" path knows
   * where to jump. Also included in the runPending IPC return value on
   * the success path. */
  createdPath?: string
  /** One-shot kickoff prompt for the new Claude tab. In-memory only —
   * stripped before persistence. */
  initialPrompt?: string
  /** One-shot teleport session id for the new Claude tab. In-memory only. */
  teleportSessionId?: string
  /** One-shot conversation fork source for the new Claude tab. In-memory only. */
  forkSource?: ForkSource
}

/** An existing Claude conversation the new worktree's first agent tab
 *  should resume, instead of starting empty. The transcript is copied
 *  into the new worktree's project dir at creation time. */
export interface ForkSource {
  sessionId: string
  worktreePath: string
}

export type PendingDeletionPhase =
  | 'running-teardown'
  | 'removing-worktree'
  | 'failed'

export interface PendingDeletion {
  /** The worktree path being deleted — used as the key. */
  path: string
  repoRoot: string
  branch: string
  phase: PendingDeletionPhase
  /** Accumulated teardown script output. Undefined when the repo has no
   * teardown command configured — the renderer uses that to hide the log
   * panel entirely. */
  teardownLog?: string
  /** Teardown script exit code once it has finished. */
  teardownExitCode?: number
  error?: string
}

export interface WorktreesState {
  /** Flat list of worktrees across every known repo. */
  list: Worktree[]
  repoRoots: string[]
  pending: PendingWorktree[]
  /** In-flight deletions, keyed by worktree path. Lives in the store so
   * the UI can animate + stream teardown output and the FSM keeps running
   * if the user navigates away. */
  pendingDeletions: PendingDeletion[]
}

export type WorktreesEvent =
  | { type: 'worktrees/listChanged'; payload: Worktree[] }
  | { type: 'worktrees/reposChanged'; payload: string[] }
  | { type: 'worktrees/pendingAdded'; payload: PendingWorktree }
  | {
      type: 'worktrees/pendingUpdated'
      payload: { id: string; patch: Partial<PendingWorktree> }
    }
  | { type: 'worktrees/pendingRemoved'; payload: string }
  | { type: 'worktrees/pendingDeletionStarted'; payload: PendingDeletion }
  | {
      type: 'worktrees/pendingDeletionUpdated'
      payload: { path: string; patch: Partial<PendingDeletion> }
    }
  | { type: 'worktrees/pendingDeletionRemoved'; payload: string }

export const initialWorktrees: WorktreesState = {
  list: [],
  repoRoots: [],
  pending: [],
  pendingDeletions: []
}

export function worktreesReducer(
  state: WorktreesState,
  event: WorktreesEvent
): WorktreesState {
  switch (event.type) {
    case 'worktrees/listChanged':
      return { ...state, list: event.payload }
    case 'worktrees/reposChanged':
      return { ...state, repoRoots: event.payload }
    case 'worktrees/pendingAdded':
      return { ...state, pending: [...state.pending, event.payload] }
    case 'worktrees/pendingUpdated': {
      const i = state.pending.findIndex((p) => p.id === event.payload.id)
      if (i === -1) return state
      const patched = { ...state.pending[i], ...event.payload.patch }
      return {
        ...state,
        pending: [
          ...state.pending.slice(0, i),
          patched,
          ...state.pending.slice(i + 1)
        ]
      }
    }
    case 'worktrees/pendingRemoved':
      return { ...state, pending: state.pending.filter((p) => p.id !== event.payload) }
    case 'worktrees/pendingDeletionStarted':
      return {
        ...state,
        pendingDeletions: [
          ...state.pendingDeletions.filter((d) => d.path !== event.payload.path),
          event.payload
        ]
      }
    case 'worktrees/pendingDeletionUpdated': {
      const i = state.pendingDeletions.findIndex(
        (d) => d.path === event.payload.path
      )
      if (i === -1) return state
      const patched = { ...state.pendingDeletions[i], ...event.payload.patch }
      return {
        ...state,
        pendingDeletions: [
          ...state.pendingDeletions.slice(0, i),
          patched,
          ...state.pendingDeletions.slice(i + 1)
        ]
      }
    }
    case 'worktrees/pendingDeletionRemoved':
      return {
        ...state,
        pendingDeletions: state.pendingDeletions.filter((d) => d.path !== event.payload)
      }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}
