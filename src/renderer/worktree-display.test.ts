import { describe, it, expect } from 'vitest'
import { displayLabel, homeRowLabel } from './worktree-display'
import type { Worktree } from '../shared/state/worktrees'

const wt = (path: string, branch: string, repoRoot = '/Users/tt/Projects/harness'): Worktree => ({
  path,
  branch,
  head: '',
  isBare: false,
  isMain: false,
  createdAt: 0,
  repoRoot
})

describe('displayLabel', () => {
  it('returns branch when alias is undefined and Cmd not held', () => {
    expect(displayLabel(wt('/a', 'feat/x'), undefined, false)).toBe('feat/x')
  })

  it('returns alias when one is provided and Cmd not held', () => {
    expect(displayLabel(wt('/a', 'feat/x'), 'my-alias', false)).toBe('my-alias')
  })

  it('Cmd held on a non-aliased row keeps showing the branch (no change)', () => {
    expect(displayLabel(wt('/some/path', 'feat/x'), undefined, true)).toBe('feat/x')
  })

  it('Cmd held on an aliased row shows path relative to worktrees root', () => {
    const w = wt('/Users/tt/Projects/harness-worktrees/tt/alias-worktrees', 'feat/x')
    expect(displayLabel(w, 'my-alias', true)).toBe('tt/alias-worktrees')
  })

  it('Cmd held on an aliased row at a custom (non-standard) path falls back to absolute path', () => {
    const w = wt('/completely/unrelated/dir', 'feat/x')
    expect(displayLabel(w, 'my-alias', true)).toBe('/completely/unrelated/dir')
  })

  it('handles trailing slash on repoRoot', () => {
    const w = wt('/Users/tt/Projects/harness-worktrees/tt/alias-worktrees', 'feat/x', '/Users/tt/Projects/harness/')
    expect(displayLabel(w, 'my-alias', true)).toBe('tt/alias-worktrees')
  })
})

describe('homeRowLabel', () => {
  it('shows the project name when there is no alias', () => {
    expect(homeRowLabel('ness', undefined, false)).toBe('ness')
    expect(homeRowLabel('ness', undefined, true)).toBe('ness')
  })

  it('shows the alias when Cmd is not held', () => {
    expect(homeRowLabel('ness', 'Home Base', false)).toBe('Home Base')
  })

  it('Cmd held on an aliased home row reveals the project name, not the branch', () => {
    expect(homeRowLabel('ness', 'Home Base', true)).toBe('ness')
  })
})
