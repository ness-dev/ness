// hydrateRemoteBackend registers the remote BEFORE awaiting connect().
// The original bug: the outer hydration loop then pinned active at a
// remote that never connected, the renderer read from an empty store, and
// App.tsx fell through to the onboarding screen even though the local
// backend had the user's repos.
//
// The first fix removed the entry on failure. That avoided onboarding but
// closed the transport (so it never retried) and hid the chip, leaving a
// saved remote the user could neither see nor delete. Now a failed remote
// stays registered as disconnected, active falls back to Local, and the
// saved active backend is only adopted once it actually connects.

import { describe, it, expect } from 'vitest'
import { WebSocketServer, WebSocket as WSClient } from 'ws'
import {
  BackendsRegistry,
  LOCAL_BACKEND_ID,
  hydrateRemoteBackend,
  hydrateSavedRemotes
} from './store'
import type { BackendConnection } from './types'
import type { LocalTransportHandle } from '../shared/transport/transport'
import { WebSocketClientTransport } from '../shared/transport/transport-websocket'

function fakeLocalTransport(): LocalTransportHandle {
  return {
    getStateSnapshot: async () => ({ state: {} as never, seq: 0 }),
    onStateEvent: () => () => undefined,
    request: async () => undefined,
    send: () => undefined,
    onSignal: () => () => undefined,
    getClientId: async () => 'local-client',
    onReconnect: () => () => undefined
  }
}

function makeRegistry(): { registry: BackendsRegistry; localConn: BackendConnection } {
  const registry = new BackendsRegistry()
  const localConn: BackendConnection = {
    id: LOCAL_BACKEND_ID,
    label: 'Local',
    url: '',
    kind: 'local',
    addedAt: 0
  }
  registry.add(localConn, fakeLocalTransport())
  return { registry, localConn }
}

function rejectingServer(): Promise<{ port: number; close: () => Promise<void> }> {
  // Auth-fails everything so the upgrade is denied → client's WS fires
  // close with `opened=false` → connect() rejects with "websocket failed
  // to open". Same shape as a real server-side token mismatch.
  return new Promise((resolve, reject) => {
    const server = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      verifyClient: (_info, cb) => cb(false, 401, 'unauthorized')
    })
    server.on('listening', () => {
      const addr = server.address()
      if (typeof addr === 'object' && addr) {
        resolve({
          port: addr.port,
          close: () => new Promise<void>((r) => server.close(() => r()))
        })
      } else {
        reject(new Error('failed to bind stub ws server'))
      }
    })
    server.on('error', reject)
  })
}

describe('BackendsRegistry.remove falls back to local', () => {
  it('removes the entry and restores activeId when the removed id was active', () => {
    const { registry } = makeRegistry()
    const remote: BackendConnection = {
      id: 'remote-1',
      label: 'R1',
      url: 'ws://example.invalid/',
      kind: 'remote',
      addedAt: Date.now()
    }
    registry.add(remote, fakeLocalTransport())
    registry.setActive('remote-1')
    expect(registry.getActiveId()).toBe('remote-1')

    registry.remove('remote-1')

    expect(registry.has('remote-1')).toBe(false)
    expect(registry.getActiveId()).toBe(LOCAL_BACKEND_ID)
  })

  it('leaves activeId alone when removing a non-active entry', () => {
    const { registry } = makeRegistry()
    const remote: BackendConnection = {
      id: 'remote-1',
      label: 'R1',
      url: 'ws://example.invalid/',
      kind: 'remote',
      addedAt: Date.now()
    }
    registry.add(remote, fakeLocalTransport())
    expect(registry.getActiveId()).toBe(LOCAL_BACKEND_ID)

    registry.remove('remote-1')

    expect(registry.has('remote-1')).toBe(false)
    expect(registry.getActiveId()).toBe(LOCAL_BACKEND_ID)
  })
})

class WSWithNode extends WebSocketClientTransport {
  constructor(opts: ConstructorParameters<typeof WebSocketClientTransport>[0]) {
    super({
      ...opts,
      initialBackoffMs: 5_000,
      maxBackoffMs: 5_000,
      WebSocketCtor: WSClient as unknown as typeof WebSocket
    })
  }
}

const nonSshBackend = {
  connectionsGetToken: async () => 'tok',
  // The hydrator only calls sshReconnect when `conn.ssh` is set, which it
  // isn't here. Throwing makes a regression onto the wrong path loud.
  sshReconnect: async () => {
    throw new Error('should not be called for non-SSH backend')
  }
}

