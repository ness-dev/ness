import { describe, it, expect } from 'vitest'
import {
  initialWorktrees,
  mergeWorktreesPreservingFailures,
  worktreesReducer,
  worktreeListsEqual,
  type PendingDeletion,
  type PendingWorktree,
  type Worktree,
  type WorktreesEvent,
  type WorktreesState
} from './worktrees'

function apply(state: WorktreesState, event: WorktreesEvent): WorktreesState {
  return worktreesReducer(state, event)
}

function stubWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    path: '/tmp/wt/a',
    branch: 'feature/a',
    head: 'deadbeef',
    isBare: false,
    isMain: false,
    createdAt: 0,
    repoRoot: '/tmp/repo',
    ...overrides
  }
}

function stubPending(overrides: Partial<PendingWorktree> = {}): PendingWorktree {
  return {
    id: 'pending:abc',
    repoRoot: '/tmp/repo',
    branchName: 'feature/a',
    status: 'creating',
    ...overrides
  }
}

describe('worktreeListsEqual', () => {
  it('is true for the same reference and for structurally identical lists', () => {
    const a = [stubWorktree({ path: '/a' }), stubWorktree({ path: '/b' })]
    expect(worktreeListsEqual(a, a)).toBe(true)
    const b = [stubWorktree({ path: '/a' }), stubWorktree({ path: '/b' })]
    expect(worktreeListsEqual(a, b)).toBe(true)
  })

  it('is false when length differs', () => {
    const a = [stubWorktree({ path: '/a' })]
    const b = [stubWorktree({ path: '/a' }), stubWorktree({ path: '/b' })]
    expect(worktreeListsEqual(a, b)).toBe(false)
  })

  it('detects a branch label change (the rebasing-2/22 -> back-on-branch case)', () => {
    const a = [stubWorktree({ path: '/a', branch: 'rebasing 2/22' })]
    const b = [stubWorktree({ path: '/a', branch: 'feature/a' })]
    expect(worktreeListsEqual(a, b)).toBe(false)
  })

  it('detects head/path/repoRoot/flag changes', () => {
    const base = stubWorktree({ path: '/a' })
    expect(worktreeListsEqual([base], [stubWorktree({ path: '/a', head: 'cafe' })])).toBe(false)
    expect(worktreeListsEqual([base], [stubWorktree({ path: '/z' })])).toBe(false)
    expect(worktreeListsEqual([base], [stubWorktree({ path: '/a', isMain: true })])).toBe(false)
    expect(worktreeListsEqual([base], [stubWorktree({ path: '/a', repoRoot: '/other' })])).toBe(false)
    expect(worktreeListsEqual([base], [stubWorktree({ path: '/a', prunable: true })])).toBe(false)
    expect(
      worktreeListsEqual(
        [stubWorktree({ path: '/a', prunable: true, prunableReason: 'gone' })],
        [stubWorktree({ path: '/a', prunable: true, prunableReason: 'other' })]
      )
    ).toBe(false)
  })

  it('is order-sensitive', () => {
    const a = [stubWorktree({ path: '/a' }), stubWorktree({ path: '/b' })]
    const b = [stubWorktree({ path: '/b' }), stubWorktree({ path: '/a' })]
    expect(worktreeListsEqual(a, b)).toBe(false)
  })
})

describe('mergeWorktreesPreservingFailures', () => {
  it('replaces each repo\'s slice with its successful result', () => {
    const roots = ['/repo/a', '/repo/b']
    const perRoot = [
      [stubWorktree({ path: '/a/1', repoRoot: '/repo/a' })],
      [stubWorktree({ path: '/b/1', repoRoot: '/repo/b' })]
    ]
    const previous = [stubWorktree({ path: '/a/old', repoRoot: '/repo/a' })]
    const out = mergeWorktreesPreservingFailures(roots, perRoot, previous)
    expect(out.map((w) => w.path)).toEqual(['/a/1', '/b/1'])
  })

  it('preserves the prior slice for a repo whose lookup returned null', () => {
    const roots = ['/repo/a', '/repo/b']
    const perRoot = [
      null,
      [stubWorktree({ path: '/b/1', repoRoot: '/repo/b' })]
    ]
    const previous = [
      stubWorktree({ path: '/a/1', repoRoot: '/repo/a' }),
      stubWorktree({ path: '/a/2', repoRoot: '/repo/a' }),
      stubWorktree({ path: '/b/old', repoRoot: '/repo/b' })
    ]
    const out = mergeWorktreesPreservingFailures(roots, perRoot, previous)
    expect(out.map((w) => w.path)).toEqual(['/a/1', '/a/2', '/b/1'])
  })

  it('drops a failed repo entirely if it had no prior entries', () => {
    const out = mergeWorktreesPreservingFailures(['/repo/a'], [null], [])
    expect(out).toEqual([])
  })

  it('empty successful result deletes that repo (deletions still propagate)', () => {
    const previous = [stubWorktree({ path: '/a/1', repoRoot: '/repo/a' })]
    const out = mergeWorktreesPreservingFailures(['/repo/a'], [[]], previous)
    expect(out).toEqual([])
  })
})

