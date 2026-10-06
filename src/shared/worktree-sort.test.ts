import { describe, it, expect } from 'vitest'
import { groupWorktrees, getGroupKey, GROUP_ORDER } from './worktree-sort'
import type { Worktree } from './state/worktrees'
import type { PRStatus } from './state/prs'

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

function wt(path: string, overrides: Partial<Worktree> = {}): Worktree {
  return stubWorktree({
    path,
    branch: path.split('/').pop() ?? path,
    createdAt: 1,
    repoRoot: '/repo',
    ...overrides
  })
}

function stubPRStatus(overrides: Partial<PRStatus> = {}): PRStatus {
  return {
    number: 1,
    title: 'PR',
    state: 'open',
    url: 'https://github.com/o/r/pull/1',
    branch: 'pr-1',
    author: null,
    checks: [],
    checksOverall: 'success',
    hasConflict: false,
    reviews: [],
    reviewDecision: 'none',
    baseBranch: 'main',
    isDefaultBase: true,
    assignees: [],
    linkedIssues: [],
    labels: [],
    ...overrides
  }
}

const mergedPR: PRStatus = stubPRStatus({ state: 'merged' })

describe('getGroupKey', () => {
  it('routes by PR state', () => {
    const w = stubWorktree()
    expect(getGroupKey(w, stubPRStatus({ checksOverall: 'failure' }))).toBe('needs-attention')
    expect(getGroupKey(w, stubPRStatus({ hasConflict: true }))).toBe('needs-attention')
    expect(getGroupKey(w, stubPRStatus({ reviewDecision: 'changes_requested' }))).toBe('needs-attention')
    expect(getGroupKey(w, stubPRStatus())).toBe('active')
    expect(getGroupKey(w, stubPRStatus({ state: 'merged' }))).toBe('merged')
    expect(getGroupKey(w, stubPRStatus({ state: 'closed' }))).toBe('merged')
  })

  it('falls back to no-pr when there is no PR status', () => {
    expect(getGroupKey(stubWorktree(), null)).toBe('no-pr')
    expect(getGroupKey(stubWorktree(), undefined)).toBe('no-pr')
  })

  it('locallyMerged trumps everything', () => {
    expect(getGroupKey(stubWorktree(), stubPRStatus(), true)).toBe('merged')
    expect(getGroupKey(stubWorktree(), null, true)).toBe('merged')
  })

  it('a previously-known open PR that transitions to merged moves to "merged" not "no-pr"', () => {
    const w = stubWorktree()
    // Simulate the open → merged transition: same PR identity, terminal state.
    expect(getGroupKey(w, stubPRStatus({ state: 'open' }))).toBe('active')
    expect(getGroupKey(w, stubPRStatus({ state: 'merged' }))).toBe('merged')
    // If the PR is closed without merging, same group.
    expect(getGroupKey(w, stubPRStatus({ state: 'closed' }))).toBe('merged')
  })
})

describe('GROUP_ORDER', () => {
  it('places pinned first, reviewing between needs-attention and active, and snoozed above merged', () => {
    expect(GROUP_ORDER).toEqual(['pinned', 'needs-attention', 'reviewing', 'active', 'no-pr', 'snoozed', 'merged'])
  })
})

describe('Reviewing grouping by PR author', () => {
  it('routes a PR you did not author into reviewing', () => {
    const pr = stubPRStatus({ author: { login: 'someone-else', avatarUrl: '' } })
    expect(getGroupKey(stubWorktree(), pr, false, false, 'me')).toBe('reviewing')
  })

  it('keeps your own PR in active', () => {
    const pr = stubPRStatus({ author: { login: 'me', avatarUrl: '' } })
    expect(getGroupKey(stubWorktree(), pr, false, false, 'me')).toBe('active')
  })

  it('falls back when viewerLogin is unknown — treats it as your own PR', () => {
    const pr = stubPRStatus({ author: { login: 'someone-else', avatarUrl: '' } })
    expect(getGroupKey(stubWorktree(), pr, false, false, null)).toBe('active')
    expect(getGroupKey(stubWorktree(), pr, false, false)).toBe('active')
  })

  it('falls back when the PR has no author', () => {
    const pr = stubPRStatus({ author: null })
    expect(getGroupKey(stubWorktree(), pr, false, false, 'me')).toBe('active')
  })

  it('does NOT mark merged review PRs as reviewing — they move to merged', () => {
    const pr = stubPRStatus({
      state: 'merged',
      author: { login: 'someone-else', avatarUrl: '' }
    })
    expect(getGroupKey(stubWorktree(), pr, false, false, 'me')).toBe('merged')
  })

  it('takes precedence over needs-attention signals (those are your problem to fix, not theirs)', () => {
    const pr = stubPRStatus({
      checksOverall: 'failure',
      author: { login: 'someone-else', avatarUrl: '' }
    })
    expect(getGroupKey(stubWorktree(), pr, false, false, 'me')).toBe('reviewing')
  })
})

