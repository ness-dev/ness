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
//   - the kickoff tab is closed before its agent made a worktree → back
//     to popout 1, so the user isn't left in a step that shows nothing
//   - the tour's project or worktree disappears → end the tour, rather
//     than leave it pointing at a row that will never come back

import type { Store } from './store'
import type { Config } from './persistence'
import type { AppState, StateEvent } from '../shared/state'
import type { TourState } from '../shared/state/onboarding'
import { wrapAutomatedMessage } from '../shared/state/json-claude'
import { getLeaves } from '../shared/state/terminals'

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
    if (
      tour.step === 'awaiting-worktree' &&
      (event.type === 'terminals/panesForWorktreeChanged' ||
        event.type === 'terminals/panesForWorktreeCleared' ||
        event.type === 'terminals/panesReplaced')
    ) {
      // Scoped to the one worktree holding the kickoff tab.
      if (event.type === 'terminals/panesForWorktreeChanged' && event.payload.worktreePath !== tour.kickoffPath) return
      if (event.type === 'terminals/panesForWorktreeCleared' && event.payload !== tour.kickoffPath) return
      if (!hasTab(state, tour.kickoffPath, tour.kickoffTabId)) {
        store.dispatch({ type: 'onboarding/tourKickoffClosed' })
      }
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

function hasTab(state: AppState, path: string | undefined, tabId: string | undefined): boolean {
  if (!path || !tabId) return false
  const tree = state.terminals.panes[path]
  if (!tree) return false
  return getLeaves(tree).some((leaf) => leaf.tabs.some((t) => t.id === tabId))
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
      'This is the user\'s first time using Ness. They just added their own project and pressed "Start something new" on its main workspace. This message is hidden from them; your reply is the first thing they read.',
      '',
      'Your job is to teach them how Ness works by getting one real task going. They know this codebase far better than you, so do not explore the repo, summarize it, or suggest tasks from it unless they ask.',
      '',
      '1. Greet them and explain the idea in a few short lines: this main workspace chat is where they ask for work. Each task gets its own worktree, an isolated copy of the project on its own branch with its own agent, so several tasks can run in parallel without touching each other or their checkout. The dots in the sidebar show which agents are working, waiting, or need approval.',
      '2. Ask what they would like to build or fix first. Anything is fine, big or small.',
      '3. When they answer, do not do the work here. Create a worktree for it with the ness-control `create_worktree` tool, with a thorough `initialPrompt` that gives the new agent everything it needs to work on its own, and a short Title Case `alias`.',
      '4. Then tell them where to go next: the new worktree is in the sidebar and its agent has already started; click it to watch or chat with that agent, which can also take them through opening a pull request when it is done. They can come back here any time to start another task alongside it.',
      '',
      'Keep it friendly and brief: a few sentences per message, no long lists or headings.'
    ].join('\n')
  )
}
