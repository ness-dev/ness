import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./debug', () => ({
  log: () => {},
  formatErr: (err: unknown) => (err instanceof Error ? err.message : String(err))
}))
vi.mock('./worktree', () => ({
  listWorktrees: vi.fn(),
  getBranchSha: vi.fn()
}))
vi.mock('./github', () => ({
  getRepoContext: vi.fn(),
  fetchPRStatusesForRepo: vi.fn(),
  fetchPRStatusByNumber: vi.fn()
}))

import { PRPoller, reconcileUnknownMergeable } from './pr-poller'
import { Store } from './store'
import { initialState, type AppState } from '../shared/state'
import type { PRStatus } from '../shared/state/prs'
import { getRepoContext, fetchPRStatusesForRepo, fetchPRStatusByNumber } from './github'
import { listWorktrees, getBranchSha } from './worktree'

function fakePRStatus(number: number): PRStatus {
  return {
    number,
    title: `PR ${number}`,
    state: 'open',
    url: '',
    branch: '',
    author: null,
    checks: [],
    checksOverall: 'none',
    hasConflict: false,
    reviews: [],
    reviewDecision: 'none',
    baseBranch: 'main',
    isDefaultBase: true,
    assignees: [],
    linkedIssues: [],
    labels: []
  }
}

function wt(path: string, branch: string, head: string) {
  return {
    path,
    branch,
    head,
    isBare: false,
    isMain: false,
    createdAt: 0,
    repoRoot: '/repo'
  }
}

function makePoller(initialByPath: Record<string, PRStatus | null>): {
  store: Store
  poller: PRPoller
} {
  const state: AppState = {
    ...initialState,
    prs: { ...initialState.prs, byPath: initialByPath }
  }
  const store = new Store(state)
  const poller = new PRPoller(store, {
    getRepoRoots: () => ['/repo'],
    getLocallyMerged: () => ({}),
    setLocallyMerged: () => {}
  })
  return { store, poller }
}

describe('PRPoller.refreshAll — offline / failure preservation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getRepoContext).mockResolvedValue({
      origin: { owner: 'o', repo: 'r' },
      upstream: { owner: 'o', repo: 'r' }
    })
    vi.mocked(getBranchSha).mockResolvedValue(null)
  })

  it('preserves cached byPath when the batched fetch throws (wifi blip)', async () => {
    const { store, poller } = makePoller({
      '/wt/a': fakePRStatus(1),
      '/wt/b': fakePRStatus(2)
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      wt('/wt/a', 'a', 'sha-a'),
      wt('/wt/b', 'b', 'sha-b')
    ])
    vi.mocked(fetchPRStatusesForRepo).mockRejectedValue(new Error('ENOTFOUND api.github.com'))

    await poller.refreshAll()

    const byPath = store.getSnapshot().state.prs.byPath
    expect(byPath['/wt/a']).toEqual(fakePRStatus(1))
    expect(byPath['/wt/b']).toEqual(fakePRStatus(2))
  })

  it('overlays each worktree from the batched result', async () => {
    const { store, poller } = makePoller({
      '/wt/a': fakePRStatus(1),
      '/wt/b': fakePRStatus(2)
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      wt('/wt/a', 'a', 'sha-a'),
      wt('/wt/b', 'b', 'sha-b')
    ])
    vi.mocked(fetchPRStatusesForRepo).mockResolvedValue(
      new Map<string, PRStatus | null>([
        ['/wt/a', fakePRStatus(10)],
        ['/wt/b', fakePRStatus(11)]
      ])
    )

    await poller.refreshAll()

    const byPath = store.getSnapshot().state.prs.byPath
    expect(byPath['/wt/a']).toEqual(fakePRStatus(10))
    expect(byPath['/wt/b']).toEqual(fakePRStatus(11))
  })

  it('writes null when batched fetch finds no PR for a branch', async () => {
    const { store, poller } = makePoller({
      '/wt/a': fakePRStatus(1)
    })
    vi.mocked(listWorktrees).mockResolvedValue([wt('/wt/a', 'a', 'sha-a')])
    vi.mocked(fetchPRStatusesForRepo).mockResolvedValue(
      new Map<string, PRStatus | null>([['/wt/a', null]])
    )

    await poller.refreshAll()

    const byPath = store.getSnapshot().state.prs.byPath
    expect('/wt/a' in byPath).toBe(true)
    expect(byPath['/wt/a']).toBeNull()
  })

  it('drops stale paths whose worktrees no longer exist, even when fetch fails', async () => {
    const { store, poller } = makePoller({
      '/wt/a': fakePRStatus(1),
      '/wt/gone': fakePRStatus(99)
    })
    vi.mocked(listWorktrees).mockResolvedValue([wt('/wt/a', 'a', 'sha-a')])
    vi.mocked(fetchPRStatusesForRepo).mockRejectedValue(new Error('offline'))

    await poller.refreshAll()

    const byPath = store.getSnapshot().state.prs.byPath
    expect(byPath['/wt/a']).toEqual(fakePRStatus(1))
    expect('/wt/gone' in byPath).toBe(false)
  })

  it('retains merged-state PRStatus when branch-name lookup returns null after merge', async () => {
    const { store, poller } = makePoller({
      '/wt/a': fakePRStatus(42)
    })
    vi.mocked(listWorktrees).mockResolvedValue([wt('/wt/a', 'a', 'sha-a')])
    // Batch fetch comes back null — head branch deleted post-merge.
    vi.mocked(fetchPRStatusesForRepo).mockResolvedValue(
      new Map<string, PRStatus | null>([['/wt/a', null]])
    )
    // Followup by PR number finds the merged PR.
    vi.mocked(fetchPRStatusByNumber).mockResolvedValue({
      ...fakePRStatus(42),
      state: 'merged'
    })

    await poller.refreshAll()

    expect(vi.mocked(fetchPRStatusByNumber)).toHaveBeenCalledWith(
      expect.any(Object),
      42,
      '/wt/a',
      'a'
    )
    expect(store.getSnapshot().state.prs.byPath['/wt/a']?.state).toBe('merged')
  })

  it('does not run a followup when the previously-known PR was already in a terminal state', async () => {
    const { poller } = makePoller({
      '/wt/a': { ...fakePRStatus(42), state: 'merged' }
    })
    vi.mocked(listWorktrees).mockResolvedValue([wt('/wt/a', 'a', 'sha-a')])
    vi.mocked(fetchPRStatusesForRepo).mockResolvedValue(
      new Map<string, PRStatus | null>([['/wt/a', null]])
    )

    await poller.refreshAll()

    expect(vi.mocked(fetchPRStatusByNumber)).not.toHaveBeenCalled()
  })
})

