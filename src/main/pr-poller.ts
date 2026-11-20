import { listWorktrees, getBranchSha, type WorktreeInfo } from './worktree'
import { isOnRealBranch } from './git-ops-state'
import { mergeWorktreesPreservingFailures, worktreeListsEqual } from '../shared/state/worktrees'
import {
  getRepoContext,
  fetchPRStatusesForRepo,
  fetchPRStatusByNumber,
  fetchAssignedPRs,
  type PRStatusRequest,
  type RepoContext,
  type AssignedPRsRepoLookup
} from './github'
import { log, formatErr } from './debug'
import type { Store } from './store'
import type { PRStatus } from '../shared/state/prs'
import type { AssignedPR } from '../shared/state/assigned-prs'

const POLL_INTERVAL_MS = 5 * 60 * 1000
const STALE_WINDOW_MS = 60 * 1000
/** How long to wait before re-querying PRs whose mergeability GitHub was
 *  still computing. Long enough for that computation to land, short enough
 *  that a newly-conflicted PR surfaces in seconds rather than next poll. */
const MERGEABLE_RECHECK_DELAY_MS = 2000
/** Ceiling on re-queries per round — one GraphQL call each, and a push to a
 *  busy base branch invalidates every open PR in the repo at once. */
const MERGEABLE_RECHECK_MAX = 20

/** A PR whose `mergeable` came back UNKNOWN, worth exactly one re-query. */
export interface MergeableRecheck {
  path: string
  root: string
  branch: string
  prNumber: number
}

/** Reconcile PRs whose mergeability GitHub hadn't finished computing.
 *
 *  GitHub computes mergeability lazily: any push to the base branch
 *  invalidates the cached merge commit for every open PR, and the first
 *  query after that returns UNKNOWN — which `buildPRStatus` surfaces as
 *  `hasConflict === null`. **UNKNOWN is not "no conflict."** Letting the
 *  null through drops a genuinely-conflicted worktree out of the
 *  Needs Attention sidebar group until the next poll five minutes later.
 *
 *  `hasConflict === null` is an exact signal here: `buildPRStatus` maps
 *  CONFLICTING→true and MERGEABLE→false, so null means UNKNOWN and
 *  nothing else. That's why this needs no extra plumbing through the
 *  fetch layer.
 *
 *  Carries the last known verdict forward while the PR number and head SHA
 *  are unchanged (a new head SHA invalidates the old verdict, so null is
 *  correct there), and returns the PRs worth re-querying. */
export function reconcileUnknownMergeable(
  prev: Record<string, PRStatus | null>,
  next: Record<string, PRStatus | null>,
  worktrees: ReadonlyArray<{ path: string; branch: string; repoRoot: string }>
): { byPath: Record<string, PRStatus | null>; rechecks: MergeableRecheck[] } {
  const byPath = { ...next }
  const rechecks: MergeableRecheck[] = []
  for (const wt of worktrees) {
    const status = byPath[wt.path]
    if (!status || status.hasConflict !== null) continue
    // Conflicts are meaningless once a PR is merged or closed.
    if (status.state === 'merged' || status.state === 'closed') continue
    rechecks.push({
      path: wt.path,
      root: wt.repoRoot,
      branch: wt.branch,
      prNumber: status.number
    })
    const prior = prev[wt.path]
    if (
      prior &&
      prior.hasConflict !== null &&
      prior.number === status.number &&
      !!prior.headSha &&
      prior.headSha === status.headSha
    ) {
      byPath[wt.path] = { ...status, hasConflict: prior.hasConflict }
    }
  }
  return { byPath, rechecks }
}

interface PRPollerOptions {
  getRepoRoots: () => string[]
  /** Current persisted "locallyMerged" map (branch → SHA at merge time). */
  getLocallyMerged: () => Record<string, string>
  /** Called with a pruned map whenever stale entries are detected, so the
   * caller can persist the change. */
  setLocallyMerged: (next: Record<string, string>) => void
}

