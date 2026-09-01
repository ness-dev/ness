import type { JsonClaudePermissionMode } from './json-claude'

export interface WorktreeScripts {
  setup: string
  teardown: string
}

export type MergeStrategy = 'squash' | 'merge-commit' | 'fast-forward'
export type WorktreeBase = 'remote' | 'local'
/** Density of each sidebar worktree row. `comfy` stacks the label and
 *  detail cluster on two lines; `compact` folds the detail cluster onto
 *  the right of a single line. The pending-tool alert (needs-approval)
 *  always uses the two-line layout regardless of this setting — that
 *  signal is too important to hide. */
export type SidebarDensity = 'compact' | 'comfy'

/** Per-item toggles for the sidebar row's detail cluster. Each `true`
 *  means the item shows when it has data to show (e.g. `assignee` only
 *  renders when a PR actually has an assignee). Set to `false` to hide
 *  the item entirely regardless of data availability. */
export interface SidebarDetailPrefs {
  repoLabel: boolean
  branch: boolean
  age: boolean
  diff: boolean
  milestone: boolean
  prNumber: boolean
  assignee: boolean
}

/** Per-density detail prefs. Compact and comfy have independent toggle
 *  sets because their goals differ — compact users are optimizing for
 *  density and typically want fewer items, while comfy users have the
 *  vertical space for the full cluster. */
export interface SidebarDetailPrefsByMode {
  compact: SidebarDetailPrefs
  comfy: SidebarDetailPrefs
}

/** Comfy default: everything on. Users can turn things off. */
export const DEFAULT_SIDEBAR_DETAILS_COMFY: SidebarDetailPrefs = {
  repoLabel: true,
  branch: true,
  age: true,
  diff: true,
  milestone: true,
  prNumber: true,
  assignee: true
}

/** Compact default: the minimum useful set — repo (multi-repo
 *  disambiguation), PR number, and assignee avatar. Branch (only
 *  meaningful when aliased), age, diff stats, and milestone are all
 *  off by default to keep a single-line row uncrowded. Users can turn
 *  any of them on. */
export const DEFAULT_SIDEBAR_DETAILS_COMPACT: SidebarDetailPrefs = {
  repoLabel: true,
  branch: false,
  age: false,
  diff: false,
  milestone: false,
  prNumber: true,
  assignee: true
}

export const DEFAULT_SIDEBAR_DETAILS: SidebarDetailPrefsByMode = {
  compact: DEFAULT_SIDEBAR_DETAILS_COMPACT,
  comfy: DEFAULT_SIDEBAR_DETAILS_COMFY
}

export type AgentKindSetting = 'claude' | 'codex' | 'cursor'

export type BrowserToolsMode = 'view' | 'full'

export type JsonModeChatDensity = 'compact' | 'comfy'

/** Five-step UI density. Controls the root `html` font-size so every
 *  `rem`-based unit (and therefore the entire `text-xs` / `text-sm` /
 *  `text-base` / `text-lg` scale and every `w-N` / `h-N` icon) shifts
 *  together. See SCALES below for the authoritative table — adding a
 *  sixth rung later is a one-line change there. */
export type UiScale = 'x-small' | 'small' | 'medium' | 'large' | 'x-large'

export interface UiScaleSpec {
  id: UiScale
  label: string
  rootPx: number
  /** Pixels added to the user's `terminalFontSize` so xterm stays in
   *  proportion with the rest of the UI. XTerminal and the Settings
   *  preview both read from this same table. */
  terminalOffset: number
}

export const SCALES: readonly UiScaleSpec[] = [
  { id: 'x-small', label: 'X-Small', rootPx: 14, terminalOffset: -2 },
  { id: 'small', label: 'Small', rootPx: 16, terminalOffset: 0 },
  { id: 'medium', label: 'Medium', rootPx: 18, terminalOffset: 2 },
  { id: 'large', label: 'Large', rootPx: 20, terminalOffset: 4 },
  { id: 'x-large', label: 'X-Large', rootPx: 22, terminalOffset: 6 }
] as const

export function scaleSpec(id: UiScale): UiScaleSpec {
  return SCALES.find((s) => s.id === id) ?? SCALES[0]
}

/** The pixel font-size a code editor / terminal should use at a given UI
 *  scale: the user's configured `terminalFontSize` shifted by the scale's
 *  `terminalOffset` so Monaco and xterm stay in proportion with the rest of
 *  the rem-scaled UI. Monaco consumers (DiffView / FileView / ReviewDiffPane)
 *  and XTerminal both go through this — passing the raw setting instead makes
 *  the editor ignore `uiScale`. */
export function scaledEditorFontSize(
  terminalFontSize: number | undefined,
  uiScale: UiScale
): number {
  return (terminalFontSize || 13) + scaleSpec(uiScale).terminalOffset
}

export type ThemeMode = 'light' | 'dark' | 'system'