/** A PR whose mergeability GitHub is still computing: `mergeable: UNKNOWN`
 *  arrives as `hasConflict: null`. */
function unknownMergeable(number: number, headSha: string): PRStatus {
  return { ...fakePRStatus(number), headSha, hasConflict: null }
}

describe('PRPoller — UNKNOWN mergeability (sticky carry-forward)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getRepoContext).mockResolvedValue({
      origin: { owner: 'o', repo: 'r' },
      upstream: { owner: 'o', repo: 'r' }
    })
    vi.mocked(getBranchSha).mockResolvedValue(null)
  })

  it('preserves a cached conflict when GitHub returns UNKNOWN for the same head SHA', async () => {
    const { store, poller } = makePoller({
      '/wt/a': { ...fakePRStatus(1), headSha: 'sha-1', hasConflict: true }
    })
    vi.mocked(listWorktrees).mockResolvedValue([wt('/wt/a', 'a', 'sha-a')])
    vi.mocked(fetchPRStatusesForRepo).mockResolvedValue(
      new Map<string, PRStatus | null>([['/wt/a', unknownMergeable(1, 'sha-1')]])
    )

    await poller.refreshAll()

    expect(store.getSnapshot().state.prs.byPath['/wt/a']?.hasConflict).toBe(true)
  })

  it('preserves a cached non-conflict when GitHub returns UNKNOWN', async () => {
    const { store, poller } = makePoller({
      '/wt/a': { ...fakePRStatus(1), headSha: 'sha-1', hasConflict: false }
    })
    vi.mocked(listWorktrees).mockResolvedValue([wt('/wt/a', 'a', 'sha-a')])
    vi.mocked(fetchPRStatusesForRepo).mockResolvedValue(
      new Map<string, PRStatus | null>([['/wt/a', unknownMergeable(1, 'sha-1')]])
    )

    await poller.refreshAll()

    expect(store.getSnapshot().state.prs.byPath['/wt/a']?.hasConflict).toBe(false)
  })

  it('does not carry a conflict forward across a new head SHA (force-push / new commit)', async () => {
    const { store, poller } = makePoller({
      '/wt/a': { ...fakePRStatus(1), headSha: 'sha-old', hasConflict: true }
    })
    vi.mocked(listWorktrees).mockResolvedValue([wt('/wt/a', 'a', 'sha-a')])
    vi.mocked(fetchPRStatusesForRepo).mockResolvedValue(
      new Map<string, PRStatus | null>([['/wt/a', unknownMergeable(1, 'sha-new')]])
    )

    await poller.refreshAll()

    expect(store.getSnapshot().state.prs.byPath['/wt/a']?.hasConflict).toBeNull()
  })

  it('does not carry a conflict forward across a different PR number', async () => {
    const { store, poller } = makePoller({
      '/wt/a': { ...fakePRStatus(1), headSha: 'sha-1', hasConflict: true }
    })
    vi.mocked(listWorktrees).mockResolvedValue([wt('/wt/a', 'a', 'sha-a')])
    vi.mocked(fetchPRStatusesForRepo).mockResolvedValue(
      new Map<string, PRStatus | null>([['/wt/a', unknownMergeable(2, 'sha-1')]])
    )

    await poller.refreshAll()

    expect(store.getSnapshot().state.prs.byPath['/wt/a']?.hasConflict).toBeNull()
  })

  it('leaves UNKNOWN as null when there is no cached entry', async () => {
    const { store, poller } = makePoller({})
    vi.mocked(listWorktrees).mockResolvedValue([wt('/wt/a', 'a', 'sha-a')])
    vi.mocked(fetchPRStatusesForRepo).mockResolvedValue(
      new Map<string, PRStatus | null>([['/wt/a', unknownMergeable(1, 'sha-1')]])
    )

    await poller.refreshAll()

    expect(store.getSnapshot().state.prs.byPath['/wt/a']?.hasConflict).toBeNull()
  })

  it('lets a definitive CONFLICTING / MERGEABLE answer win over the cached value', async () => {
    const { store, poller } = makePoller({
      '/wt/a': { ...fakePRStatus(1), headSha: 'sha-1', hasConflict: true },
      '/wt/b': { ...fakePRStatus(2), headSha: 'sha-2', hasConflict: false }
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      wt('/wt/a', 'a', 'sha-a'),
      wt('/wt/b', 'b', 'sha-b')
    ])
    vi.mocked(fetchPRStatusesForRepo).mockResolvedValue(
      new Map<string, PRStatus | null>([
        // Conflict resolved upstream.
        ['/wt/a', { ...fakePRStatus(1), headSha: 'sha-1', hasConflict: false }],
        // Newly conflicted.
        ['/wt/b', { ...fakePRStatus(2), headSha: 'sha-2', hasConflict: true }]
      ])
    )

    await poller.refreshAll()

    const byPath = store.getSnapshot().state.prs.byPath
    expect(byPath['/wt/a']?.hasConflict).toBe(false)
    expect(byPath['/wt/b']?.hasConflict).toBe(true)
  })
})

