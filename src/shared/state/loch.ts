// What a backend knows about loch on its own machine. Today that's only
// whether the CLI is there: the sidebar's "Install history tracking" prompt
// and the explainer's Install button are pointless without it. Probed at
// boot and again on request (after the user installs loch, say), so it can
// change while Ness runs.

export interface LochState {
  /** A `loch` binary was found (on PATH, or the copy Ness installed). */
  available: boolean
  /** Ness has a release it can download for this machine's platform, so
   *  history tracking can be offered even when loch isn't there yet. */
  installable: boolean
  /** Repo roots main is turning recording on for by itself, because they
   *  were added while `settings.lochRecordNewRepos` is on. Hides the
   *  sidebar prompt meanwhile; a repo whose install fails drops out of
   *  here without joining `lochRecordingRepos`, so the prompt comes back. */
  autoRecording: string[]
}

export type LochEvent =
  | { type: 'loch/availabilityChanged'; payload: boolean }
  | { type: 'loch/installableChanged'; payload: boolean }
  | { type: 'loch/autoRecordingChanged'; payload: { repoRoot: string; active: boolean } }

export const initialLoch: LochState = {
  available: false,
  installable: false,
  autoRecording: []
}

export function lochReducer(state: LochState, event: LochEvent): LochState {
  switch (event.type) {
    case 'loch/availabilityChanged':
      return state.available === event.payload ? state : { ...state, available: event.payload }
    case 'loch/installableChanged':
      return state.installable === event.payload ? state : { ...state, installable: event.payload }
    case 'loch/autoRecordingChanged': {
      const { repoRoot, active } = event.payload
      const has = state.autoRecording.includes(repoRoot)
      if (has === active) return state
      return {
        ...state,
        autoRecording: active
          ? [...state.autoRecording, repoRoot]
          : state.autoRecording.filter((r) => r !== repoRoot)
      }
    }
    default:
      return state
  }
}
