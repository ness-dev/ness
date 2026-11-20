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
    pinnedPaths: {},
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

describe('pinned rows', () => {
  it('routes a pinned worktree into the pinned group instead of its status group', () => {
    const model = buildWorktreeListModel(
      input({
        worktrees: [wt({ path: '/w/a' }), wt({ path: '/w/b' })],
        prStatuses: { '/w/a': pr({ number: 1, checksOverall: 'failure' }) },
        pinnedPaths: { '/w/a': true }
      })
    )
    expect(findGroup(model, 0, 'pinned')?.rows.map((r) => r.path)).toEqual(['/w/a'])
    expect(findGroup(model, 0, 'needs-attention')).toBeUndefined()
    expect(findGroup(model, 0, 'no-pr')?.rows.map((r) => r.path)).toEqual(['/w/b'])
  })

  it('marks isPinned on the row model', () => {
    const model = buildWorktreeListModel(
      input({
        worktrees: [wt({ path: '/w/a' }), wt({ path: '/w/b' })],
        pinnedPaths: { '/w/a': true }
      })
    )
    const pinnedRow = findGroup(model, 0, 'pinned')!.rows[0]
    const plainRow = findGroup(model, 0, 'no-pr')!.rows[0]
    expect(pinnedRow.isPinned).toBe(true)
    expect(plainRow.isPinned).toBe(false)
  })

  it('orders the pinned group first', () => {
    const model = buildWorktreeListModel(
      input({
        worktrees: [wt({ path: '/w/a' }), wt({ path: '/w/b' })],
        pinnedPaths: { '/w/b': true }
      })
    )
    expect(model.sections[0].groups[0].key).toBe('pinned')
  })

  it('hides a snoozed pinned worktree in snoozed but keeps it pinned', () => {
    const model = buildWorktreeListModel(
      input({
        worktrees: [wt({ path: '/w/a' })],
        snoozeByPath: { '/w/a': { path: '/w/a', snoozedAt: 1, wakeAt: 999 } },
        pinnedPaths: { '/w/a': true }
      })
    )
    expect(findGroup(model, 0, 'pinned')).toBeUndefined()
    const row = findGroup(model, 0, 'snoozed')!.rows[0]
    expect(row.isSnoozed).toBe(true)
    expect(row.isPinned).toBe(true)
  })
})

