// The sidebar "Install history tracking" prompt reads loch + settings
// fields off BackendStateEntry. Entries are reused while their key deps
// are unchanged, so a field the prompt reads but the key omits leaves the
// prompt showing after the user installs or dismisses — until some
// unrelated sidebar slice happens to change.

import { describe, it, expect } from 'vitest'
import { initialState, rootReducer, type AppState, type StateEvent } from '../shared/state'
import { SegmentedSelector } from './backend-segments'
import { backendStateEntryDeps, selectHistoryPromptRepos, type BackendStateEntry } from './store'

function makeSelector(): (state: AppState) => readonly string[] {
  const selector = new SegmentedSelector<{ state: AppState; connection: undefined }, BackendStateEntry>(
    backendStateEntryDeps,
    (source, backendId) => ({ backendId, label: backendId, kind: 'local', state: source.state })
  )
  return (state) =>
    selectHistoryPromptRepos(
      selector.select([{ id: 'local', state: { state, connection: undefined } }]).map((s) => s.value)
    )
}

const base: AppState = rootReducer(
  rootReducer(initialState, { type: 'loch/availabilityChanged', payload: true }),
  { type: 'worktrees/reposChanged', payload: ['/repo'] }
)

describe('selectHistoryPromptRepos through the backend-state segments', () => {
  it('prompts for a repo that is not recording', () => {
    expect(makeSelector()(base)).toEqual(['/repo'])
  })

  const cases: [string, StateEvent][] = [
    ['recording starts', { type: 'settings/lochRecordingReposChanged', payload: ['/repo'] }],
    ['prompt is dismissed', { type: 'settings/lochPromptDismissedReposChanged', payload: ['/repo'] }],
    ['blame gutter is turned off', { type: 'settings/lochBlameEnabledChanged', payload: false }],
    ['loch becomes unavailable', { type: 'loch/availabilityChanged', payload: false }]
  ]
  for (const [name, event] of cases) {
    it(`drops the prompt when ${name}`, () => {
      const select = makeSelector()
      expect(select(base)).toEqual(['/repo'])
      expect(select(rootReducer(base, event))).toEqual([])
    })
  }

  it('drops the prompt when loch stops being installable', () => {
    const installableOnly = rootReducer(
      rootReducer(base, { type: 'loch/availabilityChanged', payload: false }),
      { type: 'loch/installableChanged', payload: true }
    )
    const select = makeSelector()
    expect(select(installableOnly)).toEqual(['/repo'])
    expect(select(rootReducer(installableOnly, { type: 'loch/installableChanged', payload: false }))).toEqual([])
  })
})
