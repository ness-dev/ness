import { describe, it, expect } from 'vitest'
import { initialOnboarding, onboardingReducer, sanitizeTour, type OnboardingState } from './onboarding'

const at = (tour: OnboardingState['tour']): OnboardingState => ({ tour })

describe('onboardingReducer', () => {
  it('starts finished, so nobody sees the tour unless main opts them in', () => {
    expect(initialOnboarding.tour.step).toBe('done')
  })

  it('tourStarted moves an eligible install to the home popout', () => {
    const next = onboardingReducer(at({ step: 'eligible' }), {
      type: 'onboarding/tourStarted',
      payload: { repoRoot: '/r' }
    })
    expect(next.tour).toEqual({ step: 'home', repoRoot: '/r' })
  })

  it('tourStarted is ignored unless eligible', () => {
    const state = at({ step: 'done' })
    expect(
      onboardingReducer(state, { type: 'onboarding/tourStarted', payload: { repoRoot: '/r' } })
    ).toBe(state)
  })

  const kickedOff = { type: 'onboarding/tourKickedOff' as const, payload: { tabId: 't1', worktreePath: '/r' } }

  it('tourKickedOff moves home to awaiting-worktree, remembering the kickoff tab', () => {
    const next = onboardingReducer(at({ step: 'home', repoRoot: '/r' }), kickedOff)
    expect(next.tour).toEqual({ step: 'awaiting-worktree', repoRoot: '/r', kickoffTabId: 't1', kickoffPath: '/r' })
  })

  it('tourKickedOff is ignored outside home', () => {
    const state = at({ step: 'eligible' })
    expect(onboardingReducer(state, kickedOff)).toBe(state)
  })

  it('tourKickoffClosed drops back to the home popout', () => {
    const next = onboardingReducer(
      at({ step: 'awaiting-worktree', repoRoot: '/r', kickoffTabId: 't1', kickoffPath: '/r' }),
      { type: 'onboarding/tourKickoffClosed' }
    )
    expect(next.tour).toEqual({ step: 'home', repoRoot: '/r' })
  })

  it('tourKickoffClosed is ignored outside awaiting-worktree', () => {
    const state = at({ step: 'new-worktree', repoRoot: '/r', worktreePath: '/w' })
    expect(onboardingReducer(state, { type: 'onboarding/tourKickoffClosed' })).toBe(state)
  })

  it('tourWorktreeCreated points popout 2 at the new worktree', () => {
    const next = onboardingReducer(at({ step: 'awaiting-worktree', repoRoot: '/r', kickoffTabId: 't1', kickoffPath: '/r' }), {
      type: 'onboarding/tourWorktreeCreated',
      payload: { worktreePath: '/r-worktrees/feat' }
    })
    expect(next.tour).toEqual({ step: 'new-worktree', repoRoot: '/r', worktreePath: '/r-worktrees/feat' })
  })

  it('tourWorktreeCreated also advances straight from home', () => {
    const next = onboardingReducer(at({ step: 'home', repoRoot: '/r' }), {
      type: 'onboarding/tourWorktreeCreated',
      payload: { worktreePath: '/w' }
    })
    expect(next.tour.step).toBe('new-worktree')
  })

  it('tourWorktreeCreated fires once: a second worktree does not move popout 2', () => {
    const state = at({ step: 'new-worktree', repoRoot: '/r', worktreePath: '/w1' })
    expect(
      onboardingReducer(state, { type: 'onboarding/tourWorktreeCreated', payload: { worktreePath: '/w2' } })
    ).toBe(state)
  })

  it('tourEnded finishes the tour from any step', () => {
    for (const tour of [
      { step: 'eligible' as const },
      { step: 'home' as const, repoRoot: '/r' },
      { step: 'new-worktree' as const, repoRoot: '/r', worktreePath: '/w' }
    ]) {
      expect(onboardingReducer(at(tour), { type: 'onboarding/tourEnded' }).tour).toEqual({ step: 'done' })
    }
  })

  it('tourEnded keeps identity once done', () => {
    const state = at({ step: 'done' })
    expect(onboardingReducer(state, { type: 'onboarding/tourEnded' })).toBe(state)
  })
})

describe('sanitizeTour', () => {
  it('treats a missing value as finished — every pre-tour config', () => {
    expect(sanitizeTour(undefined)).toEqual({ step: 'done' })
  })

  it('keeps well-formed steps', () => {
    expect(sanitizeTour({ step: 'eligible' })).toEqual({ step: 'eligible' })
    expect(sanitizeTour({ step: 'home', repoRoot: '/r' })).toEqual({ step: 'home', repoRoot: '/r' })
    expect(sanitizeTour({ step: 'new-worktree', repoRoot: '/r', worktreePath: '/w' })).toEqual({
      step: 'new-worktree',
      repoRoot: '/r',
      worktreePath: '/w'
    })
  })

  it('finishes a step that is missing the path it needs, or unknown', () => {
    expect(sanitizeTour({ step: 'home' })).toEqual({ step: 'done' })
    expect(sanitizeTour({ step: 'new-worktree', repoRoot: '/r' })).toEqual({ step: 'done' })
    expect(sanitizeTour({ step: 'spawn-second' })).toEqual({ step: 'done' })
  })

  it('falls back to home for an awaiting step without its kickoff tab', () => {
    expect(sanitizeTour({ step: 'awaiting-worktree', repoRoot: '/r' })).toEqual({ step: 'home', repoRoot: '/r' })
    expect(
      sanitizeTour({ step: 'awaiting-worktree', repoRoot: '/r', kickoffTabId: 't', kickoffPath: '/r' })
    ).toEqual({ step: 'awaiting-worktree', repoRoot: '/r', kickoffTabId: 't', kickoffPath: '/r' })
  })
})
