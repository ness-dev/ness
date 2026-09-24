import { describe, it, expect } from 'vitest'
import { resolveEditorId, editorOverrideScope, DEFAULT_EDITOR_ID } from './editor-resolve'

const base = {
  globalEditor: 'vscode',
  repoEditors: {} as Record<string, string>,
  worktreeEditors: {} as Record<string, string>
}

describe('resolveEditorId', () => {
  it('falls back to the built-in default when nothing is configured', () => {
    expect(resolveEditorId({ ...base, globalEditor: '' })).toBe(DEFAULT_EDITOR_ID)
  })

  it('uses the global editor when no repo or worktree override exists', () => {
    expect(resolveEditorId({ ...base, globalEditor: 'zed' })).toBe('zed')
  })

  it('prefers the repo override over the global editor', () => {
    expect(
      resolveEditorId({ ...base, globalEditor: 'zed', repoEditors: { '/r': 'idea' }, repoRoot: '/r' })
    ).toBe('idea')
  })

  it('prefers the worktree override over the repo override', () => {
    expect(
      resolveEditorId({
        ...base,
        globalEditor: 'zed',
        repoEditors: { '/r': 'idea' },
        worktreeEditors: { '/r/wt': 'pycharm' },
        repoRoot: '/r',
        worktreePath: '/r/wt'
      })
    ).toBe('pycharm')
  })

  it('ignores a repo override for a different repo', () => {
    expect(
      resolveEditorId({ ...base, globalEditor: 'zed', repoEditors: { '/other': 'idea' }, repoRoot: '/r' })
    ).toBe('zed')
  })

  it('ignores a worktree override for a different worktree', () => {
    expect(
      resolveEditorId({
        ...base,
        globalEditor: 'zed',
        worktreeEditors: { '/r/other': 'idea' },
        worktreePath: '/r/wt'
      })
    ).toBe('zed')
  })

  it('falls back through an empty-string override rather than resolving to it', () => {
    expect(
      resolveEditorId({
        ...base,
        globalEditor: 'zed',
        repoEditors: { '/r': 'idea' },
        worktreeEditors: { '/r/wt': '' },
        repoRoot: '/r',
        worktreePath: '/r/wt'
      })
    ).toBe('idea')
  })

  it('resolves with no repoRoot known (worktree not in the list yet)', () => {
    expect(
      resolveEditorId({ ...base, globalEditor: 'zed', worktreeEditors: { '/r/wt': 'idea' }, worktreePath: '/r/wt' })
    ).toBe('idea')
  })
})

describe('editorOverrideScope', () => {
  it('reports global when nothing overrides', () => {
    expect(editorOverrideScope({ ...base, repoRoot: '/r', worktreePath: '/r/wt' })).toBe('global')
  })

  it('reports repo when only the repo overrides', () => {
    expect(
      editorOverrideScope({ ...base, repoEditors: { '/r': 'idea' }, repoRoot: '/r', worktreePath: '/r/wt' })
    ).toBe('repo')
  })

  it('reports worktree when the worktree overrides', () => {
    expect(
      editorOverrideScope({
        ...base,
        repoEditors: { '/r': 'idea' },
        worktreeEditors: { '/r/wt': 'pycharm' },
        repoRoot: '/r',
        worktreePath: '/r/wt'
      })
    ).toBe('worktree')
  })
})
