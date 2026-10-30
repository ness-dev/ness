import type { Store } from './store'
import type { StateEvent } from '../shared/state'
import type { PRStatus } from '../shared/state/prs'
import { getLeaves } from '../shared/state/terminals'
import { log } from './debug'

/** Identity of a green build: the commit it went green on. Statuses
 *  cached by an older build carry no headSha, in which case the PR number
 *  still collapses repeated polls into one review. */
function shaKeyFor(status: PRStatus): string {
  return status.headSha || `pr-${status.number}`
}

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

/** Opens a reviewer Chat tab when a worktree's PR checks go green.
 *
 *  Modelled on CiNotifier, and deliberately the same shape: subscribe to
 *  `prs/*`, key decisions on the head commit so a flapping or re-polled
 *  status reviews once, and stay quiet about whatever was already green
 *  the first time we looked (otherwise every green PR in the workspace
 *  would spawn a reviewer at launch).
 *
 *  Which tab is treated as the author: the most recently active Chat tab
 *  that is not itself a reviewer. The review comes back to that tab
 *  because requestReview records the link.
 *
 *  Spawning a tab starts a subprocess, so delivery hops off the store
 *  fan-out first. */
export class ReviewSpawner {
  private seen = new Set<string>()
  private handledSha = new Map<string, string>()
  private unsubscribe: (() => void) | null = null

  constructor(
    private store: Store,
    private deps: ReviewSpawnerDeps
  ) {}

  start(): void {
    if (this.unsubscribe) return
    const byPath = this.store.getSnapshot().state.prs.byPath
    for (const [path, status] of Object.entries(byPath)) {
      if (!status) continue
      this.seen.add(path)
      if (status.checksOverall === 'success') this.handledSha.set(path, shaKeyFor(status))
    }
    this.unsubscribe = this.store.subscribe((event) => this.onEvent(event))
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private onEvent(event: StateEvent): void {
    if (event.type === 'prs/statusChanged') {
      this.consider(event.payload.path, event.payload.status)
      return
    }
    if (event.type === 'prs/bulkStatusChanged') {
      // Inherent sweep: the event replaces prs.byPath wholesale, and PR
      // polls are minutes apart. The per-path caches keep it cheap.
      for (const path of Object.keys(event.payload)) {
        this.consider(path, event.payload[path])
      }
      for (const path of this.seen) {
        if (!(path in event.payload)) {
          this.seen.delete(path)
          this.handledSha.delete(path)
        }
      }
    }
  }

  private consider(path: string, status: PRStatus | null): void {
    if (!status) {
      this.seen.delete(path)
      this.handledSha.delete(path)
      return
    }
    const firstObservation = !this.seen.has(path)
    this.seen.add(path)
    if (status.checksOverall !== 'success') return
    // A merged or closed PR is finished; reviewing it now helps nobody.
    if (status.state !== 'open') return

    const shaKey = shaKeyFor(status)
    if (this.handledSha.get(path) === shaKey) return
    // Claim the commit before any other check, so there is exactly one
    // decision per head commit even if a poll lands mid-spawn.
    this.handledSha.set(path, shaKey)

    if (firstObservation) {
      log('review-spawner', `skip ${path} @ ${shaKey}: already green at first poll`)
      return
    }
    if (!this.deps.isEnabled(path)) {
      log('review-spawner', `skip ${path} @ ${shaKey}: auto-review off for this worktree`)
      return
    }
    const author = this.pickAuthorTab(path)
    if (!author) {
      log('review-spawner', `skip ${path} @ ${shaKey}: no Chat tab to review for`)
      this.handledSha.delete(path)
      return
    }
    const context = buildCiGreenContext(status)
    setImmediate(() => {
      const result = this.deps.requestReview(path, author, context)
      if (!result.ok) {
        log('review-spawner', `skip ${path} @ ${shaKey}: ${result.error}`)
        this.handledSha.delete(path)
        return
      }
      log('review-spawner', `opened reviewer for ${path} @ ${shaKey}`)
    })
  }

  /** The author tab: most recently active Chat tab that isn't a reviewer.
   *  Chat only, since the review has to be delivered back to it. */
  private pickAuthorTab(worktreePath: string): string | null {
    const state = this.store.getSnapshot().state
    const tree = state.terminals.panes[worktreePath]
    if (!tree) return null
    let best: string | null = null
    let bestTs = -1
    for (const leaf of getLeaves(tree)) {
      for (const tab of leaf.tabs) {
        if (tab.type !== 'json-claude' || tab.reviewOf) continue
        const entries = state.jsonClaude.sessions[tab.id]?.entries
        const ts = entries?.[entries.length - 1]?.timestamp ?? 0
        if (ts > bestTs) {
          best = tab.id
          bestTs = ts
        }
      }
    }
    return best
  }
}
