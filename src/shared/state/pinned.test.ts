import { describe, it, expect } from 'vitest'
import { initialPinned, pinnedReducer } from './pinned'

describe('pinnedReducer', () => {
  it('pinned/set marks a path as pinned', () => {
    const next = pinnedReducer(initialPinned, { type: 'pinned/set', payload: '/a' })
    expect(next.byPath).toEqual({ '/a': true })
  })

  it('pinned/set is idempotent and keeps reference identity', () => {
    const s1 = pinnedReducer(initialPinned, { type: 'pinned/set', payload: '/a' })
    const s2 = pinnedReducer(s1, { type: 'pinned/set', payload: '/a' })
    expect(s2).toBe(s1)
  })

  it('pinned/set accumulates multiple paths', () => {
    const s1 = pinnedReducer(initialPinned, { type: 'pinned/set', payload: '/a' })
    const s2 = pinnedReducer(s1, { type: 'pinned/set', payload: '/b' })
    expect(Object.keys(s2.byPath).sort()).toEqual(['/a', '/b'])
  })

  it('pinned/clear removes the path', () => {
    const s1 = pinnedReducer(initialPinned, { type: 'pinned/set', payload: '/a' })
    const s2 = pinnedReducer(s1, { type: 'pinned/clear', payload: '/a' })
    expect(s2.byPath).toEqual({})
  })

  it('pinned/clear leaves other paths pinned', () => {
    const s1 = pinnedReducer(initialPinned, { type: 'pinned/set', payload: '/a' })
    const s2 = pinnedReducer(s1, { type: 'pinned/set', payload: '/b' })
    const s3 = pinnedReducer(s2, { type: 'pinned/clear', payload: '/a' })
    expect(s3.byPath).toEqual({ '/b': true })
  })

  it('pinned/clear on an unpinned path keeps reference identity', () => {
    const s1 = pinnedReducer(initialPinned, { type: 'pinned/set', payload: '/a' })
    const s2 = pinnedReducer(s1, { type: 'pinned/clear', payload: '/nope' })
    expect(s2).toBe(s1)
  })

  it('initialPinned starts empty', () => {
    expect(initialPinned.byPath).toEqual({})
  })
})
