import { existsSync } from 'node:fs'
import { pruneWorktrees, removeWorktree, runWorktreeScript, unlockWorktree } from './worktree'
import {
  deleteWorktreeDirectory,
  isSameVolume,
  moveWorktreeToTrash,
  scheduleTrashUnlink,
  worktreeTrashDir
} from './worktree-trash'
import { loadRepoConfig } from './repo-config'
import { log } from './debug'
import type { Store } from './store'
import type { WorktreesFSM } from './worktrees-fsm'
import type { PendingDeletion } from '../shared/state/worktrees'

interface WorktreeDeletionFSMOptions {
  getGlobalTeardownCmd: () => string
  worktreesFSM: WorktreesFSM
}

/** Owns the pending-deletion state machine. Each enqueue runs independently
 * (parallel deletions are fine — they touch disjoint paths), streams
 * teardown script output into the store, and refreshes the worktree list
 * on completion. Lives entirely in main so deletions keep running if the
 * user navigates away; the renderer just reads state.
 *
 * Fast path: on the common same-volume case we rename the worktree dir
 * into `userData/worktree-trash/<uuid>` (an O(1) APFS metadata op),
 * clean up git's bookkeeping via `git worktree prune`, dispatch the
 * "gone" event, and unlink in the background. The user's cleanup screen
 * empties in ~one render regardless of how many gigabytes of
 * node_modules the worktree held. Cross-volume worktrees fall back to
 * the historical `git worktree remove` slow path.
 *
 * Teardown scripts run BEFORE the rename because they may reference the
 * worktree in place (e.g. `docker compose -f $WORKTREE_PATH/... down`). */
export class WorktreeDeletionFSM {
  private store: Store
  private opts: WorktreeDeletionFSMOptions

  constructor(store: Store, opts: WorktreeDeletionFSMOptions) {
    this.store = store
    this.opts = opts
  }

  /** Kick off a deletion. Returns immediately after seeding the pending
   * entry; the actual work runs in the background. */
  enqueue(params: {
    repoRoot: string
    path: string
    branch: string
    force?: boolean
    locked?: boolean
    lockedReason?: string
    overrideLock?: boolean
  }): void {
    void this.run(params)
  }

  dismiss(path: string): void {
    this.store.dispatch({ type: 'worktrees/pendingDeletionRemoved', payload: path })
  }

  private async run(params: {
    repoRoot: string
    path: string
    branch: string
    force?: boolean
    locked?: boolean
    lockedReason?: string
    overrideLock?: boolean
  }): Promise<void> {
    const { repoRoot, path, branch, force, locked, lockedReason, overrideLock } = params
    const repoCfg = loadRepoConfig(repoRoot)
    const teardownCmd = repoCfg.teardownCommand || this.opts.getGlobalTeardownCmd() || ''
    const hasTeardown = Boolean(teardownCmd.trim())

    const initial: PendingDeletion = {
      path,
      repoRoot,
      branch,
      phase: hasTeardown ? 'running-teardown' : 'removing-worktree',
      teardownLog: hasTeardown ? '' : undefined
    }
    this.store.dispatch({ type: 'worktrees/pendingDeletionStarted', payload: initial })

    try {
      // A locked worktree whose directory still exists was locked on
      // purpose (usually by another Claude session), so it takes an
      // explicit override. Checked before teardown so a refusal doesn't
      // half-dismantle it. A missing directory has nothing left to
      // protect — removeWorktree/pruneWorktrees clear those on their own.
      if (locked && existsSync(path)) {
        if (!overrideLock) {
          throw new Error(
            `The worktree is locked${lockedReason ? ` (${lockedReason})` : ''}. ` +
              'Unlock it with `git worktree unlock`, or delete it again from the sidebar and confirm the force remove.'
          )
        }
        await unlockWorktree(repoRoot, path)
      }

      if (hasTeardown) {
        let buffered = ''
        const result = await runWorktreeScript(
          'teardown',
          teardownCmd,
          { worktreePath: path, branch, repoRoot },
          (_stream, chunk) => {
            buffered += chunk
            this.store.dispatch({
              type: 'worktrees/pendingDeletionUpdated',
              payload: { path, patch: { teardownLog: buffered } }
            })
          }
        )
        this.store.dispatch({
          type: 'worktrees/pendingDeletionUpdated',
          payload: { path, patch: { teardownExitCode: result.exitCode } }
        })
        // Teardown failure is non-fatal — we still want to remove the
        // worktree, matching the previous synchronous behavior.
      }

      this.store.dispatch({
        type: 'worktrees/pendingDeletionUpdated',
        payload: { path, patch: { phase: 'removing-worktree' } }
      })

      // Fast path: same-volume rename into the trash, prune git's
      // bookkeeping, background-unlink. `isSameVolume` returns false
      // if either stat throws (e.g. path is already gone) — the fast
      // path is skipped in that case, which is what we want.
      // Locked worktrees were unlocked above, which matters here too:
      // `git worktree prune` skips locked entries, so renaming a locked
      // dir out would leave a ghost entry behind.
      if (isSameVolume(path, worktreeTrashDir())) {
        const trashPath = await moveWorktreeToTrash(path)
        await pruneWorktrees(repoRoot)
        this.store.dispatch({ type: 'worktrees/pendingDeletionRemoved', payload: path })
        this.opts.worktreesFSM.refreshListDebounced()
        scheduleTrashUnlink(trashPath)
        return
      }

      log('worktree-deletion-fsm', `cross-volume fallback for ${path} — using slow git worktree remove`)
      try {
        await removeWorktree(repoRoot, path, force)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (!/working trees containing submodules cannot be moved or removed/i.test(message)) {
          throw err
        }
        log('worktree-deletion-fsm', `removing submodule worktree directory directly: ${path}`)
        await deleteWorktreeDirectory(path)
        await pruneWorktrees(repoRoot)
      }
      this.store.dispatch({ type: 'worktrees/pendingDeletionRemoved', payload: path })
      this.opts.worktreesFSM.refreshListDebounced()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log('worktree-deletion-fsm', `deletion failed for ${path}: ${message}`)
      this.store.dispatch({
        type: 'worktrees/pendingDeletionUpdated',
        payload: { path, patch: { phase: 'failed', error: message } }
      })
    }
  }
}
