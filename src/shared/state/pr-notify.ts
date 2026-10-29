// Per-worktree overrides for "inject a message into the agent chat when
// something happens on the PR". Each kind is independent: an absent kind
// means "inherit the matching global setting"; a present one is an explicit
// per-worktree choice.

import type { SettingsState } from './settings'

export type PrNotifyKind = 'ci' | 'comments' | 'conflicts'

export const PR_NOTIFY_KINDS: readonly PrNotifyKind[] = ['ci', 'comments', 'conflicts']

export type PrNotifyOverrides = Partial<Record<PrNotifyKind, boolean>>

export interface PrNotifyState {
  byPath: Record<string, PrNotifyOverrides>
}

export type PrNotifyEvent =
  | { type: 'prNotify/set'; payload: { path: string; kind: PrNotifyKind; enabled: boolean } }
  | { type: 'prNotify/clear'; payload: { path: string; kind: PrNotifyKind } }
  | { type: 'prNotify/pathRemoved'; payload: string }

export const initialPrNotify: PrNotifyState = {
  byPath: {}
}

export function isPrNotifyKind(value: unknown): value is PrNotifyKind {
  return typeof value === 'string' && (PR_NOTIFY_KINDS as readonly string[]).includes(value)
}

export function prNotifyGlobalDefault(
  settings: Pick<
    SettingsState,
    'notifyChatOnCiFailure' | 'notifyChatOnPrComments' | 'notifyChatOnMergeConflict'
  >,
  kind: PrNotifyKind
): boolean {
  switch (kind) {
    case 'ci':
      return settings.notifyChatOnCiFailure
    case 'comments':
      return settings.notifyChatOnPrComments
    case 'conflicts':
      return settings.notifyChatOnMergeConflict
  }
}

/** Effective per-worktree value: explicit override wins, otherwise the
 *  global default. */
export function isPrNotifyEnabled(
  state: PrNotifyState,
  path: string,
  kind: PrNotifyKind,
  globalDefault: boolean
): boolean {
  return state.byPath[path]?.[kind] ?? globalDefault
}

export function prNotifyReducer(
  state: PrNotifyState,
  event: PrNotifyEvent
): PrNotifyState {
  switch (event.type) {
    case 'prNotify/set': {
      const { path, kind, enabled } = event.payload
      const current = state.byPath[path]
      if (current?.[kind] === enabled) return state
      return {
        ...state,
        byPath: { ...state.byPath, [path]: { ...current, [kind]: enabled } }
      }
    }
    case 'prNotify/clear': {
      const { path, kind } = event.payload
      const current = state.byPath[path]
      if (!current || !(kind in current)) return state
      const rest = { ...current }
      delete rest[kind]
      const byPath = { ...state.byPath }
      if (Object.keys(rest).length === 0) delete byPath[path]
      else byPath[path] = rest
      return { ...state, byPath }
    }
    case 'prNotify/pathRemoved': {
      if (!(event.payload in state.byPath)) return state
      const byPath = { ...state.byPath }
      delete byPath[event.payload]
      return { ...state, byPath }
    }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}

/** Accepts both the current per-kind shape and the legacy `ciNotify`
 *  config (path → boolean), which only ever described CI failures. */
export function prNotifyFromConfig(
  current: Record<string, PrNotifyOverrides> | undefined,
  legacyCi: Record<string, boolean> | undefined
): PrNotifyState {
  const byPath: Record<string, PrNotifyOverrides> = {}
  for (const [path, enabled] of Object.entries(legacyCi ?? {})) {
    if (typeof enabled === 'boolean') byPath[path] = { ci: enabled }
  }
  for (const [path, overrides] of Object.entries(current ?? {})) {
    if (!overrides || typeof overrides !== 'object') continue
    const clean: PrNotifyOverrides = {}
    for (const kind of PR_NOTIFY_KINDS) {
      if (typeof overrides[kind] === 'boolean') clean[kind] = overrides[kind]
    }
    if (Object.keys(clean).length > 0) byPath[path] = { ...byPath[path], ...clean }
  }
  return Object.keys(byPath).length === 0 ? initialPrNotify : { byPath }
}
