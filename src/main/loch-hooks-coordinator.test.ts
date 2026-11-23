import { describe, expect, it } from 'vitest'
import { LochHooksCoordinator, type HookInstallResult } from './loch-hooks-coordinator'

/** A fake worktree filesystem: which paths currently have hooks, plus a log
 *  of operations in the order they ran, and installs that can be held open. */
function harness() {
  const bin = { current: '/old/loch' }
  const recording = new Set<string>()
  const hooksOn = new Set<string>()
  const ops: string[] = []
  const gates = new Map<string, () => void>()
  const coordinator = new LochHooksCoordinator<HookInstallResult>({
    isRecording: (repo) => recording.has(repo),
    install: async (path) => {
      ops.push(`install:start ${path}`)
      // Read before the await, like installLochHooks: a switch mid-install
      // must not be credited to this one.
      const used = bin.current
      await new Promise<void>((resolve) => gates.set(path, resolve))
      hooksOn.add(path)
      ops.push(`install:end ${path}`)
      return { ok: true, bin: used }
    },
    remove: (path) => {
      hooksOn.delete(path)
      ops.push(`remove ${path}`)
    }
  })
  const started = async (path: string): Promise<void> => {
    for (let i = 0; i < 20 && !gates.has(path); i++) await Promise.resolve()
  }
  const release = async (path: string): Promise<void> => {
    await started(path)
    gates.get(path)?.()
    gates.delete(path)
  }
  return { bin, recording, hooksOn, ops, coordinator, started, release }
}

const wt = { path: '/r/wt1', repoRoot: '/r' }

describe('LochHooksCoordinator', () => {
  it('installs and records the path when the repo is opted in', async () => {
    const h = harness()
    h.recording.add('/r')
    const p = h.coordinator.installIfRecording(wt)
    await h.release(wt.path)
    expect(await p).toEqual({ ok: true, bin: '/old/loch' })
    expect(h.hooksOn.has(wt.path)).toBe(true)
    expect(h.coordinator.isCurrent(wt.path, '/old/loch')).toBe(true)
  })

  it('an install that raced a binary switch still reads as stale', async () => {
    const h = harness()
    h.recording.add('/r')
    const p = h.coordinator.installIfRecording(wt)
    await h.started(wt.path)
    h.bin.current = '/new/loch'
    await h.release(wt.path)
    await p
    expect(h.coordinator.isCurrent(wt.path, '/new/loch')).toBe(false)
    expect(h.coordinator.isCurrent(wt.path, null)).toBe(false)
  })

  it('skips the install entirely when the repo is not opted in', async () => {
    const h = harness()
    expect(await h.coordinator.installIfRecording(wt)).toBe(null)
    expect(h.ops).toEqual([])
  })

  it('an opt-out during an in-flight install wins: the hooks end up removed', async () => {
    const h = harness()
    h.recording.add('/r')
    const install = h.coordinator.installIfRecording(wt)
    // Opt out while `loch install` is still running: list first, then removal.
    h.recording.delete('/r')
    const removal = h.coordinator.remove(wt.path)
    await h.release(wt.path)
    expect(await install).toBe(null)
    expect(await removal).toBe(true)
    expect(h.hooksOn.has(wt.path)).toBe(false)
    expect(h.coordinator.hooked.has(wt.path)).toBe(false)
  })

  it('never runs two operations on one path at once', async () => {
    const h = harness()
    h.recording.add('/r')
    const a = h.coordinator.installIfRecording(wt)
    const b = h.coordinator.installIfRecording(wt)
    await h.release(wt.path)
    await a
    await h.release(wt.path)
    await b
    expect(h.ops).toEqual([
      `install:start ${wt.path}`,
      `install:end ${wt.path}`,
      `install:start ${wt.path}`,
      `install:end ${wt.path}`
    ])
  })

  it('reports a failed removal without throwing, and keeps the queue moving', async () => {
    const coordinator = new LochHooksCoordinator<HookInstallResult>({
      isRecording: () => true,
      install: async () => ({ ok: true }),
      remove: () => {
        throw new Error('EACCES')
      }
    })
    expect(await coordinator.remove('/r/wt1')).toBe(false)
    expect(await coordinator.installIfRecording(wt)).toEqual({ ok: true })
  })
})
