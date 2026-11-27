import { describe, expect, it } from 'vitest'
import { centerEmptyMode } from './CenterEmptyState'

describe('centerEmptyMode', () => {
  it('agrees with the tour popout while the tour is on its home row', () => {
    expect(centerEmptyMode({ onboardingVisible: false, tourHomePath: '/repo' })).toBe('tour-home')
  })

  it('falls back to the generic prompt once the tour has moved on', () => {
    expect(centerEmptyMode({ onboardingVisible: false, tourHomePath: null })).toBe('no-selection')
  })

  it('does not show the tour copy behind the welcome wizard', () => {
    expect(centerEmptyMode({ onboardingVisible: true, tourHomePath: '/repo' })).toBe('no-selection')
  })
})
