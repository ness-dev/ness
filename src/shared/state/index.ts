// This file is the canonical definition of the app's shared world state.
// It's imported by BOTH the main process (which is the authoritative
// store) and the renderer (which keeps a passive mirror via
// useSyncExternalStore). The fact that the same reducer runs on both
// sides is what makes them stay in sync — the renderer never holds a
// local copy of anything in here.
//
// Adding a new piece of shared state is a 5-file edit; see CLAUDE.md
// "Adding a new piece of shared state — the 5-file checklist" for the
// pattern. Don't shortcut it with a useState in App.tsx unless the
// value is genuinely per-client (focus, modal visibility, sidebar
// width, etc.).

import {
  initialSettings,
  settingsReducer,
  type SettingsEvent,
  type SettingsState
} from './settings'
import {
  initialPRs,
  prsReducer,
  type PRsEvent,
  type PRsState
} from './prs'
import {
  initialOnboarding,
  onboardingReducer,
  type OnboardingEvent,
  type OnboardingState
} from './onboarding'
import {
  initialHooks,
  hooksReducer,
  type HooksEvent,
  type HooksState
} from './hooks'
import {
  initialWorktrees,
  worktreesReducer,
  type WorktreesEvent,
  type WorktreesState
} from './worktrees'
import {
  initialTerminals,
  terminalsReducer,
  type TerminalsEvent,
  type TerminalsState
} from './terminals'
import {
  initialUpdater,
  updaterReducer,
  type UpdaterEvent,
  type UpdaterState
} from './updater'
import {
  initialRepoConfigs,
  repoConfigsReducer,
  type RepoConfigsEvent,
  type RepoConfigsState
} from './repo-configs'
import {
  initialCosts,
  costsReducer,
  type CostsEvent,
  type CostsState
} from './costs'
import {
  initialContextWindow,
  contextWindowReducer,
  type ContextWindowEvent,
  type ContextWindowState
} from './context-window'
import {
  initialBrowser,
  browserReducer,
  type BrowserEvent,
  type BrowserState
} from './browser'
import {
  initialJsonClaude,
  jsonClaudeReducer,
  stripJsonClaudeEntries,
  type JsonClaudeEvent,
  type JsonClaudeState
} from './json-claude'
import {
  initialSnooze,
  snoozeReducer,
  type SnoozeEvent,
  type SnoozeState
} from './snooze'
import {
  initialCiNotify,
  ciNotifyReducer,
  type CiNotifyEvent,
  type CiNotifyState
} from './ci-notify'
import {
  initialPinned,
  pinnedReducer,
  type PinnedEvent,
  type PinnedState
} from './pinned'
import {
  initialAnnouncements,
  announcementsReducer,
  type AnnouncementsEvent,
  type AnnouncementsState
} from './announcements'
import {
  initialScratchpad,
  scratchpadReducer,
  type ScratchpadEvent,
  type ScratchpadState
} from './scratchpad'
import {
  initialSshBootstrap,
  sshBootstrapReducer,
  type SshBootstrapEvent,
  type SshBootstrapState
} from './ssh-bootstrap'
import {
  initialAssignedPRs,
  assignedPRsReducer,
  type AssignedPRsEvent,
  type AssignedPRsState
} from './assigned-prs'
import { initialConfigHealth, type ConfigHealthState } from './config-health'
import {
  initialAliases,
  aliasesReducer,
  type AliasesEvent,
  type AliasesState
} from './aliases'

export type { SettingsState, SettingsEvent }
export type { UpdaterState, UpdaterEvent, UpdaterStatus } from './updater'
export type {
  RepoConfigsState,
  RepoConfigsEvent,
  RepoConfig
} from './repo-configs'
export type { PRsState, PRsEvent, PRStatus, CheckStatus, PRReview } from './prs'
export type { OnboardingState, OnboardingEvent, QuestStep } from './onboarding'
export type { HooksState, HooksEvent, HooksConsent } from './hooks'
export type {
  WorktreesState,
  WorktreesEvent,
  Worktree,
  PendingWorktree,
  PendingStatus
} from './worktrees'
export type {
  CostsState,
  CostsEvent,
  ModelTally,
  SessionUsage,
  ContentBreakdown
} from './costs'
export {
  totalForSession,
  addBreakdown,
  cloneBreakdown,
  emptyBreakdown
} from './costs'
export type {
  ContextWindowState,
  ContextWindowEvent,
  ContextSnapshot,
  ContextCategories
} from './context-window'
export {
  emptyCategories,
  cloneCategories,
  totalCategories
} from './context-window'
export type {
  TerminalsState,
  TerminalsEvent,
  PtyStatus,
  PendingTool,
  ShellActivity,
  TerminalSession,
  TerminalTab,
  WorkspacePane,
  PaneNode,
  PaneLeaf,
  PaneSplit,
  SplitDirection
} from './terminals'
export {
  getLeaves,
  findLeaf,
  findLeafByTabId,
  findTabById,
  hasAnyTabs,
  mapLeaves,
  replaceNode,
  removeLeaf
} from './terminals'

