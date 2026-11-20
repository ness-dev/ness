import { describe, it, expect, vi } from 'vitest'
import { createLocalMergeOps, type LocalMergeDeps } from './local-merge'
import type { MainWorktreeStatus, MergeLocalResult } from './worktree'

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const RESULT: MergeLocalResult = {
  ok: true,
  strategy: 'squash',
  mergedBranch: 'feat',
  baseBranch: 'main',
  mainPath: '/repo'
}
const STATUS = { ready: true } as MainWorktreeStatus

function makeDeps(overrides: Partial<LocalMergeDeps> = {}): LocalMergeDeps {
  return {
    dispatch: vi.fn(),
    getCurrentBranch: vi.fn(async () => 'feat'),
    mergeWorktreeLocally: vi.fn(async () => RESULT),
    prepareMainForMerge: vi.fn(async () => STATUS),
    getBranchSha: vi.fn(async () => 'sha1'),
    recordLocallyMerged: vi.fn(),
    refreshAll: vi.fn(),
    ...overrides
  }
}

describe('createLocalMergeOps', () => {
  it('dispatches started, records the SHA, and finishes as merged', async () => {
    const deps = makeDeps()
    const ops = createLocalMergeOps(deps)
    await expect(ops.mergeLocal('/repo', 'feat', 'squash', '/wt/a')).resolves.toBe(RESULT)
    expect(deps.recordLocallyMerged).toHaveBeenCalledWith('feat', 'sha1')
    expect(deps.refreshAll).toHaveBeenCalled()
    expect(vi.mocked(deps.dispatch).mock.calls.map((c) => c[0])).toEqual([
      { type: 'prs/localMergeStarted', payload: { path: '/wt/a' } },
      { type: 'prs/localMergeFinished', payload: { path: '/wt/a', merged: true } }
    ])
  })

  it('finishes as not merged when the merge throws', async () => {
    const deps = makeDeps({ mergeWorktreeLocally: vi.fn(async () => { throw new Error('conflict') }) })
    const ops = createLocalMergeOps(deps)
    await expect(ops.mergeLocal('/repo', 'feat', 'squash', '/wt/a')).rejects.toThrow('conflict')
    expect(deps.dispatch).toHaveBeenLastCalledWith({
      type: 'prs/localMergeFinished',
      payload: { path: '/wt/a', merged: false }
    })
  })

  it('finishes as not merged when no SHA could be recorded', async () => {
    const deps = makeDeps({ getBranchSha: vi.fn(async () => null) })
    const ops = createLocalMergeOps(deps)
    await ops.mergeLocal('/repo', 'feat', 'squash', '/wt/a')
    expect(deps.recordLocallyMerged).not.toHaveBeenCalled()
    expect(deps.dispatch).toHaveBeenLastCalledWith({
      type: 'prs/localMergeFinished',
      payload: { path: '/wt/a', merged: false }
    })
  })

  it('refuses a second merge or prepare into the same repo while one runs', async () => {
    const gate = deferred<MergeLocalResult>()
    const deps = makeDeps({ mergeWorktreeLocally: vi.fn(() => gate.promise) })
    const ops = createLocalMergeOps(deps)
    const first = ops.mergeLocal('/repo', 'feat', 'squash', '/wt/a')
    await expect(ops.mergeLocal('/repo', 'other', 'squash', '/wt/b')).rejects.toThrow(/in progress/)
    await expect(ops.prepareMain('/repo')).rejects.toThrow(/in progress/)
    // The refused attempt must not mark its worktree as merging.
    expect(deps.dispatch).not.toHaveBeenCalledWith({
      type: 'prs/localMergeStarted',
      payload: { path: '/wt/b' }
    })
    // A different repo is unaffected.
    await expect(ops.prepareMain('/other-repo')).resolves.toBe(STATUS)
    gate.resolve(RESULT)
    await first
    // Lock released once the first settles.
    await expect(ops.mergeLocal('/repo', 'other', 'squash', '/wt/b')).resolves.toBe(RESULT)
  })

  it('releases the lock after a failed prepare', async () => {
    const deps = makeDeps({ prepareMainForMerge: vi.fn(async () => { throw new Error('dirty') }) })
    const ops = createLocalMergeOps(deps)
    await expect(ops.prepareMain('/repo')).rejects.toThrow('dirty')
    await expect(ops.mergeLocal('/repo', 'feat', 'squash')).resolves.toBe(RESULT)
  })
})
