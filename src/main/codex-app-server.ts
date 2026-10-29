// JSON-RPC client for `codex app-server` over stdio. One JSON object per
// line, both directions; the "jsonrpc":"2.0" field is omitted on the wire.
// The server sends us notifications (progress) and requests (approvals),
// so this is bidirectional: we route responses to pending promises and
// hand everything else to the provider.
//
// The protocol types below are a hand-written subset of what
// `codex app-server generate-ts` emits for the pinned @openai/codex
// version. Regenerate and compare when bumping the pin.

import type { Readable, Writable } from 'stream'

export type CodexUserInput =
  | { type: 'text'; text: string; text_elements: unknown[] }
  | { type: 'localImage'; path: string }

export interface CodexTurn {
  id: string
  items: CodexThreadItem[]
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress'
  error: CodexTurnError | null
}

export interface CodexTurnError {
  message: string
  codexErrorInfo: unknown
  additionalDetails: string | null
}

export interface CodexThread {
  id: string
  path?: string | null
  forkedFromId?: string | null
}

export interface CodexCommandAction {
  type: string
  command: string
}

export interface CodexFileChange {
  path: string
  kind: { type: 'add' } | { type: 'delete' } | { type: 'update'; move_path: string | null }
  diff: string
}

export type CodexThreadItem =
  | { type: 'userMessage'; id: string; content: Array<{ type: string; text?: string; path?: string }> }
  | { type: 'agentMessage'; id: string; text: string }
  | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
  | {
      type: 'commandExecution'
      id: string
      command: string
      cwd: string
      status: string
      commandActions: CodexCommandAction[]
      aggregatedOutput: string | null
      exitCode: number | null
    }
  | { type: 'fileChange'; id: string; changes: CodexFileChange[]; status: string }
  | {
      type: 'mcpToolCall'
      id: string
      server: string
      tool: string
      status: string
      arguments: unknown
      result?: { content: unknown[] } | null
      error?: { message: string } | null
    }
  | { type: 'webSearch'; id: string; query?: string }
  | { type: string; id: string }

export interface CodexThreadResponse {
  thread: CodexThread
  model: string
}

export interface CodexTurnsPage {
  data: CodexTurn[]
  nextCursor: string | null
}

export interface CodexRpcError {
  code: number
  message: string
  data?: unknown
}

export class CodexRpcRequestError extends Error {
  constructor(
    readonly method: string,
    readonly rpcError: CodexRpcError
  ) {
    super(`${method}: ${rpcError.message}`)
  }
}

type Pending = { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void }

export interface CodexAppServerHandlers {
  onNotification: (method: string, params: Record<string, unknown>) => void
  /** Server → client request (approvals). Reply with respond / respondError. */
  onRequest: (id: number | string, method: string, params: Record<string, unknown>) => void
  onProtocolError?: (line: string) => void
}

export class CodexAppServerClient {
  private nextId = 1
  private pending = new Map<number, Pending>()
  private buf = ''
  private closed = false

  constructor(
    private stdin: Writable,
    stdout: Readable,
    private handlers: CodexAppServerHandlers
  ) {
    stdout.on('data', (chunk: Buffer | string) => {
      this.buf += chunk.toString()
      let idx: number
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx).trim()
        this.buf = this.buf.slice(idx + 1)
        if (line) this.handleLine(line)
      }
    })
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`codex app-server closed (${method})`))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject })
      if (!this.write({ id, method, params })) {
        this.pending.delete(id)
        reject(new Error(`codex app-server write failed (${method})`))
      }
    })
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params })
  }

  respond(id: number | string, result: unknown): void {
    this.write({ id, result })
  }

  respondError(id: number | string, code: number, message: string): void {
    this.write({ id, error: { code, message } })
  }

  /** Rejects every in-flight request. Call when the process goes away. */
  close(reason = 'codex app-server exited'): void {
    if (this.closed) return
    this.closed = true
    for (const p of this.pending.values()) p.reject(new Error(`${reason} (${p.method})`))
    this.pending.clear()
  }

  private write(msg: unknown): boolean {
    if (this.closed) return false
    try {
      this.stdin.write(JSON.stringify(msg) + '\n')
      return true
    } catch {
      return false
    }
  }

  private handleLine(line: string): void {
    let msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: CodexRpcError }
    try {
      msg = JSON.parse(line)
    } catch {
      this.handlers.onProtocolError?.(line)
      return
    }
    const params = (msg.params ?? {}) as Record<string, unknown>
    if (msg.method !== undefined) {
      if (msg.id !== undefined) this.handlers.onRequest(msg.id, msg.method, params)
      else this.handlers.onNotification(msg.method, params)
      return
    }
    if (typeof msg.id !== 'number') return
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    if (msg.error) p.reject(new CodexRpcRequestError(p.method, msg.error))
    else p.resolve(msg.result)
  }
}
