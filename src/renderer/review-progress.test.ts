import { describe, it, expect } from 'vitest'
import { reviewedCount } from './review-progress'

const files = (...paths: string[]) => paths.map((path) => ({ path }))

describe('reviewedCount', () => {
  it('counts ticked files that are in the list', () => {
    expect(reviewedCount(files('a', 'b', 'c'), new Set(['a', 'c']))).toBe(2)
  })

  it('ignores ticks on files that dropped out of the diff', () => {
    // Ticked a, b, c; a commit removed a and added d. d is unreviewed.
    expect(reviewedCount(files('b', 'c', 'd'), new Set(['a', 'b', 'c']))).toBe(2)
  })

  it('is zero for an empty list', () => {
    expect(reviewedCount([], new Set(['a']))).toBe(0)
  })
})