describe('cross-host section merging (folder-name fallback, resolved with no origin)', () => {
  // Fleet view shows the same repo open on several hosts as ONE section.
  // Identity is repoKeyFor: the normalized origin URL when a root has one,
  // folder name when a root has RESOLVED to no origin (null). These cases
  // pass explicit nulls to exercise the fallback; a missing entry means
  // "not resolved yet" and never merges — see the last test. The merge is gated on backend ownership: it must never
  // fire for two same-named checkouts on one host, and never fire at all
  // when the caller supplies no ownership info (single-backend callers
  // keep historical behavior).
  const localRoot = '/Users/mike/dev/ness'
  const remoteRoot = '/home/mike/code/ness'

  it('merges same-named repos hosted on different backends into one section', () => {
    const model = buildWorktreeListModel(
      input({
        repoRoots: [localRoot, remoteRoot],
        repoBackendId: { [localRoot]: 'local', [remoteRoot]: 'beta' },
        repoRemotes: { [localRoot]: null, [remoteRoot]: null },
        worktrees: [
          wt({ path: '/w/local-main', repoRoot: localRoot }),
          wt({ path: '/w/remote-main', repoRoot: remoteRoot })
        ]
      })
    )
    expect(model.sections).toHaveLength(1)
    const section = model.sections[0]
    expect(section.repoName).toBe('ness')
    expect(section.repoRoots).toEqual([
      { backendId: 'local', repoRoot: localRoot },
      { backendId: 'beta', repoRoot: remoteRoot }
    ])
    const paths = section.groups.flatMap((g) => g.rows.map((r) => r.path))
    expect(paths).toContain('/w/local-main')
    expect(paths).toContain('/w/remote-main')
  })

  it('prefers the local backend root as the section primary', () => {
    // Remote listed FIRST: the primary must still be local's checkout,
    // since it's the default for new-worktree and open-in-editor.
    const model = buildWorktreeListModel(
      input({
        repoRoots: [remoteRoot, localRoot],
        repoBackendId: { [localRoot]: 'local', [remoteRoot]: 'beta' },
        repoRemotes: { [localRoot]: null, [remoteRoot]: null },
        worktrees: [wt({ path: '/w/a', repoRoot: remoteRoot })]
      })
    )
    expect(model.sections[0].repoRoot).toBe(localRoot)
  })

  it('never merges two same-named checkouts on the same host', () => {
    // /a/api and /b/api on one machine are two different repos that
    // happen to share a folder name.
    const model = buildWorktreeListModel(
      input({
        repoRoots: ['/a/api', '/b/api'],
        repoBackendId: { '/a/api': 'local', '/b/api': 'local' },
        repoRemotes: { '/a/api': null, '/b/api': null },
        worktrees: []
      })
    )
    expect(model.sections).toHaveLength(2)
    expect(model.sections.map((s) => s.repoRoot)).toEqual(['/a/api', '/b/api'])
  })

  it('does not merge without backend ownership info', () => {
    // Callers that predate multi-backend pass no repoBackendId; their
    // behavior must be bit-identical to before the merge existed.
    const model = buildWorktreeListModel(
      input({ repoRoots: ['/a/api', '/b/api'], worktrees: [] })
    )
    expect(model.sections).toHaveLength(2)
    expect(model.sections.map((s) => s.scope)).toEqual(['/a/api', '/b/api'])
  })

  it('matches repo keys case-insensitively', () => {
    const model = buildWorktreeListModel(
      input({
        repoRoots: ['/x/Ness', '/y/ness'],
        repoBackendId: { '/x/Ness': 'local', '/y/ness': 'beta' },
        repoRemotes: { '/x/Ness': null, '/y/ness': null },
        worktrees: []
      })
    )
    expect(model.sections).toHaveLength(1)
  })

  it('keys collapse state on the shared scope, not either root', () => {
    // Collapsing a merged section must survive which host's root came
    // first, so the scope is the repo key rather than a path.
    const model = buildWorktreeListModel(
      input({
        repoRoots: [localRoot, remoteRoot],
        repoBackendId: { [localRoot]: 'local', [remoteRoot]: 'beta' },
        repoRemotes: { [localRoot]: null, [remoteRoot]: null },
        worktrees: [wt({ path: '/w/a', repoRoot: localRoot })],
        collapsedRepos: { 'repo:folder:ness': true }
      })
    )
    expect(model.sections[0].scope).toBe('repo:folder:ness')
    expect(model.sections[0].collapsed).toBe(true)
  })

  it('pools pending creations and assigned PRs from every member root', () => {
    const model = buildWorktreeListModel(
      input({
        repoRoots: [localRoot, remoteRoot],
        repoBackendId: { [localRoot]: 'local', [remoteRoot]: 'beta' },
        repoRemotes: { [localRoot]: null, [remoteRoot]: null },
        worktrees: [],
        pendingWorktrees: [
          { id: 'p1', repoRoot: localRoot, branchName: 'x', status: 'creating' },
          { id: 'p2', repoRoot: remoteRoot, branchName: 'y', status: 'creating' },
          { id: 'p3', repoRoot: '/elsewhere/other', branchName: 'z', status: 'creating' }
        ] as WorktreeListModelInput['pendingWorktrees'],
        assignedPRsByRepo: {
          [localRoot]: [assigned({ number: 1, repoRoot: localRoot })],
          [remoteRoot]: [assigned({ number: 2, repoRoot: remoteRoot })]
        }
      })
    )
    const section = model.sections.find((s) => s.repoName === 'ness')!
    expect(section.pending.map((p) => p.id).sort()).toEqual(['p1', 'p2'])
    const reviewing = section.groups.find((g) => g.key === 'reviewing')
    expect(reviewing?.phantomPRs.map((p) => p.number).sort()).toEqual([1, 2])
  })
})

