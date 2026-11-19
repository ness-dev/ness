import { describe, expect, it } from 'vitest'
import { initialLoch, lochReducer } from './loch'

describe('lochReducer', () => {
  it('availabilityChanged sets the flag and keeps identity when unchanged', () => {
    expect(initialLoch.available).toBe(false)
    const on = lochReducer(initialLoch, { type: 'loch/availabilityChanged', payload: true })
    expect(on.available).toBe(true)
    expect(lochReducer(on, { type: 'loch/availabilityChanged', payload: true })).toBe(on)
  })
})
