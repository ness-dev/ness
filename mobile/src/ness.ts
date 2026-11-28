// Mobile client mirror, one per backend. Same shape as the renderer's
// ClientStore (src/renderer/store.ts): snapshot → mergeWireSnapshot, then
// every state frame through the shared rootReducer. The desktop's
// multi-backend registry is the same idea — one (transport, store) pair
// per backend, no cross-backend event routing.
import { useCallback, useRef, useSyncExternalStore } from 'react'
import { WebSocketClientTransport } from '../../src/shared/transport/transport-websocket'
import {
  initialState,
  mergeWireSnapshot,
  rootReducer,
  type AppState
} from '../../src/shared/state'
import type { PaneNode, PtyStatus, TerminalTab } from '../../src/shared/state/terminals'
import { ROLLUP_STATUS_RANK } from '../../src/shared/status-rollup'
import { buildBackend } from '../../src/renderer/build-backend'
import type { ElectronAPI } from '../../src/renderer/types'
import type { LocalTransportHandle } from '../../src/shared/transport/transport'

type Listener = () => void

/** A LAN round trip is milliseconds; a suspended-then-dead socket never
 *  answers. Short enough that the stale state isn't up for long. */
export const PROBE_TIMEOUT_MS = 3500

export interface ConnState {
  connected: boolean
  hasSnapshot: boolean
  error?: string
}

export class NessClient {
  private state: AppState = initialState
  private conn: ConnState = { connected: false, hasSnapshot: false }
  private listeners = new Set<Listener>()
  readonly transport: WebSocketClientTransport
  /** The desktop renderer's own typed backend API (build-backend.ts), bound
   *  to this connection. Every request and signal goes through it — never a
   *  hand-written channel string — so a server-side rename or signature
   *  change updates build-backend.ts and fails the mobile typecheck in CI
   *  instead of silently breaking the phone. */
  readonly api: ElectronAPI

  constructor(
    readonly id: string,
    readonly label: string,
    readonly wsUrl: string,
    readonly token: string
  ) {
    this.transport = new WebSocketClientTransport({
      url: wsUrl,
      token,
      onSnapshot: (snap) => {
        this.state = mergeWireSnapshot(snap.state)
        this.conn = { ...this.conn, hasSnapshot: true }
        this.emit()
      },
      onConnectionChange: (connected, reason) => {
        this.conn = { ...this.conn, connected, error: connected ? undefined : reason }
        this.emit()
      }
    })
    const t = this.transport
    // Rejections are logged, not thrown: a fire-and-forget UI tap on a
    // dropped connection shouldn't become an unhandled promise.
    const handle: LocalTransportHandle = {
      getStateSnapshot: () => t.getStateSnapshot(),
      onStateEvent: (cb) => t.onStateEvent(cb),
      request: (name, ...args) => {
        const p = t.request(name, ...args)
        p.catch((e: unknown) => console.warn(`[ness] ${name} failed`, e)) // eslint-disable-line no-console
        return p
      },
      send: (name, ...args) => t.send(name, ...args),
      onSignal: (name, h) => t.onSignal(name, h),
      getClientId: () => t.getClientId(),
      onReconnect: (cb) => t.onReconnect(cb)
    }
    this.api = buildBackend(() => handle, () => handle, null)
    this.transport.onStateEvent((event) => {
      this.state = rootReducer(this.state, event)
      this.emit()
    })
  }

  connect(): void {
    this.transport.connect().catch(() => {
      // the transport schedules its own retry; ConnState carries the reason
    })
  }

  /** Try again now, skipping (and resetting) the reconnect backoff. No-op
   *  while connected; `keepOpen` also spares a socket that's mid-handshake. */
  retry(opts?: { keepOpen?: boolean }): void {
    this.transport.reconnectNow(opts)
  }

  /** Back in the foreground: retry without the backoff (keepOpen spares a
   *  socket mid-handshake), and check an open socket still answers. */
  wake(): void {
    this.transport.reconnectNow({ keepOpen: true })
    void this.checkAlive()
  }

