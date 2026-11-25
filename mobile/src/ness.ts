// Mobile client mirror. Same shape as the renderer's ClientStore
// (src/renderer/store.ts): snapshot → mergeWireSnapshot, then every
// state frame through the shared rootReducer. Nothing here is
// mobile-specific except that it's ~80 lines instead of the renderer's
// multi-backend registry.
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

export interface WireStats {
  snapshotBytes: number
  events: number
  eventBytes: number
}

export class NessClient {
  private state: AppState = initialState
  private listeners = new Set<Listener>()
  private connected = false
  private lastError: string | undefined
  readonly stats: WireStats = { snapshotBytes: 0, events: 0, eventBytes: 0 }
  readonly transport: WebSocketClientTransport

  constructor(wsUrl: string, token: string) {
    this.transport = new WebSocketClientTransport({
      url: wsUrl,
      token,
      onSnapshot: (snap) => {
        // Re-stringifying costs a little CPU but it's once per (re)connect
        // and gives the spike a real payload number to report.
        this.stats.snapshotBytes = JSON.stringify(snap).length
        this.state = mergeWireSnapshot(snap.state)
        this.emit()
      },
      onConnectionChange: (connected, reason) => {
        this.connected = connected
        this.lastError = connected ? undefined : reason
        this.emit()
      }
    })
    this.transport.onStateEvent((event) => {
      this.stats.events++
      this.stats.eventBytes += JSON.stringify(event).length
      this.state = rootReducer(this.state, event)
      this.emit()
    })
  }

  connect(): Promise<void> {
    return this.transport.connect()
  }

  close(): void {
    this.transport.close()
  }

  getState = (): AppState => this.state
  isConnected = (): boolean => this.connected
  getLastError = (): string | undefined => this.lastError

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
  resolveApproval(requestId: string, allow: boolean, input: Record<string, unknown>): Promise<unknown> {
    return this.transport.request(
      'jsonClaude:resolveApproval',
      requestId,
      allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Denied from mobile' }
    )
  }
}

export function useNess<T>(client: NessClient, select: (s: AppState) => T): T {
  return useSyncExternalStore(client.subscribe, () => select(client.getState()))
}

export function useConnected(client: NessClient): boolean {
  return useSyncExternalStore(client.subscribe, client.isConnected)
}

export function tabsOf(pane: PaneNode | undefined): TerminalTab[] {
  if (!pane) return []
  if (pane.type === 'leaf') return pane.tabs
  return [...tabsOf(pane.children[0]), ...tabsOf(pane.children[1])]
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
