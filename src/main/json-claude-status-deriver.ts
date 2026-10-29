// Mirrors json-claude session state into terminals/statusChanged so the
// sidebar + tab-bar dots light up the same way they do for xterm-backed
// agent tabs. We can't piggyback on the user-scope status hooks (we
// scrub HARNESS_TERMINAL_ID from the json-claude subprocess env so they
// don't fire), so derive the status here from busy + pendingApprovals +
// session.state on every jsonClaude/* event.
//
// Mapping:
//   exited            → terminals/removed
//   pending approval  → needs-approval (with PendingTool), unless the
//                       auto-reviewer is still deciding
//   pending edit_copy → needs-approval (the human owes the agent a draft)
//   busy              → processing
//   otherwise         → waiting
//
// Same dot semantics as xterm tabs, no UI changes needed downstream.

import type { Store } from './store'
import type { StateEvent } from '../shared/state'
import type { JsonClaudeState } from '../shared/state/json-claude'
import { firstDraftForTerminal } from '../shared/state/copy-drafts'
import type { PtyStatus, PendingTool } from '../shared/state/terminals'
import { log } from './debug'

export class JsonClaudeStatusDeriver {
  private store: Store
  private unsubscribe: (() => void) | null = null
  // Stable fingerprint of (status, pendingTool) per session so we only
  // dispatch terminals/statusChanged when the derived value actually
  // changes. At ~30Hz streaming deltas with N open chats, the previous
  // fan-out-to-everyone behavior was O(N) IPC sends per token.
  private lastStatus = new Map<string, string>()

  constructor(store: Store) {
    this.store = store
  }

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.store.subscribe((event) => this.onEvent(event))
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
  }

  private onEvent(event: StateEvent): void {
    if (event.type === 'copyDrafts/requested' || event.type === 'copyDrafts/resolved') {
      const jc = this.store.getSnapshot().state.jsonClaude
      if (event.payload.terminalId in jc.sessions) {
        this.deriveSession(event.payload.terminalId, jc)
      }
      return
    }
    if (!event.type.startsWith('jsonClaude/')) return
    const jc = this.store.getSnapshot().state.jsonClaude
    // Re-derive only the session(s) the event touched, then dedup against
    // the cached fingerprint so an unchanged status is a no-op. The only
    // event we can't scope is approvalResolved (carries requestId, not
    // sessionId, and the approval is already gone from state by now); for
    // that one we sweep, and the cache makes the sweep cheap.
    for (const sessionId of this.sessionsToReDerive(event, jc)) {
      this.deriveSession(sessionId, jc)
    }
  }

  private sessionsToReDerive(
    event: StateEvent,
    jc: JsonClaudeState
  ): string[] {
    if (event.type === 'jsonClaude/approvalResolved') {
      return Object.keys(jc.sessions)
    }
    const payload =
      'payload' in event
        ? ((event as { payload?: unknown }).payload as { sessionId?: unknown } | undefined)
        : undefined
    if (payload && typeof payload.sessionId === 'string') {
      return [payload.sessionId]
    }
    log('json-claude-status-deriver', `event without sessionId: ${event.type}`)
    return Object.keys(jc.sessions)
  }

  private deriveSession(sessionId: string, jc: JsonClaudeState): void {
    const session = jc.sessions[sessionId]
    if (!session) {
      // Session disappeared (e.g. sessionCleared). Fire one terminals/removed
      // if we previously published a non-exited status — skip if we already
      // fired one via the exited path so we don't double-emit.
      const cached = this.lastStatus.get(sessionId)
      if (cached !== undefined) {
        if (cached !== 'exited') {
          this.store.dispatch({ type: 'terminals/removed', payload: sessionId })
        }
        this.lastStatus.delete(sessionId)
      }
      return
    }
    if (session.state === 'exited') {
      if (this.lastStatus.get(sessionId) === 'exited') return
      this.store.dispatch({ type: 'terminals/removed', payload: sessionId })
      this.lastStatus.set(sessionId, 'exited')
      return
    }
    let status: PtyStatus
    let pendingTool: PendingTool | null = null
    let fingerprint: string
    // An approval whose auto-reviewer is still deciding isn't a human's
    // problem yet — the reviewer resolves most of them within seconds.
    // Treating it as needs-approval flashes the worktree red and then
    // clears it, so hold the pre-approval status until the reviewer asks.
    const approval = Object.values(jc.pendingApprovals).find(
      (a) => a.sessionId === sessionId && a.autoReview?.state !== 'pending'
    )
    const copyDraft = approval
      ? null
      : firstDraftForTerminal(this.store.getSnapshot().state.copyDrafts, sessionId)
    if (approval) {
      status = 'needs-approval'
      pendingTool = { name: approval.toolName, input: approval.input }
      fingerprint = `needs-approval:${approval.requestId}`
    } else if (copyDraft) {
      status = 'needs-approval'
      pendingTool = {
        name: 'edit_copy',
        input: { title: copyDraft.title, draft: copyDraft.draft }
      }
      fingerprint = `needs-approval:${copyDraft.id}`
    } else if (session.busy) {
      status = 'processing'
      fingerprint = 'processing'
    } else {
      status = 'waiting'
      fingerprint = 'waiting'
    }
    if (this.lastStatus.get(sessionId) === fingerprint) return
    this.lastStatus.set(sessionId, fingerprint)
    this.store.dispatch({
      type: 'terminals/statusChanged',
      payload: { id: sessionId, status, pendingTool }
    })
  }
}
