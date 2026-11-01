// Regression: with a remote worktree open while Local is the active chip,
// its terminal compared the session's controllerClientId against the
// ACTIVE backend's client id. They can never match, so the terminal sat
// in the spectator overlay and Take Control appeared to do nothing — the
// server granted control to an id the UI wasn't checking. Identity must
// resolve per backend, like method routing already does.
//
// These tests use the module registry singleton, so every registration
// is undone in `finally` — a failing assertion must not leak a backend
// into the next test.

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

function freshId(): string {
  return `beta-${Math.random().toString(36).slice(2)}`
}

describe('per-backend client identity', () => {
  it('resolves the client id of the named backend, not the active one', () => {
    const registry: BackendsRegistry = getBackendsRegistry()
    const beta = freshId()
    try {
      const store = registry.add(conn(beta), fakeTransport())
      store.setClientId('me-on-beta')
      expect(registry.getActiveId()).not.toBe(beta)
      expect(getClientIdFor(beta)).toBe('me-on-beta')
    } finally {
      registry.remove(beta)
    }
  })

  it('is null for a backend that is not registered', () => {
    expect(getClientIdFor(freshId())).toBeNull()
  })

  it('notifies store subscribers when the client id changes, and only then', () => {
    // What makes useClientId a real subscription: the scoped store fires
    // its listeners on setClientId, so a reconnect re-renders readers on
    // its own rather than relying on a later session event to do it.
    const registry = getBackendsRegistry()
    const beta = freshId()
    try {
      const store = registry.add(conn(beta), fakeTransport())
      const listener = vi.fn()
      store.subscribe(listener)
      store.setClientId('first')
      expect(listener).toHaveBeenCalledTimes(1)
      store.setClientId('first')
      expect(listener).toHaveBeenCalledTimes(1)
      store.setClientId('second')
      expect(listener).toHaveBeenCalledTimes(2)
      expect(getClientIdFor(beta)).toBe('second')
    } finally {
      registry.remove(beta)
    }
  })

  it('delivers reconnects for the named backend even when it is not active', () => {
    const registry = getBackendsRegistry()
    const beta = freshId()
    const transport = fakeTransport()
    let unsub: (() => void) | null = null
    try {
      registry.add(conn(beta), transport)
      expect(registry.getActiveId()).not.toBe(beta)
      const scoped = vi.fn()
      unsub = subscribeTransportReconnectFor(beta, scoped)
      transport.fireReconnect('fresh-id')
      expect(scoped).toHaveBeenCalledWith('fresh-id')
      // The registry's reconnect wiring also pushes the new id into the
      // store before fanning out, so readers see it by the time they run.
      expect(getClientIdFor(beta)).toBe('fresh-id')
    } finally {
      unsub?.()
      registry.remove(beta)
    }
  })
})
