// Approval bridge between Ness main and the permission-prompt MCP
// server that Claude Code invokes for every per-tool approval in a
// JSON-mode session.
//
// Per-session flow:
//   1. JsonClaudeManager asks the bridge for a socket path at spawn time.
//      We mint one under os.tmpdir() and pass it to the MCP subprocess
//      via HARNESS_APPROVAL_SOCKET.
//   2. The MCP subprocess connects to that socket whenever Claude Code
//      triggers an approval. It writes an NDJSON request frame and waits
//      for a response on the same socket.
//   3. We dispatch the request to the store as jsonClaude/approvalRequested
//      and remember (requestId -> socket) so we can push the user's answer
//      back out once the renderer calls jsonClaude:resolveApproval.
//
// Sockets are ephemeral — each approval opens one, gets one reply, and
// closes. One server per session, destroyed when the session dies.

import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, existsSync, unlinkSync } from 'node:fs'
import type { Store } from './store'
import {
  QUESTION_TOOL_NAME,
  type JsonClaudePendingApproval
} from '../shared/state/json-claude'
import { log } from './debug'
import { autoReview, checkDenyList } from './auto-approver'
import type { AutoReviewStatus } from '../shared/state/json-claude'
import { findMatchingRule, ruleKey } from '../shared/permission-match'

interface ApprovalResult {
  behavior: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
  updatedPermissions?: unknown[]
  message?: string
  interrupt?: boolean
}

interface RequestFrame {
  type?: string
  id?: string
  sessionId?: string
  tool_name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  timestamp?: number
}

interface PendingSocket {
  socket: Socket
  sessionId: string
  /** Full request payload stashed so a re-review (triggered from the
   *  approval card after the user edits steering guidance) can rebuild
   *  the prompt without crossing slice boundaries. */
  payload: JsonClaudePendingApproval
}

interface SessionEntry {
  server: Server
  socketPath: string
}

export interface ApprovalBridgeDeps {
  /** Reads the current claudeCommand setting on demand so toggling it in
   *  Settings takes effect for the next auto-review without a restart. */
  getClaudeCommand: () => string
  /** Reads the current autoApprovePermissions setting on demand. When
   *  false the bridge skips auto-review entirely and dispatches the
   *  approvalRequested event directly. */
  isAutoApproveEnabled: () => boolean
  /** Reads the current autoApproveSteerInstructions setting on demand.
   *  Appended to the reviewer's policy prompt as project-specific
   *  guidance. Empty string when unset. */
  getAutoApproveSteerInstructions: () => string
}

export class ApprovalBridge {
  private store: Store
  private sessions = new Map<string, SessionEntry>()
  private pendingResponses = new Map<string, PendingSocket>()
  private deps: ApprovalBridgeDeps | null

  constructor(store: Store, deps?: ApprovalBridgeDeps) {
    this.store = store
    this.deps = deps ?? null
  }

  /** Open a Unix domain socket dedicated to `sessionId`. Returns the path
   *  the MCP subprocess should be launched with (via
   *  HARNESS_APPROVAL_SOCKET). Safe to call more than once for the same
   *  session — returns the existing path. */
  startSession(sessionId: string): string {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing.socketPath

    const dir = mkdtempSync(join(tmpdir(), 'harness-approval-'))
    const socketPath = join(dir, 'sock')

    const server = createServer((socket) => {
      this.handleConnection(sessionId, socket)
    })
    server.on('error', (err) => {
      log('approval-bridge', `server error session=${sessionId}`, err.message)
    })
    try {
      server.listen(socketPath)
    } catch (err) {
      log(
        'approval-bridge',
        `listen failed session=${sessionId}`,
        err instanceof Error ? err.message : String(err)
      )
    }

    this.sessions.set(sessionId, { server, socketPath })
    return socketPath
  }

  stopSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    this.sessions.delete(sessionId)

