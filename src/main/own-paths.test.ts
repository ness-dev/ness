import { describe, it, expect } from 'vitest'
import { isWithinRoots } from './own-paths'

describe('isWithinRoots', () => {
  const roots = ['/Users/me/repo', '/Users/me/repo-worktrees/feat']

  it('accepts a root itself and paths inside one', () => {
    expect(isWithinRoots('/Users/me/repo', roots)).toBe(true)
    expect(isWithinRoots('/Users/me/repo/src/a.ts', roots)).toBe(true)
    expect(isWithinRoots('/Users/me/repo-worktrees/feat', roots)).toBe(true)
  })

  it("rejects another host's path", () => {
    expect(isWithinRoots('/home/me/personal-assistant', roots)).toBe(false)
  })

  it('does not treat a shared name prefix as containment', () => {
    expect(isWithinRoots('/Users/me/repo-other', roots)).toBe(false)
  })

  it('handles roots with a trailing slash, and empty input', () => {
    expect(isWithinRoots('/a/b/c', ['/a/b/'])).toBe(true)
    expect(isWithinRoots('', roots)).toBe(false)
    expect(isWithinRoots('/a', [''])).toBe(false)
  })
})
