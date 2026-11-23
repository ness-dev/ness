import { describe, it, expect } from 'vitest'
import { ComposerVisibility } from './composer-visibility'

describe('ComposerVisibility', () => {
  it('starts with nothing visible', () => {
    expect(new ComposerVisibility().isVisible('s')).toBe(false)
  })

  it('reports a flip only when the overall visibility changes', () => {
    const v = new ComposerVisibility()
    expect(v.set('a', 's', true)).toBe(true)
    expect(v.set('b', 's', true)).toBeNull()
    expect(v.set('a', 's', false)).toBeNull()
    expect(v.isVisible('s')).toBe(true)
    expect(v.set('b', 's', false)).toBe(false)
    expect(v.isVisible('s')).toBe(false)
  })

  it('repeated reports from one client are not flips', () => {
    const v = new ComposerVisibility()
    v.set('a', 's', true)
    expect(v.set('a', 's', true)).toBeNull()
    expect(v.set('x', 's', false)).toBeNull()
  })

  it('removeClient returns only the chats left with no viewer', () => {
    const v = new ComposerVisibility()
    v.set('a', 's1', true)
    v.set('a', 's2', true)
    v.set('b', 's2', true)
    expect(v.removeClient('a')).toEqual(['s1'])
    expect(v.isVisible('s1')).toBe(false)
    expect(v.isVisible('s2')).toBe(true)
    expect(v.removeClient('a')).toEqual([])
  })
})
