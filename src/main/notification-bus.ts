import { randomUUID } from 'crypto'
import type { Store } from './store'
import type { NotifyMode } from '../shared/state/subscriptions'
import { parseAutomatedMessage } from '../shared/state/json-claude'
import { findTabInWorktree, pickAuthorTab } from '../shared/agent-tabs'
import {
  deliverToTab,
  deliverToWorktreeChat,
  type ChatDeliveryDeps,
  type TabDeliveryFailure
} from './chat-delivery'
import { log } from './debug'

export type TabNotifyResult =
  | { ok: true; tabId: string; woke: boolean; held: boolean }
  | { ok: false; reason: TabDeliveryFailure }

export type WorktreeNotifyResult =
  | { ok: true; sessionId: string; woke: boolean; held: boolean }
  | { ok: false; reason: 'no-chat-tab' | 'wake-failed' }

/** The one way Ness puts an automatic message into an agent chat — CI and
 *  PR updates, reviews, worktree messages, progress reports, conflict
 *  hand-offs, kickoff briefs. Anything the user types goes straight to
 *  ChatRouter.send instead; everything Ness sends on its own comes through
 *  here, so there is one place that decides which tab, interrupt vs. hold,
 *  and whether to wake, and one log line per notification.
 *
 *  - interrupt: delivered as its own turn, waking a slept tab.
 *  - silent: held in the `notifications` slice; ChatRouter.send releases
 *    it in front of the tab's next turn, whoever sends that.
 *
 *  Messages are passed as wire text (already wrapped with
 *  wrapAutomatedMessage) — the source is read back off the sentinel.
 *
 *  Interrupts can spawn a subprocess. Never call from inside a store
 *  listener; hop off the fan-out first. */
export class NotificationBus {
  constructor(
    private store: Store,
    private chat: ChatDeliveryDeps,
    /** Start a tab's session (shell-env probe and all). Resolves to whether
     *  it is running. */
    private startSession: (sessionId: string, worktreePath: string) => Promise<boolean>
  ) {}

  /** Notify one specific Chat tab. */
  toTab(
    worktreePath: string,
    tabId: string,
    wire: string,
    mode: NotifyMode = 'interrupt'
  ): TabNotifyResult {
    if (mode === 'silent' && this.hold(worktreePath, tabId, wire)) {
      return this.logged(wire, tabId, worktreePath, { ok: true, tabId, woke: false, held: true })
    }
    const r = deliverToTab(this.store.getSnapshot().state, this.chat, worktreePath, tabId, wire)
    return this.logged(wire, tabId, worktreePath, r.ok ? { ...r, held: false } : r)
  }

  /** Notify whichever agent is working in a worktree: its most recently
   *  active live session, else a slept tab to wake (interrupt), or its
   *  author tab (silent). */
  toWorktree(worktreePath: string, wire: string, mode: NotifyMode = 'interrupt'): WorktreeNotifyResult {
    if (mode === 'silent') {
      const tabId = pickAuthorTab(this.store.getSnapshot().state, worktreePath)
      if (tabId && this.hold(worktreePath, tabId, wire)) {
        return this.logged(wire, tabId, worktreePath, { ok: true, sessionId: tabId, woke: false, held: true })
      }
    }
    const r = deliverToWorktreeChat(this.store.getSnapshot().state, this.chat, worktreePath, wire)
    return this.logged(wire, r.ok ? r.sessionId : '-', worktreePath, r.ok ? { ...r, held: false } : r)
  }

  /** First turn of a tab that is being opened (or revived) to do a job: a
   *  kickoff brief, a reviewer's request. Waits for the session to start,
   *  then delivers — the slow start is why this is the one async path. */
  startWithPrompt(sessionId: string, worktreePath: string, text: string): void {
    void this.startSession(sessionId, worktreePath).then((running) => {
      if (!running) {
        log('notify', `${sourceOf(text)} -> ${sessionId}@${worktreePath} failed: session did not start`)
        return
      }
      this.chat.send(sessionId, text)
      log('notify', `${sourceOf(text)} -> ${sessionId}@${worktreePath} kickoff`)
    })
  }

  /** Queue a silent notice. False when it can't be held (not a Chat tab,
   *  or not an automated message), and the caller falls back to an
   *  interrupt, which reports the precise failure. */
  private hold(worktreePath: string, tabId: string, wire: string): boolean {
    const automated = parseAutomatedMessage(wire)
    if (!automated) return false
    const tab = findTabInWorktree(this.store.getSnapshot().state, worktreePath, tabId)
    if (tab?.type !== 'json-claude') return false
    this.store.dispatch({
      type: 'notifications/queued',
      payload: {
        tabId,
        notice: {
          id: randomUUID(),
          source: automated.source,
          ...(automated.from ? { from: automated.from } : {}),
          wire,
          queuedAt: Date.now()
        }
      }
    })
    return true
  }

  private logged<T extends { ok: boolean }>(
    wire: string,
    tabId: string,
    worktreePath: string,
    result: T
  ): T {
    const r = result as unknown as { ok: boolean; held?: boolean; woke?: boolean; reason?: string }
    const outcome = !r.ok ? `failed: ${r.reason}` : r.held ? 'held' : r.woke ? 'interrupt (woke tab)' : 'interrupt'
    log('notify', `${sourceOf(wire)} -> ${tabId}@${worktreePath} ${outcome}`)
    return result
  }
}

function sourceOf(wire: string): string {
  return parseAutomatedMessage(wire)?.source ?? 'prompt'
}
