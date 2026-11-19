// What a backend knows about loch on its own machine. Today that's only
// whether the CLI is there: the sidebar's "Install history tracking" prompt
// and the explainer's Install button are pointless without it. Probed at
// boot and again on request (after the user installs loch, say), so it can
// change while Ness runs.

export interface LochState {
  /** The `loch` binary was found on this backend's PATH. */
  available: boolean
}

export type LochEvent = { type: 'loch/availabilityChanged'; payload: boolean }

export const initialLoch: LochState = {
  available: false
}

export function lochReducer(state: LochState, event: LochEvent): LochState {
  switch (event.type) {
    case 'loch/availabilityChanged':
      return state.available === event.payload ? state : { ...state, available: event.payload }
    default:
      return state
  }
}