/** A theme loaded from `<userData>/themes/*.json`. Stays minimal — the
 *  loader only validates `name` + `mode` + an optional `colors` map of the
 *  16 semantic keys; missing keys inherit from the default of that mode at
 *  apply time. */
export interface CustomTheme {
  /** Derived from filename, sanitized to `[a-z0-9-]`. Unique across the
   *  set (collisions are dropped by the loader). */
  id: string
  /** Display label from the file's `name` field. */
  name: string
  mode: 'light' | 'dark'
  /** Partial map of semantic color keys → CSS color string. The loader
   *  doesn't enforce which keys are present — apply just sets whichever
   *  are listed. */
  colors: Record<string, string>
}

/** Shared empty-array reference so the initial reducer and "no themes on
 *  disk" outcomes return the same array — keeps `useMemo` deps stable in
 *  components reading the slice. */
export const EMPTY_CUSTOM_THEMES: CustomTheme[] = []

/** Built-in theme ids used as the per-mode default when nothing else
 *  applies — the seed value for `themeLight`/`themeDark`, the IPC "this
 *  matches the default so don't persist it" guard, and the fallback
 *  `[data-theme]` selector for partial custom themes. Kept in shared so
 *  main and renderer agree without crossing the import boundary. */
export const DEFAULT_LIGHT_THEME = 'solarized-light'
export const DEFAULT_DARK_THEME = 'dark'

/** A Nessie colour preset — the app's *brand* colour.
 *
 *  Deliberately scoped narrower than "the primary colour". It fills the
 *  `--color-brand*` ramp, which is the mark, the wordmark and the Ness tool
 *  cards. It does NOT touch `--color-accent`: that is the theme's secondary
 *  (purple on Dracula), and it owns user message bubbles, links, focus rings
 *  and the caret. Folding the two together made the app monotone and cost the
 *  contrast the old two-colour scheme had.
 *
 *  `gradient` and `flow` are the painted forms — flat presets simply repeat
 *  their own colour, so the gradient classes need no special case and
 *  `legacy` (a real three-stop gradient) drops straight in.
 *
 *  Lives in shared because main validates the persisted id against this list
 *  and the renderer renders swatches from it; there is no second copy. */
export interface NessieColor {
  id: string
  label: string
  blurb: string
  brand: string
  mid: string
  deep: string
  gradient: string
  flow: string
}

const flat = (
  id: string,
  label: string,
  blurb: string,
  brand: string,
  mid: string,
  deep: string,
  light: string
): NessieColor => ({
  id,
  label,
  blurb,
  brand,
  mid,
  deep,
  gradient: `linear-gradient(135deg, ${brand} 0%, ${brand} 100%)`,
  flow: `linear-gradient(90deg, ${mid} 0%, ${brand} 25%, ${light} 50%, ${brand} 75%, ${mid} 100%)`
})

export const NESSIE_COLORS: readonly NessieColor[] = [
  flat('loch', 'Loch Green', 'She lives in a lake.', '#4ade80', '#22c55e', '#16a34a', '#86efac'),
  flat('abyss', 'Abyss Blue', 'Deeper than the sonar goes.', '#60a5fa', '#3b82f6', '#2563eb', '#bfdbfe'),
  flat('glow', 'Bioluminescent', 'For the nocturnal cryptid.', '#22d3ee', '#06b6d4', '#0891b2', '#a5f3fc'),
  flat('heather', 'Highland Heather', 'Very Scottish of her.', '#c084fc', '#a855f7', '#9333ea', '#e9d5ff'),
  flat('salmon', 'Leaping Salmon', 'What she had for lunch.', '#fb7185', '#f43f5e', '#e11d48', '#fecdd3'),
  {
    id: 'legacy',
    label: 'Legacy Harness',
    blurb: 'The old amber → red → purple. For the nostalgic.',
    brand: '#f59e0b',
    mid: '#ef4444',
    deep: '#a855f7',
    gradient: 'linear-gradient(135deg, #f59e0b 0%, #ef4444 50%, #a855f7 100%)',
    flow: 'linear-gradient(90deg, #f59e0b 0%, #ef4444 25%, #a855f7 50%, #ef4444 75%, #f59e0b 100%)'
  }
]

export const DEFAULT_NESSIE_COLOR = 'loch'

/** Resolve a persisted id to a preset, falling back to the default so an id
 *  removed in a later release can't leave the app with no brand colour. */
export function nessieColorById(id: string): NessieColor {
  return (
    NESSIE_COLORS.find((c) => c.id === id) ??
    NESSIE_COLORS.find((c) => c.id === DEFAULT_NESSIE_COLOR)!
  )
}

/** Default kickoff prompt for "Open PR as worktree". Editable globally in
 *  Settings (`prReviewPrompt`) and per-creation in the New Worktree screen. */
export const DEFAULT_PR_REVIEW_PROMPT =
  "Review this PR. Read the diff, then check for correctness issues, design problems, security concerns, and missing edge cases. Cite file paths and line numbers for anything you flag. Skip restating what the PR does — focus on what could go wrong or be improved."

