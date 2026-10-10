import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('./debug', () => ({ log: () => {} }))

vi.mock('./repo-config', () => ({
  loadRepoConfig: vi.fn(() => ({}))
}))

vi.mock('./worktree', () => ({
  removeWorktree: vi.fn(async () => {}),
  pruneWorktrees: vi.fn(async () => {}),
  unlockWorktree: vi.fn(async () => {}),
  runWorktreeScript: vi.fn(async (_kind, _cmd, _ctx, onChunk) => {
    if (onChunk) onChunk('stdout', 'teardown-output')
    return { ok: true, exitCode: 0, stdout: '', stderr: '' }
  })
}))

vi.mock('./worktree-trash', () => ({
  deleteWorktreeDirectory: vi.fn(async () => {}),
  isSameVolume: vi.fn(() => true),
  moveWorktreeToTrash: vi.fn(async (_p: string) => '/trash/uuid'),
  scheduleTrashUnlink: vi.fn(),
  worktreeTrashDir: () => '/trash'
}))

import { Store } from './store'
import { WorktreeDeletionFSM } from './worktree-deletion-fsm'
import { removeWorktree, pruneWorktrees, runWorktreeScript, unlockWorktree } from './worktree'
import {
  deleteWorktreeDirectory,
  isSameVolume,
  moveWorktreeToTrash,
  scheduleTrashUnlink
} from './worktree-trash'
import { loadRepoConfig } from './repo-config'
import type { StateEvent } from '../shared/state'

function makeFsm(overrides: { teardown?: string } = {}) {
  const store = new Store()
  const events: StateEvent[] = []
  store.subscribe((e) => events.push(e))
  const refreshList = vi.fn(async () => [])
  const refreshListDebounced = vi.fn()
  const worktreesFSM = {
    refreshList,
    refreshListDebounced
  } as unknown as import('./worktrees-fsm').WorktreesFSM
  const fsm = new WorktreeDeletionFSM(store, {
    getGlobalTeardownCmd: () => overrides.teardown ?? '',
    worktreesFSM
  })
  return { store, events, fsm, refreshList, refreshListDebounced, worktreesFSM }
}

describe('WorktreeDeletionFSM — fast path (same volume)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(loadRepoConfig as unknown as ReturnType<typeof vi.fn>).mockReturnValue({})
    ;(isSameVolume as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true)
    ;(moveWorktreeToTrash as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      '/trash/uuid'
    )
    ;(pruneWorktrees as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
  })

  it('renames into trash, prunes git bookkeeping, dispatches removal, and fire-and-forgets the unlink', async () => {
    const { fsm, events, refreshListDebounced } = makeFsm()

    fsm.enqueue({ repoRoot: '/repo', path: '/repo/wt-a', branch: 'a' })

    // Let microtasks settle so run() finishes.
    await new Promise((r) => setImmediate(r))

    expect(moveWorktreeToTrash).toHaveBeenCalledWith('/repo/wt-a')
    expect(pruneWorktrees).toHaveBeenCalledWith('/repo')
    // Order matters: move must precede prune so git prune sees a missing dir.
    const moveOrder = (moveWorktreeToTrash as unknown as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0]
    const pruneOrder = (pruneWorktrees as unknown as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0]
    expect(moveOrder).toBeLessThan(pruneOrder)

    const removed = events.find((e) => e.type === 'worktrees/pendingDeletionRemoved')
    expect(removed).toBeTruthy()

    expect(refreshListDebounced).toHaveBeenCalledTimes(1)
    expect(scheduleTrashUnlink).toHaveBeenCalledWith('/trash/uuid')
    expect(removeWorktree).not.toHaveBeenCalled()
  })

  it('runs teardown BEFORE the move so scripts can still reference the worktree', async () => {
    const { fsm } = makeFsm({ teardown: 'echo teardown' })
    fsm.enqueue({ repoRoot: '/repo', path: '/repo/wt-a', branch: 'a' })
    await new Promise((r) => setImmediate(r))

    const teardownOrder = (runWorktreeScript as unknown as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0]
    const moveOrder = (moveWorktreeToTrash as unknown as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0]
    expect(teardownOrder).toBeLessThan(moveOrder)
  })
})

