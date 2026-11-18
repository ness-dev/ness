import { describe, it, expect, vi } from 'vitest'

vi.mock('./debug', () => ({ log: () => {} }))

import { Store } from './store'
import type { PRStatus } from '../shared/state/prs'
import { PrStatusWatcher, type PrStatusWatcherOptions } from './pr-status-watcher'

const WT = '/wt'

function pr(over: Partial<PRStatus> = {}): PRStatus {
  return {
    number: 7,
    state: 'open',
    title: 'Add div',
    url: 'https://example.com/pull/7',
    branch: 'feature',
    checksOverall: 'success',
    headSha: 'sha-1',
    checks: [],
    ...over
  } as unknown as PRStatus
}

function setup(opts: Partial<PrStatusWatcherOptions> = {}, seed?: Record<string, PRStatus>) {
  const store = new Store()
  if (seed) {
    store.dispatch({ type: 'prs/bulkStatusChanged', payload: seed })
  }
  const act = vi.fn((_path: string, _status: PRStatus, _shaKey: string) => true)
  const watcher = new PrStatusWatcher(store, {
    name: 'test',
    on: 'success',
    isEnabled: () => true,
    act,
    ...opts
  })
  watcher.start()
  const poll = async (status: PRStatus | null, path = WT): Promise<void> => {
    store.dispatch({ type: 'prs/statusChanged', payload: { path, status } })
    await new Promise((r) => setImmediate(r))
  }
  return { store, watcher, act, poll }
}

const pending = (over: Partial<PRStatus> = {}): PRStatus =>
  pr({ checksOverall: 'pending', ...over })

describe('PrStatusWatcher', () => {
  it('acts when the checks reach the state it watches', async () => {
    const { act, poll } = setup()
    await poll(pending())
    expect(act).not.toHaveBeenCalled()
    await poll(pr())
    expect(act).toHaveBeenCalledTimes(1)
    expect(act.mock.calls[0]).toEqual([WT, expect.objectContaining({ headSha: 'sha-1' }), 'sha-1'])
  })

  it('acts once per head commit however often it is polled, and again on a new one', async () => {
    const { act, poll } = setup()
    await poll(pending())
    await poll(pr())
    await poll(pr())
    expect(act).toHaveBeenCalledTimes(1)
    // A check that flaps away and back is still the same commit.
    await poll(pending())
    await poll(pr())
    expect(act).toHaveBeenCalledTimes(1)
    await poll(pr({ headSha: 'sha-2' }))
    expect(act).toHaveBeenCalledTimes(2)
  })

  it('stays quiet about a PR already in that state at the first poll', async () => {
    const { act, poll } = setup()
    await poll(pr())
    expect(act).not.toHaveBeenCalled()
    // …including when the first thing it ever sees is a bulk payload.
    const seeded = setup({}, { [WT]: pr() })
    await seeded.poll(pr())
    expect(seeded.act).not.toHaveBeenCalled()
  })

  it('falls back to the PR number when a cached status has no headSha', async () => {
    const { act, poll } = setup()
    await poll(pending({ headSha: undefined }))
    await poll(pr({ headSha: undefined }))
    expect(act).toHaveBeenCalledTimes(1)
    expect(act.mock.calls[0][2]).toBe('pr-7')
    await poll(pr({ headSha: undefined }))
    expect(act).toHaveBeenCalledTimes(1)
  })

  it('skips a worktree the enablement predicate turns down, and claims the commit anyway', async () => {
    let enabled = false
    const { act, poll } = setup({ isEnabled: () => enabled })
    await poll(pending())
    await poll(pr())
    expect(act).not.toHaveBeenCalled()
    // The commit was claimed, so flipping the setting on does not make an
    // old result fire retroactively.
    enabled = true
    await poll(pr())
    expect(act).not.toHaveBeenCalled()
  })

  it('ignores a non-open PR only when requireOpen is set', async () => {
    const strict = setup({ requireOpen: true })
    await strict.poll(pending())
    await strict.poll(pr({ state: 'merged' }))
    expect(strict.act).not.toHaveBeenCalled()

    const loose = setup()
    await loose.poll(pending())
    await loose.poll(pr({ state: 'merged' }))
    expect(loose.act).toHaveBeenCalledTimes(1)
  })

  it('releases the commit when act returns false, so a later poll retries', async () => {
    const { act, poll } = setup()
    act.mockReturnValueOnce(false)
    await poll(pending())
    await poll(pr())
    expect(act).toHaveBeenCalledTimes(1)
    await poll(pr())
    expect(act).toHaveBeenCalledTimes(2)
  })

  it('acts off the store fan-out, not inside it', async () => {
    const { store, act } = setup()
    store.dispatch({ type: 'prs/statusChanged', payload: { path: WT, status: pending() } })
    store.dispatch({ type: 'prs/statusChanged', payload: { path: WT, status: pr() } })
    // Still inside the dispatch turn: nothing has run yet.
    expect(act).not.toHaveBeenCalled()
    await new Promise((r) => setImmediate(r))
    expect(act).toHaveBeenCalledTimes(1)
  })

  it('forgets a worktree whose PR disappears, from either event', async () => {
    const { act, poll, store } = setup()
    await poll(pending())
    await poll(pr())
    expect(act).toHaveBeenCalledTimes(1)
    await poll(null)
    // Re-appearing reads as a first observation again, so it stays quiet.
    await poll(pr())
    expect(act).toHaveBeenCalledTimes(1)

    // A bulk payload that omits the path forgets it the same way.
    await poll(pending())
    await poll(pr({ headSha: 'sha-9' }))
    expect(act).toHaveBeenCalledTimes(2)
    store.dispatch({ type: 'prs/bulkStatusChanged', payload: {} })
    await new Promise((r) => setImmediate(r))
    await poll(pr({ headSha: 'sha-9' }))
    expect(act).toHaveBeenCalledTimes(2)
  })

  it('stops acting once stopped', async () => {
    const { act, poll, watcher } = setup()
    await poll(pending())
    watcher.stop()
    await poll(pr())
    expect(act).not.toHaveBeenCalled()
  })
})
