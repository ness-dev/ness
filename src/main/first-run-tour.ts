// Main-side driver for the first-run tour (shared/state/onboarding.ts).
//
// The renderer only ever reports clicks (start, dismiss). Everything that
// moves the tour on its own is decided here, from store events, so every
// client sees the same step and nothing hinges on which window noticed
// first:
//   - a repo is registered while `eligible` → the wizard just finished
//     with a project added → popout 1 on that project's home row
//   - an origin is recorded whose creator is that project's main
//     workspace → popout 2 on the new worktree (once; the reducer ignores
//     later ones)
//   - the tour's project or worktree disappears → end the tour, rather
//     than leave it pointing at a row that will never come back

import type { Store } from './store'
import type { Config } from './persistence'
import type { AppState, StateEvent } from '../shared/state'
import type { TourState } from '../shared/state/onboarding'
import { wrapAutomatedMessage } from '../shared/state/json-claude'

export function installFirstRunTour(deps: {
  store: Store
  config: () => Config
  saveConfig: (config: Config) => void
}): () => void {
  const { store } = deps
  let persisted: TourState = store.getSnapshot().state.onboarding.tour
  return store.subscribe((event: StateEvent) => {
    const state = store.getSnapshot().state
    const tour = state.onboarding.tour
    if (event.type.startsWith('onboarding/')) {
      if (tour !== persisted) {
        persisted = tour
        const config = deps.config()
        config.onboarding = { ...(config.onboarding || {}), tour }
        deps.saveConfig(config)
      }
      return
    }
    if (tour.step === 'done') return
    if (event.type === 'worktrees/reposChanged') {
      if (tour.step === 'eligible') {
        if (event.payload.length > 0) {
          store.dispatch({ type: 'onboarding/tourStarted', payload: { repoRoot: event.payload[0] } })
        }
        return
      }
      if (tour.repoRoot && !event.payload.includes(tour.repoRoot)) {
        store.dispatch({ type: 'onboarding/tourEnded' })
      }
      return
    }
    if (event.type === 'origins/recorded') {
      if (tour.step !== 'home' && tour.step !== 'awaiting-worktree') return
      if (!isHomeOf(state, event.payload.origin.creatorPath, tour.repoRoot)) return
      store.dispatch({
        type: 'onboarding/tourWorktreeCreated',
        payload: { worktreePath: event.payload.path }
      })
      return
    }
    if (event.type === 'origins/cleared') {
      if (tour.step === 'new-worktree' && event.payload === tour.worktreePath) {
        store.dispatch({ type: 'onboarding/tourEnded' })
      }
    }
  })
}

/** Is `path` the main workspace of `repoRoot`? Read off the worktree list
 *  rather than assumed equal to the repo root, which only usually holds. */
function isHomeOf(state: AppState, path: string, repoRoot: string | undefined): boolean {
  if (!repoRoot) return false
  const wt = state.worktrees.list.find((w) => w.path === path)
  if (wt) return wt.isMain && wt.repoRoot === repoRoot
  return path === repoRoot
}

/** The main workspace of the tour's project, if the tour is on popout 1. */
export function tourHomePath(state: AppState): string | null {
  const tour = state.onboarding.tour
  if (tour.step !== 'home' || !tour.repoRoot) return null
  const home = state.worktrees.list.find((w) => w.isMain && w.repoRoot === tour.repoRoot)
  return home?.path ?? null
}

export function buildFirstRunKickoff(): string {
  return wrapAutomatedMessage(
    'first-run-kickoff',
    [
      'This is the user\'s first time using Ness. They just added this project and pressed "Start something new" on the main workspace.',
      '',
      'Help them work out what to work on first:',
      '1. Take a quick look around the repo — README, recent commits, open TODOs, anything obviously unfinished — so your suggestions are grounded in this codebase.',
      '2. Suggest three or four concrete, reasonably small ideas, each in a sentence, and ask what they would like to do. Their own idea is welcome too.',
      '3. Once they pick a task, do not start it here. Create a new worktree for it with the ness-control `create_worktree` tool, with a thorough `initialPrompt` that gives the new agent everything it needs to work independently, and a short Title Case `alias`.',
      '',
      'Then tell them the new worktree is in the sidebar and that its agent is already working on it.',
      '',
      'Keep it friendly and brief. Do not explain Ness at length — they will see that as they go.'
    ].join('\n')
  )
}
