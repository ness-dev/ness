import type { Store } from './store'
import type { StateEvent } from '../shared/state'
import { getLeaves } from '../shared/state/terminals'
import { log } from './debug'

export type TerminalDeliveryOutcome =
  | { state: 'delivered' }
  | { state: 'queued' }
  | { state: 'failed'; reason: 'no-hooks' }

export type TerminalSettled = { ok: true } | { ok: false; reason: 'tab-closed' }

export interface TerminalDeliveryDeps {
  hasPty: (tabId: string) => boolean
  write: (tabId: string, data: string) => void
  /** Whether Ness's status hooks are installed. Without them a terminal
   *  never reports being idle, so a queued message would wait forever. */
  hooksEnabled: () => boolean
  onSessionStart: (listener: (tabId: string) => void) => () => void
  schedule?: (fn: () => void, ms: number) => void
}

interface Pending {
  worktreePath: string
  message: string
  onSettled?: (result: TerminalSettled) => void
}

/** SessionStart fires while the TUI is still coming up; give it a moment
 *  to start reading stdin before typing into it. */
const SESSION_START_SETTLE_MS = 1500
/** Enter goes in its own write, after the paste has been taken in. */
const SUBMIT_DELAY_MS = 150

/** Strip escape and other control bytes so a message can't end the
 *  bracketed paste early and have the rest read as keystrokes. */
export function sanitizeForPaste(message: string): string {
  return message.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}

/** Types messages into terminal agent tabs, but only when the agent is
 *  idle at its prompt: hook status 'waiting' (a Stop hook fired), or a
 *  SessionStart with no turn since. Anything else — a turn in progress, a
 *  permission prompt, a PTY that isn't running yet — holds the message
 *  until the tab next goes idle, one message per idle window, in order.
 *  Pasting while a permission prompt is up would answer it, which is the
 *  thing this exists to never do.
 *
 *  The queue is in memory. Submissions still queued at quit are settled
 *  as failed on the next boot (see sanitizeReviews). */
export class TerminalDeliveryQueue {
  private pending = new Map<string, Pending[]>()
  /** Saw SessionStart and no status change since. */
  private sessionReady = new Set<string>()
  /** Pasted, and the hook status hasn't moved yet — the 'waiting' still in
   *  state is from before our message, so don't paste a second one. */
  private awaitingTurn = new Set<string>()
  private unsubscribe: (() => void) | null = null
  private unsubscribeHooks: (() => void) | null = null
  private schedule: (fn: () => void, ms: number) => void

  constructor(
    private store: Store,
    private deps: TerminalDeliveryDeps
  ) {
    this.schedule = deps.schedule ?? ((fn, ms) => void setTimeout(fn, ms))
  }

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.store.subscribe((event) => this.onEvent(event))
    this.unsubscribeHooks = this.deps.onSessionStart((tabId) => {
      this.awaitingTurn.delete(tabId)
      this.sessionReady.add(tabId)
      if (this.pending.has(tabId)) this.schedule(() => this.flush(tabId), SESSION_START_SETTLE_MS)
    })
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribeHooks?.()
    this.unsubscribe = null
    this.unsubscribeHooks = null
  }

  deliver(
    worktreePath: string,
    tabId: string,
    message: string,
    onSettled?: (result: TerminalSettled) => void
  ): TerminalDeliveryOutcome {
    if (!this.deps.hooksEnabled()) return { state: 'failed', reason: 'no-hooks' }
    const queue = this.pending.get(tabId)
    if (!queue && this.isReady(tabId)) {
      this.paste(tabId, message)
      return { state: 'delivered' }
    }
    const entry: Pending = { worktreePath, message, onSettled }
    if (queue) queue.push(entry)
    else this.pending.set(tabId, [entry])
    log('terminal-delivery', `queued for ${tabId} (status=${this.status(tabId) ?? 'none'})`)
    return { state: 'queued' }
  }

  private status(tabId: string): string | undefined {
    return this.store.getSnapshot().state.terminals.statuses[tabId]
  }

  private isReady(tabId: string): boolean {
    if (!this.deps.hasPty(tabId) || this.awaitingTurn.has(tabId)) return false
    return this.status(tabId) === 'waiting' || this.sessionReady.has(tabId)
  }

  private paste(tabId: string, message: string): void {
    this.awaitingTurn.add(tabId)
    this.sessionReady.delete(tabId)
    this.deps.write(tabId, '\x1b[200~' + sanitizeForPaste(message) + '\x1b[201~')
    this.schedule(() => this.deps.write(tabId, '\r'), SUBMIT_DELAY_MS)
    log('terminal-delivery', `typed message into ${tabId}`)
  }

  private flush(tabId: string): void {
    const queue = this.pending.get(tabId)
    if (!queue || !this.isReady(tabId)) return
    const next = queue.shift()!
    if (queue.length === 0) this.pending.delete(tabId)
    this.paste(tabId, next.message)
    next.onSettled?.({ ok: true })
  }

  private failGone(worktreePath: string): void {
    const tree = this.store.getSnapshot().state.terminals.panes[worktreePath]
    const live = new Set<string>()
    if (tree) for (const leaf of getLeaves(tree)) for (const t of leaf.tabs) live.add(t.id)
    for (const [tabId, queue] of this.pending) {
      if (queue[0]?.worktreePath !== worktreePath || live.has(tabId)) continue
      this.pending.delete(tabId)
      log('terminal-delivery', `dropping ${queue.length} queued message(s): tab ${tabId} closed`)
      for (const p of queue) p.onSettled?.({ ok: false, reason: 'tab-closed' })
    }
  }

  private onEvent(event: StateEvent): void {
    switch (event.type) {
      case 'terminals/statusChanged': {
        const { id, status } = event.payload
        this.awaitingTurn.delete(id)
        if (status !== 'waiting') this.sessionReady.delete(id)
        // Off the store fan-out: flushing settles a submission, which
        // dispatches.
        if (status === 'waiting' && this.pending.has(id)) queueMicrotask(() => this.flush(id))
        return
      }
      case 'terminals/removed':
        this.awaitingTurn.delete(event.payload)
        this.sessionReady.delete(event.payload)
        return
      case 'terminals/panesForWorktreeChanged':
        if (this.pending.size) queueMicrotask(() => this.failGone(event.payload.worktreePath))
        return
      case 'terminals/panesForWorktreeCleared':
        if (this.pending.size) queueMicrotask(() => this.failGone(event.payload))
        return
      case 'terminals/panesReplaced': {
        // Every worktree's tree was replaced; re-check only the worktrees
        // that have something queued.
        if (!this.pending.size) return
        const paths = new Set([...this.pending.values()].map((q) => q[0].worktreePath))
        queueMicrotask(() => paths.forEach((p) => this.failGone(p)))
        return
      }
      default:
        return
    }
  }
}
