// Keeps the contextWindow slice fresh for both kinds of agent tab.
//
// The two tab types reach Claude by different routes but leave the same
// artifact, so this tracker only needs one analyzer:
//   - terminal tabs (xterm-hosted `claude`) fire the Stop hook, which
//     hands us `transcript_path` directly.
//   - chat tabs (json-mode) have hooks scrubbed, so we key off the
//     `jsonClaude/busyChanged -> false` boundary and derive the path from
//     worktreePath + sessionId, the same encoding claude uses.
//
// Same interest-gating as CostTracker: the panel is collapsed by default,
// and re-analyzing a multi-megabyte transcript on every turn for a panel
// nobody has open is pure waste. While no client is interested this does
// nothing but remember the last Stop per terminal, so opening the panel
// can backfill without waiting for another turn.
//
// Unlike CostTracker this cannot parse incrementally. Context occupancy
// is a property of the live era, and a compaction retroactively deletes
// most of what came before it — there's no forward-only fold that
// survives that. Full reparse is affordable because it's gated on the
// panel being open and measures 18-140ms on 9-50MB transcripts.

import { existsSync, readFileSync, statSync } from 'fs'
import { claudeConfigDirFor, claudeProjectsDirFor } from './claude-env'
import { join } from 'path'
import type { Store } from './store'
import type { StateEvent } from '../shared/state'
import { onStopEvent, type StopEvent } from './hooks'
import {
  findLeafByTabId,
  findTabById,
  getLeaves,
  isClaudeBackedTab
} from '../shared/state/terminals'
import type { ContextSnapshot } from '../shared/state/context-window'
import { analyzeContext } from './context-window'
import { latestSessionId } from './agents/claude'
import { log } from './debug'

/** Same path encoding claude uses for its own session files. */
function transcriptPathFor(worktreePath: string, sessionId: string): string {
  return join(
    claudeProjectsDirFor(worktreePath),
    worktreePath.replace(/[^a-zA-Z0-9]/g, '-'),
    `${sessionId}.jsonl`
  )
}

/** Byte size of the CLAUDE.md files claude would have loaded for this
 *  worktree. Only the size matters — the analyzer uses it to carve a
 *  memory-file estimate out of the system-prompt residual, since the API
 *  never reports that separately. */
function memoryCharsFor(worktreePath: string): number {
  let total = 0
  for (const p of [
    join(worktreePath, 'CLAUDE.md'),
    join(worktreePath, '.claude', 'CLAUDE.md'),
    join(claudeConfigDirFor(worktreePath), 'CLAUDE.md')
  ]) {
    try {
      if (existsSync(p)) total += statSync(p).size
    } catch {
      /* unreadable — just don't count it */
    }
  }
  return total
}

export class ContextTracker {
  private unsubscribeHook: (() => void) | null = null
  private unsubscribeStore: (() => void) | null = null
  private interestedClients = new Set<string>()
  private lastStops = new Map<string, StopEvent>()

  constructor(private store: Store) {}

  start(): void {
    this.unsubscribeHook = onStopEvent((ev) => this.handleStop(ev))
    this.unsubscribeStore = this.store.subscribe((event) => this.handleStoreEvent(event))
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
    // Codex and Cursor fire Stop hooks too, but `transcript_path` then
    // points at their own format — analyzeContext would read it as Claude
    // jsonl and produce confident nonsense. Drop it before it's recorded,
    // so backfillAll can't resurrect it later either.
    if (!this.isClaudeBacked(ev.terminalId)) return
    this.lastStops.set(ev.terminalId, ev)
    if (this.interestedClients.size === 0) return
    this.analyzeAndDispatch(
      ev.terminalId,
      ev.sessionId,
      ev.transcriptPath,
      this.worktreeForTerminal(ev.terminalId)
    )
  }

  private isClaudeBacked(terminalId: string): boolean {
    return isClaudeBackedTab(
      findTabById(this.store.getSnapshot().state.terminals.panes, terminalId)
    )
  }

  private handleStoreEvent(event: StateEvent): void {
    if (event.type === 'jsonClaude/busyChanged' && event.payload.busy === false) {
      this.refreshJsonMode(event.payload.sessionId)
      return
    }
    if (event.type === 'jsonClaude/sessionStarted') {
      this.refreshJsonMode(event.payload.sessionId)
      return
    }
    if (event.type === 'terminals/removed') {
      this.lastStops.delete(event.payload)
      this.store.dispatch({
        type: 'contextWindow/terminalCleared',
        payload: { terminalId: event.payload }
      })
    }
  }

