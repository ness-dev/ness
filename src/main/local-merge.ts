import type { MainWorktreeStatus, MergeLocalResult, MergeStrategy } from './worktree'
import type { StateEvent } from '../shared/state'

export interface LocalMergeDeps {
  dispatch: (event: StateEvent) => void
  getCurrentBranch: (worktreePath: string) => Promise<string | null>
  mergeWorktreeLocally: (
    repoRoot: string,
    branch: string,
    strategy: MergeStrategy
  ) => Promise<MergeLocalResult>
  prepareMainForMerge: (repoRoot: string) => Promise<MainWorktreeStatus>
  getBranchSha: (repoRoot: string, branch: string) => Promise<string | null>
  /** Persist `branch` as merged at `sha` (config.locallyMerged). */
  recordLocallyMerged: (branch: string, sha: string) => void
  refreshAll: () => void
}

/** The "Merge Locally" operations that write to a repo's main worktree.
 *
 * Both run in that one checkout, so two at once (a double click, a second
 * client, another worktree's panel) would fight over the same index: one
 * operation per repo, the rest refused up front. */
export function createLocalMergeOps(deps: LocalMergeDeps): {
  prepareMain: (repoRoot: string) => Promise<MainWorktreeStatus>
  mergeLocal: (
    repoRoot: string,
    sourceBranch: string,
    strategy: MergeStrategy,
    worktreePath?: string
  ) => Promise<MergeLocalResult>
} {
  const busyRepos = new Set<string>()

  function claim(repoRoot: string): void {
    if (busyRepos.has(repoRoot)) {
      throw new Error('Another merge operation on this repo is in progress.')
    }
    busyRepos.add(repoRoot)
  }

  return {
    async prepareMain(repoRoot) {
      if (!repoRoot) throw new Error('No repo root provided')
      claim(repoRoot)
      try {
        return await deps.prepareMainForMerge(repoRoot)
      } finally {
        busyRepos.delete(repoRoot)
      }
    },

    async mergeLocal(repoRoot, sourceBranch, strategy, worktreePath) {
      if (!repoRoot) throw new Error('No repo root provided')
      claim(repoRoot)
      // Only true once the merge SHA is persisted, so the optimistic
      // mergedByPath flag matches what the poller will derive next time.
      let merged = false
      try {
        // Inside the try so a throwing listener can't strand the lock.
        if (worktreePath) {
          deps.dispatch({ type: 'prs/localMergeStarted', payload: { path: worktreePath } })
        }
        let branch = sourceBranch
        if (worktreePath) {
          const resolved = await deps.getCurrentBranch(worktreePath)
          if (resolved) branch = resolved
        }
        const result = await deps.mergeWorktreeLocally(repoRoot, branch, strategy)
        const sha = await deps.getBranchSha(repoRoot, branch)
        if (sha) {
          deps.recordLocallyMerged(branch, sha)
          merged = true
        }
        deps.refreshAll()
        return result
      } finally {
        busyRepos.delete(repoRoot)
        if (worktreePath) {
          deps.dispatch({
            type: 'prs/localMergeFinished',
            payload: { path: worktreePath, merged }
          })
        }
      }
    }
  }
}
