import { describe, expect, it } from 'vitest'

describe('notification CI probe', () => {
  it('fails on purpose to exercise CI-failure notifications (reverted in the next commit)', () => {
    expect('ci-failure-probe').toBe('passing')
  })
})
