/** A piece of user-facing copy an agent handed to the human via the
 *  `edit_copy` MCP tool. The agent's tool call stays blocked in main until
 *  the human submits or dismisses it, so an entry here always has a live
 *  HTTP request behind it — see CopyDraftBroker. */
export interface CopyDraftRequest {
  id: string
  /** The tab that made the call. For Chat tabs this is the session id. */
  terminalId: string
  worktreePath: string
  draft: string
  /** What the copy is for ("Settings empty-state headline"). */
  title?: string
  /** Where it lands and any constraints the human should know about. */
  context?: string
  timestamp: number
}

export interface CopyDraftsState {
  pending: Record<string, CopyDraftRequest>
}

export const initialCopyDrafts: CopyDraftsState = {
  pending: {}
}

export type CopyDraftsEvent =
  | { type: 'copyDrafts/requested'; payload: CopyDraftRequest }
  | { type: 'copyDrafts/resolved'; payload: { id: string; terminalId: string } }

export function copyDraftsReducer(
  state: CopyDraftsState,
  event: CopyDraftsEvent
): CopyDraftsState {
  switch (event.type) {
    case 'copyDrafts/requested': {
      const req = event.payload
      return { ...state, pending: { ...state.pending, [req.id]: req } }
    }
    case 'copyDrafts/resolved': {
      const { id } = event.payload
      if (!(id in state.pending)) return state
      const next = { ...state.pending }
      delete next[id]
      return { ...state, pending: next }
    }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}

/** Oldest pending draft for one tab. A tab can only have one tool call in
 *  flight per turn in practice, but parallel tool calls are legal, so the
 *  UI shows them one at a time in arrival order. */
export function firstDraftForTerminal(
  state: CopyDraftsState,
  terminalId: string
): CopyDraftRequest | null {
  let first: CopyDraftRequest | null = null
  for (const req of Object.values(state.pending)) {
    if (req.terminalId !== terminalId) continue
    if (!first || req.timestamp < first.timestamp) first = req
  }
  return first
}
