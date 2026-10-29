import {
  watch,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  unlinkSync,
  mkdirSync
} from 'fs'
import { join } from 'path'
import type { PtyStatus } from './pty-manager'
import type { Store } from './store'
import { log } from './debug'
import { getAgent } from './agents'
import { findTabById } from '../shared/state/terminals'

// This path is also the signature we use to recognize Ness-installed
// hook entries when deduping at install time. If you change it, update
// HARNESS_HOOK_COMMAND_SIGNATURE in src/main/agents/{claude,codex,cursor}.ts
// to match, or older installed entries become unrecognizable and
// re-installs will append duplicates.
const STATUS_DIR = '/tmp/harness-status'

export interface PendingTool {
  name: string
  input: Record<string, unknown>
}

// Emit a bash command that appends one NDJSON line per event to the
// terminal's log file at /tmp/harness-status/<id>.ndjson. The line wraps
// the full stdin payload Claude Code sends to the hook, so the main process
// has access to the raw event and can do all classification in TypeScript.
//
// Gated on $HARNESS_TERMINAL_ID / $CLAUDE_HARNESS_ID — these are only set
// by PtyManager when it spawns a terminal on our behalf. Sessions started
// outside Ness (plain `claude` in a terminal, CI, etc.) hit the exit 0
// on the first line and do nothing. That inert-by-default behavior is why
// a global user-scope install is safe.
//
// POSIX only — no jq, no python. The bash reads stdin into a shell var,
// defaults empty to `null`, then emits a single printf writing one line to
// the append-mode file. A single write(2) under PIPE_BUF (4096 bytes) is
// guaranteed atomic vs. other O_APPEND writers on POSIX.
export function makeHookCommand(event: string): string {
  // mkdir -p on the append target's dirname (not just $d) so a legacy
  // $h with embedded slashes — e.g. `shell-/Users/…/wt-<ts>` from older
  // panes.json — still resolves to a creatable path instead of ENOENT.
  // Current IDs are sanitized at generation, but this keeps existing
  // installs quiet on the next boot's hook re-install.
  const inner =
    `h="${'$HARNESS_TERMINAL_ID'}"; [ -z "$h" ] && h="$CLAUDE_HARNESS_ID"; [ -z "$h" ] && exit 0; ` +
    `d=${STATUS_DIR}; f="$d/$h.ndjson"; mkdir -p "$(dirname "$f")"; ` +
    `p=$(cat); [ -z "$p" ] && p=null; ` +
    `printf "{\\"event\\":\\"${event}\\",\\"ts\\":%s,\\"payload\\":%s}\\n" ` +
    `"$(date +%s)" "$p" >> "$f"`
  return `bash -c '${inner}'`
}

interface HookEvent {
  event: string
  ts: number
  payload: Record<string, unknown> | null
}

// Most recently seen PreToolUse tool info per terminal. Used as a fallback
// source of `tool_name`/`tool_input` when a permission_prompt Notification
// arrives without those fields embedded in its own payload.
const lastPreTool = new Map<string, PendingTool>()

interface StatusUpdate {
  status: PtyStatus
  pendingTool: PendingTool | null
}

function readPendingTool(p: Record<string, unknown> | null): PendingTool | null {
  if (!p) return null
  const name = p.tool_name ?? p.toolName
  if (typeof name !== 'string' || !name) return null
  const rawInput = p.tool_input ?? p.toolInput
  const input =
    rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : {}
  return { name, input }
}

function normalizeHookEvent(event: string): string {
  switch (event) {
    case 'preToolUse':
      return 'PreToolUse'
    case 'postToolUse':
      return 'PostToolUse'
    case 'beforeSubmitPrompt':
      return 'UserPromptSubmit'
    case 'stop':
      return 'Stop'
    case 'sessionStart':
      return 'SessionStart'
    default:
      return event
  }
}

