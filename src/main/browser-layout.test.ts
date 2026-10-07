import { describe, it, expect } from 'vitest'
import { canSurfaceCapture, emulatedViewRect } from './browser-layout'

const pane = { x: 100, y: 50, width: 900, height: 900 }
const phone = { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }

describe('emulatedViewRect', () => {
  it('fills the pane when nothing is emulated', () => {
    expect(emulatedViewRect(pane, null)).toEqual(pane)
  })

  it('letterboxes a viewport that fits, centred horizontally and top-aligned', () => {
    expect(emulatedViewRect(pane, phone)).toEqual({
      x: 100 + Math.round((900 - 390) / 2),
      y: 50,
      width: 390,
      height: 844
    })
  })

  it('falls back to the pane rect when the viewport is taller than the pane', () => {
    const short = { ...pane, height: 500 }
    expect(emulatedViewRect(short, phone)).toEqual(short)
  })

  it('falls back to the pane rect when the viewport is wider than the pane', () => {
    const narrow = { ...pane, width: 320 }
    expect(emulatedViewRect(narrow, phone)).toEqual(narrow)
  })

  it('uses the viewport exactly when pane and viewport match', () => {
    const exact = { x: 0, y: 0, width: 390, height: 844 }
    expect(emulatedViewRect(exact, phone)).toEqual(exact)
  })
})

describe('canSurfaceCapture', () => {
  it('allows surface capture with no emulation', () => {
    expect(canSurfaceCapture({ x: 0, y: 0, width: 700, height: 500 }, null)).toBe(true)
  })

  it('allows it when the widget was letterboxed to the emulated size', () => {
    expect(canSurfaceCapture({ x: 10, y: 0, width: 390, height: 844 }, phone)).toBe(true)
  })

  it('refuses when the widget is bigger or smaller than the emulation', () => {
    expect(canSurfaceCapture({ x: 0, y: 0, width: 700, height: 500 }, phone)).toBe(false)
    expect(canSurfaceCapture({ x: 0, y: 0, width: 390, height: 500 }, phone)).toBe(false)
  })
})
