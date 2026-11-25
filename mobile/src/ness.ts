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

  constructor(
    readonly id: string,
    readonly label: string,
    wsUrl: string,
    token: string
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

  // ── requests the mobile UI needs (channel names from build-backend.ts) ──
  fetchEntries(sessionId: string): Promise<unknown> {
    return this.transport.request('jsonClaude:getEntries', sessionId)
  }
  startSession(sessionId: string, cwd: string): Promise<unknown> {
    return this.transport.request('jsonClaude:start', sessionId, cwd)
  }
  sendMessage(sessionId: string, text: string): void {
    this.transport.send('jsonClaude:send', sessionId, text)
  }
  interrupt(sessionId: string): Promise<unknown> {
    return this.transport.request('jsonClaude:interrupt', sessionId)
  }
  async addChatTab(worktreePath: string): Promise<string> {
    // Claude Code rejects non-UUID session ids, and a json-claude tab's id
    // *is* its session id.
    const id = uuid()
    const tab: TerminalTab = { id, type: 'json-claude', label: 'Chat', mode: 'awake' }
    await this.transport.request('panes:addTab', worktreePath, tab)
    await this.startSession(id, worktreePath)
    return id
  }
  resolveApproval(requestId: string, allow: boolean, input: Record<string, unknown>): Promise<unknown> {
    return this.transport.request(
      'jsonClaude:resolveApproval',
      requestId,
      // Claude Code's validator requires updatedInput on allow; echo it.
      allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Denied from mobile' }
    )
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

function uuid(): string {
  // Hermes has no crypto.randomUUID; a v4-shaped id is all Claude checks.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}