describe('WorktreeDeletionFSM — slow-path fallback (cross-volume)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(loadRepoConfig as unknown as ReturnType<typeof vi.fn>).mockReturnValue({})
    ;(isSameVolume as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false)
    ;(removeWorktree as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
  })

  it('calls removeWorktree (git worktree remove) with the force flag preserved', async () => {
    const { fsm, refreshListDebounced } = makeFsm()

    fsm.enqueue({ repoRoot: '/repo', path: '/vol2/wt', branch: 'x', force: true })
    await new Promise((r) => setImmediate(r))

    expect(removeWorktree).toHaveBeenCalledWith('/repo', '/vol2/wt', true)
    expect(moveWorktreeToTrash).not.toHaveBeenCalled()
    expect(scheduleTrashUnlink).not.toHaveBeenCalled()
    expect(refreshListDebounced).toHaveBeenCalledTimes(1)
  })

  it('deletes the directory and prunes when git rejects a worktree containing submodules', async () => {
    ;(removeWorktree as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error(
        'Command failed: git worktree remove /vol2/wt\nfatal: working trees containing submodules cannot be moved or removed'
      )
    )
    const { fsm, events, refreshListDebounced } = makeFsm()

    fsm.enqueue({ repoRoot: '/repo', path: '/vol2/wt', branch: 'x' })
    await new Promise((r) => setImmediate(r))

    expect(deleteWorktreeDirectory).toHaveBeenCalledWith('/vol2/wt')
    expect(pruneWorktrees).toHaveBeenCalledWith('/repo')
    expect(events.some((e) => e.type === 'worktrees/pendingDeletionRemoved')).toBe(true)
    expect(refreshListDebounced).toHaveBeenCalledTimes(1)
  })

  it('does not delete the directory directly for unrelated git errors', async () => {
    ;(removeWorktree as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('fatal: worktree is locked')
    )
    const { fsm, events } = makeFsm()

    fsm.enqueue({ repoRoot: '/repo', path: '/vol2/wt', branch: 'x' })
    await new Promise((r) => setImmediate(r))

    expect(deleteWorktreeDirectory).not.toHaveBeenCalled()
    expect(
      events.some(
        (e) =>
          e.type === 'worktrees/pendingDeletionUpdated' &&
          e.payload.patch.phase === 'failed'
      )
    ).toBe(true)
  })
})

describe('WorktreeDeletionFSM — failure surface', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(loadRepoConfig as unknown as ReturnType<typeof vi.fn>).mockReturnValue({})
  })

  it('dispatches phase:failed if the rename throws', async () => {
    ;(isSameVolume as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true)
    ;(moveWorktreeToTrash as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('EACCES')
    )
    const { fsm, events } = makeFsm()

    fsm.enqueue({ repoRoot: '/repo', path: '/repo/wt', branch: 'z' })
    await new Promise((r) => setImmediate(r))

    const failed = events.find(
      (e) =>
        e.type === 'worktrees/pendingDeletionUpdated' &&
        e.payload.patch.phase === 'failed'
    )
    expect(failed).toBeTruthy()
  })
})

describe('WorktreeDeletionFSM — locked worktrees', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(loadRepoConfig as unknown as ReturnType<typeof vi.fn>).mockReturnValue({})
    ;(isSameVolume as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true)
    ;(moveWorktreeToTrash as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      '/trash/uuid'
    )
  })

  function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'wt-fsm-locked-'))
    return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
  }

  it('refuses a locked worktree whose directory exists without an override, before teardown', () =>
    withDir(async (dir) => {
      ;(loadRepoConfig as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        teardownCommand: 'echo bye'
      })
      const { fsm, events } = makeFsm()

      fsm.enqueue({ repoRoot: '/repo', path: dir, branch: 'x', locked: true, lockedReason: 'claude agent' })
      await new Promise((r) => setImmediate(r))

      const failed = events.find(
        (e) => e.type === 'worktrees/pendingDeletionUpdated' && e.payload.patch.phase === 'failed'
      )
      expect(failed && failed.type === 'worktrees/pendingDeletionUpdated' && failed.payload.patch.error).toMatch(
        /locked \(claude agent\)/
      )
      expect(runWorktreeScript).not.toHaveBeenCalled()
      expect(unlockWorktree).not.toHaveBeenCalled()
      expect(moveWorktreeToTrash).not.toHaveBeenCalled()
    }))

  it('unlocks before trashing when the lock is overridden', () =>
    withDir(async (dir) => {
      const { fsm, events } = makeFsm()

      fsm.enqueue({ repoRoot: '/repo', path: dir, branch: 'x', locked: true, overrideLock: true })
      await new Promise((r) => setImmediate(r))

      expect(unlockWorktree).toHaveBeenCalledWith('/repo', dir)
      const unlockOrder = (unlockWorktree as unknown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
      const moveOrder = (moveWorktreeToTrash as unknown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
      expect(unlockOrder).toBeLessThan(moveOrder)
      expect(events.some((e) => e.type === 'worktrees/pendingDeletionRemoved')).toBe(true)
    }))

  it('removes a locked worktree whose directory is already gone without an override', async () => {
    ;(isSameVolume as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false)
    ;(removeWorktree as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    const { fsm, events } = makeFsm()

    fsm.enqueue({ repoRoot: '/repo', path: '/gone/wt92', branch: 'sec-9.2-fix', locked: true })
    await new Promise((r) => setImmediate(r))

    expect(unlockWorktree).not.toHaveBeenCalled()
    expect(removeWorktree).toHaveBeenCalledWith('/repo', '/gone/wt92', undefined)
    expect(events.some((e) => e.type === 'worktrees/pendingDeletionRemoved')).toBe(true)
  })
})
