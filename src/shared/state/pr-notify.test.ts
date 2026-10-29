import { describe, it, expect } from 'vitest'
import {
  initialPrNotify,
  prNotifyReducer,
  isPrNotifyEnabled,
  prNotifyFromConfig,
  prNotifyGlobalDefault
} from './pr-notify'

describe('prNotifyReducer', () => {
  it('prNotify/set adds an override for one kind', () => {
    const next = prNotifyReducer(initialPrNotify, {
      type: 'prNotify/set',
      payload: { path: '/a', kind: 'ci', enabled: true }
    })
    expect(next.byPath['/a']).toEqual({ ci: true })
  })

  it('prNotify/set can store an explicit false', () => {
    const next = prNotifyReducer(initialPrNotify, {
      type: 'prNotify/set',
      payload: { path: '/a', kind: 'comments', enabled: false }
    })
    expect(next.byPath['/a']).toEqual({ comments: false })
  })

  it('prNotify/set keeps other kinds on the same path', () => {
    const s1 = prNotifyReducer(initialPrNotify, {
      type: 'prNotify/set',
      payload: { path: '/a', kind: 'ci', enabled: true }
    })
    const s2 = prNotifyReducer(s1, {
      type: 'prNotify/set',
      payload: { path: '/a', kind: 'conflicts', enabled: false }
    })
    expect(s2.byPath['/a']).toEqual({ ci: true, conflicts: false })
  })

  it('prNotify/set is a no-op when the value is unchanged (same reference)', () => {
    const s1 = prNotifyReducer(initialPrNotify, {
      type: 'prNotify/set',
      payload: { path: '/a', kind: 'ci', enabled: true }
    })
    const s2 = prNotifyReducer(s1, {
      type: 'prNotify/set',
      payload: { path: '/a', kind: 'ci', enabled: true }
    })
    expect(s2).toBe(s1)
  })

  it('prNotify/clear removes one kind and keeps the rest', () => {
    let state = prNotifyReducer(initialPrNotify, {
      type: 'prNotify/set',
      payload: { path: '/a', kind: 'ci', enabled: true }
    })
    state = prNotifyReducer(state, {
      type: 'prNotify/set',
      payload: { path: '/a', kind: 'comments', enabled: true }
    })
    state = prNotifyReducer(state, {
      type: 'prNotify/clear',
      payload: { path: '/a', kind: 'ci' }
    })
    expect(state.byPath['/a']).toEqual({ comments: true })
  })

  it('prNotify/clear drops the path once its last kind is gone', () => {
    const s1 = prNotifyReducer(initialPrNotify, {
      type: 'prNotify/set',
      payload: { path: '/a', kind: 'ci', enabled: true }
    })
    const s2 = prNotifyReducer(s1, {
      type: 'prNotify/clear',
      payload: { path: '/a', kind: 'ci' }
    })
    expect('/a' in s2.byPath).toBe(false)
  })

  it('prNotify/clear is a no-op for an unknown path or kind (same reference)', () => {
    const s1 = prNotifyReducer(initialPrNotify, {
      type: 'prNotify/set',
      payload: { path: '/a', kind: 'ci', enabled: true }
    })
    expect(
      prNotifyReducer(s1, { type: 'prNotify/clear', payload: { path: '/b', kind: 'ci' } })
    ).toBe(s1)
    expect(
      prNotifyReducer(s1, { type: 'prNotify/clear', payload: { path: '/a', kind: 'comments' } })
    ).toBe(s1)
  })

  it('prNotify/pathRemoved drops every kind for that path only', () => {
    let state = prNotifyReducer(initialPrNotify, {
      type: 'prNotify/set',
      payload: { path: '/a', kind: 'ci', enabled: true }
    })
    state = prNotifyReducer(state, {
      type: 'prNotify/set',
      payload: { path: '/b', kind: 'conflicts', enabled: true }
    })
    state = prNotifyReducer(state, { type: 'prNotify/pathRemoved', payload: '/a' })
    expect(state.byPath).toEqual({ '/b': { conflicts: true } })
  })

  it('prNotify/pathRemoved is a no-op for an unknown path (same reference)', () => {
    expect(
      prNotifyReducer(initialPrNotify, { type: 'prNotify/pathRemoved', payload: '/x' })
    ).toBe(initialPrNotify)
  })

  it('does not mutate the initial state', () => {
    const next = prNotifyReducer(initialPrNotify, {
      type: 'prNotify/set',
      payload: { path: '/a', kind: 'ci', enabled: true }
    })
    expect(next).not.toBe(initialPrNotify)
    expect(initialPrNotify.byPath).toEqual({})
  })
})

describe('isPrNotifyEnabled', () => {
  it('falls back to the global default when there is no override', () => {
    expect(isPrNotifyEnabled(initialPrNotify, '/a', 'ci', true)).toBe(true)
    expect(isPrNotifyEnabled(initialPrNotify, '/a', 'ci', false)).toBe(false)
  })

  it('an override for one kind does not leak into another', () => {
    const state = { byPath: { '/a': { ci: true } } }
    expect(isPrNotifyEnabled(state, '/a', 'ci', false)).toBe(true)
    expect(isPrNotifyEnabled(state, '/a', 'comments', false)).toBe(false)
  })

  it('an explicit false wins over a true default', () => {
    const state = { byPath: { '/a': { conflicts: false } } }
    expect(isPrNotifyEnabled(state, '/a', 'conflicts', true)).toBe(false)
  })
})

describe('prNotifyGlobalDefault', () => {
  it('maps each kind to its setting', () => {
    const settings = {
      notifyChatOnCiFailure: true,
      notifyChatOnPrComments: false,
      notifyChatOnMergeConflict: true
    }
    expect(prNotifyGlobalDefault(settings, 'ci')).toBe(true)
    expect(prNotifyGlobalDefault(settings, 'comments')).toBe(false)
    expect(prNotifyGlobalDefault(settings, 'conflicts')).toBe(true)
  })
})

describe('prNotifyFromConfig', () => {
  it('migrates legacy ciNotify booleans to the ci kind', () => {
    expect(prNotifyFromConfig(undefined, { '/a': true, '/b': false })).toEqual({
      byPath: { '/a': { ci: true }, '/b': { ci: false } }
    })
  })

  it('merges the current shape over legacy entries and drops junk', () => {
    const state = prNotifyFromConfig(
      { '/a': { comments: true, bogus: 1 } as never, '/c': {} },
      { '/a': false }
    )
    expect(state.byPath).toEqual({ '/a': { ci: false, comments: true } })
  })

  it('returns the initial state when nothing is configured', () => {
    expect(prNotifyFromConfig(undefined, undefined)).toBe(initialPrNotify)
  })
})