    // Drop any pending sockets attached to this session with a deny so
    // the MCP server doesn't hang its model turn on an abandoned request.
    for (const [id, pending] of Array.from(this.pendingResponses.entries())) {
      if (pending.sessionId !== sessionId) continue
      this.writeResponse(pending.socket, id, {
        behavior: 'deny',
        message: 'session ended before approval resolved'
      })
      this.pendingResponses.delete(id)
      this.store.dispatch({
        type: 'jsonClaude/approvalResolved',
        payload: { requestId: id }
      })
    }

    try {
      entry.server.close()
    } catch {
      /* ignore */
    }
    if (existsSync(entry.socketPath)) {
      try {
        unlinkSync(entry.socketPath)
      } catch {
        /* ignore */
      }
    }
  }

  stopAll(): void {
    for (const id of Array.from(this.sessions.keys())) this.stopSession(id)
  }

  /** Deny every pending approval attached to `sessionId` and drop them
   *  from the slice. Unlike stopSession, the per-session server keeps
   *  listening — the caller is either doing a kill+respawn (rewind), in
   *  which case a fresh MCP connection lands on the same socket, or
   *  abandoning the current turn on a live subprocess (interrupt-and-
   *  send). `reason` is the denial message Claude sees. Mirrors the deny
   *  loop in stopSession. */
  cancelPendingForSession(sessionId: string, reason = 'session rewound'): void {
    for (const [id, pending] of Array.from(this.pendingResponses.entries())) {
      if (pending.sessionId !== sessionId) continue
      this.writeResponse(pending.socket, id, {
        behavior: 'deny',
        message: reason
      })
      this.pendingResponses.delete(id)
      this.store.dispatch({
        type: 'jsonClaude/approvalResolved',
        payload: { requestId: id }
      })
    }
  }

  /** Dispatched from the renderer-facing IPC handler. Push the user's
   *  chosen PermissionResult back out over the waiting socket. */
  resolveApproval(requestId: string, result: ApprovalResult): boolean {
    const pending = this.pendingResponses.get(requestId)
    if (!pending) return false
    this.pendingResponses.delete(requestId)
    this.writeResponse(pending.socket, requestId, result)
    this.store.dispatch({
      type: 'jsonClaude/approvalResolved',
      payload: { requestId }
    })
    return true
  }

  /** Triggered from the approval card when the user edits the steering
   *  guidance and clicks "Save & re-review". Resets the pending entry's
   *  autoReview state back to 'pending' (so the spinner reappears) and
   *  spawns a fresh Haiku oneshot. The freshly-saved guidance is read
   *  on every call inside runAutoReviewer via the deps closure, so this
   *  picks up the new text automatically. */
  rerunAutoApprovalReview(requestId: string): boolean {
    const pending = this.pendingResponses.get(requestId)
    if (!pending) return false
    if (!this.deps?.isAutoApproveEnabled()) return false

    const refreshedPayload: JsonClaudePendingApproval = {
      ...pending.payload,
      autoReview: { state: 'pending' }
    }
    this.pendingResponses.set(requestId, {
      ...pending,
      payload: refreshedPayload
    })
    this.store.dispatch({
      type: 'jsonClaude/approvalRequested',
      payload: refreshedPayload
    })
    log(
      'approval-bridge',
      `re-running auto-review session=${pending.sessionId} id=${requestId} tool=${refreshedPayload.toolName}`
    )
    void this.runAutoReviewer(refreshedPayload, pending.socket)
    return true
  }

  private handleConnection(sessionId: string, socket: Socket): void {
    let buf = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buf += chunk
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        this.handleFrame(sessionId, socket, line)
      }
    })
    socket.on('error', (err) => {
      log('approval-bridge', `socket error session=${sessionId}`, err.message)
    })
    socket.on('close', () => {
      // If the MCP server disappears before we answer, drop the pending
      // entry so a never-answered approval doesn't linger forever.
      for (const [id, pending] of Array.from(this.pendingResponses.entries())) {
        if (pending.socket === socket) {
          this.pendingResponses.delete(id)
          this.store.dispatch({
            type: 'jsonClaude/approvalResolved',
            payload: { requestId: id }
          })
        }
      }
    })
  }

  /** Allow a request without surfacing a card, and record the decision so
   *  the tool card can render a provenance badge. `rule` is the display
   *  form of the persistent grant that fired, omitted for session-scoped
   *  grants. */
  private resolveAllowed(
    socket: Socket,
    requestId: string,
    base: { sessionId: string; toolName: string; toolUseId?: string; input: Record<string, unknown> },
    rule?: string
  ): void {
    this.writeResponse(socket, requestId, {
      behavior: 'allow',
      updatedInput: base.input
    })
    if (!base.toolUseId) return
    this.store.dispatch({
      type: 'jsonClaude/approvalSessionAllowed',
      payload: {
        sessionId: base.sessionId,
        toolUseId: base.toolUseId,
        toolName: base.toolName,
        timestamp: Date.now(),
        ...(rule ? { rule } : {})
      }
    })
  }

  private handleFrame(sessionId: string, socket: Socket, line: string): void {
    let frame: RequestFrame
    try {
      frame = JSON.parse(line) as RequestFrame
    } catch (err) {
      log(
        'approval-bridge',
        `bad frame session=${sessionId}`,
        err instanceof Error ? err.message : String(err)
      )
      return
    }
    if (frame.type !== 'request' || !frame.id || !frame.tool_name) {
      log('approval-bridge', `ignoring frame session=${sessionId} type=${frame.type}`)
      return
    }

    const basePayload = {
      requestId: frame.id,
      sessionId: frame.sessionId || sessionId,
      toolName: frame.tool_name,
      input: frame.input || {},
      toolUseId: frame.tool_use_id,
      timestamp: frame.timestamp || Date.now()
    }

    // AskUserQuestion carries the user's answers back in the approval
    // response itself, so it must always reach a human — see
    // QUESTION_TOOL_NAME. Bail out above both auto-resolve paths.
    const isQuestion = basePayload.toolName === QUESTION_TOOL_NAME

    // Two explicit-user-grant paths, both checked before the LLM
    // auto-reviewer because a grant the user made by hand is cheaper and
    // more authoritative than a Haiku call:
    //
    //   1. The persistent global allowlist ("Always allow"). Lives in
    //      Ness's own config, so it applies across every worktree and
    //      repo — unlike Claude's per-worktree settings.local.json, which
    //      is what this replaced.
    //   2. The session-scoped set ("Allow {tool} this session").
    const rootState = this.store.getSnapshot().state
    if (!isQuestion) {
      const matched = findMatchingRule(
        rootState.permissions.rules,
        basePayload.toolName,
        basePayload.input
      )
      if (matched) {
        const key = ruleKey(matched)
        this.resolveAllowed(socket, frame.id, basePayload, key)
        log(
          'approval-bridge',
          `rule-allowed session=${basePayload.sessionId} id=${frame.id} tool=${basePayload.toolName} rule=${key}`
        )
        return
      }
    }

    const slice = rootState.jsonClaude
    const session = slice.sessions[basePayload.sessionId]
    if (!isQuestion && session?.sessionToolApprovals.includes(basePayload.toolName)) {
      this.resolveAllowed(socket, frame.id, basePayload)
      log(
        'approval-bridge',
        `session-allowed session=${basePayload.sessionId} id=${frame.id} tool=${basePayload.toolName}`
      )
      return
    }

    // Decide the initial autoReview status synchronously so the prompt
    // opens with the right chrome on first paint:
    //   - feature off            → no autoReview field, plain prompt.
    //   - deny-list match        → finished/ask, with the deny reason.
    //   - otherwise              → pending (spinner) + Haiku spawned below.
    const enabled = (this.deps?.isAutoApproveEnabled() ?? false) && !isQuestion
    let autoReview: AutoReviewStatus | undefined
    let denyReason: string | null = null
    if (enabled) {
      denyReason = checkDenyList(basePayload.toolName, basePayload.input)
      autoReview = denyReason
        ? { state: 'finished', decision: 'ask', reason: denyReason }
        : { state: 'pending' }
    }

    const payload: JsonClaudePendingApproval = { ...basePayload, autoReview }
    this.pendingResponses.set(frame.id, {
      socket,
      sessionId: payload.sessionId,
      payload
    })
    this.store.dispatch({ type: 'jsonClaude/approvalRequested', payload })
    log(
      'approval-bridge',
      `approvalRequested session=${payload.sessionId} id=${frame.id} tool=${frame.tool_name}` +
        (autoReview ? ` autoReview=${autoReview.state}` : '')
    )

    if (enabled && !denyReason) {
      void this.runAutoReviewer(payload, socket)
    }
  }

  /** Background Haiku call. Runs in parallel with the user-facing
   *  prompt. If the user clicks Allow/Deny first, resolveApproval()
   *  removes the request from pendingResponses and writes the socket;
   *  this function then sees the entry is gone and silently bails.
   *  Otherwise it either resolves the request itself (approve) or
   *  surfaces the reviewer's reason (ask) so the prompt becomes
   *  static text instead of a spinner. */
  private async runAutoReviewer(
    payload: JsonClaudePendingApproval,
    socket: Socket
  ): Promise<void> {
    const claudeCommand = this.deps?.getClaudeCommand() ?? 'claude'
    const steerInstructions =
      this.deps?.getAutoApproveSteerInstructions() ?? ''
    let decision
    try {
      decision = await autoReview(payload.toolName, payload.input, {
        claudeCommand,
        steerInstructions
      })
    } catch (err) {
      log(
        'approval-bridge',
        `auto-review threw session=${payload.sessionId} id=${payload.requestId}`,
        err instanceof Error ? err.message : String(err)
      )
      decision = { kind: 'ask' as const, reason: 'auto-review failed' }
    }

    // Race check: did the user resolve manually while we were waiting?
    const stillPending = this.pendingResponses.get(payload.requestId)
    if (!stillPending || stillPending.socket !== socket) {
      log(
        'approval-bridge',
        `auto-review superseded session=${payload.sessionId} id=${payload.requestId} decision=${decision.kind}`
      )
      return
    }

    if (decision.kind === 'approve') {
      this.pendingResponses.delete(payload.requestId)
      this.writeResponse(socket, payload.requestId, {
        behavior: 'allow',
        updatedInput: payload.input
      })
      this.store.dispatch({
        type: 'jsonClaude/approvalResolved',
        payload: { requestId: payload.requestId }
      })
      if (payload.toolUseId) {
        this.store.dispatch({
          type: 'jsonClaude/approvalAutoApproved',
          payload: {
            sessionId: payload.sessionId,
            toolUseId: payload.toolUseId,
            model: decision.model,
            reason: decision.reason,
            timestamp: Date.now()
          }
        })
      }
      log(
        'approval-bridge',
        `auto-approved session=${payload.sessionId} id=${payload.requestId} tool=${payload.toolName} reason="${decision.reason}"`
      )
      return
    }

    this.store.dispatch({
      type: 'jsonClaude/approvalAutoReviewFinished',
      payload: {
        requestId: payload.requestId,
        decision: 'ask',
        reason: decision.reason
      }
    })
    log(
      'approval-bridge',
      `auto-review ask session=${payload.sessionId} id=${payload.requestId} tool=${payload.toolName} reason="${decision.reason}"`
    )
  }

  private writeResponse(socket: Socket, id: string, result: ApprovalResult): void {
    try {
      socket.write(JSON.stringify({ type: 'response', id, result }) + '\n')
    } catch (err) {
      log(
        'approval-bridge',
        `write response failed id=${id}`,
        err instanceof Error ? err.message : String(err)
      )
    }
  }
}