/** Primary wake-lock mode. The actual hold = (this mode wants it) OR (the
 *  transient `preventSleepUntil` timer is still live). Single-select; the
 *  timer overlay covers the "also keep awake right now" case. */
export type PreventSleepMode = 'off' | 'while-agents-running' | 'always'

/** Stable keys for each icon in the sidebar's bottom launcher strip. New
 *  entries can be added at the end; renaming an existing key would strand
 *  existing users' pinned/unpinned choices, so avoid it. The `settings` and
 *  hamburger buttons are never in this map — the former is unhidable, the
 *  latter is the hamburger itself. */
export type BottomIconKey =
  | 'commandCenter'
  | 'newProject'
  | 'addRepo'
  | 'activity'
  | 'myWeek'
  | 'hotkeys'
  | 'reportIssue'
  | 'preventSleep'
  | 'settings'

/** All bottom-icon keys in default render order. Consumers iterate this and
 *  filter out anything present-and-true in `hiddenBottomIcons`. */
export const BOTTOM_ICON_KEYS: readonly BottomIconKey[] = [
  'commandCenter',
  'newProject',
  'addRepo',
  'activity',
  'myWeek',
  'hotkeys',
  'reportIssue',
  'preventSleep',
  'settings'
] as const

export type HiddenBottomIcons = Partial<Record<BottomIconKey, boolean>>

/** How the sidebar orders repo sections. `manual` renders `repoRoots` in the
 *  order the user dragged them into; the rest re-sort a copy at display time
 *  so the underlying manual order survives a round trip through a dynamic
 *  mode. */
export type ProjectSortMode = 'manual' | 'alphabetical' | 'recent-human' | 'recent-agent'

export const PROJECT_SORT_MODES: readonly ProjectSortMode[] = [
  'manual',
  'alphabetical',
  'recent-human',
  'recent-agent'
] as const

export function isProjectSortMode(v: unknown): v is ProjectSortMode {
  return typeof v === 'string' && (PROJECT_SORT_MODES as readonly string[]).includes(v)
}

