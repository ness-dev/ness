import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    setPath: () => {},
    isPackaged: false
  }
}))

import { buildInitialAppState } from './build-initial-state'
import type { Config } from './persistence'
import { initialPRs } from '../shared/state/prs'
import { initialOnboarding } from '../shared/state/onboarding'
import { initialHooks } from '../shared/state/hooks'
import { initialWorktrees } from '../shared/state/worktrees'
import { initialTerminals } from '../shared/state/terminals'
import { initialUpdater } from '../shared/state/updater'
import { initialRepoConfigs } from '../shared/state/repo-configs'
import { initialSettings } from '../shared/state/settings'
import { initialScratchpad } from '../shared/state/scratchpad'
import { initialConfigHealth } from '../shared/state/config-health'
import { initialReviews } from '../shared/state/reviews'

// The bug we're guarding against: a slice's `initial<Slice>` constant gains
// a new field but the main-process Store seed in index.ts forgets to include
// it, so the renderer gets `undefined` on first snapshot and crashes.
//
// `buildInitialAppState` now spreads each `initial<Slice>` so TypeScript
// catches required-field drift at compile time, but optional fields would
// still slip through. These tests assert that every key present in the
// initial constant is also present in the seeded state — which catches
// optional-field drift at runtime.

const emptyConfig: Config = {
  windowBounds: null,
  repoRoots: []
}

describe('buildInitialAppState', () => {
  const seeded = buildInitialAppState(emptyConfig, { hasGithubToken: false })

  const slices = {
    prs: initialPRs,
    onboarding: initialOnboarding,
    hooks: initialHooks,
    worktrees: initialWorktrees,
    terminals: initialTerminals,
    updater: initialUpdater,
    repoConfigs: initialRepoConfigs,
    settings: initialSettings,
    scratchpad: initialScratchpad,
    configHealth: initialConfigHealth,
    reviews: initialReviews
  } as const

  for (const [name, initial] of Object.entries(slices)) {
    it(`seeds every key from initial${name[0].toUpperCase() + name.slice(1)}`, () => {
      const slice = seeded[name as keyof typeof slices] as unknown as Record<string, unknown>
      for (const key of Object.keys(initial)) {
        expect(slice, `${name}.${key} missing from seed`).toHaveProperty(key)
      }
    })
  }

  it('applies config overrides to settings', () => {
    const result = buildInitialAppState(
      {
        ...emptyConfig,
        themeMode: 'dark',
        themeDark: 'dracula',
        themeLight: 'solarized-light',
        repoRoots: ['/a', '/b']
      },
      { hasGithubToken: true }
    )
    expect(result.settings.themeMode).toBe('dark')
    expect(result.settings.themeDark).toBe('dracula')
    expect(result.settings.themeLight).toBe('solarized-light')
    expect(result.settings.hasGithubToken).toBe(true)
    expect(result.worktrees.repoRoots).toEqual(['/a', '/b'])
  })

  it('keeps review requests and history fields, dropping malformed ones', () => {
    const author = { kind: 'agent', tabId: 't1', label: 'Chat' }
    const anchor = { commitSha: 'a', line: 1, snippet: 'x' }
    const result = buildInitialAppState(
      {
        ...emptyConfig,
        reviews: {
          '/wt': {
            comments: [
              { id: 'c1', filePath: 'a.ts', line: 1, anchor, status: 'resolved', resolvedBy: author, resolvedAt: 5 },
              { id: 'c2', filePath: 'a.ts', line: 1, anchor, status: 'open', resolvedBy: author, resolvedAt: 5 },
              { id: 'c3', filePath: 'a.ts', line: 1, anchor, status: 'resolved', resolvedBy: { kind: 'robot' }, resolvedAt: 6 }
            ],
            submissions: [
              { id: 's1', summary: '', commentIds: [], state: 'sent', verdict: 'approve', headSha: 7, briefing: { md: 'x' } },
              { id: 's2', summary: '', commentIds: [], state: 'sent', verdict: 'approve', briefing: '## What it does' }
            ],
            requests: [
              { id: 'r1', requester: author, reviewer: author, context: 'c', source: 'agent', reused: false, createdAt: 1 },
              { id: 'r2', requester: { kind: 'robot' }, reviewer: author, context: 'c', source: 'agent', createdAt: 1 }
            ]
          }
        }
      } as unknown as Config,
      { hasGithubToken: false }
    )
    const wt = result.reviews.byPath['/wt']
    expect(wt.comments[0]).toMatchObject({ resolvedBy: author, resolvedAt: 5 })
    expect(wt.comments[1]).not.toHaveProperty('resolvedBy')
    expect(wt.comments[1]).not.toHaveProperty('resolvedAt')
    expect(wt.comments[2]).not.toHaveProperty('resolvedBy')
    expect(wt.comments[2].resolvedAt).toBe(6)
    expect(wt.submissions?.[0]).not.toHaveProperty('headSha')
    expect(wt.submissions?.[0]).not.toHaveProperty('briefing')
    expect(wt.submissions?.[1].briefing).toBe('## What it does')
    expect(wt.requests?.map((r) => r.id)).toEqual(['r1'])
  })
})
