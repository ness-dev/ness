// Browser-side WebSocket implementation of ClientTransport.
//
// Lives in `shared/transport/` so it's importable from both the
// browser web client and the Electron renderer (where the
// multi-backend BackendsRegistry constructs one of these per saved
// remote — the local backend uses ElectronClientTransport instead).
// The whole point of WS is bypassing the preload/contextBridge
// plumbing for remotes — everything above the transport is already
// transport-agnostic (see the comment block atop
// `src/preload/transport-electron.ts`).
//
// Responsibilities:
//   - Own the socket lifecycle + reconnect-with-backoff.
//   - Translate `request(name, …)` into `{t:'req', id, name, args}` frames
//     and resolve the returned promise when `{t:'res', id, …}` arrives.
//   - Fan `{t:'state', event, seq}` out to registered listeners and
//     `{t:'sig', name, args}` out to per-channel signal listeners.
//   - On every (re)connect, re-snapshot and notify the store mirror so
//     any missed events from the gap are implicitly reconciled.
//
// Wire protocol is the same as the server's. See transport-websocket.ts
// on the main side for the frame shapes.

import type { StateEvent, StateSnapshot } from '../state'
import type {
  ClientSignalHandler,
  ClientTransport,
  ReconnectListener,
  StateEventListener
} from './transport'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

type ServerFrame =
  | { t: 'state'; event: StateEvent; seq: number }
  | { t: 'snapres'; id: string; ok: boolean; snapshot?: StateSnapshot; error?: string }
  | { t: 'res'; id: string; ok: boolean; value?: unknown; error?: string }
  | { t: 'sig'; name: string; args: unknown[] }

export interface WebSocketClientTransportOptions {
  url: string
  token: string
  /** Callback fired after each successful (re)connect, once the client
   *  has finished refetching the snapshot. The callee is expected to
   *  reset its local mirror to `snapshot`. */
  onSnapshot?: (snapshot: StateSnapshot) => void
  /** Backoff starting delay in ms; doubles up to `maxBackoffMs`. */
  initialBackoffMs?: number
  maxBackoffMs?: number
  /** Inject a custom WebSocket constructor (tests / non-browser runtimes). */
  WebSocketCtor?: typeof WebSocket
  /** Fires whenever the underlying socket transitions between
   *  open and closed. Used by the multi-backend chip strip to grey
   *  disconnected chips without changing what the slice hooks read.
   *  Tier 1 only distinguishes connected vs disconnected per design
   *  §I; the optional `reason` is surfaced in the chip's tooltip. */
  onConnectionChange?: (connected: boolean, reason?: string) => void
  /** How long a socket may sit in CONNECTING before it's abandoned and
   *  retried. Without this a SYN to an unroutable address (a phone off the
   *  LAN its backend lives on) can hang until the OS gives up, firing
   *  neither `open` nor `close`. */
  connectTimeoutMs?: number
  /** How long the post-open handshake (snapshot + clientId) may go without
   *  receiving anything before the socket is closed and retried. Any frame
   *  re-arms it, and each consecutive handshake timeout doubles it (up to
   *  8x), so a slow link still gets there eventually: the snapshot is one
   *  frame and the WebSocket API reports no progress inside a frame. */
  handshakeTimeoutMs?: number
}

/** `dead`: the socket was dropped and a reconnect started. `skipped`: there
 *  was no settled socket to test (closed, connecting, mid-handshake) or it
 *  had traffic recently enough. */
export type ProbeResult = 'alive' | 'dead' | 'skipped'

export class WebSocketClientTransport implements ClientTransport {
  private ws: WebSocket | null = null
  private nextRequestId = 1
  private readonly pending = new Map<string, PendingRequest>()
  private readonly eventListeners = new Set<StateEventListener>()
  private readonly signalListeners = new Map<string, Set<ClientSignalHandler>>()
  private readonly reconnectListeners = new Set<ReconnectListener>()
  private connectPromise: Promise<void> | null = null
  private closed = false
  private backoffMs: number
  private readonly initialBackoffMs: number
  private readonly maxBackoffMs: number
  private readonly WebSocketCtor: typeof WebSocket
  private readonly connectTimeoutMs: number
  private readonly handshakeTimeoutMs: number
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** Consecutive handshake timeouts; scales the handshake budget. Reset
   *  only by a completed handshake, deliberately not by reconnectNow(): a
   *  Retry tap on a slow link should keep the larger budget it earned. */
  private handshakeTimeouts = 0
  /** Ends the in-flight attempt (CONNECTING or mid-handshake) as a failure
   *  without scheduling a retry. Null once the handshake has finished. */
  private abortAttempt: ((reason: string) => void) | null = null
  /** Fails the current socket (handshake finished) and retries immediately.
   *  Null when there's no settled socket to drop. */
  private dropSocket: ((reason: string) => void) | null = null
  private probing: Promise<ProbeResult> | null = null
  private lastFrameAt = 0