function deriveStatus(terminalId: string, ev: HookEvent): StatusUpdate | null {
  // Cursor's preToolUse fires when the agent has picked a tool but BEFORE
  // Cursor decides whether to auto-run it or block on the TUI approval
  // prompt — and it never emits a separate "asking user" event the way
  // Claude does (Notification/permission_prompt). So for Cursor's raw
  // camelCase event, treat preToolUse as needs-approval; auto-approved
  // tools flip back to processing when postToolUse fires a moment later.
  // Claude/Codex PreToolUse (PascalCase) keeps its original meaning:
  // approval already happened, tool is about to run → processing.
  if (ev.event === 'preToolUse') {
    const tool = readPendingTool(ev.payload)
    if (tool) lastPreTool.set(terminalId, tool)
    return { status: 'needs-approval', pendingTool: tool }
  }
  switch (normalizeHookEvent(ev.event)) {
    case 'PreToolUse': {
      const tool = readPendingTool(ev.payload)
      if (tool) lastPreTool.set(terminalId, tool)
      return { status: 'processing', pendingTool: null }
    }
    case 'UserPromptSubmit':
    case 'PostToolUse':
      return { status: 'processing', pendingTool: null }
    case 'Stop':
      return { status: 'waiting', pendingTool: null }
    case 'Notification': {
      const p = ev.payload as Record<string, unknown> | null
      const t = p?.notification_type
      if (t === 'permission_prompt' || t === 'elicitation_dialog') {
        const fromNotification = readPendingTool(p)
        const pendingTool = fromNotification ?? lastPreTool.get(terminalId) ?? null
        return { status: 'needs-approval', pendingTool }
      }
      if (t === 'idle_prompt') return { status: 'waiting', pendingTool: null }
      return null
    }
    default:
      return null
  }
}

// Per-terminal byte offset into the NDJSON log. Tail from here on each
// fs.watch firing; advance to EOF after successful read.
const offsets = new Map<string, number>()
// Left-over partial line from the last read (in case a write lands
// between our read and the newline flush). Keyed by terminal id.
const residual = new Map<string, string>()
// Last session ID dispatched per terminal. Every hook payload carries one, so
// this dedups the steady-state case while still catching the ID actually
// changing under a live terminal (Claude's `/clear` starts a new session).
const lastSessionId = new Map<string, string>()

export interface StopEvent {
  terminalId: string
  sessionId: string
  transcriptPath: string
  ts: number
}

type StopListener = (ev: StopEvent) => void
const stopListeners = new Set<StopListener>()

/** Subscribe to Stop hook events with their raw payload (notably
 *  transcript_path). Used by CostTracker to know when to re-tail a
 *  session jsonl. Returns an unsubscribe fn. */
export function onStopEvent(listener: StopListener): () => void {
  stopListeners.add(listener)
  return () => {
    stopListeners.delete(listener)
  }
}

const sessionStartListeners = new Set<(terminalId: string) => void>()

/** Subscribe to SessionStart hook events. The agent's TUI is starting up
 *  with nothing in flight — the only "ready for input" signal a freshly
 *  launched or resumed session gives before its first turn (Stop covers
 *  every later one). Returns an unsubscribe fn. */
export function onSessionStartEvent(listener: (terminalId: string) => void): () => void {
  sessionStartListeners.add(listener)
  return () => {
    sessionStartListeners.delete(listener)
  }
}

function emitSessionStartIfRelevant(terminalId: string, ev: HookEvent): void {
  if (normalizeHookEvent(ev.event) !== 'SessionStart') return
  for (const l of sessionStartListeners) {
    try {
      l(terminalId)
    } catch (err) {
      log('hooks', 'session-start listener error', err instanceof Error ? err.message : err)
    }
  }
}

function emitStopIfRelevant(terminalId: string, ev: HookEvent): void {
  if (ev.event !== 'Stop') return
  const p = ev.payload as Record<string, unknown> | null
  if (!p) return
  const sessionId = p.session_id
  const transcriptPath = p.transcript_path
  if (typeof sessionId !== 'string' || typeof transcriptPath !== 'string') return
  const payload: StopEvent = { terminalId, sessionId, transcriptPath, ts: ev.ts }
  for (const l of stopListeners) {
    try {
      l(payload)
    } catch (err) {
      log('hooks', 'stop listener error', err instanceof Error ? err.message : err)
    }
  }
}