export interface SettingsState {
  /** Whether the active theme is the light theme, the dark theme, or follows
   *  the OS appearance. Default 'system'. */
  themeMode: ThemeMode
  /** Theme id used when `themeMode` resolves to 'light'. */
  themeLight: string
  /** Theme id used when `themeMode` resolves to 'dark'. */
  themeDark: string
  /** User-authored themes loaded from `<userData>/themes/*.json` at boot
   *  (and on reload). Replaced wholesale on rescan — array reference
   *  changes only when the on-disk contents actually change. */
  customThemes: CustomTheme[]
  hotkeys: Record<string, string> | null
  defaultAgent: AgentKindSetting
  claudeCommand: string
  codexCommand: string
  cursorCommand: string
  worktreeScripts: WorktreeScripts
  claudeEnvVars: Record<string, string>
  codexEnvVars: Record<string, string>
  cursorEnvVars: Record<string, string>
  harnessMcpEnabled: boolean
  nameClaudeSessions: boolean
  terminalFontFamily: string
  terminalFontSize: number
  editor: string
  worktreeBase: WorktreeBase
  mergeStrategy: MergeStrategy
  sidebarDensity: SidebarDensity
  sidebarDetails: SidebarDetailPrefsByMode
  /** Set once the user dismisses the starter-task cards on the New
   *  worktree screen. One-way — there is no UI to bring them back, which
   *  is the point of a "don't show me this again" affordance. */
  starterTasksDismissed: boolean
  /** Whether the New worktree screen opens with its Advanced section
   *  expanded. Sticky across restarts: someone who works in there wants it
   *  open every time, and someone who never touches it never sees it. */
  newWorktreeAdvancedOpen: boolean
  shareClaudeSettings: boolean
  claudeModel: string | null
  codexModel: string | null
  cursorModel: string | null
  hasGithubToken: boolean
  githubAuthSource: 'pat' | 'gh-cli' | null
  /** GitHub login of the user whose token is configured. Resolved at
   *  boot via a /user call once the token is available. Used by the
   *  sidebar to bucket PRs you didn't author into the Reviewing group;
   *  null until resolved or when the token is missing/invalid. */
  viewerLogin: string | null
  harnessStarred: boolean | null
  autoUpdateEnabled: boolean
  /** When true (default), ⌘Q must be held briefly to quit (Chrome-style
   *  "Warn Before Quitting"); a tap shows a toast and does nothing. When
   *  false, ⌘Q quits immediately. */
  warnBeforeQuitting: boolean
  /** When true, the Open PR action (⌘⇧G) opens the PR in a Ness browser
   *  tab instead of handing the URL to the system browser. */
  openPrInBrowserTab: boolean
  /** Swaps the click / ⌘-click roles for links in a terminal. Default
   *  (false): plain click goes external (system browser, or editor for
   *  file paths), ⌘-click stays in Ness (browser tab / file tab). True
   *  inverts both, matching terminals where ⌘-click is the "open it for
   *  real" gesture. */
  terminalPlainClickOpensInApp: boolean
  harnessSystemPromptEnabled: boolean
  harnessSystemPrompt: string
  harnessSystemPromptMain: string
  claudeTuiFullscreen: boolean
  wsTransportEnabled: boolean
  wsTransportPort: number
  wsTransportHost: string
  browserToolsEnabled: boolean
  browserToolsMode: BrowserToolsMode
  /** Whether a chat can be forked into a new worktree — both the Chat tab
   *  menu action and the create_worktree MCP parameter. Off by default, and
   *  off hides the feature rather than merely rejecting it, so agents aren't
   *  told about an option that will fail. */
  conversationForkEnabled: boolean
  /** When true, agents get the `send_message` MCP tool and can deliver a
   *  message into another worktree's chat — the one capability that
   *  deliberately crosses the worktree boundary. Default off. */
  worktreeMessagingEnabled: boolean
  /** Controls whether new Claude tabs spawn as the terminal-hosted TUI
   *  ('xterm') or the React chat interface ('json'). Internal values are
   *  unchanged; the user-facing label is "Terminal" / "Chat". */
  defaultClaudeTabType: 'xterm' | 'json'
  /** True once the user clicks the X on the "Switch to the new Chat
   *  mode" overlay shown on Terminal Claude tabs. Persistent so the
   *  promotion stays dismissed across reloads. */
  chatPromotionDismissed: boolean
  /** When true, JSON-mode tabs run a Haiku oneshot to auto-approve
   *  obviously-safe tool calls instead of prompting the user. Productivity
   *  feature only — an LLM judging another LLM is not a security boundary.
   *  A hardcoded deny-list catches the high-blast-radius cases (rm -rf,
   *  git push, web fetch, etc.) before Haiku is ever consulted. Default
   *  off. */
  autoApprovePermissions: boolean
  /** Optional project-specific guidance appended to the auto-approver's
   *  policy prompt (after the hardcoded safety preamble). Useful for
   *  per-project carve-outs like "approve `npm install` on this repo"
   *  or "be especially strict about Bash that writes outside src/".
   *  Empty by default — the base policy is what runs. Has no effect
   *  unless autoApprovePermissions is on. */
  autoApproveSteerInstructions: string
  /** Diagnostic toggle (no UI): when true, json-mode tabs spawn the user's
   *  PATH `claude` instead of the bundled one. Default off. */
  useSystemClaudeForJsonMode: boolean
  /** Visual density of the JSON-mode chat. 'compact' (default) keeps the
   *  power-user defaults; 'comfy' bumps font sizes, padding, and corner
   *  radius for newcomers / screen-sharing. Wired via CSS variables on
   *  the chat root, so it's a pure styling switch. */
  jsonModeChatDensity: JsonModeChatDensity
  /** Global UI density. Maps to a root `html` font-size — see SCALES. */
  uiScale: UiScale
  /** Id of the active Nessie colour preset — the app's primary colour.
   *  Drives the `--color-brand*` ramp and the accent. See NESSIE_COLORS. */
  nessieColor: string
  /** When true, plain Enter sends a message in the JSON-mode chat
   *  composer (Shift+Enter inserts a newline). When false (default),
   *  the historical behavior applies: Cmd/Ctrl+Enter sends and plain
   *  Enter inserts a newline. */
  jsonModeSendOnEnter: boolean
  /** When true (default), JSON-mode chat auto-scrolls to follow the tail
   *  of a streaming response. When false, the most recent user message is
   *  pinned to the top of the viewport instead, and a "Jump to prompt"
   *  button surfaces when the anchor scrolls off the top. */
  autoScrollToBottom: boolean
  /** Permission mode applied to a freshly-spawned json-mode session.
   *  Existing sessions keep whatever mode they were in (set via the
   *  statusline picker). Default 'acceptEdits' so first-time users
   *  don't get a wall of approval cards for routine edits; Bash and
   *  other risky tools still surface approvals. */
  jsonModeDefaultPermissionMode: JsonClaudePermissionMode
  /** Minutes a json-mode tab can sit at the yellow "waiting" dot before
   *  the auto-sleep monitor tears its subprocess down. The slept tab
   *  stays in the tree (history intact) and re-spawns on click. 0
   *  disables auto-sleep entirely. */
  autoSleepMinutes: number
  snoozeDefaultDays: number
  /** Global default for "when a worktree's PR checks transition into
   *  failure, inject a message into its agent chat". Per-worktree
   *  overrides live in the `ciNotify` slice and win over this. */
  notifyChatOnCiFailure: boolean
  /** When true, high-volume diagnostic categories are written to
   *  debug.log — currently per-GitHub-API-call `[github-api]` lines (URL,
   *  method, status, duration). Off by default because the per-call
   *  volume is high during PR refresh bursts. HUD metrics like "GH API"
   *  rate are always on regardless of this flag. */
  expandedDiagnosticLoggingEnabled: boolean
  /** Default prompt pre-filled into the "Open PR as worktree" screen and
   *  used as the kickoff prompt when an MCP `create_worktree` call provides
   *  a `prNumber` without an explicit `initialPrompt`. The textarea on the
   *  PR-creation screen is seeded from this value but edits there are
   *  one-shot — managing the default happens in Settings. */
  prReviewPrompt: string
  /** Announcement ids the user has dismissed with the per-banner `×`.
   *  Used to filter the fetched feed down to the most recent unseen
   *  entry. Append-only — we never garbage-collect because entries fall
   *  out of the feed on their own once they expire. */
  dismissedAnnouncementIds: string[]
  /** When true, all announcement banners are suppressed regardless of
   *  the feed contents. Set by the "Hide all announcements" action and
   *  cleared only by the user. */
  announcementsMuted: boolean
  /** When true, PRs that have you as a requested reviewer (across every
   *  repo added to Ness) show up as phantom entries in the sidebar's
   *  Reviewing group — click one and it opens the "new worktree from PR"
   *  screen with that PR pre-selected. Off by default; opt-in via
   *  Settings. */
  showAssignedPRs: boolean
  /** Primary wake-lock mode. The side effect (a power-save blocker)
   *  lives in the main-process WakeLockController — never in the store.
   *  Default 'off'. */
  preventSleepMode: PreventSleepMode
  /** Epoch-ms deadline for the temporary "keep awake for the next hour"
   *  overlay, or null when no timer is running. Shared world state (a
   *  second client sees the countdown) but deliberately NOT persisted to
   *  config — a temporary hold resets on app relaunch rather than
   *  surprising the user days later. The WakeLockController clears it back
   *  to null when the deadline passes. */
  preventSleepUntil: number | null
  /** Which bottom-launcher icons the user has hidden. Missing / false ⇒
   *  visible. Managed via the hamburger dropdown on the strip. Global (not
   *  per-repo) — these are launcher actions that don't depend on repo state. */
  hiddenBottomIcons: HiddenBottomIcons
  /** User's preferred render order for the bottom-launcher icons. Any key
   *  in `BOTTOM_ICON_KEYS` but missing here gets appended in canonical order
   *  at read time (so adding a new icon to the codebase just shows up on the
   *  end). Managed via up/down chevrons in the hamburger dropdown. */
  bottomIconOrder: BottomIconKey[]
  /** How the sidebar orders repo sections. Only observable when more than
   *  one repo is in the workspace and repos aren't merged into one list. */
  projectSort: ProjectSortMode
}