  private refreshJsonMode(sessionId: string): void {
    if (this.interestedClients.size === 0) return
    const session = this.store.getSnapshot().state.jsonClaude.sessions[sessionId]
    if (!session) return
    // Chat tabs pin the tab id as the claude session id, so terminalId
    // and sessionId are the same value here.
    this.analyzeAndDispatch(
      sessionId,
      sessionId,
      transcriptPathFor(session.worktreePath, sessionId),
      session.worktreePath
    )
  }

  /** Worktree that owns a terminal tab, for locating its CLAUDE.md. */
  private worktreeForTerminal(terminalId: string): string | null {
    const panes = this.store.getSnapshot().state.terminals.panes
    for (const [worktreePath, tree] of Object.entries(panes)) {
      if (findLeafByTabId(tree, terminalId)) return worktreePath
    }
    return null
  }

  private analyzeAndDispatch(
    terminalId: string,
    sessionId: string,
    transcriptPath: string,
    worktreePath: string | null
  ): void {
    let raw: string
    try {
      raw = readFileSync(transcriptPath, 'utf-8')
    } catch {
      // Transcript not written yet (first turn) — nothing to report, and
      // the next turn boundary will pick it up.
      return
    }
    try {
      const analysis = analyzeContext(raw, worktreePath ? memoryCharsFor(worktreePath) : 0)
      const snapshot: ContextSnapshot = {
        sessionId,
        transcriptPath,
        model: analysis.model,
        limit: analysis.limit,
        usedTokens: analysis.usedTokens,
        categories: analysis.categories,
        autocompactAt: analysis.autocompactAt,
        compactions: analysis.compactions,
        discoverableTools: analysis.discoverableTools,
        measured: analysis.measured,
        updatedAt: Date.now()
      }
      this.store.dispatch({
        type: 'contextWindow/snapshotUpdated',
        payload: { terminalId, snapshot }
      })
    } catch (err) {
      log(
        'context-tracker',
        `failed to analyze ${transcriptPath}: ${err instanceof Error ? err.message : err}`
      )
    }
  }

  /** Re-analyze everything we know about. Runs when the first client
   *  opens the panel, so it populates without waiting for a turn. */
  private backfillAll(): void {
    for (const ev of this.lastStops.values()) {
      this.analyzeAndDispatch(
        ev.terminalId,
        ev.sessionId,
        ev.transcriptPath,
        this.worktreeForTerminal(ev.terminalId)
      )
    }
    const state = this.store.getSnapshot().state
    for (const sessionId of Object.keys(state.jsonClaude.sessions)) {
      this.refreshJsonMode(sessionId)
    }
    // Terminal tabs that haven't fired a Stop this run (app restarted
    // mid-session) still have a transcript on disk.
    //
    // A transcript belongs to exactly one tab, so claim them: the
    // latestSessionId fallback below would otherwise hand the same file to
    // every session-id-less tab in a worktree, and showing two tabs the
    // same wrong numbers is worse than showing one of them nothing. Tabs
    // that lose the race stay empty until their first Stop event, which
    // tells us their real transcript.
    const claimed = new Set<string>()
    for (const ev of this.lastStops.values()) claimed.add(ev.transcriptPath)

    for (const [worktreePath, tree] of Object.entries(state.terminals.panes)) {
      for (const leaf of getLeaves(tree)) {
        for (const tab of leaf.tabs) {
          if (tab.type !== 'agent') continue
          // Without this, a Codex or Cursor tab in a worktree that also
          // has Claude history would adopt Claude's transcript via the
          // latestSessionId fallback below and show another agent's
          // numbers as its own.
          if (!isClaudeBackedTab(tab)) continue
          if (this.lastStops.has(tab.id)) continue
          const cwd = tab.cwd || worktreePath
          // Prefer the tab's own session id, but fall back to the most
          // recent transcript in the worktree. Tabs created before session
          // ids were assigned — and tabs whose id changed under `/clear`
          // before any hook fired — have no sessionId, and without this
          // fallback the panel stays empty for them forever.
          const own =
            tab.sessionId && existsSync(transcriptPathFor(cwd, tab.sessionId))
              ? tab.sessionId
              : null
          const sessionId = own ?? latestSessionId(cwd)
          if (!sessionId) continue
          const path = transcriptPathFor(cwd, sessionId)
          if (!existsSync(path) || claimed.has(path)) continue
          claimed.add(path)
          this.analyzeAndDispatch(tab.id, sessionId, path, cwd)
        }
      }
    }
  }
}
