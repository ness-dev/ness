import { afterEach, describe, expect, it, vi } from 'vitest'
import { Store } from './store'
import { LochAutoRecorder } from './loch-auto-recorder'
import type { Worktree } from '../shared/state/worktrees'
import type { LochRecordingResult } from '../shared/loch'

const wt = (repoRoot: string, prunable = false): Worktree => ({
  path: `${repoRoot}/main`,
  branch: 'main',
  head: 'abc',
  isBare: false,
  isMain: true,
  createdAt: 0,
  repoRoot,
  ...(prunable ? { prunable: true } : {})
})

const OK: LochRecordingResult = { ok: true, installed: 1, viaProject: 0, failed: 0 }

function harness(opts?: { enable?: (root: string) => Promise<LochRecordingResult> }) {
  const store = new Store()
  const state = { recordNewRepos: true, repoRoots: ['/existing'] as string[] }
  const calls: string[] = []
  const recorder = new LochAutoRecorder(store, {
    recordNewRepos: () => state.recordNewRepos,
    repoRoots: () => state.repoRoots,
    isRecording: () => false,
    canRecord: () => true,
    enable: async (root) => {
      calls.push(`start ${root}`)
      const r = opts?.enable ? await opts.enable(root) : OK
      calls.push(`end ${root}`)
      return r
    },
    log: () => {},
    listTimeoutMs: 1000
  })
  recorder.start()
  const addRepos = (...roots: string[]): void => {
    state.repoRoots = [...state.repoRoots, ...roots]
    store.dispatch({ type: 'worktrees/reposChanged', payload: [...state.repoRoots] })
  }
  const removeRepo = (root: string): void => {
    state.repoRoots = state.repoRoots.filter((r) => r !== root)
    store.dispatch({ type: 'worktrees/reposChanged', payload: [...state.repoRoots] })
  }
  const list = (...wts: Worktree[]): void => {
    store.dispatch({ type: 'worktrees/listChanged', payload: wts })
  }
  const active = (): string[] => store.getSnapshot().state.loch.autoRecording
  return { store, state, calls, recorder, addRepos, removeRepo, list, active }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('LochAutoRecorder', () => {
  it('enables a newly added repo once its worktrees are listed', async () => {
    const h = harness()
    h.addRepos('/new')
    expect(h.active()).toEqual(['/new'])
    h.list(wt('/existing'), wt('/new'))
    h.list(wt('/existing'), wt('/new'))
    await h.recorder.idle()
    expect(h.calls).toEqual(['start /new', 'end /new'])
    expect(h.active()).toEqual([])
  })

  it('ignores repos that were registered at construction', async () => {
    const h = harness()
    h.store.dispatch({ type: 'worktrees/reposChanged', payload: ['/existing'] })
    h.list(wt('/existing'))
    await h.recorder.idle()
    expect(h.calls).toEqual([])
    expect(h.active()).toEqual([])
  })

  it('does nothing when the answer is off', async () => {
    const h = harness()
    h.state.recordNewRepos = false
    h.addRepos('/new')
    h.list(wt('/new'))
    await h.recorder.idle()
    expect(h.calls).toEqual([])
    expect(h.active()).toEqual([])
  })

  it('clears autoRecording when the repo is removed while waiting', async () => {
    const h = harness()
    h.addRepos('/new')
    h.removeRepo('/new')
    expect(h.active()).toEqual([])
    h.list(wt('/new'))
    await h.recorder.idle()
    expect(h.calls).toEqual([])
  })

  it('skips enable when the answer flips off mid-chain', async () => {
    let release!: () => void
    const h = harness({
      enable: (root) =>
        root === '/a' ? new Promise((resolve) => { release = () => resolve(OK) }) : Promise.resolve(OK)
    })
    h.addRepos('/a', '/b')
    h.list(wt('/a'), wt('/b'))
    await Promise.resolve()
    h.state.recordNewRepos = false
    release()
    await h.recorder.idle()
    expect(h.calls).toEqual(['start /a', 'end /a'])
    expect(h.active()).toEqual([])
  })

  it('runs repos added together one after the other', async () => {
    const releases: Array<() => void> = []
    const h = harness({
      enable: () => new Promise((resolve) => { releases.push(() => resolve(OK)) })
    })
    h.addRepos('/a', '/b')
    h.list(wt('/a'), wt('/b'))
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(h.calls).toEqual(['start /a'])
    releases[0]()
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(h.calls).toEqual(['start /a', 'end /a', 'start /b'])
    releases[1]()
    await h.recorder.idle()
    expect(h.calls).toEqual(['start /a', 'end /a', 'start /b', 'end /b'])
  })

  it('clears autoRecording when enable fails or throws', async () => {
    const h = harness({
      enable: async (root) => {
        if (root === '/b') throw new Error('boom')
        return { ok: false, code: 'download-failed' }
      }
    })
    h.addRepos('/a', '/b')
    h.list(wt('/a'), wt('/b'))
    await h.recorder.idle()
    expect(h.active()).toEqual([])
  })

  it('gives up on a repo with no usable worktree after the timeout', () => {
    vi.useFakeTimers()
    const h = harness()
    h.addRepos('/new')
    h.list(wt('/new', true))
    expect(h.active()).toEqual(['/new'])
    vi.advanceTimersByTime(1000)
    expect(h.active()).toEqual([])
    h.list(wt('/new'))
    expect(h.calls).toEqual([])
  })
})
