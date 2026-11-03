import { describe, it, expect, vi } from 'vitest'
import { isWithinRoots, ownedPathsOnly } from './own-paths'

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

describe('ownedPathsOnly', () => {
  const isOwn = (p: string) => isWithinRoots(p, ['/Users/me/repo'])

  it('runs the handler for an owned path, passing every argument through', () => {
    const handler = vi.fn((_ctx: string, path: string, a: number, b: string) => `${path}:${a}:${b}`)
    const guarded = ownedPathsOnly(isOwn, handler)
    expect(guarded('ctx', '/Users/me/repo/src', 1, 'x')).toBe('/Users/me/repo/src:1:x')
    expect(handler).toHaveBeenCalledWith('ctx', '/Users/me/repo/src', 1, 'x')
  })

  it('rejects a foreign path without running the handler', () => {
    const handler = vi.fn()
    expect(() => ownedPathsOnly(isOwn, handler)('ctx', '/home/me/repo')).toThrow(/Not a worktree on this host/)
    expect(handler).not.toHaveBeenCalled()
  })

  it('drops a foreign path silently in signal mode', () => {
    const handler = vi.fn()
    expect(ownedPathsOnly(isOwn, handler, 'drop')('ctx', '/home/me/repo')).toBeUndefined()
    expect(handler).not.toHaveBeenCalled()
  })
})
