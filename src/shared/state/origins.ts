// Provenance: which agent Chat tab created a worktree. A plain fact about
// the worktree, recorded once at creation — implicit subscriptions are
// derived from it on read (see shared/subscribers.ts) rather than written
// out as subscription records of their own.

export interface WorktreeOrigin {
  creatorPath: string
  creatorTabId: string
  createdAt: number
}

export interface OriginsState {
  byPath: Record<string, WorktreeOrigin>
}

export type OriginsEvent =
  | { type: 'origins/recorded'; payload: { path: string; origin: WorktreeOrigin } }
  | { type: 'origins/cleared'; payload: string }

export const initialOrigins: OriginsState = {
  byPath: {}
}

export function originsReducer(state: OriginsState, event: OriginsEvent): OriginsState {
  switch (event.type) {
    case 'origins/recorded':
      return { ...state, byPath: { ...state.byPath, [event.payload.path]: event.payload.origin } }
    case 'origins/cleared': {
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