  /** iOS reports a socket that died while suspended as OPEN. One that
   *  doesn't answer is dropped and reconnected, and its data no longer
   *  counts as live: Connecting / "Can't reach" takes over until the new
   *  snapshot lands, instead of the pre-sleep state passing for current.
   *  An ordinary drop keeps showing the last state as before; this is the
   *  case where it's likely stale. */
  async checkAlive(opts?: { ifIdleMs?: number }): Promise<void> {
    const r = await this.transport.probe(PROBE_TIMEOUT_MS, opts)
    if (r !== 'dead' || this.conn.connected) return
    this.conn = { connected: false, hasSnapshot: false }
    this.emit()
  }

  close(): void {
    this.transport.close()
  }

  getState = (): AppState => this.state
  getConn = (): ConnState => this.conn

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  private emit(): void {
    for (const l of this.listeners) l()
  }

}

export function useNess<T>(client: NessClient, select: (s: AppState) => T): T {
  return useSyncExternalStore(client.subscribe, () => select(client.getState()))
}

export function useConn(client: NessClient): ConnState {
  return useSyncExternalStore(client.subscribe, client.getConn)
}

/** ConnState of several clients at once. The returned array keeps its
 *  identity until one of them changes, so state frames (which also notify
 *  client subscribers) don't re-render. */
export function useConns(clients: readonly NessClient[]): readonly ConnState[] {
  const cache = useRef<readonly ConnState[]>([])
  const subscribe = useCallback(
    (l: Listener) => {
      const unsubs = clients.map((cl) => cl.subscribe(l))
      return () => unsubs.forEach((u) => u())
    },
    [clients]
  )
  const get = () => {
    const next = clients.map((cl) => cl.getConn())
    const prev = cache.current
    if (next.length !== prev.length || next.some((cn, i) => cn !== prev[i])) cache.current = next
    return cache.current
  }
  return useSyncExternalStore(subscribe, get)
}

/** "192.168.1.234" from "ws://192.168.1.234:37292/" — what the user would
 *  recognise as the machine's address. */
export function hostOf(wsUrl: string): string {
  const authority = /^[a-z]+:\/\/([^/?#]+)/i.exec(wsUrl)?.[1] ?? wsUrl
  return authority.replace(/:\d+$/, '')
}

export type WaitingView =
  | { kind: 'none-enabled' }
  /** Every backend has its snapshot; whatever the caller waited for isn't
   *  coming from a connection. */
  | { kind: 'all-connected' }
  | { kind: 'connecting'; pending: number[] }
  | { kind: 'unreachable'; failed: number[] }

/** What the not-yet-connected screen should say, by index into `conns`.
 *  Only backends without a snapshot count; "unreachable" once every one of
 *  them has failed at least once, "connecting" while any is still on its
 *  first try. */
export function waitingView(conns: readonly ConnState[]): WaitingView {
  if (conns.length === 0) return { kind: 'none-enabled' }
  const waiting = conns.flatMap((cn, i) => (cn.hasSnapshot ? [] : [i]))
  if (waiting.length === 0) return { kind: 'all-connected' }
  const failed = waiting.filter((i) => !conns[i].connected && !!conns[i].error)
  if (failed.length === waiting.length) return { kind: 'unreachable', failed }
  return { kind: 'connecting', pending: waiting.filter((i) => !failed.includes(i)) }
}

export function tabsOf(pane: PaneNode | undefined): TerminalTab[] {
  if (!pane) return []
  if (pane.type === 'leaf') return pane.tabs
  return [...tabsOf(pane.children[0]), ...tabsOf(pane.children[1])]
}

export function chatTabsOf(state: AppState, worktreePath: string): TerminalTab[] {
  return tabsOf(state.terminals.panes[worktreePath]).filter((t) => t.type === 'json-claude')
}

/** Same rollup the sidebar uses: highest-ranked tab status wins. */
export function rollupStatus(state: AppState, worktreePath: string): PtyStatus {
  let best: PtyStatus = 'idle'
  for (const tab of tabsOf(state.terminals.panes[worktreePath])) {
    const s = state.terminals.statuses[tab.id]
    if (s && ROLLUP_STATUS_RANK[s] > ROLLUP_STATUS_RANK[best]) best = s
  }
  return best
}