export type SettingsEvent =
  | { type: 'settings/themeModeChanged'; payload: ThemeMode }
  | { type: 'settings/themeLightChanged'; payload: string }
  | { type: 'settings/themeDarkChanged'; payload: string }
  | { type: 'settings/customThemesChanged'; payload: CustomTheme[] }
  | { type: 'settings/hotkeysChanged'; payload: Record<string, string> | null }
  | { type: 'settings/defaultAgentChanged'; payload: AgentKindSetting }
  | { type: 'settings/claudeCommandChanged'; payload: string }
  | { type: 'settings/codexCommandChanged'; payload: string }
  | { type: 'settings/cursorCommandChanged'; payload: string }
  | { type: 'settings/worktreeScriptsChanged'; payload: WorktreeScripts }
  | { type: 'settings/claudeEnvVarsChanged'; payload: Record<string, string> }
  | { type: 'settings/codexEnvVarsChanged'; payload: Record<string, string> }
  | { type: 'settings/cursorEnvVarsChanged'; payload: Record<string, string> }
  | { type: 'settings/harnessMcpEnabledChanged'; payload: boolean }
  | { type: 'settings/nameClaudeSessionsChanged'; payload: boolean }
  | { type: 'settings/terminalFontFamilyChanged'; payload: string }
  | { type: 'settings/terminalFontSizeChanged'; payload: number }
  | { type: 'settings/editorChanged'; payload: string }
  | { type: 'settings/worktreeBaseChanged'; payload: WorktreeBase }
  | { type: 'settings/mergeStrategyChanged'; payload: MergeStrategy }
  | { type: 'settings/sidebarDensityChanged'; payload: SidebarDensity }
  | { type: 'settings/sidebarDetailsChanged'; payload: SidebarDetailPrefsByMode }
  | { type: 'settings/newWorktreeAdvancedOpenChanged'; payload: boolean }
  | { type: 'settings/starterTasksDismissedChanged'; payload: boolean }
  | { type: 'settings/shareClaudeSettingsChanged'; payload: boolean }
  | { type: 'settings/hasGithubTokenChanged'; payload: boolean }
  | { type: 'settings/githubAuthSourceChanged'; payload: 'pat' | 'gh-cli' | null }
  | { type: 'settings/viewerLoginChanged'; payload: string | null }
  | { type: 'settings/harnessStarredChanged'; payload: boolean | null }
  | { type: 'settings/claudeModelChanged'; payload: string | null }
  | { type: 'settings/codexModelChanged'; payload: string | null }
  | { type: 'settings/cursorModelChanged'; payload: string | null }
  | { type: 'settings/autoUpdateEnabledChanged'; payload: boolean }
  | { type: 'settings/warnBeforeQuittingChanged'; payload: boolean }
  | { type: 'settings/openPrInBrowserTabChanged'; payload: boolean }
  | { type: 'settings/terminalPlainClickOpensInAppChanged'; payload: boolean }
  | { type: 'settings/harnessSystemPromptEnabledChanged'; payload: boolean }
  | { type: 'settings/harnessSystemPromptChanged'; payload: string }
  | { type: 'settings/harnessSystemPromptMainChanged'; payload: string }
  | { type: 'settings/claudeTuiFullscreenChanged'; payload: boolean }
  | { type: 'settings/wsTransportEnabledChanged'; payload: boolean }
  | { type: 'settings/wsTransportPortChanged'; payload: number }
  | { type: 'settings/wsTransportHostChanged'; payload: string }
  | { type: 'settings/browserToolsEnabledChanged'; payload: boolean }
  | { type: 'settings/conversationForkEnabledChanged'; payload: boolean }
  | { type: 'settings/browserToolsModeChanged'; payload: BrowserToolsMode }
  | { type: 'settings/worktreeMessagingEnabledChanged'; payload: boolean }
  | { type: 'settings/defaultClaudeTabTypeChanged'; payload: 'xterm' | 'json' }
  | { type: 'settings/chatPromotionDismissedChanged'; payload: boolean }
  | { type: 'settings/autoApprovePermissionsChanged'; payload: boolean }
  | { type: 'settings/autoApproveSteerInstructionsChanged'; payload: string }
  | { type: 'settings/useSystemClaudeForJsonModeChanged'; payload: boolean }
  | { type: 'settings/jsonModeChatDensityChanged'; payload: JsonModeChatDensity }
  | { type: 'settings/uiScaleChanged'; payload: UiScale }
  | { type: 'settings/nessieColorChanged'; payload: string }
  | { type: 'settings/jsonModeSendOnEnterChanged'; payload: boolean }
  | { type: 'settings/autoScrollToBottomChanged'; payload: boolean }
  | {
      type: 'settings/jsonModeDefaultPermissionModeChanged'
      payload: JsonClaudePermissionMode
    }
  | { type: 'settings/autoSleepMinutesChanged'; payload: number }
  | { type: 'settings/snoozeDefaultDaysChanged'; payload: number }
  | { type: 'settings/notifyChatOnCiFailureChanged'; payload: boolean }
  | { type: 'settings/expandedDiagnosticLoggingEnabledChanged'; payload: boolean }
  | { type: 'settings/prReviewPromptChanged'; payload: string }
  | { type: 'settings/announcementDismissed'; payload: string }
  | { type: 'settings/announcementsMutedChanged'; payload: boolean }
  | { type: 'settings/showAssignedPRsChanged'; payload: boolean }
  | { type: 'settings/preventSleepModeChanged'; payload: PreventSleepMode }
  | { type: 'settings/preventSleepUntilChanged'; payload: number | null }
  | { type: 'settings/hiddenBottomIconsChanged'; payload: HiddenBottomIcons }
  | { type: 'settings/bottomIconOrderChanged'; payload: BottomIconKey[] }
  | { type: 'settings/projectSortChanged'; payload: ProjectSortMode }

