import { describe, it, expect } from 'vitest'
import {
  migrations,
  runMigrations,
  SCHEMA_VERSION,
  type AnyConfig,
  type PersistedPane,
  type PersistedPaneNode,
  type PersistedTab
} from './persistence-migrations'

// Convenience: run only the v{from}→v{from+1} migration in isolation.
function runOne(from: number, config: AnyConfig): AnyConfig {
  migrations[from](config)
  return config
}

function tab(id: string, type: 'agent' | 'shell' = 'shell', agentKind?: 'claude' | 'codex'): PersistedTab {
  return { id, type, label: id, agentKind: type === 'agent' ? (agentKind ?? 'claude') : undefined }
}

/** Create a legacy tab with type 'claude' (pre-v4 format) for migration tests. */
function legacyTab(id: string, type: 'claude' | 'shell' = 'shell'): Record<string, unknown> {
  return { id, type, label: id }
}

function pane(id: string, tabs: PersistedTab[], activeTabId?: string): PersistedPane {
  return { id, tabs, activeTabId: activeTabId ?? tabs[0]?.id ?? '' }
}

describe('SCHEMA_VERSION invariant', () => {
  it('matches migrations.length', () => {
    expect(SCHEMA_VERSION).toBe(migrations.length)
  })

  it('is at least 3 — historical migrations are never removed', () => {
    // If this fails, someone deleted or reordered an existing migration.
    // Migrations are append-only; if one is broken, write a new one that
    // fixes it forward rather than editing the old one.
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(3)
  })
})

describe('v0 → v1: repoRoot → repoRoots', () => {
  it('promotes single repoRoot string to repoRoots array', () => {
    const c: AnyConfig = { repoRoot: '/Users/mike/repo' }
    runOne(0, c)
    expect(c.repoRoots).toEqual(['/Users/mike/repo'])
    expect(c.repoRoot).toBeUndefined()
  })

  it('drops a stale repoRoot field when repoRoots already exists', () => {
    const c: AnyConfig = {
      repoRoot: '/old/path',
      repoRoots: ['/new/path']
    }
    runOne(0, c)
    expect(c.repoRoots).toEqual(['/new/path'])
    expect(c.repoRoot).toBeUndefined()
  })

  it('is a no-op when neither field is present', () => {
    const c: AnyConfig = { theme: 'dark' }
    runOne(0, c)
    expect(c).toEqual({ theme: 'dark' })
  })

  it('does not touch unrelated keys', () => {
    const c: AnyConfig = {
      repoRoot: '/a',
      theme: 'dark',
      windowBounds: { x: 1, y: 2, width: 100, height: 200 }
    }
    runOne(0, c)
    expect(c.theme).toBe('dark')
    expect(c.windowBounds).toEqual({ x: 1, y: 2, width: 100, height: 200 })
  })
})

