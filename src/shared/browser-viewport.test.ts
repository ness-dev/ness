import { describe, it, expect } from 'vitest'
import {
  DEFAULT_MOBILE_USER_AGENT,
  DEVICE_PRESETS,
  VIEWPORT_LIMITS,
  formatViewport,
  normalizeViewport,
  viewportsEqual
} from './browser-viewport'

describe('normalizeViewport', () => {
  it('accepts width + height and fills in defaults', () => {
    const r = normalizeViewport({ width: 390, height: 844 })
    expect(r.viewport).toEqual({
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
      // A phone-sized viewport without a phone UA gets UA-sniffing sites'
      // desktop HTML, which looks like the emulation didn't work.
      userAgent: DEFAULT_MOBILE_USER_AGENT
    })
  })

  it('leaves the user agent alone for desktop-sized viewports', () => {
    expect(normalizeViewport({ width: 1280, height: 800 }).viewport?.userAgent).toBeUndefined()
  })

  it('an explicit empty user agent opts out of the mobile UA', () => {
    const r = normalizeViewport({ width: 390, height: 844, userAgent: '' })
    expect(r.viewport?.mobile).toBe(true)
    expect(r.viewport?.userAgent).toBeUndefined()
  })

  it('an explicit user agent wins over the mobile default', () => {
    expect(
      normalizeViewport({ width: 390, height: 844, userAgent: 'custom/1.0' }).viewport?.userAgent
    ).toBe('custom/1.0')
  })

  it('rounds fractional sizes', () => {
    expect(normalizeViewport({ width: 390.4, height: 843.6 }).viewport).toMatchObject({
      width: 390,
      height: 844
    })
  })

  it('defaults mobile off for desktop-width viewports', () => {
    expect(normalizeViewport({ width: 1280, height: 800 }).viewport?.mobile).toBe(false)
  })

  it('honours an explicit mobile flag either way', () => {
    expect(normalizeViewport({ width: 1280, height: 800, mobile: true }).viewport?.mobile).toBe(
      true
    )
    expect(normalizeViewport({ width: 390, height: 844, mobile: false }).viewport?.mobile).toBe(
      false
    )
  })

  it('rejects non-numeric or missing sizes', () => {
    expect(normalizeViewport({ height: 844 }).error).toMatch(/width must be a number/)
    expect(normalizeViewport({ width: 390, height: 'tall' }).error).toMatch(
      /height must be a number/
    )
    expect(normalizeViewport(null).error).toMatch(/must be an object/)
  })

  it('rejects out-of-range sizes rather than clamping', () => {
    expect(normalizeViewport({ width: 10, height: 844 }).error).toMatch(/between/)
    expect(normalizeViewport({ width: 20000, height: 844 }).error).toMatch(/20000/)
    expect(normalizeViewport({ width: 390, height: VIEWPORT_LIMITS.maxSize + 1 }).error).toMatch(
      /height/
    )
  })

  it('validates deviceScaleFactor', () => {
    expect(normalizeViewport({ width: 390, height: 844, deviceScaleFactor: 2 }).viewport
      ?.deviceScaleFactor).toBe(2)
    expect(normalizeViewport({ width: 390, height: 844, deviceScaleFactor: 9 }).error).toMatch(
      /deviceScaleFactor/
    )
  })

  it('trims the user agent and drops an empty one', () => {
    expect(
      normalizeViewport({ width: 390, height: 844, userAgent: '  Mozilla/5.0 (iPhone)  ' }).viewport
        ?.userAgent
    ).toBe('Mozilla/5.0 (iPhone)')
    expect(normalizeViewport({ width: 390, height: 844, userAgent: '   ' }).viewport?.userAgent)
      .toBeUndefined()
    expect(normalizeViewport({ width: 1280, height: 800, userAgent: null }).viewport?.userAgent)
      .toBeUndefined()
    expect(normalizeViewport({ width: 390, height: 844, userAgent: 42 }).error).toMatch(
      /userAgent/
    )
    expect(
      normalizeViewport({
        width: 390,
        height: 844,
        userAgent: 'x'.repeat(VIEWPORT_LIMITS.maxUserAgentLength + 1)
      }).error
    ).toMatch(/at most/)
  })
})

describe('formatViewport', () => {
  it('omits the scale suffix at 1x', () => {
    expect(formatViewport({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true })).toBe(
      '390×844'
    )
  })
  it('includes the scale suffix otherwise', () => {
    expect(formatViewport({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true })).toBe(
      '390×844 @2x'
    )
  })
})

describe('viewportsEqual', () => {
  const base = { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }
  it('treats null/undefined as the same "no override"', () => {
    expect(viewportsEqual(null, undefined)).toBe(true)
    expect(viewportsEqual(null, base)).toBe(false)
  })
  it('compares every field', () => {
    expect(viewportsEqual(base, { ...base })).toBe(true)
    expect(viewportsEqual(base, { ...base, height: 845 })).toBe(false)
    expect(viewportsEqual(base, { ...base, mobile: false })).toBe(false)
    expect(viewportsEqual(base, { ...base, userAgent: 'x' })).toBe(false)
  })
  it('treats an absent user agent and an empty one as equal', () => {
    expect(viewportsEqual(base, { ...base, userAgent: undefined })).toBe(true)
  })
})

describe('DEVICE_PRESETS', () => {
  it('every preset survives normalization unchanged', () => {
    for (const preset of DEVICE_PRESETS) {
      const r = normalizeViewport(preset.viewport)
      expect(r.error).toBeUndefined()
      expect(viewportsEqual(r.viewport, preset.viewport)).toBe(true)
    }
  })
  it('has unique ids', () => {
    expect(new Set(DEVICE_PRESETS.map((p) => p.id)).size).toBe(DEVICE_PRESETS.length)
  })
})
