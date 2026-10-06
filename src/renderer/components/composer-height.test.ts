import { describe, it, expect } from 'vitest'
import {
  clampComposerHeight,
  MIN_COMPOSER_HEIGHT,
  MIN_TRANSCRIPT_HEIGHT
} from './composer-height'

describe('clampComposerHeight', () => {
  it('grows the composer when dragging up (negative deltaY)', () => {
    expect(clampComposerHeight(100, -40, 500)).toBe(140)
  })

  it('shrinks the composer when dragging down (positive deltaY)', () => {
    expect(clampComposerHeight(100, 30, 500)).toBe(70)
  })

  it('returns the current height for a zero delta', () => {
    expect(clampComposerHeight(137, 0, 500)).toBe(137)
  })

  it('floors at MIN_COMPOSER_HEIGHT', () => {
    expect(clampComposerHeight(100, 500, 500)).toBe(MIN_COMPOSER_HEIGHT)
  })

  it('caps growth so the transcript keeps MIN_TRANSCRIPT_HEIGHT', () => {
    // transcript 200px can donate 200-120=80px before hitting its floor
    expect(clampComposerHeight(100, -500, 200)).toBe(180)
  })

  it('allows growth up to exactly the transcript floor', () => {
    expect(clampComposerHeight(100, -80, 200)).toBe(180)
    expect(clampComposerHeight(100, -81, 200)).toBe(180)
  })

  it('refuses to grow when the transcript is already at its floor', () => {
    expect(clampComposerHeight(100, -50, MIN_TRANSCRIPT_HEIGHT)).toBe(100)
  })

  it('refuses to grow when the transcript is already below its floor', () => {
    expect(clampComposerHeight(100, -50, 40)).toBe(100)
  })

  it('still allows shrinking when the transcript is below its floor', () => {
    expect(clampComposerHeight(100, 20, 40)).toBe(80)
  })

  it('lets the composer floor win when it conflicts with the transcript floor', () => {
    // A squeezed layout must never leave the composer unusably short.
    expect(clampComposerHeight(20, -500, 0)).toBe(MIN_COMPOSER_HEIGHT)
  })

  it('rounds fractional drag deltas to whole pixels', () => {
    expect(clampComposerHeight(100, -10.6, 500)).toBe(111)
  })
})
