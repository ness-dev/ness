// Records how each agent tab's turn ended, for the sidebar inbox.
//
// A turn ends when a tab's status moves into 'waiting' from something
// that isn't already 'waiting'. That's the one signal every agent tab
// shares — Chat tabs get it from JsonClaudeStatusDeriver (busy → false),
// terminal tabs from the Stop hook. What we can say about the turn
// depends on the tab:
//
//   - Chat tabs: main holds the full entries, so the last top-level
//     assistant message is classified directly.
//   - Terminal Claude tabs: the Stop hook payload carries
//     `transcript_path`, and hooks.ts fires `onStopEvent` before it
//     dispatches the 'waiting' status, so the path is known by the time
//     the transition arrives. The jsonl tail is read off the hot path.
//   - Terminal Codex / Cursor tabs: their transcripts are another format,
//     so the turn is recorded as plain 'finished' with no text.
//
// Every dispatch is scoped to the one tab the event names, and status
// transitions are deduped against a per-tab cache, so a streaming chat
// costs nothing here (CLAUDE.md anti-patterns #1 and #2).

import { open } from 'fs/promises'
import type { Store } from './store'
import type { AppState, StateEvent } from '../shared/state'
import {
  findLeafByTabId,
  getLeaves,
  isClaudeBackedTab,
  type PtyStatus,
  type TerminalTab
} from '../shared/state/terminals'
import { classifyTurnText } from '../shared/inbox-turn'
import type { InboxTurn } from '../shared/state/inbox'
import { onStopEvent } from './hooks'
import { log } from './debug'

/** Enough to hold the final assistant message of any realistic turn
 *  without reading a multi-megabyte transcript end to end. */
const TRANSCRIPT_TAIL_BYTES = 256 * 1024

function isAgentTab(tab: TerminalTab): boolean {
  return tab.type === 'agent' || tab.type === 'json-claude'
}

/** Text of the last top-level assistant message in a Claude jsonl
 *  transcript tail. Sidechain (sub-agent) lines are skipped — their final
 *  words aren't addressed to the user. Exported for tests. */
export function lastAssistantTextFromJsonl(tail: string): string {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.startsWith('{')) continue
    let rec: {
      type?: string
      isSidechain?: boolean
      message?: { content?: unknown }
    }
    try {
      rec = JSON.parse(line)
    } catch {
      continue // the first line of a tail is usually cut mid-record
    }
    if (rec.type === 'user' && !rec.isSidechain) {
      // A real user prompt (not a tool result) bounds the turn: anything
      // older belongs to an earlier one.
      const content = rec.message?.content
      if (typeof content === 'string') return ''
      if (Array.isArray(content) && content.some((b) => b?.type === 'text')) return ''
      continue
    }
    if (rec.type !== 'assistant' || rec.isSidechain) continue
    const content = rec.message?.content
    if (!Array.isArray(content)) continue
    const text = content
      .filter((b): b is { type: 'text'; text: string } => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim()
    if (text) return text
  }
  return ''
}

async function readTail(path: string): Promise<string> {
  const fh = await open(path, 'r')
  try {
    const { size } = await fh.stat()
    const len = Math.min(size, TRANSCRIPT_TAIL_BYTES)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, size - len)
    return buf.toString('utf-8')
  } finally {
    await fh.close()
  }
}

export class InboxDeriver {
  private unsubscribe: (() => void) | null = null
  private unsubscribeStop: (() => void) | null = null
  private lastStatus = new Map<string, PtyStatus>()
  private transcriptByTab = new Map<string, string>()

