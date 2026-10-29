// Holds the agent side of the `edit_copy` MCP tool. The control server's
// HTTP handler parks on `request()` until a human submits or dismisses the
// draft from whichever client is showing it; the slice entry is what every
// client renders, and the waiter map is what turns the human's click back
// into the HTTP response the agent is blocked on.
//
// Status dots: Chat tabs get needs-approval from JsonClaudeStatusDeriver,
// which reads the copyDrafts slice. Terminal tabs have no deriver — their
// status comes from Claude Code hooks, which only know a tool is running —
// so the broker sets needs-approval itself and hands back to processing once
// the human answers (the tool is still finishing; PostToolUse follows).

import { randomUUID } from 'crypto'
import type { Store } from './store'
import type { CopyDraftRequest } from '../shared/state/copy-drafts'
import { log } from './debug'

export type CopyDraftOutcome =
  | { kind: 'submitted'; text: string; note?: string }
  | { kind: 'dismissed'; note?: string }
  | { kind: 'cancelled' }

export type CopyDraftInput = Omit<CopyDraftRequest, 'id' | 'timestamp'>

export class CopyDraftBroker {
  private waiters = new Map<string, (outcome: CopyDraftOutcome) => void>()

  constructor(
    private store: Store,
    private isChatSession: (terminalId: string) => boolean
  ) {}

  request(input: CopyDraftInput): { id: string; result: Promise<CopyDraftOutcome> } {
    const id = randomUUID()
    const req: CopyDraftRequest = { ...input, id, timestamp: Date.now() }
    const result = new Promise<CopyDraftOutcome>((resolve) => {
      this.waiters.set(id, resolve)
    })
    this.store.dispatch({ type: 'copyDrafts/requested', payload: req })
    if (!this.isChatSession(req.terminalId)) {
      this.store.dispatch({
        type: 'terminals/statusChanged',
        payload: {
          id: req.terminalId,
          status: 'needs-approval',
          pendingTool: { name: 'edit_copy', input: { title: req.title, draft: req.draft } }
        }
      })
    }
    log('copy-drafts', `requested id=${id} terminal=${req.terminalId}`)
    return { id, result }
  }

  /** Returns false when the draft is already gone — answered from another
   *  client, or the agent's call was abandoned. */
  resolve(id: string, outcome: CopyDraftOutcome): boolean {
    const waiter = this.waiters.get(id)
    const req = this.store.getSnapshot().state.copyDrafts.pending[id]
    if (!waiter || !req) return false
    this.waiters.delete(id)
    this.store.dispatch({
      type: 'copyDrafts/resolved',
      payload: { id, terminalId: req.terminalId }
    })
    if (!this.isChatSession(req.terminalId)) {
      const current = this.store.getSnapshot().state.terminals.statuses[req.terminalId]
      if (current === 'needs-approval') {
        this.store.dispatch({
          type: 'terminals/statusChanged',
          payload: { id: req.terminalId, status: 'processing', pendingTool: null }
        })
      }
    }
    log('copy-drafts', `resolved id=${id} outcome=${outcome.kind}`)
    waiter(outcome)
    return true
  }

  /** The agent stopped waiting (call timed out, turn interrupted, process
   *  exited). Drop the card so nobody edits into the void. */
  cancel(id: string): void {
    this.resolve(id, { kind: 'cancelled' })
  }
}
