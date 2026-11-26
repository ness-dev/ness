// Mobile client mirror, one per backend. Same shape as the renderer's
// ClientStore (src/renderer/store.ts): snapshot → mergeWireSnapshot, then
// every state frame through the shared rootReducer. The desktop's
// multi-backend registry is the same idea — one (transport, store) pair
// per backend, no cross-backend event routing.
import { useSyncExternalStore } from 'react'
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
