import { describe, it, expect } from 'vitest'
import {
  defaultSelectedRepoRoots,
  formatAge,
  isTempPath,
  partitionRepos,
  summarizeWork,
  type DiscoveredRepo
} from './work-discovery'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

function repo(over: Partial<DiscoveredRepo>): DiscoveredRepo {
  return {
    repoRoot: '/Users/me/code/app',
    name: 'app',
    worktrees: [],
    sessionCount: 0,
    liveCount: 0,
    lastActiveAt: NOW,
    isTemp: false,
    alreadyAdded: false,
    ...over
  }
}

describe('work-discovery selection rules', () => {
  it('recognises temp directories under either spelling', () => {
    expect(isTempPath('/tmp/demo')).toBe(true)
    expect(isTempPath('/private/tmp/demo')).toBe(true)
    expect(isTempPath('/private/var/folders/5c/x/T/repo')).toBe(true)
    expect(isTempPath('/Users/me/tmp/repo')).toBe(false)
  })

  it('pre-checks only recent, non-temp repos', () => {
    const repos = [
      repo({ repoRoot: '/a', lastActiveAt: NOW - 2 * DAY }),
      repo({ repoRoot: '/b', lastActiveAt: NOW - 20 * DAY }),
      repo({ repoRoot: '/tmp/c', lastActiveAt: NOW, isTemp: true })
    ]
    expect(defaultSelectedRepoRoots(repos, NOW)).toEqual(['/a'])
  })

  it('keeps month-old repos visible but tucks away stale and temp ones', () => {
    const repos = [
      repo({ repoRoot: '/a', lastActiveAt: NOW - 20 * DAY }),
      repo({ repoRoot: '/b', lastActiveAt: NOW - 45 * DAY }),
      repo({ repoRoot: '/tmp/c', isTemp: true })
    ]
    const { primary, rest } = partitionRepos(repos, NOW)
    expect(primary.map((r) => r.repoRoot)).toEqual(['/a'])
    expect(rest.map((r) => r.repoRoot)).toEqual(['/b', '/tmp/c'])
  })

  it('totals worktrees, conversations and live sessions', () => {
    const wt = { path: '/a', branch: 'main', isMain: true, sessionCount: 0, lastActiveAt: null }
    const summary = summarizeWork([
      repo({ worktrees: [wt, wt], sessionCount: 5, liveCount: 1 }),
      repo({ worktrees: [wt], sessionCount: 2, liveCount: 0 })
    ])
    expect(summary).toEqual({ repos: 2, worktrees: 3, conversations: 7, live: 1 })
  })

  it('formats ages in the units a person would say', () => {
    expect(formatAge(NOW - 20_000, NOW)).toBe('just now')
    expect(formatAge(NOW - 5 * 60_000, NOW)).toBe('5m ago')
    expect(formatAge(NOW - 3 * 60 * 60_000, NOW)).toBe('3h ago')
    expect(formatAge(NOW - DAY, NOW)).toBe('yesterday')
    expect(formatAge(NOW - 15 * DAY, NOW)).toBe('15 days ago')
    expect(formatAge(NOW - 70 * DAY, NOW)).toBe('2 months ago')
  })
})
