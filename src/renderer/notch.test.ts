import { describe, expect, it } from 'vitest'
import { computeNotchPush, planNotchPush } from './notch'

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

describe('planNotchPush', () => {
  const band = [860, 1060] as const
  // Fifteen 100px tabs from viewport x=500 (content-relative lefts).
  const tabs = Array.from({ length: 15 }, (_, i) => ({ left: 500 + i * 100, width: 100, scrolls: true }))

  it('pushes the tab under the band at the current offset', () => {
    // At scroll 100, index 4 sits at 800-900.
    expect(planNotchPush(tabs, ...band, { scroll: 100, naturalMaxScroll: 500 })).toEqual({ index: 4, px: 260 })
  })

  it('widens the gap near the end so the offset stays reachable', () => {
    // At 790 index 11 sits at 810-910 and needs 250, which would cap the
    // range at 750. The gap grows to 290 so 790 stays the end of the range.
    const push = planNotchPush(tabs, ...band, { scroll: 790, naturalMaxScroll: 500 })
    expect(push).toEqual({ index: 11, px: 290 })
    expect(tabs[11].left - 790 + push!.px).toBeGreaterThanOrEqual(band[1])
  })

  it('does not widen pushes on non-strip items', () => {
    const items = [{ left: 900, width: 50, scrolls: false }]
    expect(planNotchPush(items, ...band, { scroll: 300, naturalMaxScroll: 0 })).toEqual({ index: 0, px: 160 })
  })
})
