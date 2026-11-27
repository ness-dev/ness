// First-run tour: two sidebar popouts shown to someone who just came
// through the welcome wizard.
//
//   eligible           fresh install, wizard not finished yet — nothing shown
//   home               popout 1 on the project's main workspace row
//   awaiting-worktree  kickoff chat running; waiting for its agent to make a
//                      worktree. Nothing is shown; closing the kickoff tab
//                      drops back to `home` so the user is never stranded here
//   new-worktree       popout 2 on the worktree that agent created
//   done               finished or dismissed; terminal
//
// Main drives every transition except the user's clicks (see
// main/first-run-tour.ts). A config written before the tour existed loads
// as `done`, so only a genuinely new install ever starts at `eligible`.

export type TourStep = 'eligible' | 'home' | 'awaiting-worktree' | 'new-worktree' | 'done'

export interface TourState {
  step: TourStep
  /** The project the tour is about. Set from `home` on. */
  repoRoot?: string
  /** The worktree popout 2 points at. Set in `new-worktree` only. */
  worktreePath?: string
  /** The kickoff Chat tab and the worktree holding it. Set in
   *  `awaiting-worktree` only, so main can tell when it's closed. */
  kickoffTabId?: string
  kickoffPath?: string
}

export interface OnboardingState {
  tour: TourState
}

export type OnboardingEvent =
  | { type: 'onboarding/tourStarted'; payload: { repoRoot: string } }
  | { type: 'onboarding/tourKickedOff'; payload: { tabId: string; worktreePath: string } }
  | { type: 'onboarding/tourKickoffClosed' }
  | { type: 'onboarding/tourWorktreeCreated'; payload: { worktreePath: string } }
  | { type: 'onboarding/tourEnded' }

export const TOUR_DONE: TourState = { step: 'done' }

export const initialOnboarding: OnboardingState = {
  tour: TOUR_DONE
}

/** Parse a persisted tour, falling back to `done` for anything missing or
 *  malformed — an unreadable value must never put the tour in front of
 *  someone who has already used Ness. */
export function sanitizeTour(raw: unknown): TourState {
  if (!raw || typeof raw !== 'object') return TOUR_DONE
  const r = raw as Record<string, unknown>
  const repoRoot = typeof r.repoRoot === 'string' && r.repoRoot ? r.repoRoot : undefined
  const worktreePath = typeof r.worktreePath === 'string' && r.worktreePath ? r.worktreePath : undefined
  switch (r.step) {
    case 'eligible':
      return { step: 'eligible' }
    case 'home':
      return repoRoot ? { step: 'home', repoRoot } : TOUR_DONE
    case 'awaiting-worktree': {
      if (!repoRoot) return TOUR_DONE
      const kickoffTabId = typeof r.kickoffTabId === 'string' && r.kickoffTabId ? r.kickoffTabId : undefined
      const kickoffPath = typeof r.kickoffPath === 'string' && r.kickoffPath ? r.kickoffPath : undefined
      // Without the tab there's no way to notice it closing; fall back to
      // popout 1 rather than wait on nothing.
      return kickoffTabId && kickoffPath
        ? { step: 'awaiting-worktree', repoRoot, kickoffTabId, kickoffPath }
        : { step: 'home', repoRoot }
    }
    case 'new-worktree':
      return repoRoot && worktreePath ? { step: 'new-worktree', repoRoot, worktreePath } : TOUR_DONE
    default:
      return TOUR_DONE
  }
}

export function onboardingReducer(
  state: OnboardingState,
  event: OnboardingEvent
): OnboardingState {
  const tour = state.tour
  switch (event.type) {
    case 'onboarding/tourStarted':
      if (tour.step !== 'eligible') return state
      return { ...state, tour: { step: 'home', repoRoot: event.payload.repoRoot } }
    case 'onboarding/tourKickedOff':
      if (tour.step !== 'home') return state
      return {
        ...state,
        tour: {
          step: 'awaiting-worktree',
          repoRoot: tour.repoRoot,
          kickoffTabId: event.payload.tabId,
          kickoffPath: event.payload.worktreePath
        }
      }
    case 'onboarding/tourKickoffClosed':
      if (tour.step !== 'awaiting-worktree') return state
      return { ...state, tour: { step: 'home', repoRoot: tour.repoRoot } }
    case 'onboarding/tourWorktreeCreated':
      // From `home` too, defensively: nothing currently creates a worktree
      // from the home workspace before Start (main holds its default tabs
      // back during `home`), but if something does, follow it.
      if (tour.step !== 'home' && tour.step !== 'awaiting-worktree') return state
      return {
        ...state,
        tour: { step: 'new-worktree', repoRoot: tour.repoRoot, worktreePath: event.payload.worktreePath }
      }
    case 'onboarding/tourEnded':
      if (tour.step === 'done') return state
      return { ...state, tour: TOUR_DONE }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}
