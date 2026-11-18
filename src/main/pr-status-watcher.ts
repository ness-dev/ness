import type { Store } from './store'
import type { StateEvent } from '../shared/state'
import type { PRStatus } from '../shared/state/prs'
import { log } from './debug'

/** Identity of a check result: the commit it happened on. Statuses cached
 *  by an older build carry no headSha; falling back to the PR number still
 *  collapses a flapping check down to one action. */
function shaKeyFor(status: PRStatus): string {
  return status.headSha || `pr-${status.number}`
}

export interface PrStatusWatcherOptions {
  /** Log prefix, and the name this watcher is known by. */
  name: string
  /** The checks state that triggers `act`. */
  on: PRStatus['checksOverall']
  /** Skip PRs that aren't open. A merged or closed PR is finished. */
  requireOpen?: boolean
  /** Per-worktree opt-in, re-read per decision so a toggle takes effect
   *  without a restart. */
  isEnabled: (worktreePath: string) => boolean
  /** Do the thing. Runs off the store fan-out, because acting can spawn a
   *  subprocess or replay a transcript. Return false to release the
   *  commit claim so a later poll of the same commit tries again. */
  act: (worktreePath: string, status: PRStatus, shaKey: string) => boolean
}

/** Watches a worktree's PR checks and acts once per head commit when they
 *  reach `on`.
 *
 *  The dedup is the subtle part, and it is why this is one class rather
 *  than one per consumer:
 *
 *  - **The head commit is the identity of a result.** `handledSha` records
 *    the commit last decided about, so a check that flaps
 *    (failure → pending → failure on a re-run) acts once, while a fresh
 *    push that also fails acts again. Deliberately NOT keyed on a
 *    transition in `checksOverall`: a push whose CI finishes before the
 *    poller ever observes an in-between state is still a new result, and
 *    with multi-minute poll intervals that is the common case.
 *  - **The commit is claimed before any other check**, so exactly one
 *    decision happens per commit even if a poll lands while `act` is
 *    still running, and the decline logging stays one line per commit.
 *  - **`seen` suppresses a burst on the first poll after boot**, where
 *    every already-red (or already-green) PR would otherwise read as
 *    fresh.
 *
 *  Lives here rather than in PRPoller so the poller stays ignorant of
 *  what anyone does with its output. */
export class PrStatusWatcher {
  private seen = new Set<string>()
  private handledSha = new Map<string, string>()
  private unsubscribe: (() => void) | null = null

  constructor(
    private store: Store,
    private opts: PrStatusWatcherOptions
  ) {}

  start(): void {
    if (this.unsubscribe) return
    // Seed from whatever the store already knows, so a poll that landed
    // before we subscribed doesn't read as a fresh result.
    const byPath = this.store.getSnapshot().state.prs.byPath
    for (const [path, status] of Object.entries(byPath)) {
      if (!status) continue
      this.seen.add(path)
      // Claim an already-triggering commit so boot stays quiet until a
      // NEW one arrives. Marking the path seen isn't enough on its own —
      // the next poll would read as fresh.
      if (status.checksOverall === this.opts.on) {
        this.handledSha.set(path, shaKeyFor(status))
      }
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
      // Sweeping the whole payload is inherent to this event — it
      // replaces prs.byPath wholesale — and PR polls are minutes apart,
      // so the cost is negligible. The per-path caches below keep the
      // sweep from turning into repeated work.
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
    const { name, on, requireOpen, isEnabled, act } = this.opts
    if (!status) {
      this.seen.delete(path)
      this.handledSha.delete(path)
      return
    }
    const firstObservation = !this.seen.has(path)
    this.seen.add(path)
    if (status.checksOverall !== on) return
    if (requireOpen && status.state !== 'open') return

    const shaKey = shaKeyFor(status)
    if (this.handledSha.get(path) === shaKey) return
    this.handledSha.set(path, shaKey)

    if (firstObservation) {
      log('pr-watcher', `${name}: skip ${path} @ ${shaKey}: already ${on} at first poll`)
      return
    }
    if (!isEnabled(path)) {
      log('pr-watcher', `${name}: skip ${path} @ ${shaKey}: off for this worktree`)
      return
    }
    setImmediate(() => {
      if (!act(path, status, shaKey)) this.handledSha.delete(path)
    })
  }
}
