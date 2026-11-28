import { describe, expect, it } from 'vitest'
import { applyProjectAccordion, buildWorktreeListBase } from '../../src/renderer/worktree-list-model'
import type { Worktree } from '../../src/shared/state/worktrees'
import { projectRowA11y, projectTap } from '../src/picker-selection'

describe('projectTap', () => {
  it('expands a collapsed project, without opening it', () => {
    expect(projectTap({ unified: false, collapsed: true }, '/r/a')).toEqual({ kind: 'focus', path: '/r/a' })
  })
  it('opens main on a tap on an expanded project', () => {
    expect(projectTap({ unified: false, collapsed: false }, '/r/a')).toEqual({ kind: 'open', path: '/r/a' })
  })
  it('opens straight away in the unified list, which never collapses', () => {
    expect(projectTap({ unified: true, collapsed: false }, '/r/a')).toEqual({ kind: 'open', path: '/r/a' })
  })
})

describe('projectRowA11y', () => {
  it('a collapsed project reads collapsed, and its hint says it expands', () => {
    expect(projectRowA11y({ unified: false, collapsed: true })).toEqual({ expanded: false, hint: 'Shows its worktrees' })
  })
  it('an expanded project reads expanded, and its hint says it opens main', () => {
    expect(projectRowA11y({ unified: false, collapsed: false })).toEqual({ expanded: true, hint: 'Opens main' })
  })
  it('a unified-list project has no expanded state', () => {
    expect(projectRowA11y({ unified: true, collapsed: false }).expanded).toBeUndefined()
  })
})

// The whole flow through the shared accordion: two repos, the picker
// opened on repo a's feature branch.
function wt(repoRoot: string, path: string, isMain: boolean): Worktree {
  return { path, branch: isMain ? 'main' : path.split('/').pop()!, head: 'x', isMain, repoRoot, createdAt: 1 } as Worktree
}

describe('picker focus through applyProjectAccordion', () => {
  const worktrees = [wt('/r/a', '/r/a', true), wt('/r/a', '/r/a-wt/feat', false), wt('/r/b', '/r/b', true), wt('/r/b', '/r/b-wt/fix', false)]
  const base = buildWorktreeListBase({
    worktrees,
    repoRoots: ['/r/a', '/r/b'],
    repoBackendId: {},
    repoRemotes: {},
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
    assignedPRsByRepo: {},
    unifiedRepos: false,
    isGroupCollapsed: () => false,
    assignOrdinals: false
  } as Parameters<typeof buildWorktreeListBase>[0])
  const byRepo = (m: ReturnType<typeof applyProjectAccordion>, root: string) => m.sections.find((s) => s.homes[0]?.worktree.repoRoot === root)!

  it('starts with the current project expanded; first tap on another expands it, second opens it', () => {
    let focus = '/r/a-wt/feat'
    let m = applyProjectAccordion(base, focus, {})
    expect(byRepo(m, '/r/a').collapsed).toBe(false)
    expect(byRepo(m, '/r/b').collapsed).toBe(true)

    const first = projectTap(byRepo(m, '/r/b'), '/r/b')
    expect(first.kind).toBe('focus')
    focus = first.path
    m = applyProjectAccordion(base, focus, {})
    expect(byRepo(m, '/r/b').collapsed).toBe(false)
    expect(byRepo(m, '/r/a').collapsed).toBe(true)

    expect(projectTap(byRepo(m, '/r/b'), '/r/b')).toEqual({ kind: 'open', path: '/r/b' })
  })

  it('a pinned-open project is already expanded, so the first tap opens it', () => {
    const m = applyProjectAccordion(base, '/r/a-wt/feat', { [byRepo(applyProjectAccordion(base, null, {}), '/r/b').scope]: true })
    expect(byRepo(m, '/r/b').collapsed).toBe(false)
    expect(projectTap(byRepo(m, '/r/b'), '/r/b')).toEqual({ kind: 'open', path: '/r/b' })
  })

  it('with no focus nothing collapses, so the first tap on any project opens it', () => {
    const m = applyProjectAccordion(base, null, {})
    for (const root of ['/r/a', '/r/b']) {
      expect(byRepo(m, root).collapsed).toBe(false)
      expect(projectTap(byRepo(m, root), root)).toEqual({ kind: 'open', path: root })
    }
  })
})
