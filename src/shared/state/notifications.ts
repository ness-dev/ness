// Silent notifications held for a Chat tab. An interrupt-mode notification
// is delivered as its own turn and wakes the tab; a silent one waits here
// and rides along with the next turn the tab takes, whoever sends it — the
// user typing, or the next interrupt. ChatRouter.send is what drains it.
//
// Keyed by tab id (a Chat tab's id is its session id). Not persisted: a
// held notice is "nice to know", and the next poll restates PR state anyway.

import type { JsonClaudeAutomationSource } from './json-claude'

export interface PendingNotice {
  id: string
  source: JsonClaudeAutomationSource
  from?: string
  /** The sentinel-wrapped text exactly as it will be written to the agent. */
  wire: string
  queuedAt: number
}

export interface NotificationsState {
  pendingByTab: Record<string, PendingNotice[]>
}

export type NotificationsEvent =
  | { type: 'notifications/queued'; payload: { tabId: string; notice: PendingNotice } }
  | { type: 'notifications/drained'; payload: { tabIds: string[] } }

export const initialNotifications: NotificationsState = {
  pendingByTab: {}
}

/** More than this and the oldest are dropped — a tab nobody has spoken to
 *  in days shouldn't open with a wall of stale updates. */
export const MAX_PENDING_PER_TAB = 20

export function notificationsReducer(
  state: NotificationsState,
  event: NotificationsEvent
): NotificationsState {
  switch (event.type) {
    case 'notifications/queued': {
      const { tabId, notice } = event.payload
      const prev = state.pendingByTab[tabId] ?? []
      const next = [...prev, notice].slice(-MAX_PENDING_PER_TAB)
      return { ...state, pendingByTab: { ...state.pendingByTab, [tabId]: next } }
    }
    case 'notifications/drained': {
      const hit = event.payload.tabIds.filter((id) => id in state.pendingByTab)
      if (hit.length === 0) return state
      const next = { ...state.pendingByTab }
      for (const id of hit) delete next[id]
      return { ...state, pendingByTab: next }
    }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}
