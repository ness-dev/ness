import { describe, it, expect } from 'vitest'
import {
  DEFAULT_RIGHT_PANEL_ORDER,
  effectiveHiddenRightPanels,
  effectiveRightPanelOrder,
  initialRepoConfigs,
  repoConfigsReducer,
  type RepoConfig,
  type RepoConfigsState
} from './repo-configs'

describe('repoConfigsReducer', () => {
  it('loaded replaces the whole map', () => {
    const start: RepoConfigsState = {
      byRepo: { '/old': { setupCommand: 'old' } },
      filenameByRepo: { '/old': '.harness.json' }
    }
    const next = repoConfigsReducer(start, {
      type: 'repoConfigs/loaded',
      payload: {
        byRepo: { '/a': { setupCommand: 'a' }, '/b': {} },
        filenameByRepo: { '/a': '.ness.json', '/b': '.harness.json' }
      }
    })
    expect(Object.keys(next.byRepo).sort()).toEqual(['/a', '/b'])
    expect(next.byRepo['/a']).toEqual({ setupCommand: 'a' })
    expect(next.filenameByRepo).toEqual({ '/a': '.ness.json', '/b': '.harness.json' })
  })

  it('changed merges a single repo without disturbing others', () => {
    const start: RepoConfigsState = {
      byRepo: {
        '/a': { setupCommand: 'a' },
        '/b': { mergeStrategy: 'squash' }
      },
      filenameByRepo: { '/a': '.harness.json', '/b': '.ness.json' }
    }
    const updated: RepoConfig = {
      setupCommand: 'a-updated',
      hideMergePanel: true
    }
    const next = repoConfigsReducer(start, {
      type: 'repoConfigs/changed',
      payload: { repoRoot: '/a', config: updated, filename: '.harness.json' }
    })
    expect(next.byRepo['/a']).toEqual(updated)
    expect(next.byRepo['/b']).toBe(start.byRepo['/b'])
    expect(next.filenameByRepo['/a']).toBe('.harness.json')
    expect(next.filenameByRepo['/b']).toBe('.ness.json')
  })

  it('removed drops the matching entry', () => {
    const start: RepoConfigsState = {
      byRepo: { '/a': {}, '/b': {} },
      filenameByRepo: { '/a': '.ness.json', '/b': '.harness.json' }
    }
    const next = repoConfigsReducer(start, {
      type: 'repoConfigs/removed',
      payload: '/a'
    })
    expect(Object.keys(next.byRepo)).toEqual(['/b'])
    expect(next.filenameByRepo).toEqual({ '/b': '.harness.json' })
  })

  it('removed on a missing key is a no-op (returns same reference)', () => {
    const start: RepoConfigsState = {
      byRepo: { '/a': {} },
      filenameByRepo: { '/a': '.ness.json' }
    }
    const next = repoConfigsReducer(start, {
      type: 'repoConfigs/removed',
      payload: '/missing'
    })
    expect(next).toBe(start)
  })

  it('effectiveHiddenRightPanels migrates legacy hideMergePanel / hidePrPanel', () => {
    expect(effectiveHiddenRightPanels({ hideMergePanel: true })).toEqual({
      scratchpad: true,
      merge: true
    })
    expect(effectiveHiddenRightPanels({ hidePrPanel: true })).toEqual({
      scratchpad: true,
      pr: true
    })
    expect(
      effectiveHiddenRightPanels({
        hideMergePanel: true,
        hiddenRightPanels: { pr: true, commits: true }
      })
    ).toEqual({ scratchpad: true, merge: true, pr: true, commits: true })
  })

  it('effectiveHiddenRightPanels prefers new field over legacy', () => {
    // Legacy says "hide merge", new explicitly sets merge: false.
    // effectiveHiddenRightPanels only adds legacy when new is undefined.
    expect(
      effectiveHiddenRightPanels({
        hideMergePanel: true,
        hiddenRightPanels: { merge: false }
      })
    ).toEqual({ scratchpad: true, merge: false })
  })

  it('effectiveHiddenRightPanels defaults scratchpad to hidden', () => {
    expect(effectiveHiddenRightPanels({})).toEqual({ scratchpad: true })
  })

  it('effectiveHiddenRightPanels lets explicit scratchpad: false override default', () => {
    expect(
      effectiveHiddenRightPanels({ hiddenRightPanels: { scratchpad: false } })
    ).toEqual({ scratchpad: false })
  })

  it('effectiveRightPanelOrder returns default when unset', () => {
    expect(effectiveRightPanelOrder(null)).toEqual(DEFAULT_RIGHT_PANEL_ORDER)
    expect(effectiveRightPanelOrder({})).toEqual(DEFAULT_RIGHT_PANEL_ORDER)
    expect(effectiveRightPanelOrder({ rightPanelOrder: [] })).toEqual(DEFAULT_RIGHT_PANEL_ORDER)
  })

  it('effectiveRightPanelOrder honors saved order', () => {
    expect(
      effectiveRightPanelOrder({
        rightPanelOrder: [
          'cost',
          'pr',
          'merge',
          'todos',
          'commits',
          'changedFiles',
          'allFiles',
          'context',
          'scratchpad'
        ]
      })
    ).toEqual([
      'cost',
      'pr',
      'merge',
      'todos',
      'commits',
      'changedFiles',
      'allFiles',
      'context',
      'scratchpad'
    ])
  })

  it('effectiveRightPanelOrder fills in missing keys and drops unknown', () => {
    // Partial saved order — the missing keys get appended in canonical order
    const result = effectiveRightPanelOrder({
      rightPanelOrder: ['cost', 'pr'] as never
    })
    expect(result[0]).toBe('cost')
    expect(result[1]).toBe('pr')
    // Remaining keys in canonical order
    expect(result.slice(2)).toEqual([
      'merge',
      'commits',
      'changedFiles',
      'allFiles',
      'todos',
      'context',
      'scratchpad'
    ])
    expect(result).toHaveLength(DEFAULT_RIGHT_PANEL_ORDER.length)
  })

  it('effectiveRightPanelOrder deduplicates repeated keys', () => {
    const result = effectiveRightPanelOrder({
      rightPanelOrder: ['pr', 'pr', 'merge'] as never
    })
    expect(result.filter((k) => k === 'pr')).toHaveLength(1)
    expect(result).toHaveLength(DEFAULT_RIGHT_PANEL_ORDER.length)
  })

  it('effectiveRightPanelOrder appends newly discovered tools at the end', () => {
    const result = effectiveRightPanelOrder({ rightPanelOrder: ['pr'] as never }, [
      'tool:pr-comments'
    ])
    expect(result[0]).toBe('pr')
    expect(result[result.length - 1]).toBe('tool:pr-comments')
    expect(result).toHaveLength(DEFAULT_RIGHT_PANEL_ORDER.length + 1)
  })

  it('effectiveRightPanelOrder honors a saved position for a custom tool', () => {
    const result = effectiveRightPanelOrder(
      { rightPanelOrder: ['tool:pr-comments', 'pr'] as never },
      ['tool:pr-comments']
    )
    expect(result[0]).toBe('tool:pr-comments')
    expect(result[1]).toBe('pr')
  })

  it('effectiveRightPanelOrder drops a saved tool that no longer exists', () => {
    const result = effectiveRightPanelOrder({
      rightPanelOrder: ['tool:deleted', 'pr'] as never
    })
    expect(result).not.toContain('tool:deleted')
    expect(result).toHaveLength(DEFAULT_RIGHT_PANEL_ORDER.length)
  })

  it('effectiveHiddenRightPanels handles null/empty config', () => {
    expect(effectiveHiddenRightPanels(null)).toEqual({ scratchpad: true })
    expect(effectiveHiddenRightPanels(undefined)).toEqual({ scratchpad: true })
    expect(effectiveHiddenRightPanels({})).toEqual({ scratchpad: true })
  })

  it('returns a new object reference on real changes', () => {
    const next = repoConfigsReducer(initialRepoConfigs, {
      type: 'repoConfigs/changed',
      payload: { repoRoot: '/a', config: {}, filename: '.ness.json' }
    })
    expect(next).not.toBe(initialRepoConfigs)
  })
})
