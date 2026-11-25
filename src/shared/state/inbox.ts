// Inbox: the "what needs me next, and why?" view of every agent tab.
//
// Status alone can't answer that — every agent that finished a turn reads
// 'waiting' forever, whether it asked you something an hour ago or you
// already read its reply. So the inbox keeps two extra facts per tab:
//
//   - `turns`: how the tab's most recent turn ended (a question, or just
//     done) plus one line of the agent's last message. Derived in main by
//     InboxDeriver, because chat entries are stripped from the wire
//     snapshot and terminal tabs only expose their transcript to main.
//   - `seenAt`: when the user last looked at the tab. A turn that ended
//     after that is unread. Shared state, so clearing it on the desktop
//     also clears it on the phone.
//
// `statusSince` records when each tab entered its current status, so the
// needs-you sections can sort oldest-first; terminals.statuses carries no
// timestamp. `prSeen` holds the fingerprint of the PR event the user last
// saw per worktree, so a new event (a fresh CI failure on a new commit)
// resurfaces without anything having to be "unseen".

import type { PtyStatus } from './terminals'

export type InboxTurnKind = 'question' | 'finished'

export interface InboxTurn {
  worktreePath: string
  /** Epoch ms, stamped in main. */
  endedAt: number
  kind: InboxTurnKind
  /** One line from the agent's last message; '' when none is available
   *  (Codex/Cursor terminal tabs, or an interrupted turn). */
  text: string
}

export interface InboxState {
  turns: Record<string, InboxTurn>
  /** Tab id → epoch ms the user last viewed it. */
  seenAt: Record<string, number>
  /** Tab id → epoch ms its status last changed value. Not persisted:
   *  statuses themselves don't survive a restart. */
  statusSince: Record<string, { status: PtyStatus; since: number }>
  /** Worktree path → fingerprint of the PR event last seen there. */
  prSeen: Record<string, string>
}

export type InboxEvent =
  | { type: 'inbox/turnEnded'; payload: { tabId: string; turn: InboxTurn } }
  | { type: 'inbox/seen'; payload: { tabId: string; ts: number } }
  | { type: 'inbox/prSeen'; payload: { worktreePath: string; fingerprint: string } }
  | {
      type: 'inbox/statusSince'
      payload: { tabId: string; status: PtyStatus; since: number }
    }
  /** Drop every record for tabs that no longer exist. */
  | { type: 'inbox/tabsForgotten'; payload: { tabIds: string[] } }

export const initialInbox: InboxState = {
  turns: {},
  seenAt: {},
  statusSince: {},
  prSeen: {}
}

/** True when the tab's last turn ended after the user last looked. */
export function isTurnUnread(state: InboxState, tabId: string): boolean {
  const turn = state.turns[tabId]
  if (!turn) return false
  return turn.endedAt > (state.seenAt[tabId] ?? 0)
}

function omitKeys<T>(rec: Record<string, T>, keys: string[]): Record<string, T> {
  let next: Record<string, T> | null = null
  for (const k of keys) {
    if (!(k in rec)) continue
    if (!next) next = { ...rec }
    delete next[k]
  }
  return next ?? rec
}

export function inboxReducer(state: InboxState, event: InboxEvent): InboxState {
  switch (event.type) {
    case 'inbox/turnEnded': {
      const { tabId, turn } = event.payload
      const prev = state.turns[tabId]
      if (
        prev &&
        prev.endedAt === turn.endedAt &&
        prev.kind === turn.kind &&
        prev.text === turn.text &&
        prev.worktreePath === turn.worktreePath
      ) {
        return state
      }
      return { ...state, turns: { ...state.turns, [tabId]: turn } }
    }
    case 'inbox/seen': {
      const { tabId, ts } = event.payload
      // Monotonic: a late-arriving mark from a second client can't make
      // an already-read turn unread again.
      if ((state.seenAt[tabId] ?? 0) >= ts) return state
      return { ...state, seenAt: { ...state.seenAt, [tabId]: ts } }
    }
    case 'inbox/prSeen': {
      const { worktreePath, fingerprint } = event.payload
      if (state.prSeen[worktreePath] === fingerprint) return state
      return { ...state, prSeen: { ...state.prSeen, [worktreePath]: fingerprint } }
    }
    case 'inbox/statusSince': {
      const { tabId, status, since } = event.payload
      if (state.statusSince[tabId]?.status === status) return state
      return {
        ...state,
        statusSince: { ...state.statusSince, [tabId]: { status, since } }
      }
    }
    case 'inbox/tabsForgotten': {
      const { tabIds } = event.payload
      const turns = omitKeys(state.turns, tabIds)
      const seenAt = omitKeys(state.seenAt, tabIds)
      const statusSince = omitKeys(state.statusSince, tabIds)
      if (
        turns === state.turns &&
        seenAt === state.seenAt &&
        statusSince === state.statusSince
      ) {
        return state
      }
      return { ...state, turns, seenAt, statusSince }
    }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}