describe('cross-host section merging by remote URL', () => {
  const owners = (a: string, b: string) => ({ [a]: 'local', [b]: 'beta' })

  it('merges differently-named folders that share an origin', () => {
    // The fork-vs-rename case folder matching could never handle:
    // claude-harness locally, harness on the server, one upstream.
    const model = buildWorktreeListModel(
      input({
        repoRoots: ['/l/claude-harness', '/r/harness'],
        repoBackendId: owners('/l/claude-harness', '/r/harness'),
        repoRemotes: {
          '/l/claude-harness': 'github.com/ness-dev/ness',
          '/r/harness': 'github.com/ness-dev/ness'
        },
        worktrees: []
      })
    )
    expect(model.sections).toHaveLength(1)
    expect(model.sections[0].scope).toBe('repo:remote:github.com/ness-dev/ness')
  })

  it('keeps same-named folders with different origins apart', () => {
    // Two unrelated `api` repos — the wrong-merge the folder key allowed.
    const model = buildWorktreeListModel(
      input({
        repoRoots: ['/l/api', '/r/api'],
        repoBackendId: owners('/l/api', '/r/api'),
        repoRemotes: { '/l/api': 'github.com/acme/api', '/r/api': 'github.com/other/api' },
        worktrees: []
      })
    )
    expect(model.sections).toHaveLength(2)
  })

  it('keeps a fork and its upstream apart', () => {
    const model = buildWorktreeListModel(
      input({
        repoRoots: ['/l/ness', '/r/ness'],
        repoBackendId: owners('/l/ness', '/r/ness'),
        repoRemotes: { '/l/ness': 'github.com/you/ness', '/r/ness': 'github.com/ness-dev/ness' },
        worktrees: []
      })
    )
    expect(model.sections).toHaveLength(2)
  })

  it('does not merge a remote-bearing root with a remote-less one of the same name', () => {
    // Different namespaces (remote: vs folder:) by construction.
    const model = buildWorktreeListModel(
      input({
        repoRoots: ['/l/ness', '/r/ness'],
        repoBackendId: owners('/l/ness', '/r/ness'),
        repoRemotes: { '/l/ness': 'github.com/ness-dev/ness', '/r/ness': null },
        worktrees: []
      })
    )
    expect(model.sections).toHaveLength(2)
  })
})

describe('cross-host section merging with unresolved remotes', () => {
  it('never merges a root whose remote has not resolved yet', () => {
    // No entry at all (undefined) — the window between repoRoots landing
    // and the async origin lookup finishing, or an older harness-server
    // that never sends repoRemotes. Same folder name on two hosts, but
    // merging on a guess would bounce sections (and collapse state) on
    // first paint and silently join unrelated repos. Not merging is the
    // safe direction; null (resolved, no origin) is what opts into the
    // folder fallback.
    const localRoot = '/Users/mike/dev/ness'
    const remoteRoot = '/home/mike/code/ness'
    const model = buildWorktreeListModel(
      input({
        repoRoots: [localRoot, remoteRoot],
        repoBackendId: { [localRoot]: 'local', [remoteRoot]: 'beta' },
        repoRemotes: {},
        worktrees: []
      })
    )
    expect(model.sections).toHaveLength(2)
    expect(model.sections.map((s) => s.scope)).toEqual([localRoot, remoteRoot])
  })

  it('merges once both sides resolve to null, but not while one is pending', () => {
    const a = '/l/ness'
    const b = '/r/ness'
    const pendingOne = buildWorktreeListModel(
      input({
        repoRoots: [a, b],
        repoBackendId: { [a]: 'local', [b]: 'beta' },
        repoRemotes: { [a]: null },
        worktrees: []
      })
    )
    expect(pendingOne.sections).toHaveLength(2)
    const bothResolved = buildWorktreeListModel(
      input({
        repoRoots: [a, b],
        repoBackendId: { [a]: 'local', [b]: 'beta' },
        repoRemotes: { [a]: null, [b]: null },
        worktrees: []
      })
    )
    expect(bothResolved.sections).toHaveLength(1)
  })
})

