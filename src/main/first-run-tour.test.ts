import { describe, it, expect, vi } from 'vitest'
import { Store } from './store'
import { installFirstRunTour } from './first-run-tour'
import { initialState, type AppState } from '../shared/state'
import type { TourState } from '../shared/state/onboarding'
import type { Worktree } from '../shared/state/worktrees'
import type { PaneNode } from '../shared/state/terminals'
import type { Config } from './persistence'

const REPO = '/r'
const wt = (path: string, isMain: boolean, repoRoot = REPO): Worktree =>
  ({ path, branch: path, head: '', isBare: false, isMain, createdAt: 0, repoRoot }) as Worktree
const leaf = (tabIds: string[]): PaneNode =>
  ({
    type: 'leaf',
    id: 'p',
    tabs: tabIds.map((id) => ({ id, type: 'json-claude', label: id, sessionId: id })),
    activeTabId: tabIds[0] ?? ''
  }) as PaneNode

function setup(tour: TourState, patch?: (s: AppState) => AppState) {
  let state: AppState = { ...initialState, onboarding: { tour } }
  if (patch) state = patch(state)
  const store = new Store(state)
  const config = { repoRoots: [] } as unknown as Config
  const saveConfig = vi.fn()
  installFirstRunTour({ store, config: () => config, saveConfig })
  return { store, config, saveConfig, tour: () => store.getSnapshot().state.onboarding.tour }
}

const withWorktrees = (list: Worktree[]) => (s: AppState): AppState => ({
  ...s,
  worktrees: { ...s.worktrees, list }
})

const origin = (path: string, creatorPath: string) =>
  ({
    type: 'origins/recorded',
    payload: { path, origin: { creatorPath, creatorTabId: 't', createdAt: 0 } }
  }) as const

describe('installFirstRunTour', () => {
  it('starts the tour on the first repo added to an eligible install', () => {
    const t = setup({ step: 'eligible' })
    t.store.dispatch({ type: 'worktrees/reposChanged', payload: [REPO, '/other'] })
    expect(t.tour()).toEqual({ step: 'home', repoRoot: REPO })
  })

  it('ignores an empty repo list while eligible', () => {
    const t = setup({ step: 'eligible' })
    t.store.dispatch({ type: 'worktrees/reposChanged', payload: [] })
    expect(t.tour().step).toBe('eligible')
  })

  it('never starts for an install that is already done', () => {
    const t = setup({ step: 'done' })
    t.store.dispatch({ type: 'worktrees/reposChanged', payload: [REPO] })
    expect(t.tour().step).toBe('done')
    expect(t.saveConfig).not.toHaveBeenCalled()
  })

  it('ends the tour when its project is removed', () => {
    const t = setup({ step: 'home', repoRoot: REPO })
    t.store.dispatch({ type: 'worktrees/reposChanged', payload: ['/other'] })
    expect(t.tour().step).toBe('done')
  })

  it('shows popout 2 for a worktree created from the project home', () => {
    const t = setup(
      { step: 'awaiting-worktree', repoRoot: REPO, kickoffTabId: 'k', kickoffPath: REPO },
      withWorktrees([wt(REPO, true)])
    )
    t.store.dispatch(origin('/r-wt/feat', REPO))
    expect(t.tour()).toEqual({ step: 'new-worktree', repoRoot: REPO, worktreePath: '/r-wt/feat' })
  })

  it('falls back to the repo root when the creator is not in the list yet', () => {
    const t = setup({ step: 'home', repoRoot: REPO })
    t.store.dispatch(origin('/r-wt/feat', REPO))
    expect(t.tour().step).toBe('new-worktree')
  })

  it('ignores a worktree created from some other worktree', () => {
    const t = setup({ step: 'home', repoRoot: REPO }, withWorktrees([wt(REPO, true), wt('/r-wt/a', false)]))
    t.store.dispatch(origin('/r-wt/b', '/r-wt/a'))
    expect(t.tour().step).toBe('home')
  })

  it('ignores a worktree created from another project home', () => {
    const t = setup({ step: 'home', repoRoot: REPO }, withWorktrees([wt(REPO, true), wt('/x', true, '/x')]))
    t.store.dispatch(origin('/x-wt/b', '/x'))
    expect(t.tour().step).toBe('home')
  })

  it('drops back to popout 1 when the kickoff tab is closed', () => {
    const t = setup({ step: 'awaiting-worktree', repoRoot: REPO, kickoffTabId: 'k', kickoffPath: REPO })
    t.store.dispatch({ type: 'terminals/panesForWorktreeChanged', payload: { worktreePath: REPO, panes: leaf(['k', 's']) } })
    expect(t.tour().step).toBe('awaiting-worktree')
    t.store.dispatch({ type: 'terminals/panesForWorktreeChanged', payload: { worktreePath: REPO, panes: leaf(['s']) } })
    expect(t.tour()).toEqual({ step: 'home', repoRoot: REPO })
  })

  it('ignores pane changes in other worktrees while waiting', () => {
    const t = setup({ step: 'awaiting-worktree', repoRoot: REPO, kickoffTabId: 'k', kickoffPath: REPO })
    t.store.dispatch({ type: 'terminals/panesForWorktreeChanged', payload: { worktreePath: '/elsewhere', panes: leaf(['x']) } })
    expect(t.tour().step).toBe('awaiting-worktree')
  })

  it('ends the tour when the popout 2 worktree is removed', () => {
    const t = setup({ step: 'new-worktree', repoRoot: REPO, worktreePath: '/w' })
    t.store.dispatch({ type: 'origins/cleared', payload: '/other' })
    expect(t.tour().step).toBe('new-worktree')
    t.store.dispatch({ type: 'origins/cleared', payload: '/w' })
    expect(t.tour().step).toBe('done')
  })

  it('persists the tour on each change, and only on a change', () => {
    const t = setup({ step: 'eligible' })
    t.store.dispatch({ type: 'worktrees/reposChanged', payload: [REPO] })
    expect(t.saveConfig).toHaveBeenCalledTimes(1)
    expect(t.config.onboarding?.tour).toEqual({ step: 'home', repoRoot: REPO })
    t.store.dispatch({ type: 'onboarding/tourStarted', payload: { repoRoot: '/ignored' } })
    expect(t.saveConfig).toHaveBeenCalledTimes(1)
    t.store.dispatch({ type: 'onboarding/tourEnded' })
    expect(t.saveConfig).toHaveBeenCalledTimes(2)
    expect(t.config.onboarding?.tour).toEqual({ step: 'done' })
  })
})
