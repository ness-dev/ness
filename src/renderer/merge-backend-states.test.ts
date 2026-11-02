// The merge is the single source for every owner map the routing layer
// depends on (pathBackendId, repoBackendId, pendingBackendId). The layers
// on either side — SegmentedSelector below, buildWorktreeListModel above
// — were tested; this one wasn't, and it's where a wrong owner silently
// sends a tab operation to the wrong machine.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { initialState, type AppState } from '../shared/state'
import type { Worktree, PendingWorktree } from '../shared/state/worktrees'
import {
  mergeBackendStates,
  getMergedWorktrees,
  resetMergedWorktreesCache,
  tabsFromPanes,
  type BackendStateLike
} from './merge-backend-states'

function wt(path: string, repoRoot: string): Worktree {
  return { path, branch: path.split('/').pop()!, head: 'abc', isBare: false, isMain: false, createdAt: 1, repoRoot }
}

function pending(id: string, repoRoot: string): PendingWorktree {
  return { id, repoRoot, branchName: 'b', status: 'creating' } as PendingWorktree
}

function backend(
  backendId: string,
  opts: {
    kind?: 'local' | 'remote'
    worktrees?: Worktree[]
    repoRoots?: string[]
    pending?: PendingWorktree[]
    panes?: AppState['terminals']['panes']
    statuses?: AppState['terminals']['statuses']
  } = {}
): BackendStateLike {
  const state: AppState = {
    ...initialState,
    worktrees: {
      ...initialState.worktrees,
      list: opts.worktrees ?? [],
      repoRoots: opts.repoRoots ?? [],
      pending: opts.pending ?? []
    },
    terminals: {
      ...initialState.terminals,
      panes: opts.panes ?? {},
      statuses: opts.statuses ?? {}
    }
  }
  return { backendId, label: backendId.toUpperCase(), kind: opts.kind ?? 'remote', state }
}

const noTabs = () => ({})

describe('mergeBackendStates', () => {
  it('single mode keeps only the active backend', () => {
    const entries = [
      backend('local', { kind: 'local', worktrees: [wt('/l/a', '/l')] }),
      backend('beta', { worktrees: [wt('/b/a', '/b')] })
    ]
    const merged = mergeBackendStates(entries, { viewMode: 'single', activeId: 'beta', tabsFor: noTabs })
    expect(merged.flatWorktrees.map((w) => w.path)).toEqual(['/b/a'])
    expect(Object.keys(merged.backendMeta)).toEqual(['beta'])
  })

  it('merged mode includes every backend, in registry order', () => {
    const entries = [
      backend('local', { kind: 'local', worktrees: [wt('/l/a', '/l')] }),
      backend('beta', { worktrees: [wt('/b/a', '/b')] })
    ]
    const merged = mergeBackendStates(entries, { viewMode: 'merged', activeId: 'local', tabsFor: noTabs })
    expect(merged.worktrees.map((m) => `${m.backendId}:${m.worktree.path}`)).toEqual(['local:/l/a', 'beta:/b/a'])
    expect(merged.worktrees[1].backendLabel).toBe('BETA')
    expect(merged.worktrees[1].backendKind).toBe('remote')
  })

  it('attributes every owner map to the right backend', () => {
    const entries = [
      backend('local', { kind: 'local', worktrees: [wt('/l/a', '/l')], repoRoots: ['/l'], pending: [pending('p1', '/l')] }),
      backend('beta', { worktrees: [wt('/b/a', '/b')], repoRoots: ['/b'], pending: [pending('p2', '/b')] })
    ]
    const merged = mergeBackendStates(entries, { viewMode: 'merged', activeId: 'local', tabsFor: noTabs })
    expect(merged.pathBackendId).toEqual({ '/l/a': 'local', '/b/a': 'beta' })
    expect(merged.repoBackendId).toEqual({ '/l': 'local', '/b': 'beta' })
    expect(merged.pendingBackendId).toEqual({ p1: 'local', p2: 'beta' })
    expect(merged.backendMeta.beta).toEqual({ label: 'BETA', kind: 'remote' })
    expect(merged.pendingWorktrees.map((p) => p.id)).toEqual(['p1', 'p2'])
  })

  it('on a cross-host path collision, last writer wins and it warns once', () => {
    // The documented composite-identity gap. Until identity is
    // (backendId, path) this is the behaviour; the test pins that it
    // is at least loud.
    const warn = vi.fn()
    const entries = [
      backend('local', { kind: 'local', worktrees: [wt('/same/path', '/r')] }),
      backend('beta', { worktrees: [wt('/same/path', '/r')] })
    ]
    const merged = mergeBackendStates(entries, { viewMode: 'merged', activeId: 'local', tabsFor: noTabs, warn })
    expect(merged.pathBackendId['/same/path']).toBe('beta')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('/same/path')
    expect(warn.mock.calls[0][0]).toContain('local vs beta')
  })

  it('takes tabs from the injected per-backend source', () => {
    const entries = [backend('local', { kind: 'local' }), backend('beta')]
    const tabsFor = vi.fn((id: string) => ({ [`/${id}/wt`]: [] }))
    const merged = mergeBackendStates(entries, { viewMode: 'merged', activeId: 'local', tabsFor })
    expect(tabsFor).toHaveBeenCalledTimes(2)
    expect(Object.keys(merged.tabsByWorktree).sort()).toEqual(['/beta/wt', '/local/wt'])
  })
})

