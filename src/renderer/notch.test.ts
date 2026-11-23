import { describe, expect, it } from 'vitest'
import { computeNotchPush } from './notch'

describe('computeNotchPush', () => {
  const band = [860, 1060] as const

  it('pushes the first item overlapping the band to its right edge', () => {
    const items = [
      { left: 500, width: 150 },
      { left: 650, width: 150 },
      { left: 800, width: 150 },
      { left: 950, width: 150 }
    ]
    expect(computeNotchPush(items, ...band)).toEqual({ index: 2, px: 260 })
  })

  it('returns null when everything ends before the band', () => {
    expect(computeNotchPush([{ left: 0, width: 860 }], ...band)).toBeNull()
  })

  it('returns null when the first item past the band already clears it', () => {
    expect(computeNotchPush([{ left: 100, width: 100 }, { left: 1060, width: 50 }], ...band)).toBeNull()
  })

  it('skips zero-width items', () => {
    expect(computeNotchPush([{ left: 900, width: 0 }, { left: 900, width: 40 }], ...band)).toEqual({ index: 1, px: 160 })
  })
})
