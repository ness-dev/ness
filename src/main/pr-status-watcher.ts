import type { Store } from './store'
import type { StateEvent } from '../shared/state'
import type { PRStatus } from '../shared/state/prs'
import {
  isPrNotifyEnabled,
  prNotifyGlobalDefault,
  type PrNotifyKind
} from '../shared/state/pr-notify'
import {
  deliverToWorktreeChat,
  type ChatDeliveryDeps,
  type ChatDeliveryResult
} from './chat-delivery'

/** Shared plumbing for the notifiers that turn PR status changes into agent
 *  chat messages: one subscription, per-path first-observation tracking, and
 *  deferred delivery. Subclasses decide what counts as news.
 *
 *  `seen` exists so the first poll after boot (or after a PR first appears)
 *  can be told apart from a genuine change — otherwise every already-red,
 *  already-commented, already-conflicting PR would read as fresh on launch. */
export abstract class PrStatusWatcher {
  protected readonly store: Store
  protected readonly deps: ChatDeliveryDeps
  private seen = new Set<string>()
  private unsubscribe: (() => void) | null = null

  constructor(store: Store, deps: ChatDeliveryDeps) {
    this.store = store
    this.deps = deps
  }

  start(): void {
    if (this.unsubscribe) return
    // Seed from whatever the store already knows so a poll that landed
    // before we subscribed doesn't read as a fresh transition.
    const byPath = this.store.getSnapshot().state.prs.byPath
    for (const [path, status] of Object.entries(byPath)) {
      if (!status) continue
      this.seen.add(path)
      this.seed(path, status)
    }
    this.unsubscribe = this.store.subscribe((event) => this.onEvent(event))
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  /** Record the baseline for a PR without notifying. */
  protected abstract seed(path: string, status: PRStatus): void
  protected abstract consider(path: string, status: PRStatus, firstObservation: boolean): void
  protected abstract forget(path: string): void

  protected isEnabled(path: string, kind: PrNotifyKind): boolean {
    const state = this.store.getSnapshot().state
    return isPrNotifyEnabled(
      state.prNotify,
      path,
      kind,
      prNotifyGlobalDefault(state.settings, kind)
    )
  }

  /** Waking a tab spawns a subprocess and replays its transcript from
   *  disk. That's far too much work to run inside a store listener, so
   *  delivery always hops off the fan-out first. */
  protected deliverLater(
    worktreePath: string,
    message: string,
    onResult: (result: ChatDeliveryResult) => void
  ): void {
    setImmediate(() => {
      const state = this.store.getSnapshot().state
      onResult(deliverToWorktreeChat(state, this.deps, worktreePath, message))
    })
  }

  private onEvent(event: StateEvent): void {
    if (event.type === 'prs/statusChanged') {
      this.observe(event.payload.path, event.payload.status)
      return
    }
    if (event.type === 'prs/bulkStatusChanged') {
      // Sweeping the whole payload is inherent to this event — it replaces
      // prs.byPath wholesale — and PR polls are minutes apart, so the cost
      // is negligible. The per-path caches in subclasses keep the sweep from
      // turning into repeated work.
      for (const path of Object.keys(event.payload)) {
        this.observe(path, event.payload[path])
      }
      for (const path of this.seen) {
        if (!(path in event.payload)) {
          this.seen.delete(path)
          this.forget(path)
        }
      }
    }
  }

  private observe(path: string, status: PRStatus | null): void {
    if (!status) {
      this.seen.delete(path)
      this.forget(path)
      return
    }
    const firstObservation = !this.seen.has(path)
    this.seen.add(path)
    this.consider(path, status, firstObservation)
  }
}

export function isPrOpen(status: PRStatus): boolean {
  return status.state === 'open' || status.state === 'draft'
}
