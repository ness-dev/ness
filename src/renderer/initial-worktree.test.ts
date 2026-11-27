import { describe, expect, it } from 'vitest'
import { pickInitialWorktree } from './initial-worktree'

describe('pickInitialWorktree', () => {
  const worktreePaths = ['/a', '/b']

  it("opens the tour's project over the first row", () => {
    expect(
      pickInitialWorktree({ tourStep: 'home', tourHomePath: '/b', worktreePaths, tourBackendHasRows: true })
    ).toBe('/b')
  })

  it('falls back to the first row with no tour', () => {
    expect(
      pickInitialWorktree({ tourStep: 'done', tourHomePath: null, worktreePaths, tourBackendHasRows: true })
    ).toBe('/a')
  })

  it("waits while the tour's backend has rows but hasn't started the tour", () => {
    expect(
      pickInitialWorktree({ tourStep: 'eligible', tourHomePath: null, worktreePaths, tourBackendHasRows: true })
    ).toBeNull()
  })

  it("doesn't wait on an eligible tour when every row is from another backend", () => {
    expect(
      pickInitialWorktree({ tourStep: 'eligible', tourHomePath: null, worktreePaths, tourBackendHasRows: false })
    ).toBe('/a')
  })

  it('picks nothing with no rows', () => {
    expect(
      pickInitialWorktree({ tourStep: 'done', tourHomePath: null, worktreePaths: [], tourBackendHasRows: false })
    ).toBeNull()
  })
})