describe('reconcileUnknownMergeable — recheck collection', () => {
  const trees = [{ path: '/wt/a', branch: 'a', repoRoot: '/repo' }]

  it('collects an UNKNOWN open PR for recheck', () => {
    const { rechecks } = reconcileUnknownMergeable(
      {},
      { '/wt/a': unknownMergeable(7, 'sha-1') },
      trees
    )
    expect(rechecks).toEqual([{ path: '/wt/a', root: '/repo', branch: 'a', prNumber: 7 }])
  })

  it('does not recheck a PR with a definitive answer', () => {
    const { rechecks } = reconcileUnknownMergeable(
      {},
      { '/wt/a': { ...fakePRStatus(7), hasConflict: true } },
      trees
    )
    expect(rechecks).toEqual([])
  })

  it('does not recheck merged or closed PRs — conflicts are moot there', () => {
    for (const state of ['merged', 'closed'] as const) {
      const { rechecks } = reconcileUnknownMergeable(
        {},
        { '/wt/a': { ...unknownMergeable(7, 'sha-1'), state } },
        trees
      )
      expect(rechecks).toEqual([])
    }
  })

  it('does not mutate the input map', () => {
    const next = { '/wt/a': unknownMergeable(7, 'sha-1') }
    const prev = { '/wt/a': { ...fakePRStatus(7), headSha: 'sha-1', hasConflict: true } }
    const { byPath } = reconcileUnknownMergeable(prev, next, trees)
    expect(next['/wt/a']?.hasConflict).toBeNull()
    expect(byPath['/wt/a']?.hasConflict).toBe(true)
  })
})