// Client-side placeholder. Real values are seeded in the main-process Store
// constructor from the on-disk config and secrets.
export const initialSettings: SettingsState = {
  themeMode: 'system',
  themeLight: DEFAULT_LIGHT_THEME,
  themeDark: DEFAULT_DARK_THEME,
  customThemes: EMPTY_CUSTOM_THEMES,
  hotkeys: null,
  defaultAgent: 'claude',
  claudeCommand: '',
  codexCommand: '',
  cursorCommand: '',
  worktreeScripts: { setup: '', teardown: '' },
  claudeEnvVars: {},
  codexEnvVars: {},
  cursorEnvVars: {},
  harnessMcpEnabled: true,
  nameClaudeSessions: false,
  terminalFontFamily: '',
  terminalFontSize: 13,
  editor: 'vscode',
  worktreeBase: 'remote',
  mergeStrategy: 'squash',
  sidebarDensity: 'comfy',
  sidebarDetails: DEFAULT_SIDEBAR_DETAILS,
  newWorktreeAdvancedOpen: false,
  starterTasksDismissed: false,
  shareClaudeSettings: true,
  claudeModel: null,
  codexModel: null,
  cursorModel: null,
  hasGithubToken: false,
  githubAuthSource: null,
  viewerLogin: null,
  harnessStarred: null,
  autoUpdateEnabled: true,
  warnBeforeQuitting: true,
  openPrInBrowserTab: false,
  terminalPlainClickOpensInApp: false,
  harnessSystemPromptEnabled: true,
  harnessSystemPrompt: '',
  harnessSystemPromptMain: '',
  claudeTuiFullscreen: true,
  wsTransportEnabled: false,
  wsTransportPort: 37291,
  wsTransportHost: '127.0.0.1',
  browserToolsEnabled: true,
  conversationForkEnabled: false,
  browserToolsMode: 'full',
  worktreeMessagingEnabled: false,
  defaultClaudeTabType: 'xterm',
  chatPromotionDismissed: false,
  autoApprovePermissions: false,
  autoApproveSteerInstructions: '',
  useSystemClaudeForJsonMode: false,
  jsonModeChatDensity: 'compact',
  uiScale: 'small',
  nessieColor: DEFAULT_NESSIE_COLOR,
  jsonModeSendOnEnter: false,
  autoScrollToBottom: true,
  jsonModeDefaultPermissionMode: 'acceptEdits',
  autoSleepMinutes: 30,
  snoozeDefaultDays: 7,
  notifyChatOnCiFailure: false,
  expandedDiagnosticLoggingEnabled: false,
  prReviewPrompt: DEFAULT_PR_REVIEW_PROMPT,
  dismissedAnnouncementIds: [],
  announcementsMuted: false,
  showAssignedPRs: false,
  preventSleepMode: 'off',
  preventSleepUntil: null,
  hiddenBottomIcons: {},
  bottomIconOrder: [...BOTTOM_ICON_KEYS],
  projectSort: 'manual'
}

