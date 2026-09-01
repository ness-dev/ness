import { describe, it, expect } from 'vitest'
import type { Worktree, PRStatus, TerminalTab, PendingTool } from './types'
import type { AssignedPR } from '../shared/state/assigned-prs'
import {
  buildWorktreeListModel,
  UNIFIED_REPO_ROOT,
  type WorktreeListModelInput
} from './worktree-list-model'

function wt(overrides: Partial<Worktree> & { path: string }): Worktree {
  return {
    branch: overrides.path.split('/').pop()!,
    head: 'abc123',
    isBare: false,
    isMain: false,
    createdAt: 1000,
    repoRoot: '/repos/alpha',
    ...overrides
  }
}

function pr(overrides: Partial<PRStatus> & { number: number }): PRStatus {
  return {
    title: 'PR',
    state: 'open',
    url: '',
    branch: 'b',
    author: { login: 'me', avatarUrl: '' },
    checks: [],
    checksOverall: 'none',
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

function assigned(overrides: Partial<AssignedPR> & { number: number }): AssignedPR {
  return {
    title: 'Review me',
    url: '',
    branch: 'their-branch',
    repoRoot: '/repos/alpha',
    repoNameWithOwner: 'org/alpha',
    author: { login: 'someone-else' },
    isDraft: false,
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides
  }
}

function tab(id: string, type: TerminalTab['type'] = 'agent'): TerminalTab {
  return { id, type, label: id } as TerminalTab
}

function input(overrides: Partial<WorktreeListModelInput> = {}): WorktreeListModelInput {
  return {
    worktrees: [],
    repoRoots: ['/repos/alpha'],
    pendingWorktrees: [],
    pendingDeletions: [],
    tabsByWorktree: {},
    statuses: {},
    pendingTools: {},
    shellActivity: {},
    prStatuses: {},
    mergedPaths: {},
    snoozeByPath: {},
    aliases: {},
    viewerLogin: null,
    unifiedRepos: false,
    collapsedRepos: {},
    isGroupCollapsed: () => false,
    ...overrides
  }
}

function findGroup(
  model: ReturnType<typeof buildWorktreeListModel>,
  sectionIdx: number,
  key: string
) {
  return model.sections[sectionIdx].groups.find((g) => g.key === key)
}

describe('status aggregation', () => {
  it('takes the worst status across a worktree tabs', () => {
    const model = buildWorktreeListModel(
      input({
        worktrees: [wt({ path: '/w/a' })],
        tabsByWorktree: { '/w/a': [tab('t1'), tab('t2'), tab('t3')] },
        statuses: { t1: 'idle', t2: 'processing', t3: 'waiting' }
      })
    )
    expect(model.statusByPath['/w/a']).toBe('waiting')
  })

  it('needs-approval wins and carries that tab pending tool', () => {
    const pendingTool: PendingTool = { name: 'Bash', input: {} } as PendingTool
    const model = buildWorktreeListModel(
      input({
        worktrees: [wt({ path: '/w/a' })],
        tabsByWorktree: { '/w/a': [tab('t1'), tab('t2')] },
        statuses: { t1: 'waiting', t2: 'needs-approval' },
        pendingTools: { t2: pendingTool }
      })
    )
    expect(model.statusByPath['/w/a']).toBe('needs-approval')
    expect(model.pendingToolByPath['/w/a']).toBe(pendingTool)
    expect(model.sections[0].groups[0].rows[0].pendingTool).toBe(pendingTool)
  })

  it('reports shell activity only for shell tabs', () => {
    const model = buildWorktreeListModel(
      input({
        worktrees: [wt({ path: '/w/a' }), wt({ path: '/w/b' })],
        tabsByWorktree: {
          '/w/a': [tab('agent1', 'agent')],
          '/w/b': [tab('sh1', 'shell')]
        },
        shellActivity: { agent1: { active: true }, sh1: { active: true } }
      })
    )
    expect(model.shellActiveByPath['/w/a']).toBe(false)
    expect(model.shellActiveByPath['/w/b']).toBe(true)
  })

  it('marks rows in the merged group with the merged display status', () => {
    const model = buildWorktreeListModel(
      input({
        worktrees: [wt({ path: '/w/a' })],
        prStatuses: { '/w/a': pr({ number: 1, state: 'merged' }) }
      })
    )
    const row = findGroup(model, 0, 'merged')!.rows[0]
    expect(row.isMerged).toBe(true)
    expect(row.displayStatus).toBe('merged')
    expect(row.status).toBe('idle')
  })
})

// The bug this refactor exists to kill: the touch picker called
// groupWorktrees without assignedPRs and never rendered phantomPRs, so
// review requests without a worktree were invisible on mobile.
describe('phantom reviewing PRs', () => {
  it('injects assigned PRs into the reviewing group', () => {
    const model = buildWorktreeListModel(
      input({
        worktrees: [],
        assignedPRsByRepo: { '/repos/alpha': [assigned({ number: 7 })] }
      })
    )
    const reviewing = findGroup(model, 0, 'reviewing')!
    expect(reviewing.rows).toHaveLength(0)
    expect(reviewing.phantomPRs.map((p) => p.number)).toEqual([7])
    expect(reviewing.count).toBe(1)
  })

  it('dedups a phantom against an existing worktree for the same PR', () => {
    const model = buildWorktreeListModel(
      input({
        worktrees: [wt({ path: '/w/a' })],
        viewerLogin: 'me',
        prStatuses: {
          '/w/a': pr({ number: 7, author: { login: 'someone-else', avatarUrl: '' } })
        },
        assignedPRsByRepo: {
          '/repos/alpha': [assigned({ number: 7 }), assigned({ number: 9 })]
        }
      })
    )
    const reviewing = findGroup(model, 0, 'reviewing')!
    expect(reviewing.rows.map((r) => r.path)).toEqual(['/w/a'])
    expect(reviewing.phantomPRs.map((p) => p.number)).toEqual([9])
    expect(reviewing.count).toBe(2)
  })

  it('keeps a reviewing group alive that has only phantoms', () => {
    const model = buildWorktreeListModel(
      input({ assignedPRsByRepo: { '/repos/alpha': [assigned({ number: 7 })] } })
    )
    expect(model.sections[0].groups.map((g) => g.key)).toEqual(['reviewing'])
  })

  it('buckets phantoms per repo in split mode', () => {
    const model = buildWorktreeListModel(
      input({
        repoRoots: ['/repos/alpha', '/repos/beta'],
        unifiedRepos: false,
        assignedPRsByRepo: {
          '/repos/alpha': [assigned({ number: 1 })],
          '/repos/beta': [assigned({ number: 2, repoRoot: '/repos/beta' })]
        }
      })
    )
    expect(findGroup(model, 0, 'reviewing')!.phantomPRs.map((p) => p.number)).toEqual([1])
    expect(findGroup(model, 1, 'reviewing')!.phantomPRs.map((p) => p.number)).toEqual([2])
  })

  it('flattens phantoms from every repo in unified mode', () => {
    const model = buildWorktreeListModel(
      input({
        repoRoots: ['/repos/alpha', '/repos/beta'],
        unifiedRepos: true,
        assignedPRsByRepo: {
          '/repos/alpha': [assigned({ number: 1 })],
          '/repos/beta': [assigned({ number: 2, repoRoot: '/repos/beta' })]
        }
      })
    )
    expect(model.sections).toHaveLength(1)
    expect(findGroup(model, 0, 'reviewing')!.phantomPRs.map((p) => p.number).sort()).toEqual([1, 2])
  })
})

describe('repo sectioning', () => {
  it('splits worktrees per repo and shows headers when there are several', () => {
    const model = buildWorktreeListModel(
      input({
        repoRoots: ['/repos/alpha', '/repos/beta'],
        worktrees: [
          wt({ path: '/w/a', repoRoot: '/repos/alpha' }),
          wt({ path: '/w/b', repoRoot: '/repos/beta' })
        ],
        unifiedRepos: false
      })
    )
    expect(model.sections.map((s) => s.repoRoot)).toEqual(['/repos/alpha', '/repos/beta'])
    expect(model.sections.map((s) => s.repoName)).toEqual(['alpha', 'beta'])
    expect(model.showRepoHeaders).toBe(true)
    expect(model.showRepoLabels).toBe(false)
    expect(model.sections[0].groups[0].rows[0].repoLabel).toBeUndefined()
  })

  it('collapses into one synthetic section with per-row repo labels in unified mode', () => {
    const model = buildWorktreeListModel(
      input({
        repoRoots: ['/repos/alpha', '/repos/beta'],
        worktrees: [
          wt({ path: '/w/a', repoRoot: '/repos/alpha' }),
          wt({ path: '/w/b', repoRoot: '/repos/beta' })
        ],
        unifiedRepos: true
      })
    )
    expect(model.sections).toHaveLength(1)
    expect(model.sections[0].repoRoot).toBe(UNIFIED_REPO_ROOT)
    expect(model.sections[0].unified).toBe(true)
    expect(model.showRepoHeaders).toBe(false)
    expect(model.showRepoLabels).toBe(true)
    const labels = model.sections[0].groups[0].rows.map((r) => r.repoLabel).sort()
    expect(labels).toEqual(['alpha', 'beta'])
  })

  it('stays split when unifiedRepos is on but there is only one repo', () => {
    const model = buildWorktreeListModel(
      input({ worktrees: [wt({ path: '/w/a' })], unifiedRepos: true })
    )
    expect(model.sections[0].repoRoot).toBe('/repos/alpha')
    expect(model.showRepoHeaders).toBe(false)
    expect(model.showRepoLabels).toBe(false)
  })

  it('routes pending worktrees to their repo section', () => {
    const model = buildWorktreeListModel(
      input({
        repoRoots: ['/repos/alpha', '/repos/beta'],
        unifiedRepos: false,
        pendingWorktrees: [
          { id: 'p1', repoRoot: '/repos/beta', branchName: 'x', status: 'creating' } as never
        ]
      })
    )
    expect(model.sections[0].pending).toHaveLength(0)
    expect(model.sections[1].pending).toHaveLength(1)
  })
})

describe('cmd ordinals', () => {
  it('numbers visible rows in display order', () => {
    const model = buildWorktreeListModel(
      input({
        worktrees: [
          wt({ path: '/w/a', createdAt: 3 }),
          wt({ path: '/w/b', createdAt: 2 }),
          wt({ path: '/w/c', createdAt: 1 })
        ]
      })
    )
    expect(model.sections[0].groups[0].rows.map((r) => r.cmdOrdinal)).toEqual([1, 2, 3])
  })

  it('skips rows inside collapsed groups', () => {
    const model = buildWorktreeListModel(
      input({
        worktrees: [wt({ path: '/w/a' }), wt({ path: '/w/m' })],
        prStatuses: { '/w/m': pr({ number: 1, state: 'merged' }) },
        isGroupCollapsed: (_scope, key) => key === 'merged'
      })
    )
    expect(findGroup(model, 0, 'merged')!.rows[0].cmdOrdinal).toBeUndefined()
    expect(findGroup(model, 0, 'no-pr')!.rows[0].cmdOrdinal).toBe(1)
  })

  it('skips rows inside collapsed repos', () => {
    const model = buildWorktreeListModel(
      input({
        repoRoots: ['/repos/alpha', '/repos/beta'],
        unifiedRepos: false,
        worktrees: [
          wt({ path: '/w/a', repoRoot: '/repos/alpha' }),
          wt({ path: '/w/b', repoRoot: '/repos/beta' })
        ],
        collapsedRepos: { '/repos/alpha': true }
      })
    )
    expect(model.sections[0].groups[0].rows[0].cmdOrdinal).toBeUndefined()
    expect(model.sections[1].groups[0].rows[0].cmdOrdinal).toBe(1)
  })

  it('stops after nine', () => {
    const worktrees = Array.from({ length: 12 }, (_, i) =>
      wt({ path: `/w/${i}`, createdAt: 100 - i })
    )
    const model = buildWorktreeListModel(input({ worktrees }))
    const ordinals = model.sections[0].groups[0].rows.map((r) => r.cmdOrdinal)
    expect(ordinals.slice(0, 9)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(ordinals.slice(9)).toEqual([undefined, undefined, undefined])
  })

  it('assigns none when ordinals are disabled (touch surfaces)', () => {
    const model = buildWorktreeListModel(
      input({ worktrees: [wt({ path: '/w/a' })], assignOrdinals: false })
    )
    expect(model.sections[0].groups[0].rows[0].cmdOrdinal).toBeUndefined()
  })
})

describe('per-row decoration', () => {
  it('carries alias, snooze, and deleting state onto the row', () => {
    const model = buildWorktreeListModel(
      input({
        worktrees: [wt({ path: '/w/a' })],
        aliases: { '/w/a': 'Alpha Work' },
        snoozeByPath: { '/w/a': { path: '/w/a', snoozedAt: 1, wakeAt: 999 } },
        pendingDeletions: [{ path: '/w/a' } as never]
      })
    )
    const row = findGroup(model, 0, 'snoozed')!.rows[0]
    expect(row.alias).toBe('Alpha Work')
    expect(row.isSnoozed).toBe(true)
    expect(row.snoozeWakeAt).toBe(999)
    expect(row.deleting).toBe(true)
    expect(model.snoozedPaths).toEqual({ '/w/a': true })
  })

  it('reports group counts including phantoms', () => {
    const model = buildWorktreeListModel(
      input({
        worktrees: [wt({ path: '/w/a' })],
        viewerLogin: 'me',
        prStatuses: { '/w/a': pr({ number: 1, author: { login: 'other', avatarUrl: '' } }) },
        assignedPRsByRepo: { '/repos/alpha': [assigned({ number: 5 })] }
      })
    )
    const reviewing = findGroup(model, 0, 'reviewing')!
    expect(reviewing.count).toBe(2)
    expect(model.sections[0].count).toBe(2)
  })
})

describe('project sort', () => {
  const threeRepos = {
    repoRoots: ['/repos/zulu', '/repos/alpha', '/repos/mike'],
    worktrees: [
      wt({ path: '/w/z', repoRoot: '/repos/zulu' }),
      wt({ path: '/w/a', repoRoot: '/repos/alpha' }),
      wt({ path: '/w/m', repoRoot: '/repos/mike' })
    ],
    unifiedRepos: false
  }

  it('keeps repoRoots order in manual mode', () => {
    const model = buildWorktreeListModel(input({ ...threeRepos, projectSort: 'manual' }))
    expect(model.sections.map((s) => s.repoName)).toEqual(['zulu', 'alpha', 'mike'])
  })

  it('defaults to manual when no mode is supplied', () => {
    const model = buildWorktreeListModel(input(threeRepos))
    expect(model.sections.map((s) => s.repoName)).toEqual(['zulu', 'alpha', 'mike'])
  })

  it('sorts by repo name in alphabetical mode', () => {
    const model = buildWorktreeListModel(input({ ...threeRepos, projectSort: 'alphabetical' }))
    expect(model.sections.map((s) => s.repoName)).toEqual(['alpha', 'mike', 'zulu'])
  })

  it('sorts newest-human-input first, using the newest worktree in each repo', () => {
    const model = buildWorktreeListModel(
      input({
        ...threeRepos,
        worktrees: [...threeRepos.worktrees, wt({ path: '/w/z2', repoRoot: '/repos/zulu' })],
        projectSort: 'recent-human',
        lastHumanActive: { '/w/a': 100, '/w/m': 300, '/w/z': 50, '/w/z2': 500 }
      })
    )
    expect(model.sections.map((s) => s.repoName)).toEqual(['zulu', 'mike', 'alpha'])
  })

  it('reads a different map for agent recency than for human recency', () => {
    const model = buildWorktreeListModel(
      input({
        ...threeRepos,
        projectSort: 'recent-agent',
        lastHumanActive: { '/w/z': 999 },
        lastAgentActive: { '/w/a': 200, '/w/m': 100 }
      })
    )
    expect(model.sections.map((s) => s.repoName)).toEqual(['alpha', 'mike', 'zulu'])
  })

  it('sorts repos with no activity to the bottom, alphabetically among themselves', () => {
    const model = buildWorktreeListModel(
      input({
        ...threeRepos,
        projectSort: 'recent-human',
        lastHumanActive: { '/w/m': 100 }
      })
    )
    expect(model.sections.map((s) => s.repoName)).toEqual(['mike', 'alpha', 'zulu'])
  })

  it('leaves the single unified section alone', () => {
    const model = buildWorktreeListModel(
      input({ ...threeRepos, unifiedRepos: true, projectSort: 'alphabetical' })
    )
    expect(model.sections.map((s) => s.repoRoot)).toEqual([UNIFIED_REPO_ROOT])
  })

  it('assigns Cmd ordinals in sorted display order', () => {
    const model = buildWorktreeListModel(input({ ...threeRepos, projectSort: 'alphabetical' }))
    const firstRows = model.sections.map((s) => s.groups[0].rows[0])
    expect(firstRows.map((r) => r.path)).toEqual(['/w/a', '/w/m', '/w/z'])
    expect(firstRows.map((r) => r.cmdOrdinal)).toEqual([1, 2, 3])
  })
})
