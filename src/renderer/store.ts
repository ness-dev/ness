// Renderer-side mirror of the main-process store. This is intentionally
// a passive view: the renderer NEVER originates a mutation here. Every
// change comes from a `state:event` message that we apply via the
// SHARED reducer (the same code main runs), guaranteeing the two stay
// in sync without any custom diffing.
//
// Multi-backend (Tier 1): the renderer holds a `BackendsRegistry` of
// `(transport, ClientStore)` pairs — one per configured backend. Each
// transport is naturally scoped to one backend (each `state:event`
// channel only ever delivers events from its own server), so no
// per-event routing is required: at registration time we wire each
// transport's `onStateEvent` directly to its own store. The hooks
// below (`useSettings`, `usePrs`, `usePanes`, …) read from the
// **active** backend's store via `useSyncExternalStore`, with the
// subscribe callback firing on either (a) inner-store events or (b)
// active-id changes — so switching backends triggers a re-render that
// reads from the new active store.
//
// To mutate state, call the corresponding `useBackend()` method (e.g.
// `useBackend().setTheme(...)`). That goes to whichever backend the
// registry currently routes to (active backend for most surfaces;
// always-local for connections-list mutations). Main dispatches
// through its store, broadcasts the event back here, the matching
// per-backend store applies it, and any component reading via the
// active backend's hooks re-renders.

import { useSyncExternalStore } from 'react'
import {
  initialState,
  mergeWireSnapshot,
  rootReducer,
  type AppState,
  type StateEvent,
  type WireSnapshotState
} from '../shared/state'
import type { PtyStatus } from '../shared/state/terminals'
import type { RemoteServerVersion } from '../shared/state/ssh-bootstrap'
import type { LocalTransportHandle, BackendConnection } from './types'
import type { BootstrapProgress, SshBootstrapState } from '../shared/state/ssh-bootstrap'
import { WebSocketClientTransport } from '../shared/transport/transport-websocket'
import { initBackend, getBackend } from './backend'

/** Stable id for the in-process Electron backend. Mirrors the value in
 *  src/main/persistence.ts; duplicated here because main isn't
 *  importable from renderer code. */
export const LOCAL_BACKEND_ID = 'local'

/** Per-backend client-side mirror. One instance per configured backend.
 *  Owns the AppState mirror, the listener set, and the cached client
 *  id. Constructed by the registry at backend-add time. */
class ClientStore {
  private state: AppState = initialState
  private listeners = new Set<() => void>()
  private clientIdValue: string | null = null

  applyEvent(event: StateEvent): void {
    this.state = rootReducer(this.state, event)
    for (const l of this.listeners) l()
  }

  setSnapshot(state: WireSnapshotState): void {
    // Per-slice merge against initialState. This is the wire-side trust
    // boundary: a remote `harness-server` on an older version may be
    // missing entire slices (added after it shipped) AND/OR be missing
    // individual fields inside slices it does send (e.g. v2.9.3 sends
    // `settings` without `customThemes`, which 99262b2 added). A
    // top-level shallow merge would only fix the first case; the
    // per-slice merge fixes both. New renderer + old server is the
    // common skew. The shared helper enforces — via the AppState return
    // type — that future slice additions can't silently miss this list.
    this.state = mergeWireSnapshot(state)
    for (const l of this.listeners) l()
  }

  setClientId(id: string): void {
    this.clientIdValue = id
  }

  getClientId(): string | null {
    return this.clientIdValue
  }

  getState(): AppState {
    return this.state
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }
}

/** Holds N `(transport, store)` pairs and tracks which one is active.
 *  The "routing by backend" is structural — each transport's event
 *  channel only delivers its own backend's events, so wiring each
 *  transport's `onStateEvent` to its own store at registration is the
 *  whole story. There is no central event dispatcher.
 *
 *  Active selection is renderer-shell-owned (per
 *  plans/tier-1-multi-backend-ux.md §C). For Tier 1 v1 the registry
 *  starts with only the local backend; remote backends are added in
 *  later steps when the chip strip / add-backend modal lands. */
/** Per-backend connection status (Tier 1 §I). KISS: two states only.
 *  The local backend is hardcoded to 'connected' since it has no
 *  socket to drop. Reasons populate the chip tooltip on disconnect. */
export interface BackendStatus {
  state: 'connected' | 'disconnected'
  reason?: string
}

interface BackendEntry {
  connection: BackendConnection
  transport: LocalTransportHandle
  store: ClientStore
  status: BackendStatus
}

/** Stable snapshot returned for ids the registry doesn't know about,
 *  shared across calls so useSyncExternalStore selectors stay
 *  reference-stable for missing entries. */