describe('tabsFromPanes', () => {
  it('flattens every leaf of every tree, keyed by worktree path', () => {
    const tabs = tabsFromPanes({
      '/w': {
        type: 'leaf',
        id: 'leaf-1',
        tabs: [{ id: 't1', type: 'shell', label: 'Shell' }, { id: 't2', type: 'shell', label: 'Shell' }]
      } as AppState['terminals']['panes'][string]
    })
    expect(tabs['/w'].map((t) => t.id)).toEqual(['t1', 't2'])
  })
})

describe('getMergedWorktrees (shared cache)', () => {
  beforeEach(() => resetMergedWorktreesCache())

  it('returns the same object for the same inputs — two callers, one merge', () => {
    const entries = [backend('local', { kind: 'local' })]
    const a = getMergedWorktrees(entries, 'merged', 'local')
    const b = getMergedWorktrees(entries, 'merged', 'local')
    expect(b).toBe(a)
  })

  it('recomputes when the view mode or active backend changes', () => {
    const entries = [backend('local', { kind: 'local' }), backend('beta')]
    const merged = getMergedWorktrees(entries, 'merged', 'local')
    const single = getMergedWorktrees(entries, 'single', 'local')
    expect(single).not.toBe(merged)
    expect(single.flatWorktrees).toEqual([])
    expect(getMergedWorktrees(entries, 'single', 'beta')).not.toBe(single)
  })

  it('does not re-walk pane trees for a status change', () => {
    // The regression the reviewer called out: a status flip on any
    // backend used to re-run getLeaves over every worktree on every host.
    // Pane trees are memoized on `panes` alone, so a status-only change
    // must reuse the previous tab map by reference.
    const panes = {
      '/w': { type: 'leaf', id: 'leaf-1', tabs: [{ id: 't1', type: 'shell', label: 'Shell' }] }
    } as unknown as AppState['terminals']['panes']
    const before = [backend('local', { kind: 'local', panes, statuses: { t1: 'idle' } })]
    const first = getMergedWorktrees(before, 'merged', 'local')

    const after = [backend('local', { kind: 'local', panes, statuses: { t1: 'processing' } })]
    const second = getMergedWorktrees(after, 'merged', 'local')

    expect(second).not.toBe(first) // the merge itself legitimately reran
    expect(second.statuses.t1).toBe('processing')
    expect(second.tabsByWorktree['/w']).toBe(first.tabsByWorktree['/w']) // but not the tab walk
  })

  it('keeps unchanged outputs by reference when another field changes', () => {
    const list = [wt('/w', '/r')]
    const first = getMergedWorktrees(
      [backend('local', { kind: 'local', worktrees: list, statuses: { t1: 'idle' } })],
      'merged',
      'local'
    )
    const second = getMergedWorktrees(
      [backend('local', { kind: 'local', worktrees: list, statuses: { t1: 'processing' } })],
      'merged',
      'local'
    )
    expect(second.statuses).not.toBe(first.statuses)
    expect(second.flatWorktrees).toBe(first.flatWorktrees)
    expect(second.worktrees).toBe(first.worktrees)
    expect(second.pathBackendId).toBe(first.pathBackendId)
    expect(second.backendMeta).toBe(first.backendMeta)
  })

  it('returns the previous result when an event changed nothing it reads', () => {
    const list = [wt('/w', '/r')]
    const first = getMergedWorktrees(
      [backend('local', { kind: 'local', worktrees: list })],
      'merged',
      'local'
    )
    const second = getMergedWorktrees(
      [backend('local', { kind: 'local', worktrees: list })],
      'merged',
      'local'
    )
    expect(second).toBe(first)
  })

  it('hands out a new worktree list when a worktree is added', () => {
    const a = wt('/a', '/r')
    const first = getMergedWorktrees([backend('local', { kind: 'local', worktrees: [a] })], 'merged', 'local')
    const second = getMergedWorktrees(
      [backend('local', { kind: 'local', worktrees: [a, wt('/b', '/r')] })],
      'merged',
      'local'
    )
    expect(second.flatWorktrees).not.toBe(first.flatWorktrees)
    expect(second.flatWorktrees.map((w) => w.path)).toEqual(['/a', '/b'])
  })
})
