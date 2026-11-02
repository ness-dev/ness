// Transport abstraction — the seam between main and renderer.
//
// Today there's exactly one implementation pair: ElectronServerTransport
// (main side, wraps ipcMain + webContents.send) and ElectronClientTransport
// (renderer side, wraps ipcRenderer). In the future, additional pairs
// (WebSocket, SSH stdio, …) can slot in without touching any call site
// above this layer — the store, slices, and window.api surface are all
// transport-agnostic.
//
// Three kinds of traffic flow across a transport:
//
// 1. State events — the authoritative mutation stream. Main's Store
//    dispatches a StateEvent, the server transport broadcasts it to every
//    connected client, and each client's mirror applies the SAME shared
//    reducer. This is the backbone of the 2.0 architecture.
//
// 2. Requests — one-shot RPC calls (mirror of ipcMain.handle /
//    ipcRenderer.invoke). Named by a channel string; args and return
//    value are arbitrary JSON-serializable data. All requests are async;
//    there is intentionally no sync variant so future non-Electron
//    transports don't have to invent blocking round-trips.
//
// 3. Signals — fire-and-forget pushes in either direction (mirror of
//    webContents.send / ipcRenderer.send). Used for high-frequency
//    streams (PTY bytes) and low-level fire-and-forget notifications
//    (menu-triggered events, pty:write). No return value, no delivery
//    guarantee beyond what the underlying transport provides.
//
// Server-side request/signal handlers receive a ConnectionContext as
// their first argument. The `clientId` is a server-assigned UUID that
// stays stable for the life of a connection (one per BrowserWindow, one
// per WebSocket). It lets main-side handlers gate on "who's calling" —
// e.g. only the terminal's current controller's pty:write / pty:resize
// are honoured; other clients watch as spectators. Client-side signal
// handlers don't receive a ctx because the server identity is implicit.

import type { StateEvent, StateSnapshot } from '../state'

/** Server-assigned identity of a connected client, threaded into every
 *  request/signal handler so main can gate on who's calling. Stable for
 *  the lifetime of a connection (a BrowserWindow or a WebSocket). */
export interface ConnectionContext {
  clientId: string
  /** Which transport carried the call. `ipc` is the local Electron
   *  window; `ws` is anything that reached the network listener (the
   *  web client, another Ness using this one as a remote). Handlers for
   *  state that belongs to the local machine's shell — saved remote
   *  connections and their tokens — refuse `ws`. */
  via: 'ipc' | 'ws'
}

// Handler args are typed as `any[]` because the wire boundary is
// inherently untyped — the transport doesn't know what each channel's
// arg shape is. Individual handlers declare their own concrete types at
// the call site (e.g. `(ctx, repoRoot: string) => …`). This mirrors how
// ipcMain.handle / ipcRenderer.invoke are typed in @types/electron.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RequestHandler = (ctx: ConnectionContext, ...args: any[]) => unknown | Promise<unknown>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SignalHandler = (ctx: ConnectionContext, ...args: any[]) => void
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ClientSignalHandler = (...args: any[]) => void
export type StateEventListener = (event: StateEvent, seq: number) => void

/** Fires after each successful (re)connect with the server-assigned
 *  clientId for the new socket. WS reconnects mint a fresh UUID per
 *  connection, so subscribers (notably the renderer's per-backend
 *  ClientStore) must refresh any cached clientId on every fire. The
 *  first connect is also delivered through this callback — there's no
 *  separate "first connect" path. */
export type ReconnectListener = (clientId: string) => void

/** Plain-object ClientTransport shape, exposed by the preload (and
 *  the web-client shim) for the local backend. The renderer's
 *  BackendsRegistry treats this as one of N transports and wires it
 *  directly to the local backend's mirrored ClientStore.
 *
 *  Duck-typed because it crosses the contextBridge as a serialized
 *  object; the original class instance isn't preserved across the
 *  bridge. Lives in shared/ so both `src/preload/index.ts` (limited
 *  to tsconfig.node.json) and `src/renderer/store.ts` can import it. */
export interface LocalTransportHandle {
  getStateSnapshot(): Promise<StateSnapshot>
  onStateEvent(cb: StateEventListener): () => void
  request(name: string, ...args: unknown[]): Promise<unknown>
  send(name: string, ...args: unknown[]): void
  onSignal(name: string, handler: ClientSignalHandler): () => void
  getClientId(): Promise<string>
  onReconnect(cb: ReconnectListener): () => void
}

/** Electron-only helpers exposed by the preload that genuinely can't
 *  live in the renderer: webUtils.getPathForFile (for resolving paths
 *  of dropped files) + ipcRenderer.send for window controls (the local
 *  BrowserWindow is what's being controlled, regardless of which
 *  backend is active). Null in the web-client. Same cross-context
 *  shape rationale as LocalTransportHandle — kept in shared/ so the
 *  preload (tsconfig.node.json) and the renderer can both import it. */
export interface ElectronOnlyHelpers {
  getFilePath(file: File): string
  windowMinimize(): void
  windowToggleMaximize(): void
  windowClose(): void
}

export interface ServerTransport {
  /** Broadcast a state event to every connected client. */
  broadcastStateEvent(event: StateEvent, seq: number): void

  /** Register an async request handler for a named channel. */
  onRequest(name: string, handler: RequestHandler): void

  /** Register a fire-and-forget signal handler from clients. */
  onSignal(name: string, handler: SignalHandler): void

  /** Push a fire-and-forget signal to all connected clients. */
  sendSignal(name: string, ...args: unknown[]): void

  /** Subscribe to connection-close events so app code can sweep state
   *  owned by the disconnecting client (e.g. clear controllers/spectators). */
  onClientDisconnect(callback: (clientId: string) => void): void

  /** Lifecycle — called once during boot. */
  start(): void

  /** Lifecycle — called during shutdown. */
  stop(): void
}

export interface ClientTransport {
  /** Fetch the current state snapshot from the server. */
  getStateSnapshot(): Promise<StateSnapshot>

  /** Subscribe to the incoming state-event stream. Returns an unsubscribe. */
  onStateEvent(listener: StateEventListener): () => void

  /** Async RPC — mirror of ipcRenderer.invoke. */
  request(name: string, ...args: unknown[]): Promise<unknown>

  /** Fire-and-forget — mirror of ipcRenderer.send. */
  send(name: string, ...args: unknown[]): void

  /** Subscribe to a signal channel pushed from the server. Returns an unsubscribe. */
  onSignal(name: string, handler: ClientSignalHandler): () => void

  /** The server-assigned identity for this client. Stable for the
   *  connection's lifetime; reassigned (new UUID) after a reconnect. */
  getClientId(): Promise<string>

  /** Fires after each successful (re)connect with the fresh server-side
   *  clientId. For transports that don't reconnect (Electron IPC) this
   *  may be a no-op — the local clientId is stable for the renderer's
   *  lifetime, so subscribers can also read it via `getClientId()`. */
  onReconnect(cb: ReconnectListener): () => void
}