export type { BrowserState, BrowserEvent, BrowserTabState } from './browser'
export type {
  JsonClaudeState,
  JsonClaudeEvent,
  JsonClaudeSession,
  JsonClaudeSessionState,
  JsonClaudeChatEntry,
  JsonClaudeMessageBlock,
  JsonClaudePendingApproval
} from './json-claude'
export type { SnoozeState, SnoozeEvent, SnoozeEntry } from './snooze'
export { MAX_WAKE } from './snooze'
export type { CiNotifyState, CiNotifyEvent } from './ci-notify'
export { isCiNotifyEnabled } from './ci-notify'
export type { PinnedState, PinnedEvent } from './pinned'
export type {
  AnnouncementsState,
  AnnouncementsEvent,
  Announcement
} from './announcements'
export type { ScratchpadState, ScratchpadEvent } from './scratchpad'
export type {
  SshBootstrapState,
  SshBootstrapEvent,
  BootstrapPhase,
  BootstrapProgress,
  BootstrapError
} from './ssh-bootstrap'
export type { AssignedPRsState, AssignedPRsEvent, AssignedPR } from './assigned-prs'
export type { ConfigHealthState, ConfigLoadError } from './config-health'
export type { AliasesState, AliasesEvent } from './aliases'

export interface AppState {
  settings: SettingsState
  prs: PRsState
  onboarding: OnboardingState
  hooks: HooksState
  worktrees: WorktreesState
  terminals: TerminalsState
  updater: UpdaterState
  repoConfigs: RepoConfigsState
  costs: CostsState
  contextWindow: ContextWindowState
  browser: BrowserState
  jsonClaude: JsonClaudeState
  snooze: SnoozeState
  ciNotify: CiNotifyState
  pinned: PinnedState
  announcements: AnnouncementsState
  scratchpad: ScratchpadState
  sshBootstrap: SshBootstrapState
  assignedPRs: AssignedPRsState
  configHealth: ConfigHealthState
  aliases: AliasesState
}

export type StateEvent =
  | SettingsEvent
  | PRsEvent
  | OnboardingEvent
  | HooksEvent
  | WorktreesEvent
  | TerminalsEvent
  | UpdaterEvent
  | RepoConfigsEvent
  | CostsEvent
  | ContextWindowEvent
  | BrowserEvent
  | JsonClaudeEvent
  | SnoozeEvent
  | CiNotifyEvent
  | PinnedEvent
  | AnnouncementsEvent
  | ScratchpadEvent
  | SshBootstrapEvent
  | AssignedPRsEvent
  | AliasesEvent

export const initialState: AppState = {
  settings: initialSettings,
  prs: initialPRs,
  onboarding: initialOnboarding,
  hooks: initialHooks,
  worktrees: initialWorktrees,
  terminals: initialTerminals,
  updater: initialUpdater,
  repoConfigs: initialRepoConfigs,
  costs: initialCosts,
  contextWindow: initialContextWindow,
  browser: initialBrowser,
  jsonClaude: initialJsonClaude,
  snooze: initialSnooze,
  ciNotify: initialCiNotify,
  pinned: initialPinned,
  announcements: initialAnnouncements,
  scratchpad: initialScratchpad,
  sshBootstrap: initialSshBootstrap,
  assignedPRs: initialAssignedPRs,
  configHealth: initialConfigHealth,
  aliases: initialAliases
}

export function rootReducer(state: AppState, event: StateEvent): AppState {
  if (event.type.startsWith('settings/')) {
    return {
      ...state,
      settings: settingsReducer(state.settings, event as SettingsEvent)
    }
  }
  if (event.type.startsWith('prs/')) {
    return { ...state, prs: prsReducer(state.prs, event as PRsEvent) }
  }
  if (event.type.startsWith('onboarding/')) {
    return {
      ...state,
      onboarding: onboardingReducer(state.onboarding, event as OnboardingEvent)
    }
  }
  if (event.type.startsWith('hooks/')) {
    return { ...state, hooks: hooksReducer(state.hooks, event as HooksEvent) }
  }
  if (event.type.startsWith('worktrees/')) {
    return {
      ...state,
      worktrees: worktreesReducer(state.worktrees, event as WorktreesEvent)
    }
  }
  if (event.type.startsWith('terminals/')) {
    return {
      ...state,
      terminals: terminalsReducer(state.terminals, event as TerminalsEvent)
    }
  }
  if (event.type.startsWith('updater/')) {
    return { ...state, updater: updaterReducer(state.updater, event as UpdaterEvent) }
  }
  if (event.type.startsWith('repoConfigs/')) {
    return {
      ...state,
      repoConfigs: repoConfigsReducer(state.repoConfigs, event as RepoConfigsEvent)
    }
  }
  if (event.type.startsWith('costs/')) {
    return { ...state, costs: costsReducer(state.costs, event as CostsEvent) }
  }
  if (event.type.startsWith('contextWindow/')) {
    return {
      ...state,
      contextWindow: contextWindowReducer(
        state.contextWindow,
        event as ContextWindowEvent
      )
    }
  }
  if (event.type.startsWith('browser/')) {
    return { ...state, browser: browserReducer(state.browser, event as BrowserEvent) }
  }
  if (event.type.startsWith('jsonClaude/')) {
    return {
      ...state,
      jsonClaude: jsonClaudeReducer(state.jsonClaude, event as JsonClaudeEvent)
    }
  }
  if (event.type.startsWith('snooze/')) {
    return {
      ...state,
      snooze: snoozeReducer(state.snooze, event as SnoozeEvent)
    }
  }
  if (event.type.startsWith('ciNotify/')) {
    return {
      ...state,
      ciNotify: ciNotifyReducer(state.ciNotify, event as CiNotifyEvent)
    }
  }
  if (event.type.startsWith('pinned/')) {
    return {
      ...state,
      pinned: pinnedReducer(state.pinned, event as PinnedEvent)
    }
  }
  if (event.type.startsWith('announcements/')) {
    return {
      ...state,
      announcements: announcementsReducer(state.announcements, event as AnnouncementsEvent)
    }
  }
  if (event.type.startsWith('scratchpad/')) {
    return {
      ...state,
      scratchpad: scratchpadReducer(state.scratchpad, event as ScratchpadEvent)
    }
  }
  if (event.type.startsWith('sshBootstrap/')) {
    return {
      ...state,
      sshBootstrap: sshBootstrapReducer(state.sshBootstrap, event as SshBootstrapEvent)
    }
  }
  if (event.type.startsWith('assignedPRs/')) {
    return {
      ...state,
      assignedPRs: assignedPRsReducer(state.assignedPRs, event as AssignedPRsEvent)
    }
  }
  if (event.type.startsWith('aliases/')) {
    return {
      ...state,
      aliases: aliasesReducer(state.aliases, event as AliasesEvent)
    }
  }
  // configHealth has no events — it's seeded at construction only (see
  // config-health.ts), so there's no reducer branch. The field flows through
  // unchanged via the `...state` spreads above.
  return state
}