// Exported for testing. Reads newly-appended NDJSON records and dispatches
// the derived status transitions. See the first-touch comment below for the
// boot-replay guard this function encodes.
export function tailLog(terminalId: string, store: Store): void {
  const path = join(STATUS_DIR, `${terminalId}.ndjson`)
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return
  }
  try {
    const { size } = fstatSync(fd)
    // First touch of this terminal in this process. The .ndjson survives app
    // restarts in /tmp but `offsets` does not, so a naive read from 0 would
    // replay the terminal's entire hook history (thousands of events) and
    // dispatch a status change per record — a synchronous boot-time store
    // storm. We only ever need the *current* status, which the last record
    // already encodes, so on first touch we skip straight to the tail.
    const firstTouch = !offsets.has(terminalId)
    let off = offsets.get(terminalId) ?? 0
    if (size < off) {
      // File was truncated or replaced — start over.
      off = 0
      residual.delete(terminalId)
    }
    if (size === off) return
    const len = size - off
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, off)
    offsets.set(terminalId, size)

    const text = (residual.get(terminalId) ?? '') + buf.toString('utf-8')
    const allLines = text.split('\n')
    // Last chunk may be a partial line; stash it for next read.
    const tail = allLines.pop() ?? ''
    if (tail) residual.set(terminalId, tail)
    else residual.delete(terminalId)

    // On first touch, process only the final complete record (current
    // status); on subsequent tails, process every newly-appended line.
    const lines = firstTouch ? allLines.slice(-1) : allLines

    for (const line of lines) {
      if (!line.trim()) continue
      let ev: HookEvent
      try {
        ev = JSON.parse(line) as HookEvent
      } catch (err) {
        log('hooks', `parse error for ${terminalId}: ${err instanceof Error ? err.message : err}`, line)
        continue
      }
      log('hooks', `event terminal=${terminalId} event=${ev.event}`)
      // Track the agent-assigned session ID from every hook event that
      // carries one. Per-agent extractors keep field names (session_id vs
      // conversation_id) out of shared code, so a coincidental collision in
      // one agent's payload can't be misread as another agent's session ID.
      if (ev.payload) {
        const tab = findTabById(store.getSnapshot().state.terminals.panes, terminalId)
        const agent = tab?.agentKind ? getAgent(tab.agentKind) : null
        const sid = agent?.extractSessionId?.(ev.payload as Record<string, unknown>) ?? null
        if (sid && lastSessionId.get(terminalId) !== sid) {
          lastSessionId.set(terminalId, sid)
          store.dispatch({
            type: 'terminals/sessionIdDiscovered',
            payload: { terminalId, sessionId: sid }
          })
        }
      }
      emitStopIfRelevant(terminalId, ev)
      emitSessionStartIfRelevant(terminalId, ev)
      const update = deriveStatus(terminalId, ev)
      if (update) {
        store.dispatch({
          type: 'terminals/statusChanged',
          payload: {
            id: terminalId,
            status: update.status,
            pendingTool: update.pendingTool
          }
        })
      }
    }
  } finally {
    closeSync(fd)
  }
}

/** Watch the status directory and dispatch terminal status transitions
 *  through the main-process store. The store's event transport fans the
 *  events out to every client that subscribes. */
export function watchStatusDir(store: Store): () => void {
  mkdirSync(STATUS_DIR, { recursive: true })

  log('hooks', `watching status dir: ${STATUS_DIR}`)

  const watcher = watch(STATUS_DIR, (_eventType, filename) => {
    if (!filename || !filename.endsWith('.ndjson')) return
    if (filename.startsWith('.')) return
    const terminalId = filename.replace(/\.ndjson$/, '')
    try {
      tailLog(terminalId, store)
    } catch (err) {
      log('hooks', `tail failed for ${terminalId}`, err instanceof Error ? err.message : err)
    }
  })

  return () => watcher.close()
}

/** Called on terminal death — drop the log file and reset tailing state. */
export function cleanupTerminalLog(terminalId: string): void {
  offsets.delete(terminalId)
  residual.delete(terminalId)
  lastPreTool.delete(terminalId)
  lastSessionId.delete(terminalId)
  try {
    unlinkSync(join(STATUS_DIR, `${terminalId}.ndjson`))
  } catch {
    // file may not exist; ignore
  }
}
