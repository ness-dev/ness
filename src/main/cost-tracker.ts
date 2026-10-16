// CostTracker subscribes to Stop hook events, reads the session jsonl
// pointed at by `transcript_path`, and produces:
//   - per-model usage totals (tokens + $)
//   - a ContentBreakdown attributing the session's $ total across
//     content categories (see src/shared/state/costs.ts).
//
// Strategy: maintain a per-session cache of partially-parsed state and
// fold only the bytes appended since last parse into it. Transcripts grow
// without bound across a session, so the original full-reparse approach
// scaled with transcript size and showed up as the worst [store-slow]
// listener in perf.log. The accumulators fold linearly from beginning to
// end, so incremental parsing produces totals identical to a single-shot
// reparse — that's the property the regression test pins down.
//
// JSON-mode tabs don't fire Claude's Stop hook (we scrub the
// HARNESS_TERMINAL_ID env var so user-scope hooks stay inert under
// `claude -p`). Instead, we subscribe to the store and trigger the same
// reparse on `jsonClaude/busyChanged` transitions to false (the boundary
// JsonClaudeManager dispatches when claude emits a `result` event), and
// on `jsonClaude/sessionStarted` so reopened tabs rehydrate from the
// on-disk JSONL even if the costs slice doesn't persist their entry.
//
// Per-block token counts aren't in the Anthropic usage field, so we
// estimate the $ split by char-length proportion within each turn:
// the turn's known output-rate cost is divided across this message's
// text/thinking/tool_use blocks by their char lengths; the turn's
// input-rate cost is divided across the running context composition
// (accumulated from prior messages' content). A single big tool_result
// naturally gets credited on every subsequent turn's input attribution,
// which captures the "doubly expensive" insight that early large
// outputs keep costing money as long as they sit in the context.

import { readFileSync } from 'fs'
import { claudeProjectsDirFor } from './claude-env'
import { join } from 'path'
import type { Store } from './store'
import type { StateEvent } from '../shared/state'
import { onStopEvent, type StopEvent } from './hooks'
import { type SessionUsage } from '../shared/state/costs'
import {
  newFoldState,
  resetFoldState,
  detectFormat,
  foldClaudeLines,
  foldCodexLines,
  type FoldState
} from './jsonl-fold'
import { log } from './debug'

interface CacheEntry extends FoldState {
  charOffset: number
  format: 'claude' | 'codex' | null
}

function newCacheEntry(): CacheEntry {
  return {
    charOffset: 0,
    format: null,
    ...newFoldState()
  }
}

function resetCacheEntry(entry: CacheEntry): void {
  entry.charOffset = 0
  entry.format = null
  resetFoldState(entry)
}

export class CostTracker {
  private unsubscribeHook: (() => void) | null = null
  private unsubscribeStore: (() => void) | null = null
  private cache = new Map<string, CacheEntry>()
  // The CostPanel is collapsed by default and most users never open it.
  // Parsing + dispatching on every turn boundary for a panel nobody is
  // looking at burns CPU and inflates the costs slice. Clients (one per
  // BrowserWindow / WS peer) signal interest via costs:setInterest; while
  // the set is empty, handleStop / recordJsonModeTurnComplete short-circuit.
  // The last StopEvent per terminal is retained so we can backfill on the
  // next 0→positive transition without waiting for another turn.
  private interestedClients = new Set<string>()
  private lastStops = new Map<string, StopEvent>()

  constructor(private store: Store) {}

  start(): void {
    this.unsubscribeHook = onStopEvent((ev) => this.handleStop(ev))
    this.unsubscribeStore = this.store.subscribe((event) =>
      this.handleStoreEvent(event)
    )
  }

  stop(): void {
    this.unsubscribeHook?.()
    this.unsubscribeHook = null
    this.unsubscribeStore?.()
    this.unsubscribeStore = null
  }

  setClientInterested(clientId: string, expanded: boolean): void {
    const wasZero = this.interestedClients.size === 0
    if (expanded) this.interestedClients.add(clientId)
    else this.interestedClients.delete(clientId)
    if (wasZero && this.interestedClients.size > 0) this.backfillAll()
  }

  removeClient(clientId: string): void {
    this.interestedClients.delete(clientId)
  }

  private handleStop(ev: StopEvent): void {
    this.lastStops.set(ev.terminalId, ev)
    if (this.interestedClients.size === 0) return
    this.parseAndDispatchStop(ev)
  }

