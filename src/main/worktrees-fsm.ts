import {
  addWorktree,
  defaultWorktreeDir,
  fetchPullRequestRef,
  listWorktrees,
  localBranchExists,
  runWorktreeScript,
  type WorktreeInfo
} from './worktree'
import { getPRMetadata } from './github'
import { loadRepoConfig } from './repo-config'
import { log } from './debug'
import type { Store } from './store'
import {
  mergeWorktreesPreservingFailures,
  worktreeListsEqual,
  type Worktree,
  type PendingWorktree,
  type ForkSource
} from '../shared/state/worktrees'
import type { AgentKind } from '../shared/state/terminals'
import { slugifyPromptToBranch, withAutoNameInstruction } from '../shared/auto-name'
import { existsSync } from 'fs'
import { join } from 'path'

/** Sanitize a PR's head branch into a name that's safe as both a git
 *  branch (we're not strict here since git accepts most things) and a
 *  filesystem path component. Slashes survive — git accepts them and
 *  `git worktree add` is happy to nest dirs the same way fresh-start
 *  worktrees do for branches like `feature/foo`. */
export function sanitizeHeadBranchForLocal(headBranch: string): string {
  const cleaned = headBranch
    .replace(/[~^:?*\[\]\\\x00-\x1f\x7f]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/@\{/g, '')
    .replace(/^[-.]+|[-.]+$/g, '')
  return cleaned
}

/** Pick a local branch name for a PR's head. Prefers the upstream head
 *  ref directly so the PR poller's ref-match logic just works; falls
 *  back to a `<head>-pr-<N>` suffix when a local branch with that name
 *  already exists (e.g. the user has their own work on that ref). */
export async function chooseLocalPRBranchName(
  repoRoot: string,
  headBranch: string,
  prNumber: number
): Promise<string> {
  const sanitized = sanitizeHeadBranchForLocal(headBranch)
  const candidate = sanitized || `pr-${prNumber}`
  if (await localBranchExists(repoRoot, candidate)) {
    return `${candidate}-pr-${prNumber}`
  }
  return candidate
}

/** Give up appending numeric suffixes after this many collisions and let
 *  git report whatever it reports. 50 worktrees off one prompt slug means
 *  something else is wrong. */
const MAX_AUTO_NAME_ATTEMPTS = 50

/** Pick a provisional branch name from a kickoff prompt that collides with
 *  neither an existing branch nor an existing worktree directory. Exported
 *  for the reducer tests; callers should go through `runPending`. */
export async function pickAutoBranchName(
  repoRoot: string,
  worktreeDir: string,
  prompt: string
): Promise<string> {
  const base = slugifyPromptToBranch(prompt)
  for (let n = 1; n <= MAX_AUTO_NAME_ATTEMPTS; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`
    // Both checks matter: the branch may exist without a worktree (deleted
    // worktree, stale ref) and the directory may exist without a branch
    // (a failed create that left the folder behind).
    if (existsSync(join(worktreeDir, candidate))) continue
    if (await localBranchExists(repoRoot, candidate)) continue
    return candidate
  }
  return `${base}-${MAX_AUTO_NAME_ATTEMPTS + 1}`
}

export type PendingOutcome =
  | { id: string; outcome: 'success'; createdPath: string }
  | { id: string; outcome: 'setup-failed'; createdPath: string }
  | { id: string; outcome: 'error'; error: string }

interface WorktreesFSMOptions {
  getRepoRoots: () => string[]
  getWorktreeSetupCmd: () => string
  getWorktreeBaseMode: () => 'remote' | 'local'
  /** Called after a worktree has been created on disk (and its setup
   * script has run, regardless of script outcome). The host wires this
   * to (a) PR poller refresh and (b) PanesFSM.ensureInitialized so the
   * default Claude+Shell pair is created with the initial prompt. */
  onWorktreeCreated: (params: {
    createdPath: string
    initialPrompt?: string
    teleportSessionId?: string
    agentKind?: AgentKind
    model?: string
    forkSource?: ForkSource
    /** The ref the new branch was cut from, when the caller specified one.
     *  Only used to explain provenance in the fork relocation preamble. */
    baseRef?: string
  }) => void | Promise<void>
}

/** How long `refreshListDebounced` waits after the last call before
 *  firing. Long enough to coalesce a bulk deletion of 30+ worktrees
 *  into one list refresh, short enough that the sidebar still feels
 *  live on interactive one-off deletions. */
const REFRESH_LIST_DEBOUNCE_MS = 250

/** Owns the pending-creation state machine plus the "refresh the flat
 * worktree list across every known repo" operation. All writes go through
 * the Store. Designed so the renderer awaits `runPending(…)` end-to-end;
 * in-progress status transitions are visible via the usual state events. */
export class WorktreesFSM {
  private store: Store
  private opts: WorktreesFSMOptions
  private refreshDebounceTimer: ReturnType<typeof setTimeout> | null = null

  constructor(store: Store, opts: WorktreesFSMOptions) {
    this.store = store
    this.opts = opts
  }

  /** Walk all known repos, list worktrees, flatten, and dispatch
   * worktrees/listChanged. Safe to call repeatedly. A repo whose lookup
   * throws (transient FS error, network drive glitch) preserves its
   * previously-known worktrees so the UI doesn't flicker — successful
   * results still replace their repo's slice, so deletions propagate. */
  async refreshList(): Promise<Worktree[]> {
    const roots = this.opts.getRepoRoots()
    const perRoot = await Promise.all(
      roots.map((r) =>
        listWorktrees(r).catch((err) => {
          log('worktrees-fsm', `listWorktrees failed for ${r}`, err instanceof Error ? err.message : err)
          return null
        })
      )
    )
    const previous = this.store.getSnapshot().state.worktrees.list
    const flat = mergeWorktreesPreservingFailures(roots, perRoot, previous)
    this.applyList(flat)
    return flat
  }

  /** Trailing-debounced variant of `refreshList`. Multiple back-to-back
   *  callers (e.g. a bulk deletion of 30 worktrees) coalesce into a
   *  single refresh once the batch settles — the naive per-completion
   *  `refreshList()` would otherwise spawn `git worktree list --porcelain`
   *  once per repo per deletion. Fire-and-forget; errors surface via
   *  the underlying `refreshList` logging path. */
  refreshListDebounced(): void {
    if (this.refreshDebounceTimer) clearTimeout(this.refreshDebounceTimer)
    this.refreshDebounceTimer = setTimeout(() => {
      this.refreshDebounceTimer = null
      void this.refreshList()
    }, REFRESH_LIST_DEBOUNCE_MS)
  }

  /** Replace the flat worktree list, but only dispatch when it actually
   * differs from what's in the store. Lets the PR poller and the branch
   * watcher re-derive branch labels on a tick / fs event without churning
   * the array reference (and re-rendering the world) when nothing moved.
   * Returns whether a dispatch was emitted. */
  applyList(flat: Worktree[]): boolean {
    const current = this.store.getSnapshot().state.worktrees.list
    if (worktreeListsEqual(current, flat)) return false
    this.store.dispatch({ type: 'worktrees/listChanged', payload: flat })
    return true
  }

  dispatchRepos(roots: string[]): void {
    this.store.dispatch({ type: 'worktrees/reposChanged', payload: roots })
  }

  /** Drive the creation FSM to completion. Dispatches state transitions as
   * it goes so the pending screens stay live, and resolves with a terminal
   * outcome that the renderer uses to route focus. The initialPrompt /
   * teleportSessionId are carried through to onWorktreeCreated so the
   * panes layer can embed them in the new Claude tab — the renderer
   * never has to stage them locally. */
  async runPending(params: {
    id: string
    repoRoot: string
    branchName: string
    initialPrompt?: string
    teleportSessionId?: string
    agentKind?: AgentKind
    model?: string
    /** When set, the new worktree's first agent tab resumes a copy of this
     *  session's conversation instead of starting empty. */
    forkSource?: ForkSource
    /** When set, check out an existing branch instead of creating one
     * with `-b`. Used when the user picks from the existing-branches
     * dropdown — git resolves names like `origin/foo` to a local
     * tracking branch correctly, whereas `-b origin/foo` would create
     * a literally-named local branch. */
    checkoutExisting?: boolean
    /** When set (the "Any Git Ref" tab), the new branch `branchName` is
     * forked from this ref via `git worktree add -b <branchName> <baseRef>`
     * instead of from the repo's default base. */
    baseRef?: string
  }): Promise<PendingOutcome> {
    const { id, repoRoot, teleportSessionId, agentKind, model, forkSource, checkoutExisting, baseRef } = params
    const wtDir = defaultWorktreeDir(repoRoot)

    // Auto-name: an empty branchName means "you name it" — the default path
    // from the New worktree screen, where the user types only a prompt. Ness
    // slugs a provisional name (it needs one before `git worktree add`), and
    // the kickoff prompt carries an instruction telling the agent to replace
    // it via the rename_worktree MCP tool once it has read the task.
    let branchName = params.branchName
    let initialPrompt = params.initialPrompt
    if (!branchName) {
      if (!initialPrompt?.trim()) {
        const error = 'a branch name or a kickoff prompt is required'
        this.store.dispatch({
          type: 'worktrees/pendingAdded',
          payload: { id, repoRoot, branchName: '', status: 'error', error }
        })
        return { id, outcome: 'error', error }
      }
      branchName = await pickAutoBranchName(repoRoot, wtDir, initialPrompt)
      initialPrompt = withAutoNameInstruction(initialPrompt)
    }

    const pending: PendingWorktree = {
      id,
      repoRoot,
      branchName,
      status: 'creating',
      initialPrompt,
      teleportSessionId,
      forkSource
    }
    this.store.dispatch({ type: 'worktrees/pendingAdded', payload: pending })

    try {
      const mode = this.opts.getWorktreeBaseMode()
      const created = await addWorktree(repoRoot, wtDir, branchName, {
        // An explicit baseRef (Ref tab) wins over default-base resolution,
        // so skip the remote fetch when one is supplied.
        fetchRemote: mode === 'remote' && !baseRef,
        checkoutExisting,
        baseBranch: baseRef
      })
      return await this.finishCreate({
        id,
        repoRoot,
        created,
        initialPrompt,
        teleportSessionId,
        agentKind,
        model,
        forkSource,
        baseRef
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.store.dispatch({
        type: 'worktrees/pendingUpdated',
        payload: { id, patch: { status: 'error', error: message } }
      })
      return { id, outcome: 'error', error: message }
    }
  }

  /** Open someone else's PR as a worktree. Fetches the PR head into a
   * local branch named after the PR's actual head ref (or `<head>-pr-<N>`
   * if that name is taken locally), so the PR poller's ref-match logic
   * just works — no per-worktree marker needed. */
  async runPendingPR(params: {
    id: string
    repoRoot: string
    prNumber: number
    initialPrompt?: string
    agentKind?: AgentKind
    model?: string
  }): Promise<PendingOutcome> {
    const { id, repoRoot, prNumber, initialPrompt, agentKind, model } = params
    // Show *something* while we go ask GitHub for the head ref name.
    let branchName = `pr-${prNumber}`
    const pending: PendingWorktree = {
      id,
      repoRoot,
      branchName,
      status: 'creating',
      initialPrompt
    }
    this.store.dispatch({ type: 'worktrees/pendingAdded', payload: pending })

    try {
      const meta = await getPRMetadata(repoRoot, prNumber)
      if (!meta) throw new Error(`Couldn't fetch PR #${prNumber} from GitHub`)

      branchName = await chooseLocalPRBranchName(repoRoot, meta.headBranch, prNumber)
      if (branchName !== pending.branchName) {
        this.store.dispatch({
          type: 'worktrees/pendingUpdated',
          payload: { id, patch: { branchName } }
        })
      }

      await fetchPullRequestRef(repoRoot, prNumber, branchName)

      const wtDir = defaultWorktreeDir(repoRoot)
      const created = await addWorktree(repoRoot, wtDir, branchName, {
        checkoutExisting: true
      })

      return await this.finishCreate({
        id,
        repoRoot,
        created,
        initialPrompt,
        agentKind,
        model
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.store.dispatch({
        type: 'worktrees/pendingUpdated',
        payload: { id, patch: { status: 'error', error: message } }
      })
      return { id, outcome: 'error', error: message }
    }
  }

  /** Shared post-creation steps: setup script + onWorktreeCreated
   * callback + refreshList + final pending outcome. */
  private async finishCreate(args: {
    id: string
    repoRoot: string
    created: WorktreeInfo
    initialPrompt?: string
    teleportSessionId?: string
    agentKind?: AgentKind
    model?: string
    forkSource?: ForkSource
    baseRef?: string
  }): Promise<PendingOutcome> {
    const { id, repoRoot, created, initialPrompt, teleportSessionId, agentKind, model, forkSource, baseRef } = args

    // Publish the path as soon as it exists on disk. `git worktree add` has
    // already made it visible to `git worktree list`, so any list refresh
    // from here on would otherwise let the generic pane sweep initialize it
    // before onWorktreeCreated gets to seed the first tab.
    this.store.dispatch({
      type: 'worktrees/pendingUpdated',
      payload: { id, patch: { createdPath: created.path } }
    })

    // Claim the path before the setup script runs. `git worktree list`
    // already reports it, so any refreshList in the meantime would let
    // main's listChanged sweep init panes for it — without the prompt,
    // agent kind or model, and the ensureInitialized below would then
    // find a tree and bail. The sweep skips claimed paths.
    this.store.dispatch({
      type: 'worktrees/pendingUpdated',
      payload: { id, patch: { createdPath: created.path } }
    })

    const setupCmd = this.resolveSetupCmd(repoRoot)
    let setupFailed = false
    if (setupCmd) {
      this.store.dispatch({
        type: 'worktrees/pendingUpdated',
        payload: { id, patch: { status: 'setup', setupLog: '' } }
      })
      let buffered = ''
      const result = await runWorktreeScript(
        'setup',
        setupCmd,
        { worktreePath: created.path, branch: created.branch, repoRoot },
        (_stream, chunk) => {
          buffered += chunk
          this.store.dispatch({
            type: 'worktrees/pendingUpdated',
            payload: { id, patch: { setupLog: buffered } }
          })
        }
      )
      setupFailed = !result.ok
      this.store.dispatch({
        type: 'worktrees/pendingUpdated',
        payload: { id, patch: { setupExitCode: result.exitCode } }
      })
    }

    // Awaited: a conversation fork has to copy the transcript and probe git
    // for the relocation preamble before the first agent tab spawns.
    await this.opts.onWorktreeCreated({
      createdPath: created.path,
      initialPrompt,
      teleportSessionId,
      agentKind,
      model,
      forkSource,
      baseRef
    })
    await this.refreshList()

    if (setupFailed) {
      this.store.dispatch({
        type: 'worktrees/pendingUpdated',
        payload: { id, patch: { status: 'setup-failed', createdPath: created.path } }
      })
      return { id, outcome: 'setup-failed', createdPath: created.path }
    }

    this.store.dispatch({ type: 'worktrees/pendingRemoved', payload: id })
    return { id, outcome: 'success', createdPath: created.path }
  }

  /** Post-creation work for externally-created worktrees (e.g. the MCP
   * create_worktree tool): run the setup script. */
  async runWorktreeSetup(ctx: { repoRoot: string; worktreePath: string; branch: string }): Promise<void> {
    const setupCmd = this.resolveSetupCmd(ctx.repoRoot)
    if (!setupCmd) return
    await runWorktreeScript('setup', setupCmd, {
      worktreePath: ctx.worktreePath,
      branch: ctx.branch,
      repoRoot: ctx.repoRoot
    })
  }

  private resolveSetupCmd(repoRoot: string): string {
    const repoCfg = loadRepoConfig(repoRoot)
    return repoCfg.setupCommand || this.opts.getWorktreeSetupCmd() || ''
  }

  async retryPending(id: string): Promise<PendingOutcome> {
    const current = this.store
      .getSnapshot()
      .state.worktrees.pending.find((p) => p.id === id)
    if (!current) {
      return { id, outcome: 'error', error: 'Pending entry not found' }
    }
    // Clear the terminal-state flags so status transitions look right.
    this.store.dispatch({
      type: 'worktrees/pendingUpdated',
      payload: {
        id,
        patch: { status: 'creating', error: undefined, setupLog: undefined, setupExitCode: undefined, createdPath: undefined }
      }
    })
    // Re-run. Note: if the worktree was already created on disk the first
    // time, addWorktree will error — the user should dismiss+recreate in
    // that case. We preserve the existing behavior (retry was already
    // fragile in the old renderer code).
    return this.runPending({
      id,
      repoRoot: current.repoRoot,
      branchName: current.branchName,
      initialPrompt: current.initialPrompt,
      teleportSessionId: current.teleportSessionId,
      forkSource: current.forkSource
    })
  }

  dismissPending(id: string): void {
    this.store.dispatch({ type: 'worktrees/pendingRemoved', payload: id })
  }
}