export interface StateSnapshot {
  state: AppState
  seq: number
}

/** Snapshot shape as it comes off the wire. Each slice may be entirely
 *  absent (older server with a not-yet-existing slice) or present but
 *  missing recently-added fields (older server with the slice but an
 *  older schema). Consumers must merge with `initialState` defaults via
 *  `mergeWireSnapshot` before treating the value as a full `AppState`. */
export type WireSnapshotState = {
  [K in keyof AppState]?: Partial<AppState[K]>
}

/** Per-slice shallow merge of a wire snapshot against `initialState`
 *  defaults. Protects against two version skews:
 *
 *   1. Older server is missing an entire slice (e.g. `snooze` added after
 *      the server shipped) — `initialState[slice]` fills it in.
 *   2. Older server has the slice but is missing a recently-added field
 *      (e.g. `settings.customThemes` added in 99262b2 after v2.9.3) —
 *      the per-field default from `initialState[slice]` fills it in.
 *
 *  If a future PR adds a slice to `AppState`/`initialState` and forgets
 *  to add a line here, TypeScript will fail the build: the object
 *  literal won't satisfy `AppState`. */
export function mergeWireSnapshot(state: WireSnapshotState): AppState {
  return {
    settings: { ...initialState.settings, ...state.settings },
    prs: { ...initialState.prs, ...state.prs },
    onboarding: { ...initialState.onboarding, ...state.onboarding },
    hooks: { ...initialState.hooks, ...state.hooks },
    worktrees: { ...initialState.worktrees, ...state.worktrees },
    terminals: { ...initialState.terminals, ...state.terminals },
    updater: { ...initialState.updater, ...state.updater },
    repoConfigs: { ...initialState.repoConfigs, ...state.repoConfigs },
    costs: { ...initialState.costs, ...state.costs },
    contextWindow: { ...initialState.contextWindow, ...state.contextWindow },
    browser: { ...initialState.browser, ...state.browser },
    jsonClaude: { ...initialState.jsonClaude, ...state.jsonClaude },
    snooze: { ...initialState.snooze, ...state.snooze },
    ciNotify: { ...initialState.ciNotify, ...state.ciNotify },
    pinned: { ...initialState.pinned, ...state.pinned },
    announcements: { ...initialState.announcements, ...state.announcements },
    scratchpad: { ...initialState.scratchpad, ...state.scratchpad },
    sshBootstrap: { ...initialState.sshBootstrap, ...state.sshBootstrap },
    assignedPRs: { ...initialState.assignedPRs, ...state.assignedPRs },
    configHealth: { ...initialState.configHealth, ...state.configHealth },
    aliases: { ...initialState.aliases, ...state.aliases }
  }
}

/** Returns a snapshot with `jsonClaude.sessions[*].entries` elided.
 *  Transports call this before serializing the initial-snapshot frame to
 *  keep the wire payload bounded by the rest of the state — entries grow
 *  unboundedly with chat history. Renderers fill them in lazily on first
 *  JsonModeChat mount via `jsonClaude:getEntries`. */
export function stripSnapshotForWire(snapshot: StateSnapshot): StateSnapshot {
  return {
    ...snapshot,
    state: {
      ...snapshot.state,
      jsonClaude: stripJsonClaudeEntries(snapshot.state.jsonClaude)
    }
  }
}