const DEFAULT_BACKEND_STATUS: BackendStatus = { state: 'connected' }

/** Subscribe to "this transport reconnected" events at the registry
 *  level. Fires after each (re)connect (including the first), once the
 *  registry's ClientStore has been seeded with the fresh server-side
 *  clientId. XTerminal subscribes here to re-fire `terminal:join` after
 *  a reconnect — the server's old `controllerClientId` was cleared when
 *  the old socket closed, and the renderer's mount-only join effect
 *  doesn't run again on its own. */
type ReconnectSubscriber = (backendId: string, clientId: string) => void

export class BackendsRegistry {
  private entries = new Map<string, BackendEntry>()
  private activeId: string = LOCAL_BACKEND_ID
  private activeIdListeners = new Set<() => void>()
  private listListeners = new Set<() => void>()
  private statusListeners = new Set<() => void>()
  private reconnectListeners = new Set<ReconnectSubscriber>()
  // Cached return values for the read-only hooks. We rebuild the
  // cached array / status map ONLY when the underlying data changes;
  // useSyncExternalStore requires getSnapshot to be reference-stable
  // for unchanged data (otherwise React keeps detecting "new state"
  // and infinite-loops). Invalidated by the mutators below.
  private connectionsCache: readonly BackendConnection[] | null = null

  add(
    connection: BackendConnection,
    transport: LocalTransportHandle,
    initialStatus: BackendStatus = DEFAULT_BACKEND_STATUS
  ): ClientStore {
    if (this.entries.has(connection.id)) {
      throw new Error(`backend already registered: ${connection.id}`)
    }
    const store = new ClientStore()
    this.entries.set(connection.id, {
      connection,
      transport,
      store,
      status: initialStatus
    })
    transport.onStateEvent((event, _seq) => store.applyEvent(event as StateEvent))
    // The WS transport mints a fresh server-side clientId on every
    // reconnect, so we keep the registry's ClientStore in sync and fan
    // out to renderer subscribers (XTerminal re-fires terminal:join).
    // The local Electron transport's onReconnect is a no-op, so this is
    // a free wire on local backends.
    transport.onReconnect((clientId) => {
      store.setClientId(clientId)
      // eslint-disable-next-line no-console
      console.log(`[take-control] transport reconnect backend=${connection.id} clientId=${clientId}`)
      for (const l of this.reconnectListeners) {
        try {
          l(connection.id, clientId)
        } catch {
          // swallow — a flaky subscriber mustn't kill the registry
        }
      }
    })
    this.connectionsCache = null
    for (const l of this.listListeners) l()
    return store
  }

  subscribeReconnect(cb: ReconnectSubscriber): () => void {
    this.reconnectListeners.add(cb)
    return () => {
      this.reconnectListeners.delete(cb)
    }
  }

  setStatus(id: string, status: BackendStatus): void {
    const entry = this.entries.get(id)
    if (!entry) return
    if (entry.status.state === status.state && entry.status.reason === status.reason) return
    entry.status = status
    for (const l of this.statusListeners) l()
  }

  getStatus(id: string): BackendStatus {
    return this.entries.get(id)?.status ?? DEFAULT_BACKEND_STATUS
  }

  subscribeStatus(cb: () => void): () => void {
    this.statusListeners.add(cb)
    return () => {
      this.statusListeners.delete(cb)
    }
  }

  remove(id: string): void {
    if (id === LOCAL_BACKEND_ID) {
      throw new Error('cannot remove local backend')
    }
    const entry = this.entries.get(id)
    if (!entry) return
    // Close the underlying transport if it has a close method. The
    // remote WebSocketClientTransport exposes one; the local handle
    // (a plain object wrapper around ElectronClientTransport) doesn't,
    // and we wouldn't want to drop the local IPC channel anyway.
    const closer = (entry.transport as { close?: () => void }).close
    if (typeof closer === 'function') {
      try {
        closer.call(entry.transport)
      } catch {
        /* swallow — we're tearing down regardless */
      }
    }
    this.entries.delete(id)
    if (this.activeId === id) this.setActive(LOCAL_BACKEND_ID)
    this.connectionsCache = null
    for (const l of this.listListeners) l()
  }