  constructor(private store: Store) {}

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribeStop = onStopEvent((ev) => {
      this.transcriptByTab.set(ev.terminalId, ev.transcriptPath)
    })
    this.unsubscribe = this.store.subscribe((event) => this.onEvent(event))
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.unsubscribeStop?.()
    this.unsubscribeStop = null
  }

  private onEvent(event: StateEvent): void {
    switch (event.type) {
      case 'terminals/statusChanged':
        this.onStatus(event.payload.id, event.payload.status)
        return
      case 'terminals/removed':
        this.lastStatus.delete(event.payload)
        return
      case 'terminals/panesForWorktreeChanged':
        this.forgetClosedTabs(event.payload.worktreePath)
        return
      case 'terminals/panesForWorktreeCleared':
        this.forgetClosedTabs(event.payload)
        return
    }
  }

  private onStatus(tabId: string, status: PtyStatus): void {
    const prev = this.lastStatus.get(tabId)
    if (prev === status) return
    this.lastStatus.set(tabId, status)
    const now = Date.now()
    this.store.dispatch({
      type: 'inbox/statusSince',
      payload: { tabId, status, since: now }
    })
    // `prev === undefined` is a status replayed at boot or on respawn, not
    // a turn that just ended — the persisted turn already covers it.
    if (status !== 'waiting' || prev === undefined || prev === 'idle') return
    const state = this.store.getSnapshot().state
    const located = this.locate(state, tabId)
    if (!located) return
    const { worktreePath, tab } = located
    if (!isAgentTab(tab)) return

    if (tab.type === 'json-claude') {
      this.record(tabId, worktreePath, now, this.chatText(state, tabId))
      return
    }
    const transcript = this.transcriptByTab.get(tabId)
    if (!transcript || !isClaudeBackedTab(tab)) {
      this.record(tabId, worktreePath, now, '')
      return
    }
    // Record right away so the row moves the instant the turn ends, then
    // fill in the text once the transcript tail is read.
    this.record(tabId, worktreePath, now, '')
    readTail(transcript)
      .then((tail) => {
        const text = lastAssistantTextFromJsonl(tail)
        if (!text) return
        // A newer turn may have ended while we were reading.
        if (this.store.getSnapshot().state.inbox.turns[tabId]?.endedAt !== now) return
        this.record(tabId, worktreePath, now, text)
      })
      .catch((err) => {
        log('inbox', `transcript read failed for ${tabId}`, err instanceof Error ? err.message : err)
      })
  }

  private chatText(state: AppState, tabId: string): string {
    const entries = state.jsonClaude.sessions[tabId]?.entries ?? []
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]
      if (e.kind === 'user' && !e.isQueued) return ''
      if (e.kind !== 'assistant' || e.parentToolUseId) continue
      const text = (e.blocks ?? [])
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text)
        .join('\n')
        .trim()
      if (text) return text
    }
    return ''
  }

  private record(tabId: string, worktreePath: string, endedAt: number, rawText: string): void {
    const { kind, text } = classifyTurnText(rawText)
    const turn: InboxTurn = { worktreePath, endedAt, kind, text }
    this.store.dispatch({ type: 'inbox/turnEnded', payload: { tabId, turn } })
  }

  private locate(
    state: AppState,
    tabId: string
  ): { worktreePath: string; tab: TerminalTab } | null {
    for (const [worktreePath, tree] of Object.entries(state.terminals.panes)) {
      const leaf = findLeafByTabId(tree, tabId)
      const tab = leaf?.tabs.find((t) => t.id === tabId)
      if (tab) return { worktreePath, tab }
    }
    return null
  }

  /** Drop inbox records for tabs closed in this one worktree. */
  private forgetClosedTabs(worktreePath: string): void {
    const state = this.store.getSnapshot().state
    const tree = state.terminals.panes[worktreePath]
    const live = new Set<string>()
    if (tree) for (const leaf of getLeaves(tree)) for (const t of leaf.tabs) live.add(t.id)
    const gone: string[] = []
    for (const [tabId, turn] of Object.entries(state.inbox.turns)) {
      if (turn.worktreePath === worktreePath && !live.has(tabId)) gone.push(tabId)
    }
    if (gone.length === 0) return
    for (const id of gone) {
      this.lastStatus.delete(id)
      this.transcriptByTab.delete(id)
    }
    this.store.dispatch({ type: 'inbox/tabsForgotten', payload: { tabIds: gone } })
  }
}
