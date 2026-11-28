// PTY output → WebView, batched with backpressure. terminal:data arrives as
// many small frames; each injectJavaScript is a bridge crossing plus a JS
// parse in the page, so frames are coalesced for one tick and only one
// batch is ever in flight — the next goes when xterm's write callback acks
// the last. A noisy build therefore costs a handful of injections a second
// however fast it prints, and a slow phone just gets bigger batches.

/** One injection's ceiling. History replay is up to 1 MB (PtyManager's
 *  HISTORY_CAP_BYTES); splitting it keeps a single injection's string, and
 *  the page's parse of it, from stalling the bridge. */
export const MAX_BATCH = 256 * 1024
const COALESCE_MS = 16

export class OutputQueue {
  private pending: string[] = []
  private pendingLen = 0
  private inflight = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private drainWaiters: (() => void)[] = []
  private disposed = false

  constructor(private readonly deliver: (chunk: string) => void) {}

  push(data: string): void {
    if (this.disposed || !data) return
    this.pending.push(data)
    this.pendingLen += data.length
    if (!this.inflight && !this.timer) this.timer = setTimeout(() => this.flush(), COALESCE_MS)
  }

  /** The page finished writing the last batch. */
  ack(): void {
    this.inflight = false
    this.flush()
  }

  /** Resolves once everything pushed so far has been written. */
  drained(): Promise<void> {
    if (!this.inflight && this.pendingLen === 0) return Promise.resolve()
    return new Promise((resolve) => this.drainWaiters.push(resolve))
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending = []
    this.pendingLen = 0
    for (const w of this.drainWaiters.splice(0)) w()
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.disposed || this.inflight) return
    if (this.pendingLen === 0) {
      for (const w of this.drainWaiters.splice(0)) w()
      return
    }
    let all = this.pending.length === 1 ? this.pending[0] : this.pending.join('')
    let chunk = all
    if (all.length > MAX_BATCH) {
      // Don't split a UTF-16 surrogate pair across batches.
      let cut = MAX_BATCH
      const code = all.charCodeAt(cut - 1)
      if (code >= 0xd800 && code <= 0xdbff) cut--
      chunk = all.slice(0, cut)
      all = all.slice(cut)
      this.pending = [all]
      this.pendingLen = all.length
    } else {
      this.pending = []
      this.pendingLen = 0
    }
    this.inflight = true
    this.deliver(chunk)
  }
}