describe('homes', () => {
  const main = (repoRoot = '/repos/alpha', branch = 'main') =>
    wt({ path: repoRoot, repoRoot, isMain: true, branch })

  it('pulls the main worktree out of the groups into the section home', () => {
    const model = buildWorktreeListModel(input({ worktrees: [main(), wt({ path: '/w/a' })] }))
    const section = model.sections[0]
    expect(section.homes.map((r) => r.path)).toEqual(['/repos/alpha'])
    expect(section.workGroups.flatMap((g) => g.rows.map((r) => r.path))).toEqual(['/w/a'])
    // Overview surfaces still see main in the full grouping.
    expect(section.groups.flatMap((g) => g.rows.map((r) => r.path))).toContain('/repos/alpha')
  })

  it('pulls a pinned main out of the pinned group and drops the emptied group', () => {
    const model = buildWorktreeListModel(
      input({ worktrees: [main(), wt({ path: '/w/a' })], pinnedPaths: { '/repos/alpha': true } })
    )
    expect(model.sections[0].homes).toHaveLength(1)
    expect(model.sections[0].workGroups.map((g) => g.key)).toEqual(['no-pr'])
  })

  it('summarises the repo’s live worktrees, ignoring archived ones', () => {
    const model = buildWorktreeListModel(
      input({
        worktrees: [main(), wt({ path: '/w/a' }), wt({ path: '/w/b' }), wt({ path: '/w/c' }), wt({ path: '/w/s' })],
        tabsByWorktree: { '/w/a': [tab('ta')], '/w/b': [tab('tb')], '/w/c': [tab('tc')] },
        statuses: { ta: 'processing', tb: 'needs-approval', tc: 'idle' },
        snoozeByPath: { '/w/s': { path: '/w/s', snoozedAt: 0, wakeAt: Date.now() + 1000 } }
      })
    )
    expect(model.sections[0].homes[0].home).toEqual({
      showBranch: false,
      agents: 3,
      byStatus: { processing: 1, 'needs-approval': 1, waiting: 0, idle: 1 }
    })
  })

  it('shows the branch only when main is off a base branch', () => {
    const onMain = buildWorktreeListModel(input({ worktrees: [main()] }))
    expect(onMain.sections[0].homes[0].home!.showBranch).toBe(false)
    const offMain = buildWorktreeListModel(input({ worktrees: [main('/repos/alpha', 'hotfix')] }))
    expect(offMain.sections[0].homes[0].home!.showBranch).toBe(true)
    const prBase = buildWorktreeListModel(
      input({
        worktrees: [main('/repos/alpha', 'release'), wt({ path: '/w/a' })],
        prStatuses: { '/w/a': pr({ number: 1, baseBranch: 'release' }) }
      })
    )
    expect(prBase.sections[0].homes[0].home!.showBranch).toBe(false)
  })

  it('scopes PR base branches to their own repo', () => {
    const model = buildWorktreeListModel(
      input({
        repoRoots: ['/repos/alpha', '/repos/beta'],
        worktrees: [
          main('/repos/alpha', 'release'),
          main('/repos/beta', 'release'),
          wt({ path: '/w/a', repoRoot: '/repos/alpha' })
        ],
        prStatuses: { '/w/a': pr({ number: 1, baseBranch: 'release' }) }
      })
    )
    expect(model.sections.map((s) => s.homes[0].home!.showBranch)).toEqual([false, true])
  })

  it('stacks every repo’s home in repo order in unified mode, each counting only its repo', () => {
    const model = buildWorktreeListModel(
      input({
        repoRoots: ['/repos/alpha', '/repos/beta'],
        unifiedRepos: true,
        worktrees: [
          main('/repos/beta'),
          main('/repos/alpha'),
          wt({ path: '/w/b', repoRoot: '/repos/beta' })
        ]
      })
    )
    const homes = model.sections[0].homes
    expect(homes.map((r) => r.path)).toEqual(['/repos/alpha', '/repos/beta'])
    expect(homes.map((r) => r.home!.agents)).toEqual([0, 1])
    expect(homes.map((r) => r.repoLabel)).toEqual(['alpha', 'beta'])
  })
})

describe('archive tail', () => {
  it('folds snoozed and merged into one tail, collapsed when both are', () => {
    const model = buildWorktreeListModel(
      input({
        worktrees: [wt({ path: '/w/a' }), wt({ path: '/w/m' }), wt({ path: '/w/s' })],
        mergedPaths: { '/w/m': true },
        snoozeByPath: { '/w/s': { path: '/w/s', snoozedAt: 0, wakeAt: Date.now() + 1000 } },
        isGroupCollapsed: (_scope, key) => key === 'merged' || key === 'snoozed'
      })
    )
    const { tail, workGroups } = model.sections[0]
    expect(workGroups.map((g) => g.key)).toEqual(['no-pr'])
    expect(tail!.groups.map((g) => g.key)).toEqual(['snoozed', 'merged'])
    expect(tail!.count).toBe(2)
    expect(tail!.collapsed).toBe(true)
  })

  it('counts as expanded when any tail group is open', () => {
    const model = buildWorktreeListModel(
      input({
        worktrees: [wt({ path: '/w/m' }), wt({ path: '/w/s' })],
        mergedPaths: { '/w/m': true },
        snoozeByPath: { '/w/s': { path: '/w/s', snoozedAt: 0, wakeAt: Date.now() + 1000 } },
        isGroupCollapsed: (_scope, key) => key === 'merged'
      })
    )
    expect(model.sections[0].tail!.collapsed).toBe(false)
    expect(model.visiblePaths).toEqual(['/w/s', '/w/m'])
  })

  it('is null when there is nothing archived', () => {
    const model = buildWorktreeListModel(input({ worktrees: [wt({ path: '/w/a' })] }))
    expect(model.sections[0].tail).toBeNull()
  })
})