describe('PRPoller — UNKNOWN mergeability (bounded recheck)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.mocked(getRepoContext).mockResolvedValue({
      origin: { owner: 'o', repo: 'r' },
      upstream: { owner: 'o', repo: 'r' }
    })
    vi.mocked(getBranchSha).mockResolvedValue(null)
    vi.mocked(listWorktrees).mockResolvedValue([wt('/wt/a', 'a', 'sha-a')])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('re-queries by number and applies a definitive answer', async () => {
    const { store, poller } = makePoller({})
    vi.mocked(fetchPRStatusesForRepo).mockResolvedValue(
      new Map<string, PRStatus | null>([['/wt/a', unknownMergeable(7, 'sha-1')]])
    )
    vi.mocked(fetchPRStatusByNumber).mockResolvedValue({
      ...fakePRStatus(7),
      headSha: 'sha-1',
      hasConflict: true
    })

    await poller.refreshAll()
    expect(store.getSnapshot().state.prs.byPath['/wt/a']?.hasConflict).toBeNull()

    await vi.advanceTimersByTimeAsync(2000)

    expect(vi.mocked(fetchPRStatusByNumber)).toHaveBeenCalledWith(
      expect.any(Object),
      7,
      '/wt/a',
      'a'
    )
    expect(store.getSnapshot().state.prs.byPath['/wt/a']?.hasConflict).toBe(true)
  })

  it('patches only hasConflict, preserving fields the by-number fetch does not compute', async () => {
    const { store, poller } = makePoller({})
    vi.mocked(fetchPRStatusesForRepo).mockResolvedValue(
      new Map<string, PRStatus | null>([
        ['/wt/a', { ...unknownMergeable(7, 'sha-1'), behindBy: 12 }]
      ])
    )
    // fetchPRStatusByNumber passes behindBy: null — a wholesale replace
    // would blank the "N commits behind" indicator.
    vi.mocked(fetchPRStatusByNumber).mockResolvedValue({
      ...fakePRStatus(7),
      headSha: 'sha-1',
      hasConflict: true,
      behindBy: undefined
    })

    await poller.refreshAll()
    await vi.advanceTimersByTimeAsync(2000)

    const status = store.getSnapshot().state.prs.byPath['/wt/a']
    expect(status?.hasConflict).toBe(true)
    expect(status?.behindBy).toBe(12)
  })

  it('leaves the sticky value alone when the recheck is still UNKNOWN', async () => {
    const { store, poller } = makePoller({
      '/wt/a': { ...fakePRStatus(7), headSha: 'sha-1', hasConflict: true }
    })
    vi.mocked(fetchPRStatusesForRepo).mockResolvedValue(
      new Map<string, PRStatus | null>([['/wt/a', unknownMergeable(7, 'sha-1')]])
    )
    vi.mocked(fetchPRStatusByNumber).mockResolvedValue(unknownMergeable(7, 'sha-1'))

    await poller.refreshAll()
    await vi.advanceTimersByTimeAsync(2000)

    expect(store.getSnapshot().state.prs.byPath['/wt/a']?.hasConflict).toBe(true)
  })

  it('discards a recheck result whose head SHA moved on while it was in flight', async () => {
    const { store, poller } = makePoller({})
    vi.mocked(fetchPRStatusesForRepo).mockResolvedValue(
      new Map<string, PRStatus | null>([['/wt/a', unknownMergeable(7, 'sha-new')]])
    )
    vi.mocked(fetchPRStatusByNumber).mockResolvedValue({
      ...fakePRStatus(7),
      headSha: 'sha-stale',
      hasConflict: true
    })

    await poller.refreshAll()
    await vi.advanceTimersByTimeAsync(2000)

    expect(store.getSnapshot().state.prs.byPath['/wt/a']?.hasConflict).toBeNull()
  })

  it('runs exactly one recheck round — no retry loop', async () => {
    const { poller } = makePoller({})
    vi.mocked(fetchPRStatusesForRepo).mockResolvedValue(
      new Map<string, PRStatus | null>([['/wt/a', unknownMergeable(7, 'sha-1')]])
    )
    vi.mocked(fetchPRStatusByNumber).mockResolvedValue(unknownMergeable(7, 'sha-1'))

    await poller.refreshAll()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(vi.mocked(fetchPRStatusByNumber)).toHaveBeenCalledTimes(1)
  })

  it('stop() cancels a pending recheck', async () => {
    const { poller } = makePoller({})
    vi.mocked(fetchPRStatusesForRepo).mockResolvedValue(
      new Map<string, PRStatus | null>([['/wt/a', unknownMergeable(7, 'sha-1')]])
    )

    await poller.refreshAll()
    poller.stop()
    await vi.advanceTimersByTimeAsync(2000)

    expect(vi.mocked(fetchPRStatusByNumber)).not.toHaveBeenCalled()
  })
})