/** Read helper: return the user's stored order with any missing keys
 *  appended in canonical order. Keeps sidebars from silently losing an
 *  icon when a new one gets added to the codebase between releases. */
export function resolveBottomIconOrder(
  stored: readonly BottomIconKey[]
): BottomIconKey[] {
  const seen = new Set<BottomIconKey>()
  const out: BottomIconKey[] = []
  for (const k of stored) {
    if (BOTTOM_ICON_KEYS.includes(k) && !seen.has(k)) {
      out.push(k)
      seen.add(k)
    }
  }
  for (const k of BOTTOM_ICON_KEYS) {
    if (!seen.has(k)) out.push(k)
  }
  return out
}

export function settingsReducer(state: SettingsState, event: SettingsEvent): SettingsState {
  switch (event.type) {
    case 'settings/themeModeChanged':
      return { ...state, themeMode: event.payload }
    case 'settings/themeLightChanged':
      return { ...state, themeLight: event.payload }
    case 'settings/themeDarkChanged':
      return { ...state, themeDark: event.payload }
    case 'settings/customThemesChanged':
      return { ...state, customThemes: event.payload }
    case 'settings/hotkeysChanged':
      return { ...state, hotkeys: event.payload }
    case 'settings/defaultAgentChanged':
      return { ...state, defaultAgent: event.payload }
    case 'settings/claudeCommandChanged':
      return { ...state, claudeCommand: event.payload }
    case 'settings/codexCommandChanged':
      return { ...state, codexCommand: event.payload }
    case 'settings/cursorCommandChanged':
      return { ...state, cursorCommand: event.payload }
    case 'settings/worktreeScriptsChanged':
      return { ...state, worktreeScripts: event.payload }
    case 'settings/claudeEnvVarsChanged':
      return { ...state, claudeEnvVars: event.payload }
    case 'settings/codexEnvVarsChanged':
      return { ...state, codexEnvVars: event.payload }
    case 'settings/cursorEnvVarsChanged':
      return { ...state, cursorEnvVars: event.payload }
    case 'settings/harnessMcpEnabledChanged':
      return { ...state, harnessMcpEnabled: event.payload }
    case 'settings/nameClaudeSessionsChanged':
      return { ...state, nameClaudeSessions: event.payload }
    case 'settings/terminalFontFamilyChanged':
      return { ...state, terminalFontFamily: event.payload }
    case 'settings/terminalFontSizeChanged':
      return { ...state, terminalFontSize: event.payload }
    case 'settings/editorChanged':
      return { ...state, editor: event.payload }
    case 'settings/worktreeBaseChanged':
      return { ...state, worktreeBase: event.payload }
    case 'settings/mergeStrategyChanged':
      return { ...state, mergeStrategy: event.payload }
    case 'settings/sidebarDensityChanged':
      return { ...state, sidebarDensity: event.payload }
    case 'settings/sidebarDetailsChanged':
      return { ...state, sidebarDetails: event.payload }
    case 'settings/newWorktreeAdvancedOpenChanged':
      return { ...state, newWorktreeAdvancedOpen: event.payload }
    case 'settings/starterTasksDismissedChanged':
      return { ...state, starterTasksDismissed: event.payload }
    case 'settings/shareClaudeSettingsChanged':
      return { ...state, shareClaudeSettings: event.payload }
    case 'settings/hasGithubTokenChanged':
      return { ...state, hasGithubToken: event.payload }
    case 'settings/githubAuthSourceChanged':
      return { ...state, githubAuthSource: event.payload }
    case 'settings/viewerLoginChanged':
      return { ...state, viewerLogin: event.payload }
    case 'settings/harnessStarredChanged':
      return { ...state, harnessStarred: event.payload }
    case 'settings/claudeModelChanged':
      return { ...state, claudeModel: event.payload }
    case 'settings/codexModelChanged':
      return { ...state, codexModel: event.payload }
    case 'settings/cursorModelChanged':
      return { ...state, cursorModel: event.payload }
    case 'settings/autoUpdateEnabledChanged':
      return { ...state, autoUpdateEnabled: event.payload }
    case 'settings/warnBeforeQuittingChanged':
      return { ...state, warnBeforeQuitting: event.payload }
    case 'settings/openPrInBrowserTabChanged':
      return { ...state, openPrInBrowserTab: event.payload }
    case 'settings/terminalPlainClickOpensInAppChanged':
      return { ...state, terminalPlainClickOpensInApp: event.payload }
    case 'settings/harnessSystemPromptEnabledChanged':
      return { ...state, harnessSystemPromptEnabled: event.payload }
    case 'settings/harnessSystemPromptChanged':
      return { ...state, harnessSystemPrompt: event.payload }
    case 'settings/harnessSystemPromptMainChanged':
      return { ...state, harnessSystemPromptMain: event.payload }
    case 'settings/claudeTuiFullscreenChanged':
      return { ...state, claudeTuiFullscreen: event.payload }
    case 'settings/wsTransportEnabledChanged':
      return { ...state, wsTransportEnabled: event.payload }
    case 'settings/wsTransportPortChanged':
      return { ...state, wsTransportPort: event.payload }
    case 'settings/wsTransportHostChanged':
      return { ...state, wsTransportHost: event.payload }
    case 'settings/browserToolsEnabledChanged':
      return { ...state, browserToolsEnabled: event.payload }
    case 'settings/conversationForkEnabledChanged':
      return { ...state, conversationForkEnabled: event.payload }
    case 'settings/browserToolsModeChanged':
      return { ...state, browserToolsMode: event.payload }
    case 'settings/worktreeMessagingEnabledChanged':
      return { ...state, worktreeMessagingEnabled: event.payload }
    case 'settings/defaultClaudeTabTypeChanged':
      return { ...state, defaultClaudeTabType: event.payload }
    case 'settings/chatPromotionDismissedChanged':
      return { ...state, chatPromotionDismissed: event.payload }
    case 'settings/autoApprovePermissionsChanged':
      return { ...state, autoApprovePermissions: event.payload }
    case 'settings/autoApproveSteerInstructionsChanged':
      return { ...state, autoApproveSteerInstructions: event.payload }
    case 'settings/useSystemClaudeForJsonModeChanged':
      return { ...state, useSystemClaudeForJsonMode: event.payload }
    case 'settings/jsonModeChatDensityChanged':
      return { ...state, jsonModeChatDensity: event.payload }
    case 'settings/uiScaleChanged':
      return { ...state, uiScale: event.payload }
    case 'settings/nessieColorChanged':
      return { ...state, nessieColor: event.payload }
    case 'settings/jsonModeSendOnEnterChanged':
      return { ...state, jsonModeSendOnEnter: event.payload }
    case 'settings/autoScrollToBottomChanged':
      return { ...state, autoScrollToBottom: event.payload }
    case 'settings/jsonModeDefaultPermissionModeChanged':
      return { ...state, jsonModeDefaultPermissionMode: event.payload }
    case 'settings/autoSleepMinutesChanged':
      return { ...state, autoSleepMinutes: event.payload }
    case 'settings/snoozeDefaultDaysChanged':
      return { ...state, snoozeDefaultDays: event.payload }
    case 'settings/notifyChatOnCiFailureChanged':
      return { ...state, notifyChatOnCiFailure: event.payload }
    case 'settings/expandedDiagnosticLoggingEnabledChanged':
      return { ...state, expandedDiagnosticLoggingEnabled: event.payload }
    case 'settings/prReviewPromptChanged':
      return { ...state, prReviewPrompt: event.payload }
    case 'settings/announcementDismissed': {
      if (state.dismissedAnnouncementIds.includes(event.payload)) return state
      return {
        ...state,
        dismissedAnnouncementIds: [...state.dismissedAnnouncementIds, event.payload]
      }
    }
    case 'settings/announcementsMutedChanged':
      return { ...state, announcementsMuted: event.payload }
    case 'settings/showAssignedPRsChanged':
      return { ...state, showAssignedPRs: event.payload }
    case 'settings/preventSleepModeChanged':
      return { ...state, preventSleepMode: event.payload }
    case 'settings/preventSleepUntilChanged':
      return { ...state, preventSleepUntil: event.payload }
    case 'settings/hiddenBottomIconsChanged':
      return { ...state, hiddenBottomIcons: event.payload }
    case 'settings/bottomIconOrderChanged':
      return { ...state, bottomIconOrder: event.payload }
    case 'settings/projectSortChanged':
      return { ...state, projectSort: event.payload }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}
