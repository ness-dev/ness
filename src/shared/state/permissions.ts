// Global tool-permission allowlist — the "Always allow" grants from the
// json-mode approval card.
//
// Deliberately global rather than per-repo or per-worktree: the thing that
// made the old `.claude/settings.local.json` approach useless was that a
// grant only applied where it was made. See `shared/permission-match.ts`
// for why Ness owns this list instead of delegating to Claude's settings
// writer.
//
// Only the json-mode approval path consults this. Terminal tabs spawn the
// user's PATH `claude`, which prompts in its own TUI and persists to its
// own settings files — those grants are independent and Ness never sees
// them.

import {
  ruleKey,
  type PermissionRule,
  type StoredPermissionRule
} from '../permission-match'

export type { PermissionRule, StoredPermissionRule }

export interface PermissionsState {
  /** Insertion-ordered. The matcher short-circuits on the first hit, so
   *  order is observable only in which rule gets attributed in the log. */
  rules: StoredPermissionRule[]
  /** repoRoot → the .ness.json setupCommand the user last allowed an
   *  agent's create_worktree to run there. While the repo's command still
   *  equals this, create_worktree runs without asking; once it changes, the
   *  next one asks again. See shared/ness-tool-policy.ts. */
  approvedSetupCommands: Record<string, string>
}

export const initialPermissions: PermissionsState = {
  rules: [],
  approvedSetupCommands: {}
}

export type PermissionsEvent =
  | { type: 'permissions/loaded'; payload: { rules: StoredPermissionRule[] } }
  | { type: 'permissions/granted'; payload: { rule: StoredPermissionRule } }
  | { type: 'permissions/revoked'; payload: { id: string } }
  | { type: 'permissions/cleared' }
  | { type: 'permissions/setupCommandApproved'; payload: { repoRoot: string; command: string } }
  | { type: 'permissions/setupCommandForgotten'; payload: { repoRoot: string } }

export function permissionsReducer(
  state: PermissionsState,
  event: PermissionsEvent
): PermissionsState {
  switch (event.type) {
    case 'permissions/loaded':
      return { ...state, rules: event.payload.rules }
    case 'permissions/granted': {
      const { rule } = event.payload
      const key = ruleKey(rule)
      // Re-granting an identical rule is a no-op rather than a duplicate
      // row — the card can't tell whether a grant already exists when the
      // suggestion was picked, and silently stacking copies would make
      // the Settings list unreadable.
      if (state.rules.some((r) => ruleKey(r) === key)) return state
      return { ...state, rules: [...state.rules, rule] }
    }
    case 'permissions/revoked': {
      const idx = state.rules.findIndex((r) => r.id === event.payload.id)
      if (idx === -1) return state
      return {
        ...state,
        rules: [...state.rules.slice(0, idx), ...state.rules.slice(idx + 1)]
      }
    }
    case 'permissions/cleared':
      // Clearing every grant also forgets approved setup commands: both are
      // "run this without asking me".
      if (state.rules.length === 0 && Object.keys(state.approvedSetupCommands).length === 0) {
        return state
      }
      return { rules: [], approvedSetupCommands: {} }
    case 'permissions/setupCommandApproved': {
      const { repoRoot, command } = event.payload
      if (state.approvedSetupCommands[repoRoot] === command) return state
      return {
        ...state,
        approvedSetupCommands: { ...state.approvedSetupCommands, [repoRoot]: command }
      }
    }
    case 'permissions/setupCommandForgotten': {
      if (!(event.payload.repoRoot in state.approvedSetupCommands)) return state
      const { [event.payload.repoRoot]: _dropped, ...rest } = state.approvedSetupCommands
      void _dropped
      return { ...state, approvedSetupCommands: rest }
    }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}