describe('worktree-sort snoozed group', () => {
  it('puts a snoozed path in the snoozed group regardless of PR state', () => {
    const a = wt('/a')
    const b = wt('/b')
    const groups = groupWorktrees(
      [a, b],
      { '/a': mergedPR, '/b': null },
      { '/a': true },
      { '/a': true, '/b': true }
    )

    const snoozed = groups.find((g) => g.key === 'snoozed')
    expect(snoozed?.worktrees.map((w) => w.path).sort()).toEqual(['/a', '/b'])
    // /a is NOT also in merged
    expect(groups.find((g) => g.key === 'merged')).toBeUndefined()
  })

  it('snoozed group sorts above merged', () => {
    const a = wt('/a')
    const b = wt('/b')
    const groups = groupWorktrees(
      [a, b],
      { '/a': null, '/b': mergedPR },
      {},
      { '/a': true }
    )
    const keys = groups.map((g) => g.key)
    expect(keys.indexOf('snoozed')).toBeLessThan(keys.indexOf('merged'))
  })

  it('non-snoozed worktrees still group as before', () => {
    const a = wt('/a')
    const groups = groupWorktrees([a], { '/a': null }, {}, {})
    expect(groups.map((g) => g.key)).toEqual(['no-pr'])
  })

  it('getGroupKey returns snoozed when isSnoozed regardless of merged', () => {
    expect(getGroupKey(wt('/a'), mergedPR, true, true)).toBe('snoozed')
  })

  it('pinned trumps snoozed', () => {
    expect(getGroupKey(wt('/a'), mergedPR, true, true, null, true)).toBe('pinned')
  })

  it('no-pr group lists merge-point worktrees (PR bases) above feature worktrees', () => {
    const main = stubWorktree({ path: '/main', branch: 'main', isMain: true, createdAt: 100 })
    const develop = stubWorktree({ path: '/develop', branch: 'develop', createdAt: 50 })
    const feature = stubWorktree({ path: '/feat', branch: 'feature/x', createdAt: 200 })
    const featureWithPR = stubWorktree({ path: '/other', branch: 'feature/y', createdAt: 300 })
    // Active PR targets develop — so develop counts as a base branch.
    const groups = groupWorktrees(
      [feature, develop, main, featureWithPR],
      {
        '/main': null,
        '/develop': null,
        '/feat': null,
        '/other': stubPRStatus({ branch: 'feature/y', baseBranch: 'develop' })
      },
      {},
      {}
    )
    const noPR = groups.find((g) => g.key === 'no-pr')!
    // main pinned to top, then develop (a base branch), then features by createdAt desc.
    expect(noPR.worktrees.map((w) => w.path)).toEqual(['/main', '/develop', '/feat'])
  })
})

describe('worktree-sort pinned group', () => {
  it('puts a pinned path in the pinned group regardless of PR state', () => {
    const groups = groupWorktrees(
      [wt('/a'), wt('/b')],
      { '/a': stubPRStatus({ checksOverall: 'failure' }), '/b': null },
      {},
      {},
      null,
      undefined,
      { '/a': true, '/b': true }
    )
    const pinned = groups.find((g) => g.key === 'pinned')
    expect(pinned?.worktrees.map((w) => w.path).sort()).toEqual(['/a', '/b'])
    // Pinned worktrees appear ONLY in the pinned section.
    expect(groups.map((g) => g.key)).toEqual(['pinned'])
  })

  it('pinned group sorts above needs-attention', () => {
    const groups = groupWorktrees(
      [wt('/a'), wt('/b')],
      { '/a': null, '/b': stubPRStatus({ checksOverall: 'failure' }) },
      {},
      {},
      null,
      undefined,
      { '/a': true }
    )
    const keys = groups.map((g) => g.key)
    expect(keys.indexOf('pinned')).toBeLessThan(keys.indexOf('needs-attention'))
  })

  it('pinned wins over merged, snoozed, and reviewing', () => {
    const groups = groupWorktrees(
      [wt('/merged'), wt('/snoozed'), wt('/review')],
      {
        '/merged': mergedPR,
        '/snoozed': null,
        '/review': stubPRStatus({ author: { login: 'someone-else', avatarUrl: '' } })
      },
      { '/merged': true },
      { '/snoozed': true },
      'me',
      undefined,
      { '/merged': true, '/snoozed': true, '/review': true }
    )
    expect(groups.map((g) => g.key)).toEqual(['pinned'])
    expect(groups[0].worktrees).toHaveLength(3)
  })

  it('labels the group "Pinned"', () => {
    const groups = groupWorktrees([wt('/a')], { '/a': null }, {}, {}, null, undefined, { '/a': true })
    expect(groups[0].label).toBe('Pinned')
  })

  it('sorts the pinned group main-first then createdAt desc', () => {
    const main = stubWorktree({ path: '/main', branch: 'main', isMain: true, createdAt: 1 })
    const old = stubWorktree({ path: '/old', branch: 'old', createdAt: 50 })
    const recent = stubWorktree({ path: '/recent', branch: 'recent', createdAt: 500 })
    const groups = groupWorktrees(
      [old, recent, main],
      { '/main': null, '/old': null, '/recent': null },
      {},
      {},
      null,
      undefined,
      { '/main': true, '/old': true, '/recent': true }
    )
    expect(groups[0].worktrees.map((w) => w.path)).toEqual(['/main', '/recent', '/old'])
  })

  it('omits the pinned group when nothing is pinned', () => {
    const groups = groupWorktrees([wt('/a')], { '/a': null }, {}, {}, null, undefined, {})
    expect(groups.map((g) => g.key)).toEqual(['no-pr'])
  })

  it('treats an omitted pinnedPaths argument as nothing pinned', () => {
    const groups = groupWorktrees([wt('/a')], { '/a': null }, {}, {})
    expect(groups.map((g) => g.key)).toEqual(['no-pr'])
  })
})
