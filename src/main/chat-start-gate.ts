// A chat session's start is asynchronous (it waits on the worktree's
// shell-env probe before spawning), but the renderer treats
// `jsonClaude:start` as done the moment it returns. Anything that reaches
// a session in that window — a message typed right after a wake, a second
// client's start — has to go through here, or it lands on a provider with
// no instance and is dropped without a word.

import { log } from './debug'

interface PendingStart {
  cancelled: boolean
  done: Promise<boolean>
  /** The start that replaced this one after it was cancelled. */
  next?: PendingStart
}

export class ChatStartGate {
  private readonly pending = new Map<string, PendingStart>()
  /** Cancelled starts still in flight, waiting to be linked to the start
   *  that replaces them (kill + restart) so their held calls follow it. */
  private readonly cancelled = new Map<string, PendingStart>()

  /** Run `start` for `sessionId`, or join the start already in flight for
   *  it. Resolves true once the session is running, whichever caller
   *  started it; false when it was cancelled, declined, or threw. */
  begin(sessionId: string, start: (isCancelled: () => boolean) => Promise<boolean>): Promise<boolean> {
    const existing = this.pending.get(sessionId)
    if (existing) return existing.done
    const token: PendingStart = { cancelled: false, done: Promise.resolve(false) }
    token.done = (async () => {
      try {
        return await start(() => token.cancelled)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log('json-claude', `start failed sessionId=${sessionId}: ${msg}`)
        return false
      } finally {
        if (this.pending.get(sessionId) === token) this.pending.delete(sessionId)
        if (this.cancelled.get(sessionId) === token) this.cancelled.delete(sessionId)
      }
    })()
    this.pending.set(sessionId, token)
    const replaced = this.cancelled.get(sessionId)
    if (replaced) {
      replaced.next = token
      this.cancelled.delete(sessionId)
    }
    return token.done
  }

  /** Abandon a start still in flight; its `begin` resolves false. */
  cancel(sessionId: string): void {
    const token = this.pending.get(sessionId)
    if (!token) return
    token.cancelled = true
    this.pending.delete(sessionId)
    this.cancelled.set(sessionId, token)
  }

  /** Run `fn` now when no start is in flight, otherwise once it succeeds —
   *  in call order, after anything queued by the start's own caller. A
   *  start that was cancelled and replaced (kill + restart) hands its
   *  held calls to the replacement; they are dropped only when nothing
   *  replaced it. */
  afterStart(sessionId: string, fn: () => void): void {
    const token = this.pending.get(sessionId)
    if (!token) {
      fn()
      return
    }
    this.runAfter(sessionId, token, fn)
  }

  private runAfter(sessionId: string, token: PendingStart, fn: () => void): void {
    void token.done.then((running) => {
      if (running) fn()
      else if (token.next) this.runAfter(sessionId, token.next, fn)
      else log('json-claude', `dropped call for sessionId=${sessionId}: start did not complete`)
    })
  }

  /** Resolves once no start is in flight: true unless the one in flight
   *  failed or was cancelled without a replacement. */
  async settled(sessionId: string): Promise<boolean> {
    let token = this.pending.get(sessionId)
    while (token) {
      const running = await token.done
      if (running || !token.next) return running
      token = token.next
    }
    return true
  }
}
