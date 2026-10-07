export interface PinnedState {
  byPath: Record<string, true>
}

export type PinnedEvent =
  | { type: 'pinned/set'; payload: string }
  | { type: 'pinned/clear'; payload: string }

export const initialPinned: PinnedState = {
  byPath: {}
}

export function pinnedReducer(state: PinnedState, event: PinnedEvent): PinnedState {
  switch (event.type) {
    case 'pinned/set': {
      if (state.byPath[event.payload]) return state
      return { ...state, byPath: { ...state.byPath, [event.payload]: true } }
    }
    case 'pinned/clear': {
      if (!(event.payload in state.byPath)) return state
      const next = { ...state.byPath }
      delete next[event.payload]
      return { ...state, byPath: next }
    }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}
