import { describe, expect, it } from 'vitest'
import { initialLoch, lochReducer } from './loch'

describe('lochReducer', () => {
  it('availabilityChanged sets the flag and keeps identity when unchanged', () => {
    expect(initialLoch.available).toBe(false)
    const on = lochReducer(initialLoch, { type: 'loch/availabilityChanged', payload: true })
    expect(on.available).toBe(true)
    expect(lochReducer(on, { type: 'loch/availabilityChanged', payload: true })).toBe(on)
  })

  it('installableChanged sets the flag and keeps identity when unchanged', () => {
    expect(initialLoch.installable).toBe(false)
    const on = lochReducer(initialLoch, { type: 'loch/installableChanged', payload: true })
    expect(on.installable).toBe(true)
    expect(lochReducer(on, { type: 'loch/installableChanged', payload: true })).toBe(on)
  })

  it('autoRecordingChanged adds and removes a repo, keeping identity on no-ops', () => {
    expect(initialLoch.autoRecording).toEqual([])
    const ev = (repoRoot: string, active: boolean) =>
      ({ type: 'loch/autoRecordingChanged', payload: { repoRoot, active } }) as const
    const on = lochReducer(initialLoch, ev('/r', true))
    expect(on.autoRecording).toEqual(['/r'])
    expect(lochReducer(on, ev('/r', true))).toBe(on)
    const off = lochReducer(on, ev('/r', false))
    expect(off.autoRecording).toEqual([])
    expect(lochReducer(off, ev('/r', false))).toBe(off)
  })
})
