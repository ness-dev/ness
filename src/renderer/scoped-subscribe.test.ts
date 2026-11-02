// `createScopedSubscribe` is the half of positional backend routing that
// can go subtly wrong without failing loudly.
//
// Two properties matter, and neither is visible by eye at the call site:
//
//   1. Identity stability per backend id. `useSyncExternalStore`
//      detaches and reattaches its store listener whenever the
//      `subscribe` argument changes identity, so a fresh closure per
//      render would churn a listener on every commit — for every mounted
//      worktree, while agents stream.
//   2. Re-subscription when registry membership changes. A worktree's
//      subtree can mount before its backend finishes connecting, because
//      `hydrateRemoteBackend` is deliberately not awaited. Without the
//      swap, that subtree holds a no-op unsubscribe forever and silently
//      never renders its data.

import { describe, it, expect, vi } from 'vitest'
import { createScopedSubscribe, type ScopedSubscribeRegistry } from './store'

/** Minimal registry stub: stores can be added and removed, and list
 *  listeners fire on membership changes — the only two behaviors
 *  `createScopedSubscribe` depends on. */
function stubRegistry(): {
  reg: ScopedSubscribeRegistry
  addStore: (id: string) => { notify: () => void; subscribers: () => number }
  removeStore: (id: string) => void
} {
  const stores = new Map<
    string,
    { listeners: Set<() => void>; subscribe(cb: () => void): () => void }
  >()
  const listListeners = new Set<() => void>()

  const reg: ScopedSubscribeRegistry = {
    getStore: (id) => stores.get(id),
    subscribeList: (cb) => {
      listListeners.add(cb)
      return () => listListeners.delete(cb)
    }
  }

  return {
    reg,
    addStore: (id) => {
      const listeners = new Set<() => void>()
      const store = {
        listeners,
        subscribe(cb: () => void) {
          listeners.add(cb)
          return () => {
            listeners.delete(cb)
          }
        }
      }
      stores.set(id, store)
      for (const l of [...listListeners]) l()
      return {
        notify: () => {
          for (const l of [...listeners]) l()
        },
        subscribers: () => listeners.size
      }
    },
    removeStore: (id) => {
      stores.delete(id)
      for (const l of [...listListeners]) l()
    }
  }
}

describe('createScopedSubscribe', () => {
  it('returns the same function for the same backend id', () => {
    const { reg, addStore } = stubRegistry()
    addStore('local')
    const scopedSubscribe = createScopedSubscribe(reg)
    expect(scopedSubscribe('local')).toBe(scopedSubscribe('local'))
  })

  it('returns different functions for different backend ids', () => {
    const { reg, addStore } = stubRegistry()
    addStore('local')
    addStore('remote')
    const scopedSubscribe = createScopedSubscribe(reg)
    expect(scopedSubscribe('local')).not.toBe(scopedSubscribe('remote'))
  })

  it('routes notifications from the scoped store only', () => {
    const { reg, addStore } = stubRegistry()
    const local = addStore('local')
    const remote = addStore('remote')
    const scopedSubscribe = createScopedSubscribe(reg)

    const onLocal = vi.fn()
    scopedSubscribe('local')(onLocal)
    onLocal.mockClear()

    remote.notify()
    expect(onLocal).not.toHaveBeenCalled()

    local.notify()
    expect(onLocal).toHaveBeenCalledTimes(1)
  })

  it('attaches once a backend that was missing at subscribe time appears', () => {
    // The async-hydration case: the subtree mounted first.
    const { reg, addStore } = stubRegistry()
    const scopedSubscribe = createScopedSubscribe(reg)
    const cb = vi.fn()
    scopedSubscribe('remote')(cb)

    const remote = addStore('remote')
    // The membership change itself prompts a re-read, since the store the
    // consumer was reading just appeared.
    expect(cb).toHaveBeenCalled()
    expect(remote.subscribers()).toBe(1)

    cb.mockClear()
    remote.notify()
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('detaches cleanly when the backend goes away', () => {
    const { reg, addStore, removeStore } = stubRegistry()
    const remote = addStore('remote')
    const scopedSubscribe = createScopedSubscribe(reg)
    const cb = vi.fn()
    scopedSubscribe('remote')(cb)
    expect(remote.subscribers()).toBe(1)

    removeStore('remote')
    expect(remote.subscribers()).toBe(0)
    cb.mockClear()
    // A store that's been dropped from the registry must not keep driving
    // renders in a subtree that's being torn down.
    remote.notify()
    expect(cb).not.toHaveBeenCalled()
  })

  it('leaves no listeners behind after unsubscribe', () => {
    const { reg, addStore } = stubRegistry()
    const remote = addStore('remote')
    const scopedSubscribe = createScopedSubscribe(reg)
    const unsub = scopedSubscribe('remote')(vi.fn())
    expect(remote.subscribers()).toBe(1)
    unsub()
    expect(remote.subscribers()).toBe(0)
  })

  it('supports several independent subscribers on one backend', () => {
    // Every mounted worktree on a backend subscribes through the same
    // memoized function; they must not clobber each other's teardown.
    const { reg, addStore } = stubRegistry()
    const local = addStore('local')
    const scopedSubscribe = createScopedSubscribe(reg)
    const subscribe = scopedSubscribe('local')

    const a = vi.fn()
    const b = vi.fn()
    const unsubA = subscribe(a)
    subscribe(b)
    expect(local.subscribers()).toBe(2)

    unsubA()
    expect(local.subscribers()).toBe(1)
    local.notify()
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalled()
  })
})
