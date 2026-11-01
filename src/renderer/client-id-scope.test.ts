// Regression: with a remote worktree open while Local is the active chip,
// its terminal compared the session's controllerClientId against the
// ACTIVE backend's client id. They can never match, so the terminal sat
// in the spectator overlay and Take Control appeared to do nothing — the
// server granted control to an id the UI wasn't checking. Identity must
// resolve per backend, like method routing already does.

import { describe, it, expect, vi } from 'vitest'
import {
  BackendsRegistry,
  getBackendsRegistry,
  getClientIdFor,
  subscribeTransportReconnectFor
} from './store'
import type { BackendConnection } from './types'
import type { LocalTransportHandle } from '../shared/transport/transport'

function fakeTransport(): LocalTransportHandle & { fireReconnect: (id: string) => void } {
  let onReconnect: ((clientId: string) => void) | null = null
  return {
    getStateSnapshot: async () => ({ state: {} as never, seq: 0 }),
    onStateEvent: () => () => undefined,
    request: async () => undefined,
    send: () => undefined,
    onSignal: () => () => undefined,
    getClientId: async () => 'unused',
    onReconnect: (cb) => {
      onReconnect = cb
      return () => {
        onReconnect = null
      }
    },
    fireReconnect: (id) => onReconnect?.(id)
  }
}

function conn(id: string): BackendConnection {
  return { id, label: id, url: '', kind: 'remote', addedAt: 0 }
}

describe('per-backend client identity', () => {
  it('resolves the client id of the named backend, not the active one', () => {
    const registry: BackendsRegistry = getBackendsRegistry()
    const beta = `beta-${Math.random().toString(36).slice(2)}`
    const store = registry.add(conn(beta), fakeTransport())
    store.setClientId('me-on-beta')
    expect(getClientIdFor(beta)).toBe('me-on-beta')
    registry.remove(beta)
  })

  it('is null for a backend that is not registered', () => {
    expect(getClientIdFor('nope-' + Math.random().toString(36).slice(2))).toBeNull()
  })

  it('delivers reconnects for the named backend even when it is not active', () => {
    const registry = getBackendsRegistry()
    const beta = `beta-${Math.random().toString(36).slice(2)}`
    const transport = fakeTransport()
    registry.add(conn(beta), transport)
    // Active stays wherever it was (local); beta is NOT active.
    expect(registry.getActiveId()).not.toBe(beta)

    const scoped = vi.fn()
    const unsub = subscribeTransportReconnectFor(beta, scoped)
    transport.fireReconnect('fresh-id')
    expect(scoped).toHaveBeenCalledWith('fresh-id')
    unsub()
    registry.remove(beta)
  })
})
