import { beforeEach, describe, expect, it } from 'vitest'
import {
  getCardOverrides,
  resetCardOverrides,
  setCardOverride
} from './subagent-card-overrides'

describe('subagent card overrides', () => {
  beforeEach(resetCardOverrides)

  it('outlives the column: a collapsed running card is still collapsed on the next read', () => {
    // The column unmounts when its tab is hidden and re-reads on mount.
    setCardOverride('s1', 'agent-a', false)
    expect(getCardOverrides('s1').get('agent-a')).toBe(false)
  })

  it('keeps sessions separate', () => {
    setCardOverride('s1', 'agent-a', false)
    expect(getCardOverrides('s2').has('agent-a')).toBe(false)
  })

  it('returns a new map per change so state setters see it as changed', () => {
    const first = setCardOverride('s1', 'agent-a', true)
    const second = setCardOverride('s1', 'agent-b', true)
    expect(second).not.toBe(first)
    expect([...second.keys()]).toEqual(['agent-a', 'agent-b'])
  })

  it('drops the least recently touched session past the cap', () => {
    for (let i = 0; i < 50; i++) setCardOverride(`s${i}`, 'a', true)
    setCardOverride('s0', 'a', false)
    setCardOverride('s50', 'a', true)
    expect(getCardOverrides('s1').size).toBe(0)
    expect(getCardOverrides('s0').get('a')).toBe(false)
  })
})
