// Renderer-side backend accessor. Holds the singleton built by
// `initBackend()` (called from initStore) and serves it via two
// equivalent shapes:
//
//   import { useBackend } from '@/backend'   // React components / hooks
//   import { getBackend } from '@/backend'   // module-level / non-React
//
// The hook is the idiomatic React shape; the getter exists because a
// few call sites (XTerminal's font-cache module init, the take-control
// diagnostic, the error boundary) aren't inside React.
//
// Each method on the returned object lazily reads
// `registry.getActiveTransport()` and dispatches the call there, so
// switching backends instantly redirects subsequent commands. Local
// active goes through the preload's local-transport handle (1
// contextBridge crossing — same as the original `window.api`). Remote
// active goes through the renderer-living WebSocketClientTransport
// directly (0 crossings — same as the standalone web client).

import type { ElectronAPI } from './types'
import type {
  ElectronOnlyHelpers,
  LocalTransportHandle
} from '../shared/transport/transport'
import { buildBackend } from './build-backend'
import { useBackendScope } from './backend-scope'

let backend: ElectronAPI | null = null
/** Per-backend-id instances, built lazily by `getBackendFor`. Cached
 *  because `useBackend()` must hand back a stable reference — ~60 files
 *  pass it to `useCallback` / `useEffect` dep arrays. */
let scoped: ((backendId: string) => ElectronAPI) | null = null

declare global {
  interface Window {
    /** Preload-only Electron helpers (webUtils.getPathForFile,
     *  ipcRenderer-backed window controls). Null in the web client. */
    __harness_electron_helpers?: ElectronOnlyHelpers
  }
}

export function initBackend(opts: {
  getActiveTransport: () => LocalTransportHandle
  getLocalTransport: () => LocalTransportHandle
  /** Resolves one backend's transport by id. Undefined for an id that
   *  isn't registered (or isn't connected yet). */
  getTransportFor: (backendId: string) => LocalTransportHandle | undefined
}): void {
  const electronHelpers = window.__harness_electron_helpers ?? null
  backend = buildBackend(opts.getActiveTransport, opts.getLocalTransport, electronHelpers)

  const cache = new Map<string, ElectronAPI>()
  scoped = (backendId: string): ElectronAPI => {
    const hit = cache.get(backendId)
    if (hit) return hit
    const built = buildBackend(
      () => {
        const transport = opts.getTransportFor(backendId)
        if (!transport) {
          throw new Error(`no transport registered for backend ${backendId}`)
        }
        return transport
      },
      opts.getLocalTransport,
      electronHelpers
    )
    cache.set(backendId, built)
    return built
  }
}

export function getBackend(): ElectronAPI {
  if (!backend) {
    throw new Error('backend accessed before initBackend() — call initStore() first')
  }
  return backend
}

/** The backend for one specific id, with every method routed to that
 *  backend's transport rather than the active one. `null` falls back to
 *  the active-routed singleton.
 *
 *  Throws if `initBackend()` hasn't run; the returned object's methods
 *  throw if the id isn't registered when a call is actually made (the
 *  transport is resolved per call, so building one for a backend that's
 *  still connecting is fine). */
export function getBackendFor(backendId: string | null): ElectronAPI {
  if (!backendId) return getBackend()
  if (!scoped) {
    throw new Error('backend accessed before initBackend() — call initStore() first')
  }
  return scoped(backendId)
}

/** React-side accessor, resolving the backend from the enclosing
 *  `BackendScope`. Outside any scope this is the active-routed singleton
 *  — identical to what this hook always returned, which is why the ~60
 *  files calling it needed no edit when positional routing landed.
 *
 *  Inside a worktree's scope it returns that worktree's backend, so a
 *  remote worktree's panes issue their requests and subscribe to their
 *  `terminal:data` on the right transport while local panes stay mounted
 *  alongside. */
export function useBackend(): ElectronAPI {
  return getBackendFor(useBackendScope())
}
