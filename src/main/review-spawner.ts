import type { Store } from './store'
import type { PRStatus } from '../shared/state/prs'
import { pickAuthorTab } from './review-service'
import { PrStatusWatcher } from './pr-status-watcher'
import { log } from './debug'


export interface ReviewSpawnerDeps {
  /** Whether auto-review on green CI is on for this worktree. */
  isEnabled: (worktreePath: string) => boolean
  /** Open (or reuse) the reviewer for a requester tab. Same path
   *  `request_review` takes, so an auto-spawned reviewer is linked to the
   *  author tab exactly like a requested one. */
  requestReview: (
    worktreePath: string,
    requesterTabId: string,
    context: string
  ) => { ok: true } | { ok: false; error: string }
}

export function buildCiGreenContext(pr: PRStatus): string {
  return [
    `CI has gone green on PR #${pr.number} (${pr.branch}), so Ness opened this review automatically — the author did not ask for it by hand.`,
    '',
    `Review the whole branch against its base. Start from the diff in the Review tab.`,
    pr.title ? `\nPR title: ${pr.title}` : '',
    pr.url ? `PR: ${pr.url}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

/** Opens a reviewer Chat tab for a worktree's author tab when its PR
 *  checks go green — the automatic counterpart to request_review. The
 *  once-per-head-commit dedup lives in PrStatusWatcher, which this
 *  configures; see there for why it works that way.
 *
 *  Which tab is treated as the author: the most recently active Chat tab
 *  that is not itself a reviewer. The review comes back to that tab
 *  because requestReview records the link. */
export class ReviewSpawner {
  private watcher: PrStatusWatcher

  constructor(
    private store: Store,
    private deps: ReviewSpawnerDeps
  ) {
    this.watcher = new PrStatusWatcher(store, {
      name: 'review-spawner',
      on: 'success',
      // A merged or closed PR is finished; reviewing it now helps nobody.
      requireOpen: true,
      isEnabled: (path) => this.deps.isEnabled(path),
      act: (path, status, shaKey) => this.openReviewer(path, status, shaKey)
    })
  }

  start(): void {
    this.watcher.start()
  }

  stop(): void {
    this.watcher.stop()
  }

  /** False releases the commit claim so a later poll retries — by then
   *  the user may have opened the Chat tab this needs. */
  private openReviewer(worktreePath: string, status: PRStatus, shaKey: string): boolean {
    const author = pickAuthorTab(this.store.getSnapshot().state, worktreePath)
    if (!author) {
      log('review-spawner', `skip ${worktreePath} @ ${shaKey}: no Chat tab to review for`)
      return false
    }
    const result = this.deps.requestReview(worktreePath, author, buildCiGreenContext(status))
    if (!result.ok) {
      log('review-spawner', `skip ${worktreePath} @ ${shaKey}: ${result.error}`)
      return false
    }
    log('review-spawner', `opened reviewer for ${worktreePath} @ ${shaKey}`)
    return true
  }
}
