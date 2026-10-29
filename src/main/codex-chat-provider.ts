// The Codex ChatProvider (see chat-provider.ts). Runs the bundled
// `codex app-server` as a long-lived subprocess per chat tab and translates
// its JSON-RPC stream into the shared jsonClaude/* events.
//
// Identity: the tab id / sessionId is Ness's, minted before Codex exists.
// Codex assigns its own thread id on thread/start; we store that on the
// tab as providerSessionId and resume it on every later spawn.
//
// Mapping, live and when seeding history from thread/turns/list:
//   userMessage       → user entry (live ones are appended locally on send)
//   agentMessage      → assistant text block, streamed via deltas
//   reasoning         → assistant thinking block (summary text)
//   commandExecution  → tool_use "Bash" + tool_result
//   fileChange        → tool_use "ApplyPatch" + tool_result (the diffs)
//   mcpToolCall       → tool_use "mcp__<server>__<tool>" + tool_result
//   webSearch         → tool_use "WebSearch"
// Command approvals go through ApprovalBridge as "Bash" with the unwrapped
// command, so the global allowlist and session grants apply to Codex too.
//
// Rewind and fork work at turn granularity: every assistant entry carries
// the Codex turn id, rewind reverts to just after that turn and fork copies
// the thread through it.

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { extname } from 'path'
import type { Store } from './store'
import type {
  JsonClaudeChatEntry,
  JsonClaudeImageRef,
  JsonClaudeMessageBlock,
  JsonClaudePermissionMode,
  JsonClaudeSessionState
} from '../shared/state/json-claude'
import { parseAutomatedMessage } from '../shared/state/json-claude'
import {
  cloneCategories,
  emptyCategories,
  type ContextSnapshot
} from '../shared/state/context-window'
import { AUTOCOMPACT_FRACTION } from '../shared/context-limits'
import { log } from './debug'
import type { ApprovalResult } from './approval-bridge'
import type {
  ChatImageInput,
  ChatProvider,
  ForkOutcome,
  RewindOutcome
} from './chat-provider'
import type { StdioMcpServer } from './ness-control-mcp'
import {
  CodexAppServerClient,
  type CodexFileChange,
  type CodexThreadItem,
  type CodexThreadResponse,
  type CodexTurn,
  type CodexTurnsPage,
  type CodexUserInput
} from './codex-app-server'

interface CodexTokenUsage {
  last?: { totalTokens: number }
  modelContextWindow?: number | null
}

const APPROVAL_POLICY = 'on-request'
const SANDBOX = 'workspace-write'
const DELTA_FLUSH_MS = 30
const RESUME_RETRY_INTERVAL_MS = 250
const RESUME_RETRY_WINDOW_MS = 5000

function isActiveWriterError(reason: string): boolean {
  return /active writer/i.test(reason)
}

export interface CodexChatProviderOptions {
  getBinPath: () => string
  clientVersion: string
  /** The Codex thread id recorded on the tab, if any. */
  getThreadId: (sessionId: string) => string | undefined
  setThreadId: (sessionId: string, threadId: string) => void
  /** Model to request: the tab's override, else the Codex model setting.
   *  Undefined lets Codex use its own configured default. */
  getModel: (modelOverride?: string) => string | undefined
  requestApproval: (request: {
    requestId: string
    sessionId: string
    toolName: string
    input: Record<string, unknown>
    toolUseId?: string
  }) => Promise<ApprovalResult>
  cancelApprovalsForSession: (sessionId: string, reason: string) => void
  cancelApprovalForToolUse: (sessionId: string, toolUseId: string) => void
  spawnProcess?: (bin: string, args: string[], cwd: string) => ChildProcessWithoutNullStreams
  resumeRetry?: { intervalMs: number; windowMs: number }
  /** MCP servers the thread should run (Ness's own ness-control bridge),
   *  passed as per-thread config overrides so ~/.codex/config.toml is
   *  never touched. */
  getMcpServers?: (sessionId: string) => Record<string, StdioMcpServer>
  /** Ness's system prompt, sent as Codex developer instructions. */
  getDeveloperInstructions?: (worktreePath: string) => string | undefined
}

interface CodexInstance {
  proc: ChildProcessWithoutNullStreams
  client: CodexAppServerClient
  sessionId: string
  worktreePath: string
  threadId: string | null
  model: string | null
  /** The thread's rollout file, for cost accounting. */
  transcriptPath: string | null
  compactions: number
  activeTurnId: string | null
  ready: boolean
  /** Turns requested before the thread was ready. */
  outbox: CodexUserInput[][]
  /** agentMessage / reasoning item id → the entry streaming it. */
  streamingEntries: Map<string, string>
  fileChanges: Map<string, CodexFileChange[]>
  /** Tool items started but not completed. An interrupted turn never
   *  completes them, so turn/completed closes whatever is left. */
  openToolItems: Set<string>
  /** In-flight MCP tool calls, so an approval request (which names only
   *  the server and tool) can be tied back to its tool card. */
  openMcpCalls: Map<string, { server: string; tool: string }>
  pendingDeltas: Map<string, { text: string; thinking: string }>
  flushTimer: NodeJS.Timeout | null
  /** Turn whose failure an `error` notification already reported, so the
   *  following turn/completed doesn't add a second card. */
  erroredTurnId: string | null
}

interface PendingFork {
  sourceThreadId: string
  lastTurnId: string
  model: string | null
}