/** Owns background PR-status polling and on-demand refresh. All writes go
 * through the Store; consumers subscribe via the state event stream. */
export class PRPoller {
  private store: Store
  private opts: PRPollerOptions
  private timer: NodeJS.Timeout | null = null
  private lastAllFetchAt = 0
  private lastFetchAtByPath = new Map<string, number>()
  // Global guard is fine as long as trackedFetch has a timeout — see
  // github-recorder.ts. If a stalled repo ever surfaces again despite
  // Fix 1+2+3 together, switch this to a per-repo Set.
  private inFlightAll = false
  /** A refreshAll arrived while one was in flight. The running pass may
   *  have read state (e.g. locallyMerged) from before the caller's change,
   *  so dropping the call would let that stale result stand until the
   *  next background tick — run once more when the current pass ends. */
  private rerunAll = false
  private inFlightAssigned = false
  private recheckTimer: NodeJS.Timeout | null = null

  constructor(store: Store, opts: PRPollerOptions) {
    this.store = store
    this.opts = opts
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.refreshAll()
      if (this.store.getSnapshot().state.settings.showAssignedPRs) {
        void this.refreshAssignedPRs()
      }
    }, POLL_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.recheckTimer) {
      clearTimeout(this.recheckTimer)
      this.recheckTimer = null
    }
  }

  /** Refresh every worktree across every known repo root.
   *
   * Two independent branches run in parallel:
   *   • GraphQL branch  — one chunked batched GraphQL call per repo,
   *     dispatches `prs/bulkStatusChanged`.
   *   • Merged-SHA branch — pure `git rev-parse` per persisted branch,
   *     dispatches `prs/mergedChanged`.
   *
   * The two used to be sequential inside one try, which meant a hung
   * GraphQL request stalled the git-only merged detection too — leaving
   * ~50 locally-merged worktrees stuck in "Active" while GitHub answered
   * 504s. Splitting them is what makes the sidebar recover even when
   * GitHub is unhappy.
   *
   * Network-failure handling (GraphQL branch): per-repo fetches are
   * tagged ok/failed. The new `byPath` map starts from the current
   * snapshot (restricted to worktrees that still exist), then successful
   * results overlay. Failed fetches preserve the previously-cached
   * status — so a wifi blip doesn't flip every worktree into the "no PR"
   * sidebar group. */
  async refreshAll(): Promise<void> {
    if (this.inFlightAll) {
      this.rerunAll = true
      return
    }
    const roots = this.opts.getRepoRoots()
    if (roots.length === 0) return
    this.inFlightAll = true
    this.store.dispatch({ type: 'prs/loadingChanged', payload: true })
    try {
      // Two-phase: raw (with null on per-repo failure) drives the
      // preserve-prior-on-failure merge for the store dispatch; the []-
      // normalized view is what the PR batch loop below consumes.
      const treesByRootRaw = await Promise.all(
        roots.map((r) => listWorktrees(r).catch(() => null))
      )
      const treesByRoot = treesByRootRaw.map((t) => t ?? [])
      const allWorktrees = treesByRoot.flat()
      const now = Date.now()
      this.lastAllFetchAt = now
      for (const wt of allWorktrees) this.lastFetchAtByPath.set(wt.path, now)

      // Coarse safety-net re-derive of the worktree branch list. listWorktrees
      // is a live `git worktree list --porcelain` read, so this picks up any
      // branch switch / rename / detached-HEAD / finished-rebase that happened
      // in a terminal since the last refresh — none of which fire the existing
      // refresh triggers. The branch-sync watcher handles the prompt updates;
      // this tick guarantees convergence even if a watcher failed to attach.
      // Deduped so an unchanged list doesn't churn the array reference.
      // A repo whose lookup threw preserves its previously-known worktrees
      // so a transient error doesn't blank the UI.
      const currentList = this.store.getSnapshot().state.worktrees.list
      const nextList = mergeWorktreesPreservingFailures(roots, treesByRootRaw, currentList)
      if (!worktreeListsEqual(currentList, nextList)) {
        this.store.dispatch({ type: 'worktrees/listChanged', payload: nextList })
      }

      // Kick off both branches in parallel. Each branch is self-contained
      // (own try/catch, own dispatch) so if one hangs or throws the other
      // still updates the store.
      await Promise.all([
        // Pass the preserved-failures list, not `allWorktrees`, so a repo
        // whose listWorktrees threw keeps its worktrees (and their cached
        // PR status) instead of being pruned on a transient error.
        this.refreshGraphQLBranch(nextList).catch((err) => {
          log('pr-poller', 'GraphQL branch failed', formatErr(err))
        }),
        this.refreshMergedShaBranch(roots, treesByRoot).catch((err) => {
          log('pr-poller', 'merged-SHA branch failed', formatErr(err))
        })
      ])
    } finally {
      this.inFlightAll = false
      this.store.dispatch({ type: 'prs/loadingChanged', payload: false })
      if (this.rerunAll) {
        this.rerunAll = false
        void this.refreshAll()
      }
    }
  }

  /** GitHub GraphQL side of a full refresh: per-repo batched PR lookup,
   *  followup-by-number for post-merge branch-deleted PRs, single
   *  `prs/bulkStatusChanged` dispatch. */
  private async refreshGraphQLBranch(allWorktrees: WorktreeInfo[]): Promise<void> {
    // Group worktrees by their originating repo root so each repo's
    // GraphQL batch can be issued in parallel.
    const worktreesByRoot = new Map<string, WorktreeInfo[]>()
    for (const wt of allWorktrees) {
      const list = worktreesByRoot.get(wt.repoRoot) ?? []
      list.push(wt)
      worktreesByRoot.set(wt.repoRoot, list)
    }
    const roots = [...worktreesByRoot.keys()]

    // Per-repo: resolve origin/upstream context, then make one chunked
    // GraphQL call carrying every worktree's branch. ok=false means a
    // transport failure — every worktree in that repo will preserve its
    // cached status.
    type RepoBatch =
      | { root: string; ok: true; statuses: Map<string, PRStatus | null> }
      | { root: string; ok: false }
    const repoBatches: RepoBatch[] = await Promise.all(
      roots.map(async (root): Promise<RepoBatch> => {
        const wts = worktreesByRoot.get(root) ?? []
        try {
          const ctx = await getRepoContext(root)
          if (!ctx) {
            const empty = new Map<string, PRStatus | null>()
            for (const wt of wts) empty.set(wt.path, null)
            return { root, ok: true, statuses: empty }
          }
          const requests: PRStatusRequest[] = wts.map((wt) => ({
            worktreePath: wt.path,
            branch: wt.branch,
            headSha: wt.head
          }))
          const statuses = await fetchPRStatusesForRepo(ctx, requests)
          return { root, ok: true, statuses }
        } catch (err) {
          log('pr-poller', `PR batch failed for ${root}`, formatErr(err))
          return { root, ok: false }
        }
      })
    )

    const currentByPath = this.store.getSnapshot().state.prs.byPath
    const allowedPaths = new Set(allWorktrees.map((wt) => wt.path))
    const newByPath: Record<string, PRStatus | null> = {}
    for (const path of Object.keys(currentByPath)) {
      if (allowedPaths.has(path)) newByPath[path] = currentByPath[path]
    }
    for (const batch of repoBatches) {
      if (!batch.ok) continue
      for (const [path, status] of batch.statuses) {
        newByPath[path] = status
      }
    }

    // Branch-name lookup goes blind on a PR whose head branch was
    // deleted post-merge: the per-branch GraphQL hit returns nothing
    // and the worktree would slide into "Active". Look those up by
    // their previously-known PR number so the terminal state sticks.
    type Followup = { path: string; root: string; branch: string; prNumber: number }
    const followups: Followup[] = []
    for (const wt of allWorktrees) {
      const prev = currentByPath[wt.path]
      const next = newByPath[wt.path]
      if (
        prev &&
        next === null &&
        prev.state !== 'merged' &&
        prev.state !== 'closed'
      ) {
        followups.push({
          path: wt.path,
          root: wt.repoRoot,
          branch: wt.branch,
          prNumber: prev.number
        })
      }
    }
    if (followups.length > 0) {
      const ctxByRoot = new Map<string, RepoContext | null>()
      await Promise.all(
        Array.from(new Set(followups.map((f) => f.root))).map(async (root) => {
          ctxByRoot.set(root, await getRepoContext(root).catch(() => null))
        })
      )
      const followupResults = await Promise.all(
        followups.map(async (f) => {
          const ctx = ctxByRoot.get(f.root)
          if (!ctx) return { path: f.path, status: null as PRStatus | null }
          try {
            const status = await fetchPRStatusByNumber(ctx, f.prNumber, f.path, f.branch)
            return { path: f.path, status }
          } catch (err) {
            log('pr-poller', `followup PR #${f.prNumber} failed for ${f.path}`, formatErr(err))
            return { path: f.path, status: null }
          }
        })
      )
      for (const r of followupResults) {
        if (r.status && (r.status.state === 'merged' || r.status.state === 'closed')) {
          newByPath[r.path] = r.status
        }
      }
    }
    const { byPath: reconciled, rechecks } = reconcileUnknownMergeable(
      currentByPath,
      newByPath,
      allWorktrees
    )
    this.store.dispatch({
      type: 'prs/bulkStatusChanged',
      payload: reconciled
    })
    this.scheduleMergeableRecheck(rechecks)
  }

  /** Queue one deferred re-query round for PRs GitHub reported as UNKNOWN.
   *  Deliberately not awaited by `refreshAll` — holding `prs.loading` true
   *  for the delay would just spin the sidebar spinner longer. */
  private scheduleMergeableRecheck(rechecks: MergeableRecheck[]): void {
    if (rechecks.length === 0) return
    if (this.recheckTimer) clearTimeout(this.recheckTimer)
    const capped = rechecks.slice(0, MERGEABLE_RECHECK_MAX)
    this.recheckTimer = setTimeout(() => {
      this.recheckTimer = null
      void this.runMergeableRecheck(capped)
    }, MERGEABLE_RECHECK_DELAY_MS)
  }

  /** One re-query round, no retry loop. A PR still UNKNOWN keeps whatever
   *  `reconcileUnknownMergeable` carried forward and waits for the next
   *  poll. Only `hasConflict` is patched onto the cached status:
   *  `fetchPRStatusByNumber` doesn't compute `behindBy`, so replacing the
   *  status wholesale would blank the "N commits behind" indicator. */
  private async runMergeableRecheck(rechecks: MergeableRecheck[]): Promise<void> {
    try {
      const ctxByRoot = new Map<string, RepoContext | null>()
      await Promise.all(
        Array.from(new Set(rechecks.map((r) => r.root))).map(async (root) => {
          ctxByRoot.set(root, await getRepoContext(root).catch(() => null))
        })
      )
      const results = await Promise.all(
        rechecks.map(async (r) => {
          const ctx = ctxByRoot.get(r.root)
          if (!ctx) return null
          return await fetchPRStatusByNumber(ctx, r.prNumber, r.path, r.branch).catch((err) => {
            log('pr-poller', `mergeable recheck #${r.prNumber} failed for ${r.path}`, formatErr(err))
            return null
          })
        })
      )
      for (let i = 0; i < rechecks.length; i++) {
        const fresh = results[i]
        if (!fresh || fresh.hasConflict === null) continue
        const path = rechecks[i].path
        const current = this.store.getSnapshot().state.prs.byPath[path]
        // The worktree may have been removed, or moved on to a different
        // PR / commit, while the recheck was in flight.
        if (!current || current.number !== fresh.number) continue
        if (current.headSha !== fresh.headSha) continue
        if (current.hasConflict === fresh.hasConflict) continue
        this.store.dispatch({
          type: 'prs/statusChanged',
          payload: { path, status: { ...current, hasConflict: fresh.hasConflict } }
        })
      }
    } catch (err) {
      log('pr-poller', 'mergeable recheck round failed', formatErr(err))
    }
  }

  /** Local-git side of a full refresh: `git rev-parse` per worktree
   *  branch with a recorded merge SHA. Zero GitHub dependency — used to
   *  block behind the GraphQL branch (bug: a hung GraphQL request left
   *  every locally-merged worktree stuck in "Active" indefinitely).
   *  Prunes stale entries from the persisted map. Dispatches
   *  `prs/mergedChanged`. */
  private async refreshMergedShaBranch(
    roots: string[],
    treesByRoot: WorktreeInfo[][]
  ): Promise<void> {
    // Two passes: collect the worktrees that need a `git rev-parse`
    // lookup, fire them all in parallel, then walk results. The
    // serial-await version stalled boot by ~30ms × N at typical worktree
    // counts.
    const persisted = this.opts.getLocallyMerged()
    const mergedAll: Record<string, boolean> = {}
    const pruned: Array<{ branch: string; recordedSha: string }> = []
    type ShaJob = { root: string; path: string; branch: string; recordedSha: string }
    const shaJobs: ShaJob[] = []
    for (let i = 0; i < roots.length; i++) {
      const root = roots[i]
      const trees = treesByRoot[i]
      for (const wt of trees) {
        if (wt.isMain) continue
        if (!isOnRealBranch(wt.branch)) continue
        const recordedSha = persisted[wt.branch]
        if (!recordedSha) {
          mergedAll[wt.path] = false
          continue
        }
        shaJobs.push({ root, path: wt.path, branch: wt.branch, recordedSha })
      }
    }
    const shaResults = await Promise.all(
      shaJobs.map((j) => getBranchSha(j.root, j.branch).catch(() => null))
    )
    for (let k = 0; k < shaJobs.length; k++) {
      const job = shaJobs[k]
      const branchSha = shaResults[k]
      if (branchSha && branchSha === job.recordedSha) {
        mergedAll[job.path] = true
      } else {
        pruned.push({ branch: job.branch, recordedSha: job.recordedSha })
        mergedAll[job.path] = false
      }
    }
    if (pruned.length > 0) {
      // Prune against a fresh read, not the snapshot taken before the
      // rev-parse round: a merge can record a SHA while we await, and
      // writing the old snapshot back would erase it.
      const next = { ...this.opts.getLocallyMerged() }
      let changed = false
      for (const { branch, recordedSha } of pruned) {
        if (next[branch] === recordedSha) {
          delete next[branch]
          changed = true
        }
      }
      if (changed) this.opts.setLocallyMerged(next)
    }
    this.store.dispatch({ type: 'prs/mergedChanged', payload: mergedAll })
  }

  /** Refresh a single worktree's PR status. Used when a Claude terminal
   * reaches the "waiting" state (likely just pushed) or when the user
   * activates a stale worktree.
   *
   * One GraphQL call against the worktree's branch — no list-then-match. */
  async refreshOne(wtPath: string): Promise<void> {
    try {
      const wt = this.store
        .getSnapshot()
        .state.worktrees.list.find((w) => w.path === wtPath)
      if (!wt) return
      const ctx = await getRepoContext(wt.repoRoot)
      let status: PRStatus | null = null
      if (ctx) {
        const statuses = await fetchPRStatusesForRepo(ctx, [
          { worktreePath: wt.path, branch: wt.branch, headSha: wt.head }
        ])
        status = statuses.get(wt.path) ?? null
        if (!status) {
          const prev = this.store.getSnapshot().state.prs.byPath[wtPath]
          if (prev && prev.state !== 'merged' && prev.state !== 'closed') {
            const followup = await fetchPRStatusByNumber(ctx, prev.number, wt.path, wt.branch).catch(() => null)
            if (followup && (followup.state === 'merged' || followup.state === 'closed')) {
              status = followup
            }
          }
        }
      }
      this.lastFetchAtByPath.set(wtPath, Date.now())
      const { byPath, rechecks } = reconcileUnknownMergeable(
        this.store.getSnapshot().state.prs.byPath,
        { [wtPath]: status },
        [wt]
      )
      this.store.dispatch({
        type: 'prs/statusChanged',
        payload: { path: wtPath, status: byPath[wtPath] }
      })
      this.scheduleMergeableRecheck(rechecks)
    } catch (err) {
      log('pr-poller', `refreshOne failed for ${wtPath}`, formatErr(err))
    }
  }

  refreshOneIfStale(wtPath: string): void {
    const last = this.lastFetchAtByPath.get(wtPath) ?? 0
    if (Date.now() - last > STALE_WINDOW_MS) {
      void this.refreshOne(wtPath)
    }
  }

  /** Refresh all only if the last full refresh was more than STALE_WINDOW_MS
   * ago. Used on window focus so rapid alt-tabbing doesn't hammer GitHub. */
  refreshAllIfStale(): void {
    if (Date.now() - this.lastAllFetchAt > STALE_WINDOW_MS) {
      void this.refreshAll()
    }
    if (this.store.getSnapshot().state.settings.showAssignedPRs) {
      void this.refreshAssignedPRs()
    }
  }

  /** Fetch PRs where the viewer is a requested reviewer, scoped to the
   *  upstream repos of every Ness-added repo. Populates the
   *  `assignedPRs` slice. Guarded to skip when the setting is off; the
   *  IPC handler that toggles the setting on kicks a refresh explicitly. */
  async refreshAssignedPRs(): Promise<void> {
    if (this.inFlightAssigned) return
    if (!this.store.getSnapshot().state.settings.showAssignedPRs) return
    const roots = this.opts.getRepoRoots()
    if (roots.length === 0) {
      this.store.dispatch({
        type: 'assignedPRs/dataUpdated',
        payload: { byRepo: {}, fetchedAt: Date.now() }
      })
      return
    }
    this.inFlightAssigned = true
    this.store.dispatch({ type: 'assignedPRs/loadingChanged', payload: true })
    try {
      // Look up the upstream repo (owner/name) for each root — that's what
      // GitHub's search API returns and what we match on to bucket
      // results back to `repoRoot`. Roots without a resolvable upstream
      // are skipped (e.g. non-github remotes, missing origin).
      const lookups: AssignedPRsRepoLookup[] = []
      await Promise.all(
        roots.map(async (root) => {
          const trees = await listWorktrees(root).catch(() => [])
          const main = trees.find((t) => t.isMain) ?? trees[0]
          const probePath = main?.path ?? root
          const ctx = await getRepoContext(probePath).catch(() => null)
          if (!ctx) return
          lookups.push({
            repoRoot: root,
            nameWithOwner: `${ctx.upstream.owner}/${ctx.upstream.repo}`
          })
        })
      )
      if (lookups.length === 0) {
        this.store.dispatch({
          type: 'assignedPRs/dataUpdated',
          payload: { byRepo: {}, fetchedAt: Date.now() }
        })
        return
      }
      const summaries = await fetchAssignedPRs(lookups)
      const byRepo: Record<string, AssignedPR[]> = {}
      for (const [repoRoot, prs] of summaries) {
        byRepo[repoRoot] = prs.map((p) => ({
          number: p.number,
          title: p.title,
          url: p.url,
          branch: p.branch,
          repoRoot: p.repoRoot,
          repoNameWithOwner: p.repoNameWithOwner,
          author: p.author,
          isDraft: p.isDraft,
          updatedAt: p.updatedAt
        }))
      }
      this.store.dispatch({
        type: 'assignedPRs/dataUpdated',
        payload: { byRepo, fetchedAt: Date.now() }
      })
    } catch (err) {
      log('pr-poller', 'refreshAssignedPRs failed', formatErr(err))
    } finally {
      this.inFlightAssigned = false
      this.store.dispatch({ type: 'assignedPRs/loadingChanged', payload: false })
    }
  }

  clearAssignedPRs(): void {
    this.store.dispatch({ type: 'assignedPRs/cleared' })
  }
}