describe('display order', () => {
  it('puts homes first in ordinals, ordered paths and visible paths', () => {
    const model = buildWorktreeListModel(
      input({
        worktrees: [
          wt({ path: '/w/a', createdAt: 3 }),
          wt({ path: '/repos/alpha', isMain: true, branch: 'main', createdAt: 1 }),
          wt({ path: '/w/m' })
        ],
        mergedPaths: { '/w/m': true },
        isGroupCollapsed: (_scope, key) => key === 'merged'
      })
    )
    expect(model.sections[0].homes[0].cmdOrdinal).toBe(1)
    expect(model.orderedPaths).toEqual(['/repos/alpha', '/w/a', '/w/m'])
    expect(model.visiblePaths).toEqual(['/repos/alpha', '/w/a'])
  })

  it('keeps a collapsed repo’s home visible — it is the project row', () => {
    const model = buildWorktreeListModel(
      input({
        worktrees: [wt({ path: '/repos/alpha', isMain: true, branch: 'main' })],
        collapsedRepos: { '/repos/alpha': true }
      })
    )
    expect(model.visiblePaths).toEqual(['/repos/alpha'])
    expect(model.orderedPaths).toEqual(['/repos/alpha'])
  })
})

describe('project homes across hosts', () => {
  const localRoot = '/Users/mike/dev/ness'
  const remoteRoot = '/home/mike/code/ness'
  // Remote listed first in the user's repo order, so the primary-first
  // ordering can't pass by accident.
  const twoHosts = (overrides: Partial<WorktreeListModelInput> = {}) =>
    buildWorktreeListModel(
      input({
        repoRoots: [remoteRoot, localRoot],
        repoBackendId: { [localRoot]: 'local', [remoteRoot]: 'beta' },
        repoRemotes: { [localRoot]: null, [remoteRoot]: null },
        worktrees: [
          wt({ path: remoteRoot, repoRoot: remoteRoot, isMain: true, branch: 'main' }),
          wt({ path: localRoot, repoRoot: localRoot, isMain: true, branch: 'main' }),
          wt({ path: '/w/feature', repoRoot: localRoot })
        ],
        ...overrides
      })
    )

  it('puts the primary (local) host’s main first as the project row', () => {
    const model = twoHosts()
    expect(model.sections[0].homes.map((h) => h.path)).toEqual([localRoot, remoteRoot])
    expect(model.projectRowPaths).toEqual([localRoot])
    expect(model.visiblePaths).toEqual([localRoot, remoteRoot, '/w/feature'])
  })

  it('hides other hosts’ mains when the section is collapsed, keeping only the project row', () => {
    const model = twoHosts({ collapsedRepos: { 'repo:folder:ness': true } })
    expect(model.sections[0].collapsed).toBe(true)
    expect(model.visiblePaths).toEqual([localRoot])
    expect(model.sections[0].homes[0].cmdOrdinal).toBe(1)
    expect(model.sections[0].homes[1].cmdOrdinal).toBeUndefined()
    expect(model.orderedPaths).toEqual([localRoot, remoteRoot, '/w/feature'])
  })

  it('treats every home as a project row in unified mode', () => {
    const model = buildWorktreeListModel(
      input({
        repoRoots: ['/repos/alpha', '/repos/beta'],
        unifiedRepos: true,
        worktrees: [
          wt({ path: '/repos/alpha', repoRoot: '/repos/alpha', isMain: true, branch: 'main' }),
          wt({ path: '/repos/beta', repoRoot: '/repos/beta', isMain: true, branch: 'main' })
        ]
      })
    )
    expect(model.projectRowPaths).toEqual(['/repos/alpha', '/repos/beta'])
  })
})