export class CodexChatProvider implements ChatProvider {
  private instances = new Map<string, CodexInstance>()
  private entrySeqBySession = new Map<string, number>()
  /** Forks waiting for their tab's subprocess. thread/fork leaves the new
   *  thread loaded in whichever process ran it, and a thread loaded in one
   *  app-server can't be resumed by another ("already has an active
   *  writer"). So the fork runs in the new tab's own process at boot. */
  private pendingForks = new Map<string, PendingFork>()

  constructor(
    private store: Store,
    private opts: CodexChatProviderOptions
  ) {}

  hasSession(sessionId: string): boolean {
    return this.instances.has(sessionId)
  }

  /** The running thread's rollout jsonl, which the cost tracker can fold. */
  transcriptPath(sessionId: string): string | null {
    return this.instances.get(sessionId)?.transcriptPath ?? null
  }

  /** History is read from the Codex thread once the subprocess is up. */
  seedFromTranscript(): void {}

  create(
    sessionId: string,
    worktreePath: string,
    _permissionMode: JsonClaudePermissionMode,
    modelOverride?: string
  ): void {
    if (this.instances.has(sessionId)) return
    if (!existsSync(worktreePath)) {
      this.failToStart(sessionId, `Worktree directory no longer exists on disk: ${worktreePath}`)
      return
    }
    let proc: ChildProcessWithoutNullStreams
    try {
      proc = this.spawnAppServer(worktreePath)
    } catch (err) {
      this.failToStart(sessionId, err instanceof Error ? err.message : String(err))
      return
    }
    log('codex-chat', `spawn sessionId=${sessionId} cwd=${worktreePath} pid=${proc.pid ?? '?'}`)

    const instance: CodexInstance = {
      proc,
      client: undefined as unknown as CodexAppServerClient,
      sessionId,
      worktreePath,
      threadId: null,
      model: null,
      transcriptPath: null,
      compactions: 0,
      activeTurnId: null,
      ready: false,
      outbox: [],
      streamingEntries: new Map(),
      fileChanges: new Map(),
      openToolItems: new Set(),
      openMcpCalls: new Map(),
      pendingDeltas: new Map(),
      flushTimer: null,
      erroredTurnId: null
    }
    instance.client = new CodexAppServerClient(proc.stdin, proc.stdout, {
      onNotification: (method, params) => this.handleNotification(instance, method, params),
      onRequest: (id, method, params) => this.handleServerRequest(instance, id, method, params),
      onProtocolError: (line) => log('codex-chat', `non-json stdout sessionId=${sessionId}: ${line.slice(0, 200)}`)
    })
    this.instances.set(sessionId, instance)
    // History arrives over app-server a second or two from now; until then
    // the renderer would otherwise show an empty chat for a resumed one.
    const willSeed = !!this.opts.getThreadId(sessionId) || this.pendingForks.has(sessionId)
    const slice = this.store.getSnapshot().state.jsonClaude.sessions[sessionId]
    if (willSeed && !slice?.entries.length) this.setHistoryPending(sessionId, true)

    let stderrBuf = ''
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8')
      let idx: number
      while ((idx = stderrBuf.indexOf('\n')) >= 0) {
        const line = stderrBuf.slice(0, idx).replace(/\r$/, '')
        stderrBuf = stderrBuf.slice(idx + 1)
        if (line) log('codex-chat', `stderr sessionId=${sessionId}: ${line}`)
      }
    })
    proc.once('error', (err) => {
      if (this.instances.get(sessionId) !== instance) return
      this.teardown(instance)
      this.failToStart(sessionId, err.message)
    })
    proc.on('exit', (code, signal) => {
      log('codex-chat', `exit sessionId=${sessionId} code=${code} signal=${signal}`)
      if (this.instances.get(sessionId) !== instance) return
      this.teardown(instance)
      const exitReason = signal ? `signal ${signal}` : code === 0 ? 'clean' : `exit ${code}`
      this.dispatchState(sessionId, 'exited', { exitCode: code, exitReason })
      this.appendEntry(sessionId, {
        entryId: `${sessionId}-error-${Date.now()}`,
        kind: 'error',
        timestamp: Date.now(),
        errorKind: 'subprocess-exit',
        errorMessage: `Codex exited (${exitReason})`,
        exitWasClean: false
      })
    })

    void this.boot(instance, modelOverride)
  }

  send(sessionId: string, text: string, images?: ChatImageInput[]): void {
    const inst = this.instances.get(sessionId)
    if (!inst) return
    const input = buildUserInput(text, images)
    const busy = this.store.getSnapshot().state.jsonClaude.sessions[sessionId]?.busy
    if (busy && inst.ready && inst.activeTurnId) {
      this.appendUserEntry(sessionId, text, images, true)
      const expectedTurnId = inst.activeTurnId
      inst.client
        .request('turn/steer', { threadId: inst.threadId, expectedTurnId, input })
        .catch((err: Error) => {
          // The turn ended between our check and the request landing.
          log('codex-chat', `steer failed, starting a turn sessionId=${sessionId}`, err.message)
          if (this.instances.get(sessionId) === inst) this.startTurn(inst, input)
        })
      return
    }
    this.appendUserEntry(sessionId, text, images, false)
    this.dispatchBusy(sessionId, true)
    if (!inst.ready) {
      inst.outbox.push(input)
      return
    }
    this.startTurn(inst, input)
  }

  /** UI-only, like Claude's: a steered message is already with Codex. */
  cancelQueued(sessionId: string, entryId: string): void {
    this.store.dispatch({ type: 'jsonClaude/entryRemoved', payload: { sessionId, entryId } })
  }

  interrupt(sessionId: string): void {
    const inst = this.instances.get(sessionId)
    if (!inst) return
    if (inst.activeTurnId && inst.threadId) {
      inst.client
        .request('turn/interrupt', { threadId: inst.threadId, turnId: inst.activeTurnId })
        .catch((err: Error) => log('codex-chat', `interrupt failed sessionId=${sessionId}`, err.message))
    }
    this.unqueueUserEntries(sessionId)
    this.dispatchBusy(sessionId, false)
  }

  kill(sessionId: string): void {
    const inst = this.instances.get(sessionId)
    if (!inst) return
    log('codex-chat', `kill sessionId=${sessionId}`)
    this.teardown(inst)
    try {
      inst.proc.stdin.end()
    } catch {
      /* ignore */
    }
    try {
      inst.proc.kill('SIGTERM')
    } catch {
      /* ignore */
    }
    this.dispatchState(sessionId, 'exited', { exitReason: 'killed by user' })
  }

  killAll(): void {
    for (const id of Array.from(this.instances.keys())) this.kill(id)
  }

  setPermissionMode(): void {}

  async rewindTo(sessionId: string, fromEntryId: string): Promise<RewindOutcome> {
    const inst = this.instances.get(sessionId)
    if (!inst?.ready || !inst.threadId) return { ok: false, reason: 'session is not running' }
    const target = this.findEntry(sessionId, fromEntryId)
    if (!target?.turnId) return { ok: false, reason: 'message has no Codex turn' }
    try {
      const turns = await this.listTurns(inst, 'summary')
      const i = turns.findIndex((t) => t.id === target.turnId)
      if (i === -1) return { ok: false, reason: 'turn not found in the Codex thread' }
      const next = turns[i + 1]
      if (!next) return { ok: false, reason: 'nothing after this turn to drop' }
      await inst.client.request('thread/revert', { threadId: inst.threadId, beforeTurnId: next.id })
      await this.seedHistory(inst, true)
      return { ok: true }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      log('codex-chat', `rewind failed sessionId=${sessionId}`, reason)
      return { ok: false, reason }
    }
  }

  forkAt(sourceSessionId: string, fromEntryId: string): ForkOutcome {
    const inst = this.instances.get(sourceSessionId)
    if (!inst?.ready || !inst.threadId) return { ok: false, reason: 'session is not running' }
    const target = this.findEntry(sourceSessionId, fromEntryId)
    if (!target?.turnId) return { ok: false, reason: 'message has no Codex turn' }
    if (target.turnId === inst.activeTurnId) return { ok: false, reason: 'that turn is still running' }
    const newSessionId = randomUUID()
    this.pendingForks.set(newSessionId, {
      sourceThreadId: inst.threadId,
      lastTurnId: target.turnId,
      model: inst.model
    })
    return { ok: true, newSessionId }
  }

  // ---------------------------------------------------------------------
  // Lifecycle

  private spawnAppServer(cwd: string): ChildProcessWithoutNullStreams {
    const bin = this.opts.getBinPath()
    if (this.opts.spawnProcess) return this.opts.spawnProcess(bin, ['app-server'], cwd)
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v
    // Ness's Codex hooks key off these; a chat subprocess must not pose
    // as the terminal tab that spawned Ness.
    delete env.CLAUDE_HARNESS_ID
    delete env.HARNESS_TERMINAL_ID
    return spawn(bin, ['app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  }

  private async boot(inst: CodexInstance, modelOverride?: string): Promise<void> {
    const { sessionId } = inst
    try {
      await inst.client.request('initialize', {
        clientInfo: { name: 'ness', title: 'Ness', version: this.opts.clientVersion },
        capabilities: { experimentalApi: true }
      })
      inst.client.notify('initialized')
      void this.publishModels(inst)

      const model = this.opts.getModel(modelOverride)
      const mcpServers = this.opts.getMcpServers?.(sessionId) ?? {}
      const developerInstructions = this.opts.getDeveloperInstructions?.(inst.worktreePath)
      const threadParams = {
        cwd: inst.worktreePath,
        approvalPolicy: APPROVAL_POLICY,
        sandbox: SANDBOX,
        ...(model ? { model } : {}),
        ...(developerInstructions ? { developerInstructions } : {}),
        ...(Object.keys(mcpServers).length > 0 ? { config: { mcp_servers: mcpServers } } : {})
      }
      let resp: CodexThreadResponse | null = null
      let forked = false
      const fork = this.pendingForks.get(sessionId)
      this.pendingForks.delete(sessionId)
      if (fork) {
        try {
          // Fork doesn't inherit the parent's model — it falls back to
          // config.toml — so pass it explicitly.
          resp = await inst.client.request<CodexThreadResponse>('thread/fork', {
            threadId: fork.sourceThreadId,
            lastTurnId: fork.lastTurnId,
            excludeTurns: true,
            ...threadParams,
            ...(fork.model ? { model: fork.model } : {})
          })
          this.opts.setThreadId(sessionId, resp.thread.id)
          forked = true
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          log('codex-chat', `fork failed sessionId=${sessionId}`, reason)
          this.appendAgentError(sessionId, `Couldn't fork the Codex conversation (${reason}). Started a new one.`)
        }
      }
      const existing = fork ? undefined : this.opts.getThreadId(sessionId)
      if (existing) {
        try {
          resp = await this.resumeThread(inst, existing, threadParams)
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          log('codex-chat', `resume failed sessionId=${sessionId} thread=${existing}`, reason)
          if (isActiveWriterError(reason)) {
            // Still held by another Codex process after the retry window.
            // Starting a fresh thread here would silently orphan the
            // conversation, so stop and keep the tab pointed at it.
            if (this.instances.get(sessionId) !== inst) return
            this.teardown(inst)
            try {
              inst.proc.kill('SIGTERM')
            } catch {
              /* ignore */
            }
            this.failToStart(
              sessionId,
              'This Codex conversation is still open in another Codex process (often a Codex terminal tab). Close it, then reconnect.'
            )
            return
          }
          // A missing rollout means there was never a conversation to lose —
          // typically a Codex terminal tab that didn't get past its trust
          // prompt before being switched to Chat. Nothing worth telling.
          if (!/no rollout found/i.test(reason)) {
            this.appendAgentError(sessionId, `Couldn't resume the previous Codex conversation (${reason}). Started a new one.`)
          }
        }
      }
      if (!resp) {
        resp = await inst.client.request<CodexThreadResponse>('thread/start', threadParams)
        this.opts.setThreadId(sessionId, resp.thread.id)
      }
      if (this.instances.get(sessionId) !== inst) return
      inst.threadId = resp.thread.id
      inst.model = resp.model
      inst.transcriptPath = resp.thread.path ?? null
      log('codex-chat', `ready sessionId=${sessionId} thread=${inst.threadId} model=${inst.model}`)
      if (forked) await this.seedHistory(inst, true)
      else if (existing && existing === inst.threadId) await this.seedHistory(inst, false)
      this.store.dispatch({ type: 'jsonClaude/currentModelChanged', payload: { sessionId, model: resp.model } })
      this.setHistoryPending(sessionId, false)
      inst.ready = true
      this.dispatchState(sessionId, 'running')
      for (const input of inst.outbox.splice(0)) this.startTurn(inst, input)
    } catch (err) {
      if (this.instances.get(sessionId) !== inst) return
      const reason = err instanceof Error ? err.message : String(err)
      log('codex-chat', `boot failed sessionId=${sessionId}`, reason)
      this.teardown(inst)
      try {
        inst.proc.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      this.failToStart(sessionId, reason)
    }
  }

  /** The models this account can use, for the chat's /model picker. Best
   *  effort — a failure just leaves the picker without a Codex list. */
  private async publishModels(inst: CodexInstance): Promise<void> {
    try {
      const resp = await inst.client.request<{
        data: Array<{ id: string; displayName?: string; hidden?: boolean }>
      }>('model/list', {})
      if (this.instances.get(inst.sessionId) !== inst) return
      const models = resp.data
        .filter((m) => !m.hidden)
        .map((m) => ({ id: m.id, displayName: m.displayName || m.id }))
      this.store.dispatch({
        type: 'jsonClaude/availableModelsChanged',
        payload: { sessionId: inst.sessionId, models }
      })
    } catch (err) {
      log('codex-chat', `model/list failed sessionId=${inst.sessionId}`, err instanceof Error ? err.message : String(err))
    }
  }

  /** thread/resume, retried while another app-server or TUI still holds
   *  the thread. Switching a tab from Terminal back to Chat kills the
   *  `codex resume` TUI, but its exit lands after we're already asking. */
  private async resumeThread(
    inst: CodexInstance,
    threadId: string,
    threadParams: Record<string, unknown>
  ): Promise<CodexThreadResponse> {
    const { intervalMs, windowMs } = this.opts.resumeRetry ?? {
      intervalMs: RESUME_RETRY_INTERVAL_MS,
      windowMs: RESUME_RETRY_WINDOW_MS
    }
    const deadline = Date.now() + windowMs
    for (;;) {
      try {
        return await inst.client.request<CodexThreadResponse>('thread/resume', {
          threadId,
          excludeTurns: true,
          ...threadParams
        })
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        if (!isActiveWriterError(reason) || Date.now() >= deadline) throw err
        if (this.instances.get(inst.sessionId) !== inst) throw err
        await new Promise((r) => setTimeout(r, intervalMs))
      }
    }
  }

  /** Drops the instance and releases what it held. Callers dispatch the
   *  resulting session state themselves. */
  private teardown(inst: CodexInstance): void {
    if (this.instances.get(inst.sessionId) === inst) this.instances.delete(inst.sessionId)
    if (inst.flushTimer) clearTimeout(inst.flushTimer)
    inst.flushTimer = null
    inst.pendingDeltas.clear()
    inst.client.close()
    this.opts.cancelApprovalsForSession(inst.sessionId, 'Codex session ended')
    this.dispatchBusy(inst.sessionId, false)
    this.setHistoryPending(inst.sessionId, false)
  }

  private failToStart(sessionId: string, reason: string): void {
    log('codex-chat', `start failed sessionId=${sessionId}`, reason)
    this.setHistoryPending(sessionId, false)
    this.dispatchState(sessionId, 'exited', { exitReason: reason })
    this.appendEntry(sessionId, {
      entryId: `${sessionId}-spawn-fail-${Date.now()}`,
      kind: 'error',
      timestamp: Date.now(),
      errorKind: 'spawn-failed',
      errorMessage: reason || "Couldn't launch Codex",
      exitWasClean: false
    })
  }

  private startTurn(inst: CodexInstance, input: CodexUserInput[]): void {
    inst.client
      .request<{ turn: CodexTurn }>('turn/start', { threadId: inst.threadId, input })
      .then((r) => {
        if (!inst.activeTurnId) inst.activeTurnId = r.turn.id
      })
      .catch((err: Error) => {
        if (this.instances.get(inst.sessionId) !== inst) return
        this.appendAgentError(inst.sessionId, err.message)
        this.dispatchBusy(inst.sessionId, false)
      })
  }

  // ---------------------------------------------------------------------
  // Stream handling

  private handleNotification(inst: CodexInstance, method: string, params: Record<string, unknown>): void {
    if (this.instances.get(inst.sessionId) !== inst) return
    if (typeof params.threadId === 'string' && inst.threadId && params.threadId !== inst.threadId) return
    const turnId = typeof params.turnId === 'string' ? params.turnId : undefined
    switch (method) {
      case 'turn/started': {
        inst.activeTurnId = (params.turn as CodexTurn).id
        this.unqueueUserEntries(inst.sessionId)
        return
      }
      case 'item/started':
        this.onItemStarted(inst, params.item as CodexThreadItem, turnId)
        return
      case 'item/completed':
        this.onItemCompleted(inst, params.item as CodexThreadItem, turnId)
        return
      case 'item/agentMessage/delta':
        this.queueDelta(inst, params.itemId as string, params.delta as string, 'text')
        return
      case 'item/reasoning/summaryTextDelta':
        this.queueDelta(inst, params.itemId as string, params.delta as string, 'thinking')
        return
      case 'thread/tokenUsage/updated':
        this.publishContext(inst, params.tokenUsage as CodexTokenUsage | undefined)
        return
      case 'thread/compacted':
        inst.compactions += 1
        return
      case 'error': {
        if (params.willRetry === true) return
        const error = params.error as { message?: string } | undefined
        inst.erroredTurnId = turnId ?? null
        this.appendAgentError(inst.sessionId, describeCodexError(error?.message))
        return
      }
      case 'turn/completed': {
        const turn = params.turn as CodexTurn
        this.flushDeltas(inst)
        for (const itemId of inst.openToolItems) {
          this.store.dispatch({
            type: 'jsonClaude/toolResultAttached',
            payload: {
              sessionId: inst.sessionId,
              toolUseId: itemId,
              content: turn.status === 'interrupted' ? 'Interrupted' : 'Did not finish',
              isError: true
            }
          })
        }
        inst.openToolItems.clear()
        inst.activeTurnId = null
        if (turn.status === 'failed' && turn.error && inst.erroredTurnId !== turn.id) {
          this.appendAgentError(inst.sessionId, describeCodexError(turn.error.message))
        }
        inst.erroredTurnId = null
        this.unqueueUserEntries(inst.sessionId)
        this.dispatchBusy(inst.sessionId, false)
        return
      }
    }
  }

  private onItemStarted(inst: CodexInstance, item: CodexThreadItem, turnId?: string): void {
    const { sessionId } = inst
    if (item.type === 'userMessage') {
      // A steered message reached the model.
      this.unqueueUserEntries(sessionId)
      return
    }
    if (item.type === 'agentMessage' || item.type === 'reasoning') {
      const entryId = this.nextEntryId(sessionId, 'a')
      inst.streamingEntries.set(item.id, entryId)
      this.appendEntry(sessionId, {
        entryId,
        kind: 'assistant',
        blocks: [{ type: item.type === 'agentMessage' ? 'text' : 'thinking', text: '' }],
        isPartial: true,
        timestamp: Date.now(),
        ...(turnId ? { turnId } : {})
      })
      return
    }
    if (item.type === 'fileChange') inst.fileChanges.set(item.id, (item as { changes: CodexFileChange[] }).changes)
    if (item.type === 'mcpToolCall') {
      const call = item as { server: string; tool: string }
      inst.openMcpCalls.set(item.id, { server: call.server, tool: call.tool })
    }
    const block = toolUseBlockFor(item)
    if (!block) return
    inst.openToolItems.add(item.id)
    this.appendEntry(sessionId, {
      entryId: this.nextEntryId(sessionId, 'a'),
      kind: 'assistant',
      blocks: [block],
      timestamp: Date.now(),
      ...(turnId ? { turnId } : {})
    })
  }

  private onItemCompleted(inst: CodexInstance, item: CodexThreadItem, turnId?: string): void {
    const { sessionId } = inst
    if (item.type === 'agentMessage' || item.type === 'reasoning') {
      this.flushDeltas(inst)
      const entryId = inst.streamingEntries.get(item.id)
      inst.streamingEntries.delete(item.id)
      const block = finalStreamingBlock(item)
      if (!entryId) {
        if (block) {
          this.appendEntry(sessionId, {
            entryId: this.nextEntryId(sessionId, 'a'),
            kind: 'assistant',
            blocks: [block],
            timestamp: Date.now(),
            ...(turnId ? { turnId } : {})
          })
        }
        return
      }
      if (!block) {
        this.store.dispatch({ type: 'jsonClaude/entryRemoved', payload: { sessionId, entryId } })
        return
      }
      this.store.dispatch({
        type: 'jsonClaude/assistantEntryFinalized',
        payload: { sessionId, entryId, blocks: [block] }
      })
      return
    }
    const result = toolResultFor(item)
    if (!result) return
    inst.openToolItems.delete(item.id)
    inst.openMcpCalls.delete(item.id)
    inst.fileChanges.delete(item.id)
    this.opts.cancelApprovalForToolUse(sessionId, item.id)
    this.store.dispatch({
      type: 'jsonClaude/toolResultAttached',
      payload: { sessionId, toolUseId: item.id, content: result.content, isError: result.isError }
    })
  }

  private queueDelta(inst: CodexInstance, itemId: string, delta: string, kind: 'text' | 'thinking'): void {
    const entryId = inst.streamingEntries.get(itemId)
    if (!entryId || !delta) return
    const pending = inst.pendingDeltas.get(entryId) ?? { text: '', thinking: '' }
    pending[kind] += delta
    inst.pendingDeltas.set(entryId, pending)
    if (!inst.flushTimer) inst.flushTimer = setTimeout(() => this.flushDeltas(inst), DELTA_FLUSH_MS)
  }

  private flushDeltas(inst: CodexInstance): void {
    if (inst.flushTimer) clearTimeout(inst.flushTimer)
    inst.flushTimer = null
    for (const [entryId, pending] of inst.pendingDeltas) {
      if (pending.text) {
        this.store.dispatch({
          type: 'jsonClaude/assistantTextDelta',
          payload: { sessionId: inst.sessionId, entryId, textDelta: pending.text }
        })
      }
      if (pending.thinking) {
        this.store.dispatch({
          type: 'jsonClaude/assistantThinkingDelta',
          payload: { sessionId: inst.sessionId, entryId, textDelta: pending.thinking }
        })
      }
    }
    inst.pendingDeltas.clear()
  }

  private handleServerRequest(
    inst: CodexInstance,
    id: number | string,
    method: string,
    params: Record<string, unknown>
  ): void {
    const itemId = typeof params.itemId === 'string' ? params.itemId : undefined
    if (method === 'item/commandExecution/requestApproval') {
      const command = displayCommand(
        String(params.command ?? ''),
        (params.commandActions as Array<{ command: string }> | undefined) ?? []
      )
      void this.relayApproval(inst, id, 'Bash', { command, ...(params.reason ? { description: params.reason } : {}) }, itemId)
      return
    }
    if (method === 'item/fileChange/requestApproval') {
      const changes = (itemId && inst.fileChanges.get(itemId)) || []
      void this.relayApproval(
        inst,
        id,
        APPLY_PATCH_TOOL,
        { changes: summarizeChanges(changes), ...(params.reason ? { description: params.reason } : {}) },
        itemId
      )
      return
    }
    if (method === 'mcpServer/elicitation/request') {
      const call = parseMcpToolApproval(params)
      if (call) {
        const toolUseId = [...inst.openMcpCalls.entries()]
          .reverse()
          .find(([, c]) => c.server === call.server && c.tool === call.tool)?.[0]
        void this.relayApproval(inst, id, `mcp__${call.server}__${call.tool}`, call.args, toolUseId, 'elicitation')
        return
      }
      // A real form-filling elicitation from some MCP server. Ness has no
      // UI for those yet; declining lets the server carry on without.
      log('codex-chat', `declined MCP elicitation server=${String(params.serverName)} sessionId=${inst.sessionId}`)
      inst.client.respond(id, { action: 'decline', content: null, _meta: null })
      return
    }
    log('codex-chat', `unhandled server request ${method} sessionId=${inst.sessionId}`)
    inst.client.respondError(id, -32601, `Ness does not handle ${method}`)
  }

  private async relayApproval(
    inst: CodexInstance,
    id: number | string,
    toolName: string,
    input: Record<string, unknown>,
    toolUseId?: string,
    replyShape: 'decision' | 'elicitation' = 'decision'
  ): Promise<void> {
    const result = await this.opts.requestApproval({
      requestId: `${inst.sessionId}-codex-${id}`,
      sessionId: inst.sessionId,
      toolName,
      input,
      ...(toolUseId ? { toolUseId } : {})
    })
    if (this.instances.get(inst.sessionId) !== inst) return
    // Codex's decision carries no message, so a deny note can't reach the
    // model; "interrupt turn" maps to cancel, which ends the turn.
    const decision = result.behavior === 'allow' ? 'accept' : result.interrupt ? 'cancel' : 'decline'
    if (replyShape === 'elicitation') {
      inst.client.respond(id, { action: decision, content: decision === 'accept' ? {} : null, _meta: null })
      return
    }
    inst.client.respond(id, { decision })
  }

  /** Codex reports usage per request rather than leaving a transcript to
   *  analyze, so its snapshot has the totals but no category breakdown. */
  private publishContext(inst: CodexInstance, usage: CodexTokenUsage | undefined): void {
    if (!usage?.last) return
    const limit = usage.modelContextWindow ?? 0
    const snapshot: ContextSnapshot = {
      sessionId: inst.sessionId,
      transcriptPath: inst.transcriptPath ?? '',
      model: inst.model,
      limit,
      usedTokens: usage.last.totalTokens,
      categories: cloneCategories(emptyCategories),
      autocompactAt: Math.round(limit * AUTOCOMPACT_FRACTION),
      compactions: inst.compactions,
      discoverableTools: [],
      measured: true,
      updatedAt: Date.now()
    }
    const prev = this.store.getSnapshot().state.contextWindow.byTerminal[inst.sessionId]
    if (
      prev &&
      prev.usedTokens === snapshot.usedTokens &&
      prev.limit === snapshot.limit &&
      prev.model === snapshot.model &&
      prev.compactions === snapshot.compactions
    ) {
      return
    }
    this.store.dispatch({
      type: 'contextWindow/snapshotUpdated',
      payload: { terminalId: inst.sessionId, snapshot }
    })
  }

  // ---------------------------------------------------------------------
  // History

  private async listTurns(inst: CodexInstance, itemsView: 'summary' | 'full'): Promise<CodexTurn[]> {
    const turns: CodexTurn[] = []
    let cursor: string | null = null
    do {
      const page: CodexTurnsPage = await inst.client.request<CodexTurnsPage>('thread/turns/list', {
        threadId: inst.threadId,
        sortDirection: 'asc',
        itemsView,
        limit: 100,
        ...(cursor ? { cursor } : {})
      })
      turns.push(...page.data)
      cursor = page.nextCursor
    } while (cursor)
    return turns
  }

  /** Replace the slice's entries with the thread's history. Unforced, it
   *  only runs on an empty slice (app restart), not on a wake where the
   *  slice already holds the conversation. */
  private async seedHistory(inst: CodexInstance, force: boolean): Promise<void> {
    const session = this.store.getSnapshot().state.jsonClaude.sessions[inst.sessionId]
    if (!force && session && session.entries.length > 0) return
    const turns = await this.listTurns(inst, 'full')
    this.store.dispatch({
      type: 'jsonClaude/entriesSeeded',
      payload: { sessionId: inst.sessionId, entries: turnsToEntries(inst.sessionId, turns) }
    })
  }

  // ---------------------------------------------------------------------
  // Store helpers

  private findEntry(sessionId: string, entryId: string): JsonClaudeChatEntry | undefined {
    const session = this.store.getSnapshot().state.jsonClaude.sessions[sessionId]
    return session?.entries.find((e) => e.entryId === entryId)
  }

  private nextEntryId(sessionId: string, kind: 'u' | 'uq' | 'a'): string {
    const n = (this.entrySeqBySession.get(sessionId) ?? 0) + 1
    this.entrySeqBySession.set(sessionId, n)
    return `${sessionId}-${kind}-${n}`
  }

  private appendUserEntry(
    sessionId: string,
    text: string,
    images: ChatImageInput[] | undefined,
    queued: boolean
  ): void {
    const automated = parseAutomatedMessage(text)
    const refs = (images ?? [])
      .filter((img) => img.path.length > 0)
      .map((img) => ({ path: img.path, mediaType: img.mediaType }))
    this.appendEntry(sessionId, {
      kind: 'user',
      text: automated ? automated.body : text,
      timestamp: Date.now(),
      entryId: this.nextEntryId(sessionId, queued ? 'uq' : 'u'),
      ...(automated ? { automation: automated.source } : {}),
      ...(automated?.from ? { automationFrom: automated.from } : {}),
      ...(queued ? { isQueued: true } : {}),
      ...(refs.length > 0 ? { images: refs } : {})
    })
  }

  private appendAgentError(sessionId: string, message: string): void {
    this.appendEntry(sessionId, {
      entryId: `${sessionId}-agent-error-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      kind: 'error',
      timestamp: Date.now(),
      errorKind: 'agent-error',
      errorMessage: message
    })
  }

  private appendEntry(sessionId: string, entry: JsonClaudeChatEntry): void {
    this.store.dispatch({ type: 'jsonClaude/entryAppended', payload: { sessionId, entry } })
  }

  private unqueueUserEntries(sessionId: string): void {
    const session = this.store.getSnapshot().state.jsonClaude.sessions[sessionId]
    if (!session?.entries.some((e) => e.isQueued)) return
    this.store.dispatch({ type: 'jsonClaude/userEntriesUnqueued', payload: { sessionId } })
  }

  private dispatchState(
    sessionId: string,
    state: JsonClaudeSessionState,
    extra?: { exitCode?: number | null; exitReason?: string | null }
  ): void {
    this.store.dispatch({ type: 'jsonClaude/sessionStateChanged', payload: { sessionId, state, ...extra } })
  }

  private setHistoryPending(sessionId: string, pending: boolean): void {
    const session = this.store.getSnapshot().state.jsonClaude.sessions[sessionId]
    if (!session || !!session.historyPending === pending) return
    this.store.dispatch({ type: 'jsonClaude/historyPendingChanged', payload: { sessionId, pending } })
  }

  private dispatchBusy(sessionId: string, busy: boolean): void {
    const session = this.store.getSnapshot().state.jsonClaude.sessions[sessionId]
    if (!session || session.busy === busy) return
    this.store.dispatch({ type: 'jsonClaude/busyChanged', payload: { sessionId, busy } })
  }
}

// -----------------------------------------------------------------------
// Pure mapping helpers (exported for tests)

export const APPLY_PATCH_TOOL = 'ApplyPatch'

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

/** Codex asks before every MCP tool call with an elicitation tagged
 *  `codex_approval_kind: "mcp_tool_call"`. The tool's name is only in the
 *  human-readable message; its arguments are in `_meta.tool_params`. */
export function parseMcpToolApproval(
  params: Record<string, unknown>
): { server: string; tool: string; args: Record<string, unknown> } | null {
  const meta = params._meta as { codex_approval_kind?: unknown; tool_params?: unknown } | null | undefined
  if (meta?.codex_approval_kind !== 'mcp_tool_call') return null
  const server = typeof params.serverName === 'string' ? params.serverName : null
  const match = typeof params.message === 'string' ? params.message.match(/run tool "([^"]+)"/) : null
  if (!server || !match) return null
  const args =
    meta.tool_params && typeof meta.tool_params === 'object' && !Array.isArray(meta.tool_params)
      ? (meta.tool_params as Record<string, unknown>)
      : {}
  return { server, tool: match[1], args }
}

export function buildUserInput(text: string, images?: ChatImageInput[]): CodexUserInput[] {
  const input: CodexUserInput[] = []
  if (text.length > 0) input.push({ type: 'text', text, text_elements: [] })
  for (const img of images ?? []) {
    if (img.path.length > 0) input.push({ type: 'localImage', path: img.path })
  }
  return input
}

/** Codex wraps every command as `/bin/zsh -lc '<cmd>'`. Show (and match
 *  allowlist rules against) the command the model actually wrote. */
export function unwrapShellCommand(command: string): string {
  const m = command.match(/^(?:\S*\/)?(?:ba|z)?sh -l?c '((?:[^']|'\\'')*)'$/)
  return m ? m[1].replace(/'\\''/g, "'") : command
}

export function displayCommand(command: string, actions: Array<{ command: string }>): string {
  if (actions.length === 1 && actions[0].command) return actions[0].command
  return unwrapShellCommand(command)
}

function summarizeChanges(changes: CodexFileChange[]): Array<{ path: string; kind: string }> {
  return changes.map((c) => ({ path: c.path, kind: c.kind.type }))
}

export function toolUseBlockFor(item: CodexThreadItem): JsonClaudeMessageBlock | null {
  switch (item.type) {
    case 'commandExecution': {
      const it = item as Extract<CodexThreadItem, { type: 'commandExecution' }>
      return {
        type: 'tool_use',
        id: it.id,
        name: 'Bash',
        input: { command: displayCommand(it.command, it.commandActions ?? []) }
      }
    }
    case 'fileChange': {
      const it = item as Extract<CodexThreadItem, { type: 'fileChange' }>
      return { type: 'tool_use', id: it.id, name: APPLY_PATCH_TOOL, input: { changes: summarizeChanges(it.changes) } }
    }
    case 'mcpToolCall': {
      const it = item as Extract<CodexThreadItem, { type: 'mcpToolCall' }>
      const args = it.arguments && typeof it.arguments === 'object' ? (it.arguments as Record<string, unknown>) : {}
      return { type: 'tool_use', id: it.id, name: `mcp__${it.server}__${it.tool}`, input: args }
    }
    case 'webSearch': {
      const it = item as { id: string; query?: string }
      return { type: 'tool_use', id: it.id, name: 'WebSearch', input: it.query ? { query: it.query } : {} }
    }
    default:
      return null
  }
}

export function toolResultFor(item: CodexThreadItem): { content: string; isError: boolean } | null {
  switch (item.type) {
    case 'commandExecution': {
      const it = item as Extract<CodexThreadItem, { type: 'commandExecution' }>
      if (it.status === 'declined') return { content: 'Declined', isError: true }
      const failed = it.status === 'failed' || (it.exitCode !== null && it.exitCode !== 0)
      return { content: it.aggregatedOutput ?? '', isError: failed }
    }
    case 'fileChange': {
      const it = item as Extract<CodexThreadItem, { type: 'fileChange' }>
      if (it.status === 'declined') return { content: 'Declined', isError: true }
      const body = it.changes.map((c) => `${c.kind.type} ${c.path}\n${c.diff}`).join('\n')
      return { content: body, isError: it.status === 'failed' }
    }
    case 'mcpToolCall': {
      const it = item as Extract<CodexThreadItem, { type: 'mcpToolCall' }>
      if (it.error) return { content: it.error.message, isError: true }
      const parts = (it.result?.content ?? []).map((c) =>
        c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string'
          ? (c as { text: string }).text
          : JSON.stringify(c)
      )
      return { content: parts.join('\n'), isError: false }
    }
    case 'webSearch':
      return { content: '', isError: false }
    default:
      return null
  }
}

function finalStreamingBlock(item: CodexThreadItem): JsonClaudeMessageBlock | null {
  if (item.type === 'agentMessage') {
    const text = (item as { text: string }).text
    return text ? { type: 'text', text } : null
  }
  const r = item as { summary?: string[]; content?: string[] }
  const text = (r.summary?.length ? r.summary : (r.content ?? [])).join('\n\n')
  return text ? { type: 'thinking', text } : null
}

function describeCodexError(message: string | undefined): string {
  const msg = message || 'Codex reported an error'
  if (/\b401\b|unauthori[sz]ed|not logged in|login/i.test(msg)) {
    return `${msg}\n\nCodex isn't signed in. Run \`codex login\` in a terminal, then retry.`
  }
  return msg
}

export function turnsToEntries(sessionId: string, turns: CodexTurn[]): JsonClaudeChatEntry[] {
  const entries: JsonClaudeChatEntry[] = []
  const now = Date.now()
  turns.forEach((turn, t) => {
    turn.items.forEach((item, i) => {
      const entryId = `${sessionId}-seed-${t}-${i}`
      if (item.type === 'userMessage') {
        const content = (item as { content: Array<{ type: string; text?: string; path?: string }> }).content
        const text = content
          .filter((c) => c.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text)
          .join('\n')
        const images: JsonClaudeImageRef[] = content
          .filter((c) => c.type === 'localImage' && typeof c.path === 'string')
          .map((c) => ({
            path: c.path as string,
            mediaType: IMAGE_MEDIA_TYPES[extname(c.path as string).toLowerCase()] ?? 'image/png'
          }))
        const automated = parseAutomatedMessage(text)
        entries.push({
          entryId,
          kind: 'user',
          text: automated ? automated.body : text,
          timestamp: now,
          ...(automated ? { automation: automated.source } : {}),
          ...(automated?.from ? { automationFrom: automated.from } : {}),
          ...(images.length > 0 ? { images } : {})
        })
        return
      }
      if (item.type === 'agentMessage' || item.type === 'reasoning') {
        const block = finalStreamingBlock(item)
        if (block) entries.push({ entryId, kind: 'assistant', blocks: [block], timestamp: now, turnId: turn.id })
        return
      }
      const use = toolUseBlockFor(item)
      if (!use) return
      entries.push({ entryId, kind: 'assistant', blocks: [use], timestamp: now, turnId: turn.id })
      const result = toolResultFor(item)
      if (!result) return
      entries.push({
        entryId: `${entryId}-r`,
        kind: 'tool_result',
        timestamp: now,
        blocks: [{ type: 'tool_result', toolUseId: item.id, content: result.content, isError: result.isError }]
      })
    })
  })
  return entries
}
