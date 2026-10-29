import type { Store } from './store'

/** When each terminal tab's hook status last changed. Chat tabs carry a
 *  timestamped transcript in state; terminal tabs don't, and this is the
 *  only recency signal for them — used to pick which agent tab a review
 *  goes to. In memory only: after a relaunch every terminal tab reads as
 *  "unknown" until it does something, which is what the picker wants.
 *
 *  O(1) per event: it reads the id off the payload and nothing else. */
export class TabActivityTracker {
  private last = new Map<string, number>()
  private unsubscribe: (() => void) | null = null

  constructor(
    private store: Store,
    private now: () => number = Date.now
  ) {}

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.store.subscribe((event) => {
      if (event.type === 'terminals/statusChanged') {
        this.last.set(event.payload.id, this.now())
      } else if (event.type === 'terminals/removed') {
        this.last.delete(event.payload)
      }
    })
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  get(tabId: string): number | undefined {
    return this.last.get(tabId)
  }
}