describe('PRPoller.refreshAll — branch independence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getRepoContext).mockResolvedValue({
      origin: { owner: 'o', repo: 'r' },
      upstream: { owner: 'o', repo: 'r' }
    })
  })

  it('updates mergedByPath even when the GraphQL branch throws', async () => {
    // Setup: worktree /wt/m has a persisted merge SHA; the GraphQL call
    // for the repo throws (simulating a 504). Merged-SHA branch should
    // still dispatch its result.
    const state: AppState = { ...initialState }
    const store = new Store(state)
    const poller = new PRPoller(store, {
      getRepoRoots: () => ['/repo'],
      getLocallyMerged: () => ({ m: 'sha-recorded' }),
      setLocallyMerged: () => {}
    })

    vi.mocked(listWorktrees).mockResolvedValue([wt('/wt/m', 'm', 'sha-recorded')])
    vi.mocked(fetchPRStatusesForRepo).mockRejectedValue(new Error('504 Gateway Timeout'))
    vi.mocked(getBranchSha).mockResolvedValue('sha-recorded')

    await poller.refreshAll()

    expect(store.getSnapshot().state.prs.mergedByPath['/wt/m']).toBe(true)
  })

  it('updates bulkStatusChanged even when the merged-SHA branch throws', async () => {
    const state: AppState = { ...initialState }
    const store = new Store(state)
    const poller = new PRPoller(store, {
      getRepoRoots: () => ['/repo'],
      getLocallyMerged: () => {
        throw new Error('locallyMerged read blew up')
      },
      setLocallyMerged: () => {}
    })

    vi.mocked(listWorktrees).mockResolvedValue([wt('/wt/a', 'a', 'sha-a')])
    vi.mocked(fetchPRStatusesForRepo).mockResolvedValue(
      new Map<string, PRStatus | null>([['/wt/a', fakePRStatus(7)]])
    )

    await poller.refreshAll()

    expect(store.getSnapshot().state.prs.byPath['/wt/a']?.number).toBe(7)
  })
})

describe('PRPoller.refreshAll — merge landing during an in-flight refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getRepoContext).mockResolvedValue({
      origin: { owner: 'o', repo: 'r' },
      upstream: { owner: 'o', repo: 'r' }
    })
    vi.mocked(fetchPRStatusesForRepo).mockResolvedValue(new Map())
  })

  it('reruns instead of dropping a call that arrives mid-pass, and keeps a SHA recorded mid-pass', async () => {
    // /wt/x has a stale record (will be pruned); /wt/m is merged while the
    // first pass is awaiting its rev-parse round.
    let locallyMerged: Record<string, string> = { x: 'old-sha' }
    const store = new Store({ ...initialState })
    const poller = new PRPoller(store, {
      getRepoRoots: () => ['/repo'],
      getLocallyMerged: () => locallyMerged,
      setLocallyMerged: (next) => {
        locallyMerged = next
      }
    })
    vi.mocked(listWorktrees).mockResolvedValue([wt('/wt/x', 'x', 'new-sha'), wt('/wt/m', 'm', 'm-sha')])

    let releaseFirst!: () => void
    const firstRound = new Promise<void>((r) => {
      releaseFirst = r
    })
    let calls = 0
    vi.mocked(getBranchSha).mockImplementation(async (_root, branch) => {
      calls++
      if (calls === 1) await firstRound
      return branch === 'x' ? 'new-sha' : 'm-sha'
    })

    const first = poller.refreshAll()
    await vi.waitFor(() => expect(calls).toBe(1))

    // The merge handler records the SHA and asks for a refresh while the
    // first pass is still in flight.
    locallyMerged = { ...locallyMerged, m: 'm-sha' }
    await poller.refreshAll()

    releaseFirst()
    await first
    await vi.waitFor(() => expect(store.getSnapshot().state.prs.mergedByPath['/wt/m']).toBe(true))
    expect(locallyMerged).toEqual({ m: 'm-sha' })
  })
})