describe('worktreesReducer', () => {
  it('listChanged replaces the flat list', () => {
    const start: WorktreesState = {
      ...initialWorktrees,
      list: [stubWorktree({ path: '/a' }), stubWorktree({ path: '/b' })]
    }
    const next = apply(start, {
      type: 'worktrees/listChanged',
      payload: [stubWorktree({ path: '/c' })]
    })
    expect(next.list.map((w) => w.path)).toEqual(['/c'])
  })

  it('reposChanged replaces the repoRoots array', () => {
    const next = apply(initialWorktrees, {
      type: 'worktrees/reposChanged',
      payload: ['/tmp/repo1', '/tmp/repo2']
    })
    expect(next.repoRoots).toEqual(['/tmp/repo1', '/tmp/repo2'])
  })

  it('pendingAdded appends to the pending list', () => {
    const a = stubPending({ id: 'pending:a' })
    const b = stubPending({ id: 'pending:b' })
    const s1 = apply(initialWorktrees, { type: 'worktrees/pendingAdded', payload: a })
    const s2 = apply(s1, { type: 'worktrees/pendingAdded', payload: b })
    expect(s2.pending.map((p) => p.id)).toEqual(['pending:a', 'pending:b'])
  })

  it('pendingUpdated merges a partial patch into the matching entry', () => {
    const start: WorktreesState = {
      ...initialWorktrees,
      pending: [
        stubPending({ id: 'pending:a', status: 'creating' }),
        stubPending({ id: 'pending:b', status: 'creating' })
      ]
    }
    const next = apply(start, {
      type: 'worktrees/pendingUpdated',
      payload: { id: 'pending:a', patch: { status: 'setup', setupLog: 'hello' } }
    })
    const a = next.pending.find((p) => p.id === 'pending:a')
    const b = next.pending.find((p) => p.id === 'pending:b')
    expect(a?.status).toBe('setup')
    expect(a?.setupLog).toBe('hello')
    expect(a?.branchName).toBe('feature/a')
    expect(b?.status).toBe('creating')
  })

  it('pendingUpdated on an unknown id is a no-op', () => {
    const start: WorktreesState = {
      ...initialWorktrees,
      pending: [stubPending({ id: 'pending:a' })]
    }
    const next = apply(start, {
      type: 'worktrees/pendingUpdated',
      payload: { id: 'pending:missing', patch: { status: 'error', error: 'nope' } }
    })
    expect(next).toBe(start)
  })

  it('pendingUpdated preserves reference identity for untouched siblings', () => {
    const a = stubPending({ id: 'pending:a' })
    const b = stubPending({ id: 'pending:b' })
    const c = stubPending({ id: 'pending:c' })
    const start: WorktreesState = {
      ...initialWorktrees,
      pending: [a, b, c]
    }
    const next = apply(start, {
      type: 'worktrees/pendingUpdated',
      payload: { id: 'pending:b', patch: { status: 'setup' } }
    })
    expect(next.pending).not.toBe(start.pending)
    expect(next.pending[0]).toBe(a)
    expect(next.pending[2]).toBe(c)
    expect(next.pending[1]).not.toBe(b)
    expect(next.pending[1].status).toBe('setup')
  })

  it('pendingRemoved drops the matching entry', () => {
    const start: WorktreesState = {
      ...initialWorktrees,
      pending: [
        stubPending({ id: 'pending:a' }),
        stubPending({ id: 'pending:b' })
      ]
    }
    const next = apply(start, { type: 'worktrees/pendingRemoved', payload: 'pending:a' })
    expect(next.pending.map((p) => p.id)).toEqual(['pending:b'])
  })

  it('pendingDeletionStarted appends and deduplicates by path', () => {
    const a: PendingDeletion = {
      path: '/tmp/wt/a',
      repoRoot: '/tmp/repo',
      branch: 'feature/a',
      phase: 'running-teardown'
    }
    const b: PendingDeletion = { ...a, path: '/tmp/wt/b' }
    const s1 = apply(initialWorktrees, { type: 'worktrees/pendingDeletionStarted', payload: a })
    const s2 = apply(s1, { type: 'worktrees/pendingDeletionStarted', payload: b })
    expect(s2.pendingDeletions.map((d) => d.path)).toEqual(['/tmp/wt/a', '/tmp/wt/b'])
    // Re-starting the same path replaces the entry (retry behavior).
    const s3 = apply(s2, {
      type: 'worktrees/pendingDeletionStarted',
      payload: { ...a, phase: 'running-teardown', error: undefined }
    })
    expect(s3.pendingDeletions.map((d) => d.path)).toEqual(['/tmp/wt/b', '/tmp/wt/a'])
  })

  it('pendingDeletionUpdated merges a partial patch into the matching entry', () => {
    const start: WorktreesState = {
      ...initialWorktrees,
      pendingDeletions: [
        {
          path: '/tmp/wt/a',
          repoRoot: '/tmp/repo',
          branch: 'feature/a',
          phase: 'running-teardown'
        }
      ]
    }
    const next = apply(start, {
      type: 'worktrees/pendingDeletionUpdated',
      payload: { path: '/tmp/wt/a', patch: { teardownLog: 'hi', phase: 'removing-worktree' } }
    })
    expect(next.pendingDeletions[0].phase).toBe('removing-worktree')
    expect(next.pendingDeletions[0].teardownLog).toBe('hi')
  })

  it('pendingDeletionUpdated on an unknown path is a no-op', () => {
    const start: WorktreesState = {
      ...initialWorktrees,
      pendingDeletions: [
        { path: '/tmp/wt/a', repoRoot: '/tmp/repo', branch: 'a', phase: 'running-teardown' }
      ]
    }
    const next = apply(start, {
      type: 'worktrees/pendingDeletionUpdated',
      payload: { path: '/tmp/wt/missing', patch: { phase: 'failed' } }
    })
    expect(next).toBe(start)
  })

  it('pendingDeletionUpdated preserves reference identity for untouched siblings', () => {
    const a: PendingDeletion = {
      path: '/tmp/wt/a',
      repoRoot: '/tmp/repo',
      branch: 'a',
      phase: 'running-teardown'
    }
    const b: PendingDeletion = { ...a, path: '/tmp/wt/b' }
    const c: PendingDeletion = { ...a, path: '/tmp/wt/c' }
    const start: WorktreesState = {
      ...initialWorktrees,
      pendingDeletions: [a, b, c]
    }
    const next = apply(start, {
      type: 'worktrees/pendingDeletionUpdated',
      payload: { path: '/tmp/wt/b', patch: { phase: 'removing-worktree' } }
    })
    expect(next.pendingDeletions).not.toBe(start.pendingDeletions)
    expect(next.pendingDeletions[0]).toBe(a)
    expect(next.pendingDeletions[2]).toBe(c)
    expect(next.pendingDeletions[1]).not.toBe(b)
    expect(next.pendingDeletions[1].phase).toBe('removing-worktree')
  })

  it('pendingDeletionRemoved drops the matching entry', () => {
    const start: WorktreesState = {
      ...initialWorktrees,
      pendingDeletions: [
        { path: '/tmp/wt/a', repoRoot: '/tmp/repo', branch: 'a', phase: 'running-teardown' },
        { path: '/tmp/wt/b', repoRoot: '/tmp/repo', branch: 'b', phase: 'running-teardown' }
      ]
    }
    const next = apply(start, {
      type: 'worktrees/pendingDeletionRemoved',
      payload: '/tmp/wt/a'
    })
    expect(next.pendingDeletions.map((d) => d.path)).toEqual(['/tmp/wt/b'])
  })

  it('leaves unrelated slices untouched on each event', () => {
    const start: WorktreesState = {
      list: [stubWorktree()],
      repoRoots: ['/tmp/repo'],
      repoRemotes: {},
      pending: [stubPending()],
      pendingDeletions: []
    }
    const next = apply(start, { type: 'worktrees/reposChanged', payload: ['/tmp/other'] })
    expect(next.list).toBe(start.list)
    expect(next.pending).toBe(start.pending)
  })
})

describe('worktrees/repoRemotesChanged', () => {
  it('replaces the normalized-remote map', () => {
    const next = worktreesReducer(initialWorktrees, {
      type: 'worktrees/repoRemotesChanged',
      payload: { '/r/ness': 'github.com/ness-dev/ness', '/r/local-only': null }
    })
    expect(next.repoRemotes).toEqual({ '/r/ness': 'github.com/ness-dev/ness', '/r/local-only': null })
    expect(next.repoRoots).toBe(initialWorktrees.repoRoots)
    expect(initialWorktrees.repoRemotes).toEqual({})
  })
})