  private parseAndDispatchStop(ev: StopEvent): void {
    try {
      const entry = this.parseIncremental(ev.sessionId, ev.transcriptPath)
      if (!entry) return
      const usage: SessionUsage = {
        sessionId: ev.sessionId,
        transcriptPath: ev.transcriptPath,
        byModel: entry.byModel,
        breakdown: entry.breakdown,
        currentModel: entry.currentModel,
        updatedAt: ev.ts * 1000
      }
      this.store.dispatch({
        type: 'costs/usageUpdated',
        payload: { terminalId: ev.terminalId, usage }
      })
    } catch (err) {
      log(
        'cost-tracker',
        `failed to ingest ${ev.transcriptPath}: ${err instanceof Error ? err.message : err}`
      )
    }
  }

  private handleStoreEvent(event: StateEvent): void {
    if (
      event.type === 'jsonClaude/busyChanged' &&
      event.payload.busy === false
    ) {
      this.recordJsonModeTurnComplete(event.payload.sessionId)
      return
    }
    if (event.type === 'jsonClaude/sessionStarted') {
      this.recordJsonModeTurnComplete(event.payload.sessionId)
    }
  }

  private recordJsonModeTurnComplete(sessionId: string): void {
    if (this.interestedClients.size === 0) return
    this.parseAndDispatchJsonMode(sessionId)
  }

  /** Reparse the JSON-mode session's on-disk JSONL and dispatch fresh
   *  cost totals. Skips the dispatch when parsing yields no model data
   *  so an early reparse (resume from disk before claude has flushed)
   *  doesn't wipe an existing hydrated entry. The next reparse picks
   *  things up. */
  private parseAndDispatchJsonMode(sessionId: string): void {
    const session =
      this.store.getSnapshot().state.jsonClaude.sessions[sessionId]
    if (!session) return
    const transcriptPath = jsonClaudeTranscriptPath(
      session.worktreePath,
      sessionId
    )
    try {
      const entry = this.parseIncremental(sessionId, transcriptPath)
      if (!entry || Object.keys(entry.byModel).length === 0) return
      const usage: SessionUsage = {
        sessionId,
        transcriptPath,
        byModel: entry.byModel,
        breakdown: entry.breakdown,
        currentModel: entry.currentModel,
        updatedAt: Date.now()
      }
      this.store.dispatch({
        type: 'costs/usageUpdated',
        payload: { terminalId: sessionId, usage }
      })
    } catch (err) {
      log(
        'cost-tracker',
        `failed to ingest json-claude ${transcriptPath}: ${err instanceof Error ? err.message : err}`
      )
    }
  }

  private backfillAll(): void {
    for (const ev of this.lastStops.values()) this.parseAndDispatchStop(ev)
    const sessions = this.store.getSnapshot().state.jsonClaude.sessions
    for (const sessionId of Object.keys(sessions)) {
      this.parseAndDispatchJsonMode(sessionId)
    }
  }

  private parseIncremental(sessionId: string, path: string): CacheEntry | null {
    let entry = this.cache.get(sessionId)
    if (!entry) {
      entry = newCacheEntry()
      this.cache.set(sessionId, entry)
    }

    let text: string
    try {
      text = readFileSync(path, 'utf-8')
    } catch {
      return entry
    }

    if (text.length < entry.charOffset) {
      // Transcript was truncated or replaced — reset accumulators in place.
      resetCacheEntry(entry)
    }

    if (text.length === entry.charOffset) return entry

    const newChars = text.slice(entry.charOffset)
    // The new chunk may end mid-line; only fold complete lines and let
    // the next call re-read the trailing partial from disk.
    const lastNewline = newChars.lastIndexOf('\n')
    if (lastNewline === -1) return entry

    const completeChars = newChars.slice(0, lastNewline)

    if (entry.format === null) {
      const firstLine = completeChars.split('\n').find((l) => l.trim())
      if (firstLine) entry.format = detectFormat(firstLine)
    }

    if (entry.format === 'codex') {
      foldCodexLines(completeChars, entry)
    } else if (entry.format === 'claude') {
      foldClaudeLines(completeChars, entry)
    }

    entry.charOffset += lastNewline + 1
    return entry
  }
}

function jsonClaudeTranscriptPath(worktreePath: string, sessionId: string): string {
  return join(
    claudeProjectsDirFor(worktreePath),
    worktreePath.replace(/[^a-zA-Z0-9]/g, '-'),
    `${sessionId}.jsonl`
  )
}