  constructor(private readonly opts: WebSocketClientTransportOptions) {
    this.initialBackoffMs = opts.initialBackoffMs ?? 250
    this.maxBackoffMs = opts.maxBackoffMs ?? 5000
    this.backoffMs = this.initialBackoffMs
    this.WebSocketCtor = opts.WebSocketCtor ?? WebSocket
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 8000
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 15000
  }

  async connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise
    this.connectPromise = this.openSocket()
    // TODO(#75-followup): callers sometimes report `Uncaught (in promise)
    // Error: websocket failed to open` on the first failed connect even
    // though every known awaiter has a catch. Suspect: a secondary
    // awaiter shares the cached `connectPromise` and lets the rejection
    // escape. Reproduce with a remote backend whose server is down at
    // boot and inspect the rejection's stack.
    return this.connectPromise
  }

  /** Retry now instead of waiting out the backoff (a user's Retry tap, the
   *  app returning to the foreground). Abandons an attempt that's still
   *  connecting, since it may be stuck on a network that's gone. No-op
   *  while connected or after close(). `keepOpen` also leaves a socket
   *  that's open but mid-handshake alone (it's evidently reachable), for
   *  automatic kicks that shouldn't throw away a snapshot in flight. */
  reconnectNow({ keepOpen = false }: { keepOpen?: boolean } = {}): void {
    if (this.closed) return
    if (this.ws && this.ws.readyState === this.WebSocketCtor.OPEN && (keepOpen || !this.abortAttempt)) return
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.abortAttempt?.('reconnecting')
    this.backoffMs = this.initialBackoffMs
    this.connect().catch(() => {
      // the close path reports the failure and schedules the retry
    })
  }

  /** Check that a socket reading OPEN still reaches the server. iOS keeps
   *  reporting OPEN for a socket that died while the app was suspended (the
   *  Mac slept, the phone changed networks), and nothing notices until a
   *  request hangs. `transport:getClientId` is the round trip: every server
   *  answers it and it costs nothing, so no new frame is needed. With no
   *  answer within `timeoutMs` the socket is failed as 'connection lost'
   *  (rejecting whatever else was pending) and reconnected without backoff.
   *  `ifIdleMs` skips the probe when a frame arrived that recently, for a
   *  heartbeat that shouldn't add traffic to a busy connection. Only sockets
   *  past their handshake are probed: before that the connect and handshake
   *  timeouts already cover a dead link. */
  probe(timeoutMs: number, { ifIdleMs }: { ifIdleMs?: number } = {}): Promise<ProbeResult> {
    if (this.probing) return this.probing
    const ws = this.ws
    const drop = this.dropSocket
    if (this.closed || !ws || !drop || ws.readyState !== this.WebSocketCtor.OPEN) return Promise.resolve('skipped')
    if (ifIdleMs !== undefined && Date.now() - this.lastFrameAt < ifIdleMs) return Promise.resolve('skipped')
    const id = String(this.nextRequestId++)
    const done = new Promise<ProbeResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        if (this.ws === ws) drop('connection lost')
        resolve('dead')
      }, timeoutMs)
      const settle = (r: ProbeResult) => {
        clearTimeout(timer)
        resolve(r)
      }
      // An error response still proves the server is there. A rejection
      // after the socket went means the close path already took over.
      this.pending.set(id, {
        resolve: () => settle('alive'),
        reject: () => settle(this.ws === ws ? 'alive' : 'skipped')
      })
      this.sendFrame({ t: 'req', id, name: 'transport:getClientId', args: [] })
    }).finally(() => {
      this.probing = null
    })
    this.probing = done
    return done
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.abortAttempt?.('transport closed')
    this.ws?.close()
    this.ws = null
    for (const p of this.pending.values()) {
      p.reject(new Error('transport closed'))
    }
    this.pending.clear()
  }

  async getStateSnapshot(): Promise<StateSnapshot> {
    await this.ensureConnected()
    return this.sendSnapshotRequest()
  }

  onStateEvent(listener: StateEventListener): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  async request(name: string, ...args: unknown[]): Promise<unknown> {
    await this.ensureConnected()
    const id = String(this.nextRequestId++)
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.sendFrame({ t: 'req', id, name, args })
    })
  }

  send(name: string, ...args: unknown[]): void {
    // Fire-and-forget — if we're mid-reconnect, drop. PTY byte streams
    // aren't worth queueing; users will retype, and UI signals like
    // menu triggers are already idempotent or re-driven by focus.
    if (!this.ws || this.ws.readyState !== this.WebSocketCtor.OPEN) return
    this.sendFrame({ t: 'send', name, args })
  }

  onSignal(name: string, handler: ClientSignalHandler): () => void {
    let set = this.signalListeners.get(name)
    if (!set) {
      set = new Set()
      this.signalListeners.set(name, set)
    }
    set.add(handler)
    return () => {
      set!.delete(handler)
    }
  }

  async getClientId(): Promise<string> {
    const id = await this.request('transport:getClientId')
    return id as string
  }

  onReconnect(cb: ReconnectListener): () => void {
    this.reconnectListeners.add(cb)
    return () => {
      this.reconnectListeners.delete(cb)
    }
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.opts.url)
      url.searchParams.set('token', this.opts.token)
      const ws = new this.WebSocketCtor(url.toString())
      this.ws = ws

      let opened = false
      let ended = false
      let timer: ReturnType<typeof setTimeout> | null = null
      /** Set while the handshake runs; any incoming frame re-arms it. */
      let armHandshake: (() => void) | null = null
      const clearTimer = () => {
        if (timer) clearTimeout(timer)
        timer = null
      }

      // The one failure path, reached from the socket's own close event or
      // from a timeout/abort. Timeouts don't wait for `close`: on a hung
      // CONNECTING socket it can take as long to arrive as `open` would
      // have, so the socket is detached here and its late events ignored.
      const fail = (reason: string, retry: boolean, report = true) => {
        if (ended) return
        ended = true
        clearTimer()
        if (this.abortAttempt === abort) this.abortAttempt = null
        if (this.dropSocket === drop) this.dropSocket = null
        if (this.ws === ws) {
          this.ws = null
          this.connectPromise = null
        }
        for (const p of this.pending.values()) {
          p.reject(new Error('socket closed before response'))
        }
        this.pending.clear()
        if (report) this.opts.onConnectionChange?.(false, reason)
        if (!opened) reject(new Error('websocket failed to open'))
        else reject(new Error(reason))
        if (retry && !this.closed) this.scheduleReconnect()
      }
      // An abort of a socket that never opened leaves the last reported
      // reason (e.g. "connection timed out") standing: nothing changed.
      const abort = (reason: string) => {
        fail(reason, false, opened)
        try {
          ws.close()
        } catch {
          // already closing
        }
      }
      this.abortAttempt = abort
      // A failed probe: the link is evidently gone, but the network may be
      // fine again (the phone is back on its Wi-Fi), so retry without the
      // backoff rather than after it.
      const drop = (reason: string) => {
        fail(reason, false)
        try {
          ws.close()
        } catch {
          // already closing
        }
        if (this.closed) return
        this.backoffMs = this.initialBackoffMs
        this.connect().catch(() => {
          // the close path reports the failure and schedules the retry
        })
      }

      const timeOut = (reason: string) => {
        fail(reason, true)
        try {
          ws.close()
        } catch {
          // already closing
        }
      }
      timer = setTimeout(() => timeOut('connection timed out'), this.connectTimeoutMs)

      ws.addEventListener('open', () => {
        if (ended) return
        opened = true
        clearTimer()
        this.backoffMs = this.initialBackoffMs
        this.opts.onConnectionChange?.(true)
        const budget = this.handshakeTimeoutMs * 2 ** Math.min(this.handshakeTimeouts, 3)
        armHandshake = () => {
          clearTimer()
          timer = setTimeout(() => {
            this.handshakeTimeouts++
            timeOut('backend did not respond')
          }, budget)
        }
        armHandshake()
        // Reconcile any state gap before telling UI subscribers to re-run
        // join-on-connect side effects. If a delayed snapshot landed after
        // terminal:join, it could overwrite the restored controller roster
        // with the stale "old client disconnected" state and leave PTY input
        // silently gated off until the user opened a new tab.
        this.finishOpenHandshake()
          .then(() => {
            if (ended) return
            armHandshake = null
            clearTimer()
            this.handshakeTimeouts = 0
            if (this.abortAttempt === abort) this.abortAttempt = null
            this.dropSocket = drop
            resolve()
          })
          .catch((err) => {
            // A dropped socket already failed the attempt via `close`.
            if (ended) return
            armHandshake = null
            clearTimer()
            if (this.abortAttempt === abort) this.abortAttempt = null
            reject(err instanceof Error ? err : new Error(String(err)))
          })
      })

      ws.addEventListener('message', (evt) => {
        if (ended) return
        armHandshake?.()
        this.lastFrameAt = Date.now()
        let frame: ServerFrame
        try {
          frame = JSON.parse(String(evt.data)) as ServerFrame
        } catch {
          return
        }
        this.handleFrame(frame)
      })

      ws.addEventListener('error', () => {
        // 'error' fires before 'close'; just log-and-forward.
      })

      ws.addEventListener('close', (evt) => {
        // Already failed by a timeout or abort: this is the abandoned
        // socket finally closing.
        if (ended) return
        // CloseEvent.reason is empty for transport-level failures; in
        // that case fall back to the code so users see something
        // actionable in the chip tooltip.
        const closeEvt = evt as CloseEvent | undefined
        const reason = closeEvt?.reason || (closeEvt?.code ? `close code ${closeEvt.code}` : 'connection lost')
        fail(opened ? reason : 'failed to connect', true)
      })
    })
  }

  private scheduleReconnect(): void {
    const delay = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.closed) return
      this.connect().catch(() => {
        // next close handler schedules the retry
      })
    }, delay)
  }

  private async ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === this.WebSocketCtor.OPEN) return
    await this.connect()
  }

  private async finishOpenHandshake(): Promise<void> {
    const snap = await this.sendSnapshotRequest()
    this.opts.onSnapshot?.(snap)

    // The server mints a new UUID per WebSocket, so the renderer's
    // cached clientId is stale after every reconnect. Re-fetch and
    // notify subscribers so they can refresh their mirror's id and
    // re-fire join-on-mount side effects (terminal:join etc.).
    const id = await this.request('transport:getClientId')
    for (const l of this.reconnectListeners) {
      try {
        l(id as string)
      } catch {
        // swallow — a flaky listener mustn't kill the socket
      }
    }
  }

  private sendSnapshotRequest(): Promise<StateSnapshot> {
    const id = String(this.nextRequestId++)
    return new Promise<StateSnapshot>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as StateSnapshot),
        reject
      })
      this.sendFrame({ t: 'snapreq', id })
    })
  }

  private sendFrame(frame: object): void {
    this.ws?.send(JSON.stringify(frame))
  }

  private handleFrame(frame: ServerFrame): void {
    if (frame.t === 'state') {
      for (const l of this.eventListeners) l(frame.event, frame.seq)
      return
    }
    if (frame.t === 'sig') {
      const set = this.signalListeners.get(frame.name)
      if (!set) return
      for (const h of set) {
        try {
          h(...(frame.args ?? []))
        } catch {
          // swallow — a flaky signal listener mustn't kill the socket
        }
      }
      return
    }
    if (frame.t === 'snapres') {
      const pending = this.pending.get(frame.id)
      if (!pending) return
      this.pending.delete(frame.id)
      if (frame.ok && frame.snapshot) pending.resolve(frame.snapshot)
      else pending.reject(new Error(frame.error ?? 'snapshot failed'))
      return
    }
    if (frame.t === 'res') {
      const pending = this.pending.get(frame.id)
      if (!pending) return
      this.pending.delete(frame.id)
      if (frame.ok) pending.resolve(frame.value)
      else pending.reject(new Error(frame.error ?? 'request failed'))
      return
    }
  }
}