describe('v1 → v2: terminalTabs → flat panes', () => {
  it('wraps each worktree tab list in a single pane', () => {
    const c: AnyConfig = {
      terminalTabs: {
        '/wt/a': [tab('t1'), tab('t2')],
        '/wt/b': [legacyTab('t3', 'claude')]
      },
      activeTabId: { '/wt/a': 't2' }
    }
    runOne(1, c)
    const panes = c.panes as Record<string, PersistedPane[]>
    expect(Object.keys(panes).sort()).toEqual(['/wt/a', '/wt/b'])
    expect(panes['/wt/a'].length).toBe(1)
    expect(panes['/wt/a'][0].tabs.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(panes['/wt/a'][0].activeTabId).toBe('t2')
    expect(panes['/wt/b'][0].activeTabId).toBe('t3') // fell back to first tab
  })

  it('drops worktrees with zero tabs', () => {
    const c: AnyConfig = {
      terminalTabs: {
        '/wt/empty': [],
        '/wt/full': [tab('t1')]
      }
    }
    runOne(1, c)
    const panes = c.panes as Record<string, PersistedPane[]>
    expect(panes['/wt/empty']).toBeUndefined()
    expect(panes['/wt/full']).toBeDefined()
  })

  it('leaves the legacy terminalTabs field in place for downgrade safety', () => {
    const c: AnyConfig = {
      terminalTabs: { '/wt/a': [tab('t1')] }
    }
    runOne(1, c)
    expect(c.terminalTabs).toBeDefined()
  })

  it('is a no-op when panes already exist', () => {
    const existing = { '/wt/a': [pane('p1', [tab('t1')])] }
    const c: AnyConfig = {
      terminalTabs: { '/wt/b': [tab('t2')] },
      panes: existing
    }
    runOne(1, c)
    expect(c.panes).toBe(existing)
  })

  it('handles missing activeTabId map', () => {
    const c: AnyConfig = {
      terminalTabs: { '/wt/a': [tab('t1'), tab('t2')] }
    }
    runOne(1, c)
    const panes = c.panes as Record<string, PersistedPane[]>
    expect(panes['/wt/a'][0].activeTabId).toBe('t1') // first tab
  })
})

describe('v2 → v3: flat panes → nested by repoRoot', () => {
  const repoRoot = '/Users/mike/projects/harness'
  const worktreeSibling = '/Users/mike/projects/harness-worktrees'

  function makeFlatConfig(): AnyConfig {
    return {
      repoRoots: [repoRoot],
      panes: {
        [repoRoot]: [pane('p1', [tab('main-t1')])],
        [`${worktreeSibling}/feature-a`]: [pane('p2', [tab('a-t1')])],
        [`${worktreeSibling}/feature-b`]: [pane('p3', [tab('b-t1')])]
      }
    }
  }

  it('nests worktrees under their owning repoRoot', () => {
    const c = makeFlatConfig()
    runOne(2, c)
    const nested = c.panes as Record<string, Record<string, PersistedPane[]>>
    expect(Object.keys(nested).sort()).toEqual([repoRoot])
    expect(Object.keys(nested[repoRoot]).sort()).toEqual([
      repoRoot,
      `${worktreeSibling}/feature-a`,
      `${worktreeSibling}/feature-b`
    ])
  })

  it('groups multiple repos independently', () => {
    const c: AnyConfig = {
      repoRoots: ['/a/repo1', '/a/repo2'],
      panes: {
        '/a/repo1': [pane('p1', [tab('t1')])],
        '/a/repo1-worktrees/x': [pane('p2', [tab('t2')])],
        '/a/repo2': [pane('p3', [tab('t3')])],
        '/a/repo2-worktrees/y': [pane('p4', [tab('t4')])]
      }
    }
    runOne(2, c)
    const nested = c.panes as Record<string, Record<string, PersistedPane[]>>
    expect(Object.keys(nested['/a/repo1']).sort()).toEqual([
      '/a/repo1',
      '/a/repo1-worktrees/x'
    ])
    expect(Object.keys(nested['/a/repo2']).sort()).toEqual([
      '/a/repo2',
      '/a/repo2-worktrees/y'
    ])
  })

  it('parks unmatched worktrees in __orphan__', () => {
    const c: AnyConfig = {
      repoRoots: ['/Users/mike/projects/harness'],
      panes: {
        '/totally/unrelated/path': [pane('p1', [tab('t1')])]
      }
    }
    runOne(2, c)
    const nested = c.panes as Record<string, Record<string, PersistedPane[]>>
    expect(nested['__orphan__']).toBeDefined()
    expect(nested['__orphan__']['/totally/unrelated/path']).toBeDefined()
  })

  it('does not create __orphan__ when every entry matches', () => {
    const c = makeFlatConfig()
    runOne(2, c)
    const nested = c.panes as Record<string, Record<string, PersistedPane[]>>
    expect(nested['__orphan__']).toBeUndefined()
  })

  it('preserves the flat shape in legacyPanes for downgrade safety', () => {
    const c = makeFlatConfig()
    const flatBefore = JSON.parse(JSON.stringify(c.panes))
    runOne(2, c)
    expect(c.legacyPanes).toEqual(flatBefore)
  })

  it('is a no-op when panes is already nested', () => {
    const nested = {
      '/a/repo1': {
        '/a/repo1-worktrees/x': [pane('p1', [tab('t1')])]
      }
    }
    const c: AnyConfig = { repoRoots: ['/a/repo1'], panes: nested }
    runOne(2, c)
    expect(c.panes).toBe(nested)
    expect(c.legacyPanes).toBeUndefined()
  })

  it('is a no-op when panes is empty', () => {
    const c: AnyConfig = { repoRoots: ['/a/repo1'], panes: {} }
    runOne(2, c)
    expect(c.panes).toEqual({})
    expect(c.legacyPanes).toBeUndefined()
  })

  it('does not misattribute a path that prefix-matches the wrong repo', () => {
    // /a/repo1 is a prefix of /a/repo1-something, but the worktree path should
    // only be considered owned if it's exactly the repoRoot or lives under
    // the <basename>-worktrees sibling.
    const c: AnyConfig = {
      repoRoots: ['/a/repo1'],
      panes: {
        '/a/repo1-something-else/x': [pane('p1', [tab('t1')])]
      }
    }
    runOne(2, c)
    const nested = c.panes as Record<string, Record<string, PersistedPane[]>>
    expect(nested['/a/repo1']).toBeUndefined()
    expect(nested['__orphan__']['/a/repo1-something-else/x']).toBeDefined()
  })
})

describe('v3 → v4: tab type claude → agent + agentKind', () => {
  it('migrates claude tabs to agent with agentKind: claude', () => {
    const c: AnyConfig = {
      panes: {
        '/a/repo1': {
          '/a/repo1': [pane('p1', [legacyTab('t1', 'claude') as unknown as PersistedTab, tab('t2', 'shell')])]
        }
      }
    }
    runOne(3, c)
    const nested = c.panes as Record<string, Record<string, PersistedPane[]>>
    const tabs = nested['/a/repo1']['/a/repo1'][0].tabs
    expect(tabs[0].type).toBe('agent')
    expect((tabs[0] as unknown as Record<string, unknown>).agentKind).toBe('claude')
    expect(tabs[1].type).toBe('shell')
    expect((tabs[1] as unknown as Record<string, unknown>).agentKind).toBeUndefined()
  })

  it('is a no-op on already-migrated tabs', () => {
    const c: AnyConfig = {
      panes: {
        '/a/repo1': {
          '/a/repo1': [pane('p1', [tab('t1', 'agent', 'claude')])]
        }
      }
    }
    const before = JSON.parse(JSON.stringify(c))
    runOne(3, c)
    expect(c).toEqual(before)
  })
})

describe('runMigrations (end-to-end)', () => {
  it('runs every migration on a pristine v0 config', () => {
    const c: AnyConfig = {
      repoRoot: '/Users/mike/projects/harness',
      terminalTabs: {
        '/Users/mike/projects/harness': [legacyTab('main-t1', 'claude')],
        '/Users/mike/projects/harness-worktrees/feature': [
          legacyTab('wt-t1', 'claude'),
          legacyTab('wt-t2', 'shell')
        ]
      },
      activeTabId: {
        '/Users/mike/projects/harness-worktrees/feature': 'wt-t2'
      }
    }
    runMigrations(c)

    expect(c.schemaVersion).toBe(SCHEMA_VERSION)
    expect(c.repoRoot).toBeUndefined()
    expect(c.repoRoots).toEqual(['/Users/mike/projects/harness'])

    const nested = c.panes as Record<string, Record<string, PersistedPaneNode>>
    expect(Object.keys(nested)).toEqual(['/Users/mike/projects/harness'])
    const repo = nested['/Users/mike/projects/harness']
    expect(Object.keys(repo).sort()).toEqual([
      '/Users/mike/projects/harness',
      '/Users/mike/projects/harness-worktrees/feature'
    ])
    const featureTree = repo['/Users/mike/projects/harness-worktrees/feature'] as PersistedPaneNode
    expect(featureTree.type).toBe('leaf')
    expect(nested['__orphan__']).toBeUndefined()
  })

  it('stamps schemaVersion on an empty config', () => {
    const c: AnyConfig = {}
    runMigrations(c)
    expect(c.schemaVersion).toBe(SCHEMA_VERSION)
  })

  it('is idempotent — running twice leaves the config stable', () => {
    const c: AnyConfig = {
      repoRoot: '/a/repo1',
      terminalTabs: { '/a/repo1': [tab('t1')] }
    }
    runMigrations(c)
    const first = JSON.parse(JSON.stringify(c))
    runMigrations(c)
    // schemaVersion is already current, so no migration function runs again.
    // (Individual migrations aren't guaranteed idempotent on partial state,
    // but runMigrations gates them by schemaVersion.)
    expect(c).toEqual(first)
  })

  it('skips earlier migrations when schemaVersion is set', () => {
    // A user already at v2 should only run v2→v3, not the earlier ones.
    const c: AnyConfig = {
      schemaVersion: 2,
      // Intentionally keep a field that the v0→v1 migration would strip,
      // to prove it is not re-run.
      repoRoot: '/should/stay/because/v0/did/not/rerun',
      repoRoots: ['/a/repo1'],
      panes: {
        '/a/repo1': [pane('p1', [tab('t1')])]
      }
    }
    runMigrations(c)
    expect(c.repoRoot).toBe('/should/stay/because/v0/did/not/rerun')
    // v2→v3 nested by repo, v4→v5 converted to tree
    const nested = c.panes as Record<string, Record<string, PersistedPaneNode>>
    expect(nested['/a/repo1']).toBeDefined()
    expect(Array.isArray(nested['/a/repo1'])).toBe(false)
  })

  it('is a no-op on a fully up-to-date config', () => {
    const c: AnyConfig = {
      schemaVersion: SCHEMA_VERSION,
      repoRoots: ['/a/repo1'],
      panes: {
        '/a/repo1': {
          '/a/repo1': { type: 'leaf', id: 'p1', tabs: [tab('t1')], activeTabId: 't1' }
        }
      }
    }
    const snapshot = JSON.parse(JSON.stringify(c))
    runMigrations(c)
    expect(c).toEqual(snapshot)
  })

  it('preserves unrelated config keys across the whole chain', () => {
    const c: AnyConfig = {
      repoRoot: '/a/repo1',
      claudeCommand: 'claude --verbose',
      terminalFontSize: 15,
      onboarding: { quest: 'finale' }
    }
    runMigrations(c)
    expect(c.claudeCommand).toBe('claude --verbose')
    expect(c.terminalFontSize).toBe(15)
    expect(c.onboarding).toEqual({ quest: 'finale' })
  })
})

describe('v6 → v7: legacy theme → themeMode + themeLight/themeDark', () => {
  it('promotes a legacy dark theme into themeMode=dark + themeDark', () => {
    const c: AnyConfig = { theme: 'solarized-dark' }
    runOne(6, c)
    expect(c.themeMode).toBe('dark')
    expect(c.themeDark).toBe('solarized-dark')
    expect(c.themeLight).toBeUndefined()
    expect(c.theme).toBeUndefined()
  })

  it('promotes the legacy light theme into themeMode=light + themeLight', () => {
    const c: AnyConfig = { theme: 'solarized-light' }
    runOne(6, c)
    expect(c.themeMode).toBe('light')
    expect(c.themeLight).toBe('solarized-light')
    expect(c.themeDark).toBeUndefined()
    expect(c.theme).toBeUndefined()
  })

  it('does not override themeMode=system or step on user choice (no legacy theme)', () => {
    const c: AnyConfig = { themeMode: 'system', themeDark: 'dracula' }
    runOne(6, c)
    expect(c.themeMode).toBe('system')
    expect(c.themeDark).toBe('dracula')
    expect(c.theme).toBeUndefined()
  })

  it('is a no-op when no legacy theme field exists', () => {
    const c: AnyConfig = { repoRoots: ['/a/repo'] }
    runOne(6, c)
    expect(c.theme).toBeUndefined()
    expect(c.themeMode).toBeUndefined()
    expect(c.themeLight).toBeUndefined()
    expect(c.themeDark).toBeUndefined()
  })

  it('ignores a non-string theme value', () => {
    const c: AnyConfig = { theme: 42 }
    runOne(6, c)
    expect(c.theme).toBe(42)
    expect(c.themeMode).toBeUndefined()
  })

  it('end-to-end: legacy theme=dracula migrates through to themeMode=dark', () => {
    const c: AnyConfig = {
      theme: 'dracula',
      repoRoots: ['/a/repo']
    }
    runMigrations(c)
    expect(c.themeMode).toBe('dark')
    expect(c.themeDark).toBe('dracula')
    expect(c.theme).toBeUndefined()
  })
})

describe('v8 → v9: pin auto-approve and agent reviews for upgraders', () => {
  it('records auto-approve as off when the key is absent', () => {
    const c: AnyConfig = { repoRoots: ['/a/repo'] }
    runOne(8, c)
    expect(c.autoApprovePermissions).toBe(false)
  })

  it('leaves an explicit auto-approve choice alone', () => {
    const c: AnyConfig = { autoApprovePermissions: true }
    runOne(8, c)
    expect(c.autoApprovePermissions).toBe(true)
  })

  it('turns agent reviews on for someone already using auto-review on green CI', () => {
    const c: AnyConfig = { autoReviewOnGreenCi: true }
    runOne(8, c)
    expect(c.agentReviewsEnabled).toBe(true)
  })

  it('leaves agent reviews at the default otherwise', () => {
    const c: AnyConfig = {}
    runOne(8, c)
    expect(c.agentReviewsEnabled).toBeUndefined()
  })

  it('does not override an explicit agent-reviews choice', () => {
    const c: AnyConfig = { autoReviewOnGreenCi: true, agentReviewsEnabled: false }
    runOne(8, c)
    expect(c.agentReviewsEnabled).toBe(false)
  })
})
