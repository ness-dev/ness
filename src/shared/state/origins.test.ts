import { describe, expect, it } from 'vitest'
import { initialOrigins, originsReducer } from './origins'

const origin = { creatorPath: '/wt/a', creatorTabId: 'tab-a', createdAt: 1 }

describe('originsReducer', () => {
  it('origins/recorded stores the origin for a path', () => {
    const next = originsReducer(initialOrigins, {
      type: 'origins/recorded',
      payload: { path: '/wt/b', origin }
    })
    expect(next.byPath['/wt/b']).toEqual(origin)
  })

  it('origins/cleared removes a path and no-ops on an unknown one', () => {
    const state = { byPath: { '/wt/b': origin } }
    expect(originsReducer(state, { type: 'origins/cleared', payload: '/wt/b' }).byPath).toEqual({})
    expect(originsReducer(state, { type: 'origins/cleared', payload: '/nope' })).toBe(state)
  })
})