  updateConnection(id: string, patch: Partial<BackendConnection>): void {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.connection = { ...entry.connection, ...patch }
    this.connectionsCache = null
    for (const l of this.listListeners) l()
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  getStore(id: string): ClientStore | undefined {
    return this.entries.get(id)?.store
  }

  getTransport(id: string): LocalTransportHandle | undefined {
    return this.entries.get(id)?.transport
  }

  getConnection(id: string): BackendConnection | undefined {
    return this.entries.get(id)?.connection
  }

  listConnections(): readonly BackendConnection[] {
    if (this.connectionsCache) return this.connectionsCache
    const list: BackendConnection[] = []
    for (const e of this.entries.values()) list.push(e.connection)
    this.connectionsCache = list
    return list
  }

  getActiveStore(): ClientStore {
    const e = this.entries.get(this.activeId)
    if (!e) throw new Error(`no store for active backend ${this.activeId}`)
    return e.store
  }

  getActiveTransport(): LocalTransportHandle {
    const e = this.entries.get(this.activeId)
    if (!e) throw new Error(`no transport for active backend ${this.activeId}`)
    return e.transport
  }

  getActiveConnection(): BackendConnection {
    const e = this.entries.get(this.activeId)
    if (!e) throw new Error(`no connection for active backend ${this.activeId}`)
    return e.connection
  }

  getActiveId(): string {
    return this.activeId
  }

  getAllIds(): string[] {
    return Array.from(this.entries.keys())
  }

  setActive(id: string): void {
    if (this.activeId === id) return
    if (!this.entries.has(id)) throw new Error(`unknown backend ${id}`)
    this.activeId = id
    // No preload-side router to notify any more — the backend is
    // built in the renderer (see src/renderer/backend.ts) and reads
    // the active transport lazily on each call, so flipping `activeId`
    // here is the entire commit. Listeners below let the hooks
    // subscribed via useSyncExternalStore re-render with the new
    // active store's slice values.
    for (const l of this.activeIdListeners) l()
  }

  subscribeActiveId(cb: () => void): () => void {
    this.activeIdListeners.add(cb)
    return () => {
      this.activeIdListeners.delete(cb)
    }
  }

  subscribeList(cb: () => void): () => void {
    this.listListeners.add(cb)
    return () => {
      this.listListeners.delete(cb)
    }
  }
}

const registry = new BackendsRegistry()

/** Subscribe to "anything that would change what the slice hooks read"
 *  — fires on either active-store events or active-id changes. The
 *  active-id branch swaps the inner subscription so listeners stay
 *  tracking whichever store is currently active, without callers
 *  having to re-subscribe. */
function subscribeActive(cb: () => void): () => void {
  let storeUnsub = registry.getActiveStore().subscribe(cb)
  const idUnsub = registry.subscribeActiveId(() => {
    storeUnsub()
    storeUnsub = registry.getActiveStore().subscribe(cb)
    cb()
  })
  return () => {
    storeUnsub()
    idUnsub()
  }
}

/** Server-assigned identity for this renderer wrt the active backend.
 *  Per-backend — when active flips, this value can change. Components
 *  using `useSyncExternalStore` (via the slice hooks below) re-render
 *  on the swap and would naturally pick up the new id. Synchronous
 *  callers (selectors comparing `controllerClientId` to "me") get the
 *  active value at call time. */
export function getClientId(): string | null {
  return registry.getActiveStore().getClientId()
}

/** Subscribe to "the active backend's transport reconnected" events.
 *  Fires after each WS (re)connect with the fresh server-side clientId,
 *  AFTER the registry's per-backend ClientStore has been updated. The
 *  local Electron transport never reconnects, so this is a no-op for
 *  the local backend.
 *
 *  XTerminal subscribes here to re-fire `terminal:join` — the server
 *  cleared its old `controllerClientId` when the old socket closed, so
 *  the renderer has to re-announce itself once it has a new id. */
export function subscribeActiveTransportReconnect(
  cb: (clientId: string) => void
): () => void {
  return registry.subscribeReconnect((backendId, clientId) => {
    if (backendId !== registry.getActiveId()) return
    cb(clientId)
  })
}

export async function initStore(): Promise<void> {
  const localTransport = window.__harness_local_transport
  if (!localTransport) {
    throw new Error(
      'preload did not expose __harness_local_transport — Tier 1 multi-backend wiring missing'
    )
  }
  // Wire the local backend first; for v1 it's the only one in the
  // registry. Remote backends from `connections[]` get added by the
  // chip-strip controller in a later commit.
  //
  // The connection's `kind` follows the runtime: in the browser web
  // client, `__HARNESS_WEB__` is true and the underlying transport is
  // a WebSocketClientTransport — semantically remote, even though the
  // registry id is still `local` (it's the always-present default the
  // user can't remove). UI gating reads `kind`, not the id.
  const isWeb = typeof window !== 'undefined' && window.__HARNESS_WEB__ === true
  const localConnection: BackendConnection = {
    id: LOCAL_BACKEND_ID,
    label: 'Local',
    url: '',
    kind: isWeb ? 'remote' : 'local',
    addedAt: 0
  }
  const localStore = registry.add(localConnection, localTransport)

  // Build the `useBackend()` singleton now that the registry knows
  // about the local backend. Each method routes lazily through the registry's
  // active transport (local handle for local, WS direct for remotes —
  // the latter bypasses the preload entirely so remote RPCs are as fast
  // as the standalone web client).
  initBackend({
    getActiveTransport: () => registry.getActiveTransport(),
    getLocalTransport: () => localTransport
  })

  const [snapshot, id] = await Promise.all([
    localTransport.getStateSnapshot(),
    localTransport.getClientId()
  ])
  localStore.setSnapshot(snapshot.state)
  localStore.setClientId(id)
  // eslint-disable-next-line no-console
  console.log(`[take-control] initStore localClientId=${id}`)

  // Diagnostic logging for the controller/spectator flow. If the UI is
  // ever stuck on the wrong controller, grep console for
  // `[take-control]` — every roster event hitting the local backend's
  // store is logged with the post-reducer controllerClientId.
  localTransport.onStateEvent((event) => {
    const e = event as StateEvent
    if (
      e.type === 'terminals/controlTaken' ||
      e.type === 'terminals/controlReleased' ||
      e.type === 'terminals/clientJoined' ||
      e.type === 'terminals/clientDisconnected'
    ) {
      const payload = e.payload as { terminalId?: string }
      const tid = payload.terminalId
      const session = tid ? localStore.getState().terminals.sessions[tid] : undefined
      // eslint-disable-next-line no-console
      console.log(
        `[take-control] applied event=${e.type} payload=${JSON.stringify(e.payload)} myClientId=${id} postController=${session?.controllerClientId ?? 'null'}`
      )
    }
  })

  // Hydrate any saved remote backends (Tier 1 multi-backend UX). Each
  // remote becomes its own (transport, store) pair in the registry; the
  // user can flip between them via the chip strip. WS connect failures
  // are swallowed here — the registry entry still gets added so the
  // chip renders (greyed-disconnected styling lands in step 8) and the
  // user can retry.
  //
  // Skipped in the web client: backend.connectionsList returns an
  // empty stub there, so the loop is a no-op. Multi-backend is an
  // Electron-only feature in Tier 1.
  try {
    const backend = getBackend()
    const connections = await backend.connectionsList()
    for (const conn of connections) {
      if (conn.kind !== 'remote') continue
      void hydrateRemoteBackend(conn, { registry, backend })
    }
    const savedActive = await backend.connectionsGetActive()
    if (savedActive && registry.has(savedActive)) {
      registry.setActive(savedActive)
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[harness] failed to hydrate remote backends', err)
  }

  const local = registry.getStore(LOCAL_BACKEND_ID)
  if (local) {
    watchForTunnelPortChanges({
      subscribe: (cb) => local.subscribe(cb),
      getById: () => local.getState().sshBootstrap.byId,
      hasConnection: (id) => !!registry.getConnection(id),
      getLivePort: (id) => {
        const conn = registry.getConnection(id)
        if (!conn) return null
        try {
          return Number(new URL(conn.url).port) || null
        } catch {
          return null
        }
      },
      resync: resyncRemoteBackend
    })
  }
}

/** Rebuild a remote's WS transport when its tunnel comes back on a
 *  *different* loopback port.
 *
 *  Reconnects normally reacquire the previous port precisely so this
 *  never has to fire — the persisted ws:// URL stays valid and the
 *  transport's own retry loop reconnects on its own. But if something
 *  else grabbed the port in the meantime, main persists the new URL and
 *  the live transport is left retrying an address that will never
 *  answer. Watching the sshBootstrap slice (which main dispatches into,
 *  and which carries the bound port) is how the renderer finds out. */
export interface TunnelPortWatchDeps {
  subscribe: (cb: () => void) => () => void
  getById: () => SshBootstrapState['byId']
  /** False for connections the registry doesn't know about — nothing to
   *  rebuild, so they're skipped rather than resynced. */
  hasConnection: (connectionId: string) => boolean
  /** Port the persisted ws:// URL points at, or null if unparseable. */
  getLivePort: (connectionId: string) => number | null
  resync: (connectionId: string) => Promise<void>
}

export function watchForTunnelPortChanges(deps: TunnelPortWatchDeps): void {
  const { subscribe, getById, hasConnection, getLivePort, resync } = deps
  const reconciled = new Map<string, number>()
  const inFlight = new Set<string>()
  let lastById: SshBootstrapState['byId'] | null = null
  subscribe(() => {
    // This fires on EVERY local-store event, so bail on the common case
    // before touching anything. The reducer preserves `byId`'s identity
    // when nothing in the slice changed.
    const byId = getById()
    if (byId === lastById) return
    lastById = byId
    // One connection accumulates several attempts over its lifetime
    // (`boot-`, `hydrate-`, `reconnect-`), each pinned to whatever port
    // it bound. Only the newest describes reality — comparing all of
    // them against one per-connection guard let two stale entries
    // invalidate each other and resync on a loop.
    const newest = new Map<string, BootstrapProgress>()
    for (const entry of Object.values(byId)) {
      const id = entry.connectionId
      if (!id || entry.phase !== 'connected' || !entry.localPort) continue
      const prev = newest.get(id)
      if (!prev || entry.updatedAt > prev.updatedAt) newest.set(id, entry)
    }
    for (const [id, entry] of newest) {
      if (inFlight.has(id) || reconciled.get(id) === entry.localPort) continue
      if (!hasConnection(id)) continue
      reconciled.set(id, entry.localPort!)
      if (getLivePort(id) === entry.localPort) continue
      // A rebuild dispatches into this very slice, so without the guard
      // the resync re-enters through its own state events.
      inFlight.add(id)
      void resync(id).finally(() => inFlight.delete(id))
    }
  })
}

/** Tear down and re-create a remote's transport against its current
 *  persisted URL. */
async function resyncRemoteBackend(connectionId: string): Promise<void> {
  try {
    const backend = getBackend()
    const fresh = (await backend.connectionsList()).find((c) => c.id === connectionId)
    if (!fresh) return
    // `remove` falls active back to Local; restore it afterwards so a
    // background port change doesn't yank the user out of the backend
    // they're looking at.
    const wasActive = registry.getActiveId() === connectionId
    try {
      registry.remove(connectionId)
    } catch {
      /* not registered — hydrate below still does the right thing */
    }
    await hydrateRemoteBackend(fresh, { registry, backend })
    if (wasActive && registry.has(connectionId)) registry.setActive(connectionId)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[harness] failed to resync backend ${connectionId}`, err)
  }
}

/** Construct a WS transport for a saved remote, fetch its token from
 *  secrets, connect, and register the pair. Errors are logged but
 *  non-fatal — the user can retry from the chip strip.
 *
 *  Exported (with dependency-injection) for tests. Production callers
 *  pass the module-level `registry` and `backend`. */
export async function hydrateRemoteBackend(
  conn: BackendConnection,
  deps: {
    registry: BackendsRegistry
    backend: Pick<
      import('./types').ElectronAPI,
      'connectionsGetToken' | 'sshReconnect'
    >
    WSCtor?: typeof WebSocketClientTransport
  }
): Promise<void> {
  const { registry: reg, backend, WSCtor = WebSocketClientTransport } = deps
  try {
    // SSH backends: ask main to (re)establish the tunnel first so we
    // get a live loopback URL+token. Main runs the bootstrap pre-warm
    // on boot too — the IPC call here is idempotent and will return
    // immediately if the tunnel is already up. We mint a fresh
    // bootstrap id so the chip strip can subscribe to progress.
    let url = conn.url
    let token = await backend.connectionsGetToken(conn.id)
    if (conn.ssh) {
      try {
        const bootstrapId = `hydrate-${conn.id}`
        const result = await backend.sshReconnect({
          bootstrapId,
          connectionId: conn.id
        })
        url = result.url
        token = result.token
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[harness] ssh reconnect failed for backend ${conn.id}`, err)
        // Fall through with cached url+token so the WS transport at
        // least registers an entry; the chip will render greyed via
        // the failed connect below.
      }
    }
    if (!token) {
      // eslint-disable-next-line no-console
      console.warn(`[harness] no token stored for backend ${conn.id} — skipping`)
      return
    }
    // BackendConnection.url is the wire URL with ws://-or-wss:// prefix
    // (parseConnectionUrl preserves the TLS choice from what the user
    // pasted). The token is held separately in secrets.enc. The
    // onConnectionChange callback feeds into the registry's per-backend
    // status, which the chip strip reads to grey disconnected entries.
    //
    // onSnapshot fires after every (re)connect — we seed the registry's
    // ClientStore with each fresh snapshot so an inactive backend that
    // briefly drops + reconnects in the background catches up cleanly
    // when the user switches to it.
    if (reg.has(conn.id)) return
    const ws = new WSCtor({
      url,
      token,
      onConnectionChange: (connected, reason) => {
        reg.setStatus(conn.id, {
          state: connected ? 'connected' : 'disconnected',
          reason
        })
      },
      onSnapshot: (snapshot) => {
        const store = reg.getStore(conn.id)
        if (store) store.setSnapshot(snapshot.state)
      }
    })
    // Register BEFORE connecting so the onSnapshot + onReconnect
    // callbacks fire through the same path on first connect and on
    // every subsequent reconnect. The store is seeded with initialState
    // until the first snapshot arrives — a brief flash, gone in <100ms.
    reg.add(conn, ws)
    await ws.connect()
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[harness] failed to connect to backend ${conn.id}`, err)
    // Drop the half-registered entry so it can't poison active-backend
    // selection. Without this, the outer hydration loop's
    // `if (registry.has(savedActive)) setActive(savedActive)` would pin
    // active at this never-connected remote, and the app would render
    // the empty-state onboarding screen even though the local backend
    // has the user's real repos. `remove` auto-falls-back to
    // LOCAL_BACKEND_ID if the dropped entry was active.
    try {
      reg.remove(conn.id)
    } catch {
      /* not added or already gone — fine */
    }
  }
}

/** Tear a remote backend's WS transport down and reconnect it from
 *  scratch. Needed after an upgrade restarts the remote server: it comes
 *  back on a new port with a new token, so the live socket is pointed at
 *  a tunnel that no longer exists and no amount of WS-level retrying
 *  will recover it. Active-backend selection survives the swap. */
export async function reconnectBackend(connectionId: string): Promise<void> {
  const conn = registry.getConnection(connectionId)
  if (!conn || conn.kind !== 'remote') return
  const wasActive = registry.getActiveId() === connectionId
  registry.remove(connectionId)
  await hydrateRemoteBackend(conn, { registry, backend: getBackend() })
  if (wasActive && registry.has(connectionId)) registry.setActive(connectionId)
}

function getActiveState(): AppState {
  return registry.getActiveStore().getState()
}

/** Selector hook reading from the **active** backend's store. Re-fires
 *  on inner-store events AND on active-backend changes (so switching
 *  backends triggers a re-render that reads fresh state from the new
 *  active store). */
export function useAppState<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    subscribeActive,
    () => selector(getActiveState()),
    () => selector(initialState)
  )
}

export function useSettings() {
  return useAppState((s) => s.settings)
}

export function usePrs() {
  return useAppState((s) => s.prs)
}

export function useOnboarding() {
  return useAppState((s) => s.onboarding)
}

export function useHooks() {
  return useAppState((s) => s.hooks)
}

export function useWorktrees() {
  return useAppState((s) => s.worktrees)
}

export function useTerminals() {
  return useAppState((s) => s.terminals)
}

export function usePanes() {
  return useAppState((s) => s.terminals.panes)
}

export function useLastActive() {
  return useAppState((s) => s.terminals.lastActive)
}

export function useUpdater() {
  return useAppState((s) => s.updater)
}

export function useAnnouncements() {
  return useAppState((s) => s.announcements)
}

export function useRepoConfigs() {
  return useAppState((s) => s.repoConfigs.byRepo)
}

/** Config filename for one repo — `.ness.json`, or `.harness.json` for
 *  repos that already had one before the rename. */
export function useRepoConfigFilename(repoRoot: string | null): string {
  return useAppState((s) =>
    repoRoot ? s.repoConfigs.filenameByRepo[repoRoot] || '.ness.json' : '.ness.json'
  )
}

export function useCosts() {
  return useAppState((s) => s.costs)
}

/** Context-window occupancy for one tab. Per-id rather than whole-slice
 *  so a snapshot landing for one agent doesn't re-render every consumer —
 *  see CLAUDE.md "Anti-patterns to avoid in slices and derivers" #4. */
export function useContextWindow(terminalId: string | null) {
  return useAppState((s) => (terminalId ? s.contextWindow.byTerminal[terminalId] : undefined))
}

export function useSnooze() {
  return useAppState((s) => s.snooze)
}

export function useCiNotify() {
  return useAppState((s) => s.ciNotify)
}

export function useAssignedPRs() {
  return useAppState((s) => s.assignedPRs)
}

/** Scratchpad text for one worktree. Per-id selector — only re-renders
 *  when this worktree's text changes (other worktrees' edits don't fan
 *  out). Returns '' for unknown / null paths so the consumer doesn't
 *  need a null check. */
export function useScratchpad(worktreePath: string | null): string {
  return useAppState((s) =>
    worktreePath ? s.scratchpad.byWorktreePath[worktreePath] ?? '' : ''
  )
}

/** Per-bootstrap progress for the AddBackendModal SSH tab. Returns null
 *  when the bootstrap id is unknown (e.g. just cleared) so the modal can
 *  render a fresh state without dereferencing undefined. */
export function useSshBootstrap(bootstrapId: string | null) {
  return useLocalAppState((s) =>
    bootstrapId ? (s.sshBootstrap.byId[bootstrapId] ?? null) : null
  )
}

/** All in-flight + recently-finished SSH bootstrap entries. Used by the
 *  chip strip when it wants to show "reconnecting…" on boot-time
 *  reconnects (commit 4). */
export function useSshBootstrapAll() {
  return useLocalAppState((s) => s.sshBootstrap.byId)
}

/** Selector hook pinned to the LOCAL backend's store, whatever is
 *  active. The local Electron process owns every SSH connection, so the
 *  sshBootstrap slice only ever populates there — a chip-strip
 *  affordance reading via `useAppState` would go blank the moment the
 *  user switched to the remote it describes. */
export function useLocalAppState<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    subscribeLocal,
    () => selector(getLocalState()),
    () => selector(initialState)
  )
}

// Module-level so the subscribe identity is stable across renders —
// an inline arrow would make useSyncExternalStore re-subscribe on
// every commit.
function subscribeLocal(cb: () => void): () => void {
  const store = registry.getStore(LOCAL_BACKEND_ID)
  return store ? store.subscribe(cb) : () => {}
}

function getLocalState(): AppState {
  return registry.getStore(LOCAL_BACKEND_ID)?.getState() ?? initialState
}

/** Version of `harness-server` running on an SSH backend, or null if we
 *  haven't probed it (non-SSH backend, or the probe hasn't run yet).
 *  `upgradeAvailable` drives the chip strip's upgrade affordance. */
export function useRemoteServerVersion(connectionId: string): RemoteServerVersion | null {
  return useLocalAppState((s) => s.sshBootstrap.serverVersions[connectionId] ?? null)
}

/** Latest bootstrap attempt linked to a given backend connection, or
 *  null if none. A single backend can have several entries over its
 *  lifetime (`boot-<id>` from the main pre-warm, `hydrate-<id>` from the
 *  renderer, `reconnect-<id>` from the supervisor), so we take the most
 *  recently updated one — that's the attempt whose phase reflects
 *  reality right now.
 *
 *  Returns the slice's own object reference (never a fresh literal) so
 *  useSyncExternalStore doesn't see a "change" on every read. */
export function useSshBootstrapForConnection(connectionId: string) {
  return useLocalAppState((s) => {
    let best: BootstrapProgress | null = null
    for (const entry of Object.values(s.sshBootstrap.byId)) {
      if (entry.connectionId !== connectionId) continue
      if (!best || entry.updatedAt > best.updatedAt) best = entry
    }
    return best
  })
}

export function useAliases() {
  return useAppState((s) => s.aliases)
}

/** Per-id alias selector. Accepts null/undefined for the "no active
 *  worktree" case so callers don't have to fall back to an empty-string
 *  path (which would still subscribe, just to a permanently-undefined
 *  key). Preferred over `useAliases()` for single-worktree consumers to
 *  avoid whole-slice re-renders (CLAUDE.md anti-pattern #4). */
export function useAliasForPath(path: string | null | undefined): string | undefined {
  return useAppState((s) => (path ? s.aliases.byPath[path] : undefined))
}

export function useBrowser() {
  return useAppState((s) => s.browser)
}

/** The boot-time config.json load error, or null on a healthy load.
 *  Drives InvalidConfigModal. */
export function useConfigLoadError() {
  return useAppState((s) => s.configHealth.loadError)
}

/** Session roster (controller + spectators) for a given terminal id.
 *  Re-renders only when that terminal's entry changes. Returns null if
 *  the terminal hasn't been joined yet (e.g. right after pane create
 *  but before the XTerminal mount dispatches terminal:join). */
export function useTerminalSession(terminalId: string) {
  return useAppState((s) => s.terminals.sessions[terminalId] ?? null)
}

/** Per-terminal OSC 9;4 progress. Narrow over `useTerminals()` so a
 *  progress tick on terminal A doesn't re-render every tab subscribing
 *  for terminals B/C/D — the reducer preserves per-key reference identity
 *  for entries it didn't touch. */
export function useTerminalProgress(terminalId: string) {
  return useAppState((s) => s.terminals.progress[terminalId] ?? null)
}

/** Per-terminal status. Same narrowing rationale as useTerminalProgress,
 *  but this one was load-bearing for a different reason: `statuses` used to
 *  be threaded whole from App through WorkspaceView → SplitRenderer →
 *  LeafPane → TerminalPanel, so one terminal changing status allocated a new
 *  map and re-rendered every mounted worktree's entire subtree. With ~22
 *  worktrees mounted at once and a status dispatch per streamed token, that
 *  was the renderer's dominant commit-phase cost. Read it here, per tab. */
export function useTerminalStatus(terminalId: string): PtyStatus {
  return useAppState((s) => s.terminals.statuses[terminalId] ?? 'idle')
}

/** Per-terminal shell busy/process-name. Narrowed for the same reason as
 *  useTerminalStatus — see that comment. */
export function useShellActivity(terminalId: string) {
  return useAppState((s) => s.terminals.shellActivity[terminalId] ?? null)
}

export function useJsonClaude() {
  return useAppState((s) => s.jsonClaude)
}

/** Per-session selector. Narrow over `useJsonClaude()` so a streaming
 *  delta from session A doesn't re-render every JsonModeChat mounted
 *  for sessions B/C/D — the reducer keeps the per-key reference stable
 *  for sessions it didn't touch, so this selector returns the same
 *  object and useSyncExternalStore skips the render. */
export function useJsonClaudeSession(sessionId: string) {
  return useAppState((s) => s.jsonClaude.sessions[sessionId] ?? null)
}

/** Approvals map alone. Narrow over `useJsonClaude()` for the same
 *  reason — delta events on any session don't touch pendingApprovals,
 *  so subscribers here skip the streaming hot path entirely. */
export function useJsonClaudePendingApprovals() {
  return useAppState((s) => s.jsonClaude.pendingApprovals)
}

/** Stable empty-array reference returned by the SSR / pre-init hook
 *  paths so `useSyncExternalStore`'s reference comparison doesn't
 *  detect a "change" on every render and fall into an infinite update
 *  loop. */
const EMPTY_CONNECTIONS: readonly BackendConnection[] = []

/** Stable fallback for `useActiveBackend`'s server-side render path. */
const FALLBACK_ACTIVE_BACKEND: BackendConnection = {
  id: LOCAL_BACKEND_ID,
  label: 'Local',
  url: '',
  kind: 'local',
  addedAt: 0
}

const subscribeConnectionsList = (cb: () => void): (() => void) =>
  registry.subscribeList(cb)
const getConnectionsSnapshot = (): readonly BackendConnection[] =>
  registry.listConnections()
const getConnectionsServerSnapshot = (): readonly BackendConnection[] =>
  EMPTY_CONNECTIONS

/** Returns the list of registered backends (local + any added remotes).
 *  Re-renders on backend add/remove/rename. The chip strip uses this to
 *  render avatars; UI gating uses `useActiveBackend()` instead.
 *
 *  Returns a registry-cached array — invalidated only on real
 *  add/remove/updateConnection — so reference identity is stable
 *  across renders that don't change the list. */
export function useConnections(): readonly BackendConnection[] {
  return useSyncExternalStore(
    subscribeConnectionsList,
    getConnectionsSnapshot,
    getConnectionsServerSnapshot
  )
}

const subscribeStatus = (cb: () => void): (() => void) =>
  registry.subscribeStatus(cb)
const getStatusServerSnapshot = (): BackendStatus => DEFAULT_BACKEND_STATUS

/** Per-backend connection status. Re-renders only on transitions for
 *  the specific id. Local always returns 'connected' since the
 *  in-process transport has no socket to drop. The stored status
 *  reference is mutated only when a real transition happens, so
 *  reference identity is stable across non-transition renders. */
export function useBackendStatus(id: string): BackendStatus {
  return useSyncExternalStore(
    subscribeStatus,
    () => registry.getStatus(id),
    getStatusServerSnapshot
  )
}

const subscribeActiveBackend = (cb: () => void): (() => void) => {
  const offList = registry.subscribeList(cb)
  const offId = registry.subscribeActiveId(cb)
  return () => {
    offList()
    offId()
  }
}
const getActiveBackendSnapshot = (): BackendConnection =>
  registry.getActiveConnection()
const getActiveBackendServerSnapshot = (): BackendConnection => FALLBACK_ACTIVE_BACKEND

/** Returns the currently-active backend's connection metadata. Re-renders
 *  on either the active id changing OR the active backend's metadata
 *  being patched (e.g. rename). The most-used field is `kind` — gating
 *  things like RemoteFilePicker vs native dialog (per design §L). */
export function useActiveBackend(): BackendConnection {
  return useSyncExternalStore(
    subscribeActiveBackend,
    getActiveBackendSnapshot,
    getActiveBackendServerSnapshot
  )
}

/** Test-only / advanced: get a handle to the registry. Lets the chip
 *  strip and add-backend flow add/switch backends. Never call from
 *  hooks — they should always use the slice hooks above. */
export function getBackendsRegistry(): BackendsRegistry {
  return registry
}

export type { AppState, StateEvent }