function remoteAt(port: number, id = 'remote-1'): BackendConnection {
  return { id, label: id, url: `ws://127.0.0.1:${port}/`, kind: 'remote', addedAt: Date.now() }
}

describe('hydrateRemoteBackend on failed connect', () => {
  it('keeps the entry registered as disconnected and resolves false', async () => {
    const { port, close } = await rejectingServer()
    const { registry } = makeRegistry()
    try {
      const connected = await hydrateRemoteBackend(remoteAt(port), {
        registry,
        backend: nonSshBackend,
        WSCtor: WSWithNode
      })

      expect(connected).toBe(false)
      expect(registry.has('remote-1')).toBe(true)
      expect(registry.getStatus('remote-1').state).toBe('disconnected')
    } finally {
      // Closes the transport so its retry timer doesn't outlive the test.
      registry.remove('remote-1')
      await close()
    }
  })

  it('falls back to Local when the failed remote had been made active', async () => {
    const { port, close } = await rejectingServer()
    const { registry } = makeRegistry()
    try {
      const pending = hydrateRemoteBackend(remoteAt(port), {
        registry,
        backend: nonSshBackend,
        WSCtor: WSWithNode
      })
      // Let the token fetch settle so registry.add has run, then select it
      // the way a racing caller would.
      await Promise.resolve()
      await Promise.resolve()
      expect(registry.has('remote-1')).toBe(true)
      registry.setActive('remote-1')

      await pending

      expect(registry.getActiveId()).toBe(LOCAL_BACKEND_ID)
      expect(registry.has('remote-1')).toBe(true)
    } finally {
      registry.remove('remote-1')
      await close()
    }
  })
})

describe('hydrateSavedRemotes', () => {
  function deferred(): { promise: Promise<boolean>; resolve: (v: boolean) => void } {
    let resolve!: (v: boolean) => void
    const promise = new Promise<boolean>((r) => (resolve = r))
    return { promise, resolve }
  }

  function setup(savedActive: string): {
    registry: BackendsRegistry
    finish: (id: string, connected: boolean) => Promise<void>
    run: () => Promise<void>
  } {
    const { registry } = makeRegistry()
    const pending = new Map<string, ReturnType<typeof deferred>>()
    const connections: BackendConnection[] = ['remote-1', 'remote-2'].map((id) => ({
      id,
      label: id,
      url: 'ws://example.invalid/',
      kind: 'remote',
      addedAt: 0
    }))
    const run = (): Promise<void> =>
      hydrateSavedRemotes({
        registry,
        backend: {
          ...nonSshBackend,
          connectionsList: async () => connections,
          connectionsGetActive: async () => savedActive
        },
        hydrate: async (conn, { registry: reg }) => {
          // Mirror the real hydrator: register immediately, connect later.
          reg.add(conn, fakeLocalTransport())
          const d = deferred()
          pending.set(conn.id, d)
          return d.promise
        }
      })
    const finish = async (id: string, connected: boolean): Promise<void> => {
      pending.get(id)!.resolve(connected)
      await new Promise((r) => setTimeout(r, 0))
    }
    return { registry, finish, run }
  }

  it('does not select the saved backend before it connects', async () => {
    const { registry, run } = setup('remote-1')
    await run()
    expect(registry.has('remote-1')).toBe(true)
    expect(registry.getActiveId()).toBe(LOCAL_BACKEND_ID)
  })

  it('selects the saved backend once it connects', async () => {
    const { registry, run, finish } = setup('remote-1')
    await run()
    await finish('remote-1', true)
    expect(registry.getActiveId()).toBe('remote-1')
  })

  it('stays on Local when the saved backend fails to connect', async () => {
    const { registry, run, finish } = setup('remote-1')
    await run()
    await finish('remote-1', false)
    expect(registry.getActiveId()).toBe(LOCAL_BACKEND_ID)
    expect(registry.has('remote-1')).toBe(true)
  })

  it('does not pull the user away from a backend they picked meanwhile', async () => {
    const { registry, run, finish } = setup('remote-1')
    await run()
    registry.setActive('remote-2')
    await finish('remote-1', true)
    expect(registry.getActiveId()).toBe('remote-2')
  })

  it('ignores connects from backends that are not the saved active one', async () => {
    const { registry, run, finish } = setup('remote-1')
    await run()
    await finish('remote-2', true)
    expect(registry.getActiveId()).toBe(LOCAL_BACKEND_ID)
  })
})
