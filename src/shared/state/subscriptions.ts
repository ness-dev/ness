// Explicit subscriptions: one agent Chat tab that asked, via
// subscribe_to_worktree, to follow another worktree. The subscriber is a
// tab, not a worktree: updates have to land in the conversation that asked
// for them, and a worktree can hold several unrelated chats.
//
// Only explicit ones are stored. Implicit followers (e.g. the tab that
// created a worktree) are derived from source data on read — see
// shared/subscribers.ts, which is what every consumer should go through.

/** How a non-urgent update reaches the subscriber. Urgent ones (CI
 *  failing, the PR finishing, a progress report flagged urgent) always
 *  interrupt. */
export type NotifyMode = 'interrupt' | 'silent'

export interface WorktreeSubscription {
  id: string
  subscriberPath: string
  subscriberTabId: string
  targetPath: string
  /** Why the subscriber is watching, in its own words. Relayed to the
   *  target agent so its progress reports can be pitched at that. */
  note?: string
  /** Absent ⇒ 'interrupt'. */
  mode?: NotifyMode
  createdAt: number
}

export interface SubscriptionsState {
  list: WorktreeSubscription[]
}

export type SubscriptionsEvent =
  | { type: 'subscriptions/added'; payload: WorktreeSubscription }
  | { type: 'subscriptions/removed'; payload: { ids: string[] } }

export const initialSubscriptions: SubscriptionsState = {
  list: []
}

export function findSubscription(
  state: SubscriptionsState,
  subscriberTabId: string,
  targetPath: string
): WorktreeSubscription | undefined {
  return state.list.find(
    (s) => s.subscriberTabId === subscriberTabId && s.targetPath === targetPath
  )
}

export function explicitSubscribersOf(
  state: SubscriptionsState,
  targetPath: string
): WorktreeSubscription[] {
  return state.list.filter((s) => s.targetPath === targetPath)
}

export function explicitSubscriptionsOfTab(
  state: SubscriptionsState,
  subscriberTabId: string
): WorktreeSubscription[] {
  return state.list.filter((s) => s.subscriberTabId === subscriberTabId)
}

export function subscriptionsReducer(
  state: SubscriptionsState,
  event: SubscriptionsEvent
): SubscriptionsState {
  switch (event.type) {
    case 'subscriptions/added': {
      const sub = event.payload
      // One subscription per (tab, target): re-subscribing replaces the
      // note and mode rather than stacking a second copy of every update.
      const i = state.list.findIndex(
        (s) => s.subscriberTabId === sub.subscriberTabId && s.targetPath === sub.targetPath
      )
      if (i === -1) return { ...state, list: [...state.list, sub] }
      const cur = state.list[i]
      if (cur.note === sub.note && cur.mode === sub.mode) return state
      const patched = { ...cur, note: sub.note, mode: sub.mode }
      return { ...state, list: [...state.list.slice(0, i), patched, ...state.list.slice(i + 1)] }
    }
    case 'subscriptions/removed': {
      const ids = new Set(event.payload.ids)
      if (!state.list.some((s) => ids.has(s.id))) return state
      return { ...state, list: state.list.filter((s) => !ids.has(s.id)) }
    }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}
