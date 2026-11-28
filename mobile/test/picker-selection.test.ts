import { describe, expect, it } from 'vitest'
import { applyProjectAccordion, buildWorktreeListBase } from '../../src/renderer/worktree-list-model'
import type { Worktree } from '../../src/shared/state/worktrees'
import { projectRowA11y, projectTap } from '../src/picker-selection'

describe('projectTap', () => {
  it('focuses a project that is not focused, without opening it', () => {
    expect(projectTap({ unified: false, holdsActive: false }, '/r/a')).toEqual({ kind: 'focus', path: '/r/a' })
  })
  it('opens main on a tap on the focused project', () => {
    expect(projectTap({ unified: false, holdsActive: true }, '/r/a')).toEqual({ kind: 'open', path: '/r/a' })
  })
  it('opens straight away in the unified list, which never collapses', () => {
    expect(projectTap({ unified: true, holdsActive: false }, '/r/a')).toEqual({ kind: 'open', path: '/r/a' })
  })
})

describe('projectRowA11y', () => {
  it('a collapsed project reads collapsed, and its hint says it expands', () => {
    expect(projectRowA11y({ unified: false, holdsActive: false, collapsed: true })).toEqual({ expanded: false, hint: 'Shows its worktrees' })
  })
  it('a focused project reads expanded, and its hint says a second tap opens main', () => {
    expect(projectRowA11y({ unified: false, holdsActive: true, collapsed: false })).toEqual({
      expanded: true,
      hint: 'Double-tap again to open main'
    })
  })
  it('a unified-list project has no expanded state', () => {
    expect(projectRowA11y({ unified: true, holdsActive: false, collapsed: false }).expanded).toBeUndefined()
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

  it('a pinned-open project is expanded but still needs a first tap to select it', () => {
    const m = applyProjectAccordion(base, '/r/a-wt/feat', { [byRepo(applyProjectAccordion(base, null, {}), '/r/b').scope]: true })
    expect(byRepo(m, '/r/b').collapsed).toBe(false)
    expect(projectTap(byRepo(m, '/r/b'), '/r/b').kind).toBe('focus')
  })
})
