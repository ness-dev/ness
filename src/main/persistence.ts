import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  readdirSync,
  copyFileSync,
  renameSync
} from 'fs'
import { join } from 'path'
import { userDataDir } from './paths'
import type { ConfigLoadError } from '../shared/state/config-health'
import {
  runMigrations,
  SCHEMA_VERSION,
  type AnyConfig,
  type PersistedPane,
  type PersistedPaneNode,
  type PersistedTab
} from './persistence-migrations'
import type { CostsState } from '../shared/state/costs'
import type { SnoozeEntry } from '../shared/state/snooze'
import type { PreventSleepMode } from '../shared/state/settings'
import type { JsonClaudePermissionMode } from '../shared/state/json-claude'

export type { PersistedPane, PersistedPaneNode, PersistedTab }

export type QuestStep = 'hidden' | 'spawn-second' | 'switch-between' | 'finale' | 'done'

/** A configured backend (multi-backend UX, Tier 1).
 *  - `kind: 'local'` is the in-process Electron backend; exactly one exists,
 *    its id is the constant `LOCAL_BACKEND_ID`, and the renderer routes its
 *    transport through ElectronClientTransport instead of WebSocket.
 *  - `kind: 'remote'` is a `harness-server` reachable over WS. `url` is the
 *    schemeless authority + path (e.g. `build-box.local:37291/`); the token
 *    lives in `secrets.enc` keyed `backend-token:<id>` so this object is safe
 *    to ship over IPC. */
export interface BackendConnection {
  id: string
  label: string
  url: string
  kind: 'local' | 'remote'
  addedAt: number
  lastConnectedAt?: number
  color?: string
  initials?: string
  /** Present on remotes that were bootstrapped via SSH (vs. plain WS).
   *  When set, `url` is treated as a cache of the last tunnel's
   *  ephemeral loopback URL — the source of truth is `ssh.target`, and
   *  on each connect we re-bootstrap a fresh tunnel and overwrite `url`
   *  with the new localhost:<port>/?token=... string. See
   *  plans/remote-main.md §4. */
  ssh?: {
    /** Either an alias from ~/.ssh/config (e.g. "build-box") or a
     *  freeform "user@host[:port]" string. The bootstrap layer treats
     *  both uniformly via parseSshTarget. */
    target: string
    /** Local loopback port we used last time, if any. Lets the next
     *  reconnect prefer the same port — keeps the URL stable across
     *  restarts so xterm.js terminal ids the renderer holds don't get
     *  invalidated by a churning port. Best-effort; if it's taken on
     *  the next boot we just pick another. */
    tunnelLocalPort?: number
  }
}

export const LOCAL_BACKEND_ID = 'local'

export interface Config {
  /** Schema version of the on-disk config. Bumped whenever the shape changes;
   *  see `migrations` below. Always written; absent on pre-versioned configs. */
  schemaVersion?: number
  windowBounds: { x: number; y: number; width: number; height: number } | null
  // All repo roots that have been opened (for re-opening windows)
  repoRoots: string[]
  // Custom hotkey overrides: action name → shortcut string (e.g. "Cmd+Shift+T")
  hotkeys?: Record<string, string>
  // Which agent CLI to default to when creating new tabs: 'claude', 'codex', or 'cursor'.
  defaultAgent?: 'claude' | 'codex' | 'cursor'
  // Command used to launch Claude in a worktree terminal. Runs via login shell.
  // Ness appends `--session-id <uuid>` so each tab has a stable resumable session.
  claudeCommand?: string
  // Command used to launch Codex in a worktree terminal.
  codexCommand?: string
  // Command used to launch Cursor Agent in a worktree terminal.
  cursorCommand?: string
  // Extra environment variables injected into the PTY when spawning a Claude tab.
  claudeEnvVars?: Record<string, string>
  // Model override for Claude Code (passed as --model <id>).
  claudeModel?: string
  // Model override for Codex (passed as --model <id>).
  codexModel?: string
  // Model override for Cursor Agent (passed as --model <id>).
  cursorModel?: string
  // Extra environment variables injected into the PTY when spawning a Codex tab.
  codexEnvVars?: Record<string, string>
  // Extra environment variables injected into the PTY when spawning a Cursor Agent tab.
  cursorEnvVars?: Record<string, string>
  // When false, Ness won't inject `--mcp-config <path>` pointing at the
  // bundled ness-control MCP server. Default is enabled (undefined/true).
  harnessMcpEnabled?: boolean
  // Persisted workspace panes nested by repoRoot → worktreePath → panes[].
  // Two repos can have worktrees with identical paths in theory, and the
  // multi-repo UI shows them together, so we key by repo to keep them distinct.
  panes?: Record<string, Record<string, PersistedPaneNode>>
  // Legacy flat shape (worktreePath → panes). Migrated into the nested form on
  // first load — entries are grouped under whichever known `repoRoot` is a
  // prefix of the worktree path; unmatched entries land in `__orphan__`.
  legacyPanes?: Record<string, PersistedPane[]>
  // Even older — migrated to `legacyPanes` then to `panes` on first load.
  terminalTabs?: Record<string, PersistedTab[]>
  activeTabId?: Record<string, string>
  // Theme mode — which of `themeLight` / `themeDark` is active, or whether
  // to follow the OS color scheme. Default is 'system' (undefined treated
  // as 'system'). Replaces the legacy single `theme` field; migration
  // splits the old value into mode + matching slot.
  themeMode?: 'light' | 'dark' | 'system'
  // Theme id used when `themeMode` resolves to 'light'. Default
  // 'solarized-light'.
  themeLight?: string
  // Theme id used when `themeMode` resolves to 'dark'. Default 'dark'.
  themeDark?: string
  // App-background hex the renderer last applied. Used at next boot to
  // pick the BrowserWindow background color so the first paint doesn't
  // flash. Written from the renderer via a fire-and-forget IPC after each
  // theme apply. Phase 2 will start using this for custom themes whose
  // hex main can't synchronously resolve at window-open time.
  lastEffectiveAppBg?: string
  // Terminal font family (CSS font-family string, applied to xterm.js)
  terminalFontFamily?: string
  // Terminal font size in px
  terminalFontSize?: number
  // Preferred external editor id (see AVAILABLE_EDITORS)
  editor?: string
  // Per-repo editor overrides, repoRoot → editor id. Deliberately kept here
  // rather than in the repo's committed .ness.json: which editor you use
  // is a personal, per-machine preference, not a project fact.
  repoEditors?: Record<string, string>
  // Per-worktree editor overrides, worktree path → editor id. Narrower than
  // repoEditors; pruned when the worktree is removed.
  worktreeEditors?: Record<string, string>
  // New worktrees are branched from: 'remote' = fetch origin then branch
  // from origin/<default>, 'local' = branch from current HEAD.
  worktreeBase?: 'remote' | 'local'
  // Default strategy for "Merge locally" action. Auto-updates to whatever
  // was last used unless the user pinned one in Settings.
  mergeStrategy?: 'squash' | 'merge-commit' | 'fast-forward'
  // Density of each sidebar worktree row. 'comfy' (default) stacks the
  // detail cluster on a second line; 'compact' folds it onto the right of
  // a single line.
  sidebarDensity?: 'compact' | 'comfy'
  // Per-density detail-item toggles for the sidebar row. Compact and
  // comfy have independent toggle sets. Missing keys/modes fall back to
  // DEFAULT_SIDEBAR_DETAILS.
  sidebarDetails?: {
    compact?: {
      repoLabel?: boolean
      branch?: boolean
      age?: boolean
      diff?: boolean
      milestone?: boolean
      prNumber?: boolean
      assignee?: boolean
    }
    comfy?: {
      repoLabel?: boolean
      branch?: boolean
      age?: boolean
      diff?: boolean
      milestone?: boolean
      prNumber?: boolean
      assignee?: boolean
    }
  }
  // Which sidebar bottom-launcher icons the user has hidden via the
  // hamburger menu. Missing / false ⇒ visible. Keys are BottomIconKey
  // (see shared/state/settings.ts). Absent from disk when the user
  // hasn't hidden anything, to keep default configs tidy.
  hiddenBottomIcons?: Record<string, boolean>
  // User's preferred render order for the bottom-launcher icons. Any
  // BottomIconKey missing from this array falls back to canonical order at
  // read time (see resolveBottomIconOrder). Absent from disk when the
  // user hasn't reordered anything.
  bottomIconOrder?: string[]
  // Branches that have been merged locally via Ness, keyed by branch name.
  // Value is the branch-tip SHA at merge time — if the branch later advances
  // past this SHA, the flag is considered stale and the branch is no longer
  // shown as merged.
  // Shell command to run after a worktree is created. Runs via login shell
   // with cwd=worktree and env vars HARNESS_WORKTREE_PATH, HARNESS_BRANCH,
   // HARNESS_REPO_ROOT. Failures are logged but don't block creation.
  worktreeSetupCommand?: string
  // Shell command to run before a worktree is removed. Same execution model
   // as setup. Failures are logged but don't block removal.
  worktreeTeardownCommand?: string
  locallyMerged?: Record<string, string>
  // First-run parallelism quest — advances through steps as the user learns.
  // When true, pass --name "repo/branch" to Claude so sessions are named by
  // their worktree rather than auto-summarized. Also sets the name visible
  // to `claude --resume` and remote control.
  nameClaudeSessions?: boolean
  onboarding?: {
    quest?: QuestStep
  }
  // True once we've auto-starred ness-dev/ness on behalf of a
  // gh-cli-detected user. Sticky — if they later unstar manually, we
  // don't re-star on next boot.
  harnessAutoStarred?: boolean
  // Per-terminal token usage + estimated cost, tallied from Claude Code
  // session jsonl transcripts. Entries persist across tab/terminal death
  // so worktree-level totals survive restarts.
  costs?: CostsState
  // When false, Ness skips background update checks on startup and
  // on its periodic timer. The manual "Check for updates" button in
  // Settings still works. Default is enabled (undefined/true).
  autoUpdateEnabled?: boolean
  // When false, ⌘Q quits immediately. When true/undefined (default), ⌘Q
  // must be held briefly to quit (Chrome-style "Warn Before Quitting").
  warnBeforeQuitting?: boolean
  // When true, the Open PR action opens the PR in a Ness browser tab
  // instead of the system browser. Default is off (undefined/false).
  openPrInBrowserTab?: boolean
  // When true, a plain click on a terminal link opens it inside Ness and
  // ⌘-click hands it to the system browser / editor — the inverse of the
  // default. Default is off (undefined/false).
  terminalPlainClickOpensInApp?: boolean
  // When false, new worktrees don't symlink their .claude/settings.local.json
  // to the main worktree's copy, and the boot migration doesn't convert
  // existing regular files. Default is enabled (undefined/true).
  shareClaudeSettings?: boolean
  // Sticky expand state for the New worktree screen's Advanced section.
  // Default is collapsed (undefined/false).
  newWorktreeAdvancedOpen?: boolean
  // Set once the user dismisses the New worktree screen's starter-task
  // cards. Default is showing them (undefined/false).
  starterTasksDismissed?: boolean
  // User's choice for installing agent status hooks at user scope
  // (~/.claude/settings.json, ~/.codex/hooks.json). Persisted so a
  // declined user doesn't see the banner again on next launch.
  hooksConsent?: 'pending' | 'accepted' | 'declined'
  // One-shot migration flag: once true, we've swept all known worktrees'
  // per-worktree .claude/settings.local.json + .codex/hooks.json files
  // and stripped any legacy Ness entries. Prevents re-running the
  // migration on every boot.
  hooksMigratedToGlobal?: boolean
  harnessSystemPromptEnabled?: boolean
  harnessSystemPrompt?: string
  harnessSystemPromptMain?: string
  // Default kickoff prompt for "Open PR as worktree" / MCP create_worktree
  // with prNumber. Absent = use the bundled DEFAULT_PR_REVIEW_PROMPT.
  prReviewPrompt?: string
  // When false, Claude sessions spawn without CLAUDE_CODE_NO_FLICKER=1, so they
  // use the inline (non-fullscreen) TUI mode. Default is enabled (undefined/true).
  claudeTuiFullscreen?: boolean
  // Experimental: when true, main also serves state + RPC + signals over a
  // WebSocket bound to 127.0.0.1:<wsTransportPort>. Off by default.
  wsTransportEnabled?: boolean
  wsTransportPort?: number
  // Host the WS + HTTP web-client servers bind to. Default 127.0.0.1
  // (loopback only). Set to '0.0.0.0' to expose to other devices on the
  // LAN (a phone, second laptop, etc.). Token auth still applies, but
  // there is no TLS — only enable on a trusted network.
  wsTransportHost?: string
  // When false, the ness-control browser_* MCP tools are not advertised to
  // agents and the corresponding /browser/* control endpoints reject calls.
  // Default is enabled (undefined/true).
  browserToolsEnabled?: boolean
  // Unless true, chats can't be forked into a new worktree: the Chat tab menu
  // action is hidden, create_worktree drops its forkConversation parameter,
  // and the system prompt omits the paragraph describing it.
  // Default is disabled (undefined/false).
  conversationForkEnabled?: boolean
  // 'view' = inspect tabs + spawn/navigate, but no clicking, typing, or
  // scrolling. 'full' = everything. Default 'full' (undefined treated as 'full').
  browserToolsMode?: 'view' | 'full'
  // When true, the send_message MCP tool is advertised and the /messages
  // endpoint accepts calls, letting an agent write into another worktree's
  // chat. Default off (undefined treated as false).
  worktreeMessagingEnabled?: boolean
  // Controls whether new Claude tabs spawn as the terminal-hosted TUI
  // ('xterm') or the React chat interface ('json'). Default 'xterm'.
  defaultClaudeTabType?: 'xterm' | 'json'
  // True once the user dismisses the "Switch to the new Chat mode"
  // overlay shown on Terminal Claude tabs.
  chatPromotionDismissed?: boolean
  // When true, JSON-mode tabs delegate per-tool approval decisions to a
  // Haiku oneshot for obviously-safe tool calls. Productivity feature
  // only — not a security boundary. Default off (undefined treated as
  // false).
  autoApprovePermissions?: boolean
  // Optional project-specific guidance appended to the auto-approver's
  // policy prompt. Empty by default. Has no effect unless
  // autoApprovePermissions is on.
  autoApproveSteerInstructions?: string
  // Diagnostic toggle (no UI): when true, json-mode tabs spawn the user's
  // PATH `claude` instead of the bundled one. Default off.
  useSystemClaudeForJsonMode?: boolean
  // Visual density of the JSON-mode chat. Undefined = compact (the
  // historical look). 'comfy' bumps font sizes, padding, and corner
  // radius for newcomers / screen-sharing.
  jsonModeChatDensity?: 'compact' | 'comfy'
  // Global UI density. Undefined = 'small' (the historical look at 16px
  // root font-size). 'x-small' = 14px, 'medium' = 18px, 'large' = 20px,
  // 'x-large' = 22px.
  uiScale?: 'x-small' | 'small' | 'medium' | 'large' | 'x-large'
  /** Id of the active Nessie colour preset. Absent = the default. */
  nessieColor?: string
  // When true, plain Enter sends a message in the JSON-mode chat
  // composer (Shift+Enter inserts a newline). Default off — preserves
  // the historical Cmd/Ctrl+Enter-to-send behavior.
  jsonModeSendOnEnter?: boolean
  // When false, JSON-mode chat pins the most recent user prompt to the top
  // of the viewport instead of auto-scrolling to the bottom. Default true
  // (undefined = follow the tail, matches historical behavior).
  autoScrollToBottom?: boolean
  // Permission mode applied when a brand-new json-mode session spawns.
  // Existing sessions keep whatever mode they were last in. Default
  // 'acceptEdits' (auto-allow Edit/Write, still ask for Bash etc.).
  jsonModeDefaultPermissionMode?: JsonClaudePermissionMode
  // Minutes a json-mode tab can sit at 'waiting' before the auto-sleep
  // monitor tears its subprocess down. 0 disables auto-sleep. Default 30.
  autoSleepMinutes?: number
  // Configured backends (multi-backend UX, Tier 1). Auto-seeded on first
  // load with a single Local entry; the renderer's chip strip renders this
  // list and routes per-backend transports off `kind`. Tokens for remotes
  // live in secrets.enc keyed `backend-token:<id>`, never in this list.
  connections?: BackendConnection[]
  // Last-active backend id; restored on next launch so the user sees the
  // backend they were last looking at. Falls back to LOCAL_BACKEND_ID.
  activeBackendId?: string
  // Snoozed worktrees keyed by absolute path. Wakes when wakeAt is reached
  // or when the worktree's effective state transitions to 'processing'.
  snooze?: Record<string, SnoozeEntry>
  // Default duration (days) for plain-click snooze. Min 1, default 7.
  snoozeDefaultDays?: number
  // Per-worktree overrides for the "notify agent chat on CI failure"
  // behaviour, keyed by absolute path. Absent path = inherit
  // notifyChatOnCiFailure.
  ciNotify?: Record<string, boolean>
  // Global default for injecting a "CI failed" message into a worktree's
  // agent chat when its PR checks start failing. Default off.
  notifyChatOnCiFailure?: boolean
  // When true, high-volume diagnostic log categories (currently
  // [github-api] per-call lines) are written to debug.log. Default off.
  expandedDiagnosticLoggingEnabled?: boolean
  // Announcement ids the user dismissed via the banner's `×`. Stored
  // append-only — entries fall out of the feed naturally on expiry, so
  // we never need to garbage-collect this list.
  dismissedAnnouncementIds?: string[]
  // When true, all announcement banners are suppressed regardless of
  // feed contents.
  announcementsMuted?: boolean
  // When true, the sidebar's Reviewing group surfaces PRs where the user
  // is a requested reviewer (across all Ness repos) as phantom entries
  // that open the "new worktree from PR" screen on click. Default off.
  showAssignedPRs?: boolean
  // Per-worktree scratchpad notes, nested by repoRoot → worktreePath → text.
  // Same nesting scheme as `panes` so two repos with identical worktree
  // paths stay distinct. Absent / empty entries are pruned on write.
  scratchpadNotes?: Record<string, Record<string, string>>
  // Persisted alias map: worktree path → user-defined display alias.
  aliases?: Record<string, string>
  // Wake-lock mode: hold a power-save blocker 'off' | while any agent
  // session is processing | always. Default 'off'. The transient "+1h" timer
  // (preventSleepUntil) is session-only and deliberately NOT persisted here.
  preventSleepMode?: PreventSleepMode
}

export const DEFAULT_WORKTREE_BASE: 'remote' | 'local' = 'remote'
export const DEFAULT_MERGE_STRATEGY: 'squash' | 'merge-commit' | 'fast-forward' = 'squash'
export const DEFAULT_SIDEBAR_DENSITY: 'compact' | 'comfy' = 'comfy'

export const AVAILABLE_THEMES = [
  'dark',
  'dracula',
  'nord',
  'gruvbox-dark',
  'tokyo-night',
  'catppuccin-mocha',
  'one-dark',
  'solarized-dark',
  'solarized-light',
  'cyberfunk'
] as const

/** App background hex for each theme — used for the Electron window backgroundColor
 *  so the first paint matches the theme instead of flashing default dark. */
export const THEME_APP_BG: Record<string, string> = {
  'dark': '#0a0a0a',
  'dracula': '#282a36',
  'nord': '#2e3440',
  'gruvbox-dark': '#282828',
  'tokyo-night': '#1a1b26',
  'catppuccin-mocha': '#1e1e2e',
  'one-dark': '#282c34',
  'solarized-dark': '#002b36',
  'solarized-light': '#fdf6e3',
  'cyberfunk': '#000000'
}

export const DEFAULT_CLAUDE_COMMAND = 'claude'

/** The conversation-fork paragraph of the default system prompt, split out so
 *  `buildClaudeLaunchSettings` can drop it when the feature is disabled. It's
 *  interpolated into DEFAULT_HARNESS_SYSTEM_PROMPT below rather than duplicated,
 *  because the removal is an exact string match. A user who customized their
 *  prompt keeps whatever they wrote. */
export const HARNESS_SYSTEM_PROMPT_FORK_PARAGRAPH = `By default the new session starts blank and reads only your initialPrompt, so write that prompt as a real briefing. When the new worktree is meant to continue THIS conversation, pass \`forkConversation: true\` instead and it resumes holding everything said here. If the user asks for continuity — "pick up where we left off", "they should already know what we discussed" — that is a request to fork, not an invitation to write a longer briefing. The useful question isn't whether you could write a sufficient prompt (you almost always could); it's what that prompt would have to contain. If it needs to relay findings, discarded options, or decisions from this conversation, fork. If it's a task description someone could have written before this conversation started, don't. Don't fork for merely adjacent work, a clean retry, or code review — there the history is noise. Note that the new branch is cut from the base ref, so your uncommitted work and possibly your commits won't be there; Ness tells the forked agent where it is and what survived.`

export const DEFAULT_HARNESS_SYSTEM_PROMPT = `You are running inside Ness, a desktop app that manages multiple Claude Code sessions across git worktrees. You have access to ness-control MCP tools:

- mcp__ness-control__create_worktree: Create a new worktree with its own Claude session. Always provide a detailed initialPrompt so the new session has full context. Pass an optional alias — a short, human-readable label (Title Case with spaces, like "Auth Refactor" or "PR 214 Review"), not a kebab-case branch-style slug. Think tab title, not branch name.
- mcp__ness-control__list_worktrees: List all active worktrees.
- mcp__ness-control__set_worktree_alias: Give a worktree a short display name shown in the sidebar, window title, and tab strip. Defaults to the caller's worktree. Cosmetic only — never touches git. Aliases should read like a human-written tab title ("Auth Refactor", "Fix Login Bug", "PR 214 Review") — Title Case with spaces, a few words max — NOT a kebab-case slug like "auth-refactor" or "fix-login-bug" (that just duplicates what the branch name already conveys). Use it when the user gives the task a memorable label, or when the generated branch name is too long or technical to scan at a glance.
- mcp__ness-control__clear_worktree_alias: Remove a worktree's display alias so its branch name shows again. Defaults to the caller's worktree.

When the user wants to start a new task, fix, or investigation that would benefit from isolation, suggest creating a worktree for it rather than doing everything inline. Each worktree is an independent git branch with its own terminal and Claude session.

${HARNESS_SYSTEM_PROMPT_FORK_PARAGRAPH}

Ness also exposes embedded browser tabs — you can open a browser alongside the terminal and see and drive what's in it via the ness-control browser tools (scoped to this worktree only):

- create_browser_tab: open a new browser tab in this worktree (optionally navigating to a URL).
- list_browser_tabs, get_tab_url, get_tab_dom, get_tab_console_logs: inspect what's in the tab.
- navigate_tab, back_tab, forward_tab, reload_tab: drive the tab.
- get_tab_clickables: returns a compact JSON snapshot of in-viewport interactive elements (buttons, links, inputs, [role=button|link|tab|menuitem|checkbox|radio|switch|option|combobox|searchbox|textbox], [tabindex], [contenteditable], [onclick]) — including elements inside open shadow roots. Each entry is {role, name, cx, cy, w, h} with the click center already computed.
- click_tab, type_tab, scroll_tab, show_cursor: interact with the page — click at (x, y), type into the focused field, scroll, or just move the visible cursor overlay so the user can see what you're about to do.
- screenshot_tab: visual verification only. Returns JPEG quality 70 by default for context-efficiency; ask for format:'png' only when lossless matters. Screenshot dimensions match the CSS viewport, so coords observed in a screenshot can be passed straight to click_tab.

Click targeting workflow: **prefer get_tab_clickables → match by role + name → call click_tab(cx, cy) for anything you want to click**. It's far cheaper than a screenshot + vision and far more reliable for real DOM targets. Reserve screenshot_tab for confirming a click had the visual effect you wanted, or for targets without accessible names (canvas/SVG/images). The clickables snapshot is in-viewport only and capped at 500 items — if the target isn't there, scroll_tab first, then re-snapshot. To type into a field: click_tab on it first to focus, then type_tab. type_tab also accepts a \`key\` argument (Enter, Tab, Backspace, ArrowDown, …) for submitting forms or navigating menus.

Prefer these over blind curl/fetch — or shelling out to \`open <url>\`, which launches the user's default browser outside Ness where you can't see the result — when you need to verify rendered UI, inspect a dev server, debug a page the user is looking at, or confirm your changes actually work in the browser.

Ness also exposes shell tabs for long-running processes — anything that wouldn't naturally exit within a few seconds (dev servers, watchers, \`tail -f\`, REPL-style tools, long builds). Drive them via the ness-control shell tools (scoped to this worktree only):

- create_shell: spawn a shell tab, optionally with a command to run (\`zsh -ilc <command>\`). Returns an id — keep it for later reads.
- list_shells: enumerate existing shell tabs (id, label, command, alive). Check here before spawning — don't start a second \`npm run dev\` if one is already running.
- read_shell_output: read a shell's output, optionally with a \`match\` regex + \`context\` lines to scan a long log for errors/warnings without pulling back megabytes.
- kill_shell: terminate the process AND close the tab. For natural exits (process finishes on its own), the tab stays open for inspection — kill_shell is explicit cleanup.

Prefer these over running long-running commands via Bash — Bash either blocks until the process exits or loses the output stream when backgrounded, whereas a Ness shell tab keeps streaming, stays readable via read_shell_output after the fact, and is visible to the user in the Ness UI. Short one-shots (\`npm test\`, \`tsc --noEmit\`, \`git status\`) still belong on Bash.`

export const DEFAULT_HARNESS_SYSTEM_PROMPT_MAIN = `You are on the main worktree. This is the primary checkout — avoid making direct changes here unless the user explicitly asks. Instead, use this session to plan, review, and coordinate work across worktrees. When the user describes a task, create a new worktree for it with a thorough initialPrompt that gives the new Claude session all the context it needs to work independently. If you need to run a dev server, watcher, or other long-running process here, use the ness-control shell tools (create_shell / list_shells / read_shell_output / kill_shell) rather than Bash, so the output keeps streaming and stays readable.`

export const DEFAULT_TERMINAL_FONT_FAMILY =
  "'SF Mono', 'Monaco', 'Menlo', 'Courier New', monospace"
export const DEFAULT_TERMINAL_FONT_SIZE = 13

const DEFAULT_CONFIG: Config = {
  schemaVersion: 0, // overwritten in loadConfig — kept here to satisfy Config shape
  windowBounds: null,
  repoRoots: []
}

function getConfigPath(): string {
  return join(userDataDir(), 'config.json')
}

// When config.json can't be parsed we must not overwrite it with defaults
// (that would destroy the user's only copy). loadConfig instead records the
// error here, quarantines a copy, and SUSPENDS writes so the broken original
// survives for the user to hand-edit via the recovery modal.
let configLoadError: ConfigLoadError | null = null
let writesSuspended = false

export function getConfigLoadError(): ConfigLoadError | null {
  return configLoadError
}

/** Copy the unparseable config to a timestamped sibling before any reset, so
 *  nothing is lost. Null if the original couldn't be copied. */
function quarantineCorruptConfig(): string | null {
  const src = getConfigPath()
  if (!existsSync(src)) return null
  const backup = join(userDataDir(), `config.corrupt-${Date.now()}.json`)
  try {
    copyFileSync(src, backup)
    return backup
  } catch (e) {
    console.error('Failed to quarantine corrupt config:', e)
    return null
  }
}

function defaultConfig(): Config {
  return applyConnectionDefaults({ ...DEFAULT_CONFIG, schemaVersion: SCHEMA_VERSION })
}

export function loadConfig(): Config {
  try {
    const parsed = JSON.parse(readFileSync(getConfigPath(), 'utf-8')) as AnyConfig
    runMigrations(parsed)
    configLoadError = null
    writesSuspended = false
    return applyConnectionDefaults({
      ...DEFAULT_CONFIG,
      ...(parsed as Partial<Config>),
      schemaVersion: SCHEMA_VERSION
    })
  } catch (e) {
    // A missing file is the normal first-run case — nothing to preserve,
    // nothing the user broke, so just load defaults. Anything else (bad
    // JSON, unreadable) is corruption: quarantine the file and suspend
    // writes so the broken original survives for the user to hand-edit.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      configLoadError = null
      writesSuspended = false
    } else {
      configLoadError = {
        message: e instanceof Error ? e.message : String(e),
        configPath: getConfigPath(),
        backupPath: quarantineCorruptConfig()
      }
      writesSuspended = true
      console.error('Failed to load config (quarantined, writes suspended):', e)
    }
    return defaultConfig()
  }
}

/** Raw bytes of config.json for the in-app recovery editor; '' if unreadable. */
export function readRawConfigText(): string {
  try {
    return readFileSync(getConfigPath(), 'utf-8')
  } catch {
    return ''
  }
}

/** Write the user's hand-edited text to config.json, bypassing the
 *  write-suspend guard (it's the explicit recovery fix, not a structured
 *  save), then report whether it now parses. */
export function saveRawConfigText(
  text: string
): { ok: true } | { ok: false; error: string } {
  try {
    writeFileAtomic(text)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  return validateConfigFile()
}

/** Whether the on-disk config.json parses + migrates cleanly, without
 *  applying it — lets the recovery flow check a hand-edit before relaunching. */
export function validateConfigFile(): { ok: true } | { ok: false; error: string } {
  try {
    const data = readFileSync(getConfigPath(), 'utf-8')
    const parsed = JSON.parse(data) as AnyConfig
    runMigrations(parsed)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Abandon the corrupt config: re-enable writes and persist fresh defaults
 *  over the bad file (the quarantine copy is kept). */
export function discardCorruptConfigAndReset(): Config {
  writesSuspended = false
  configLoadError = null
  const fresh = defaultConfig()
  saveConfigSync(fresh)
  return fresh
}

/** Auto-seed the Local backend if `connections` is missing or empty, and
 *  default `activeBackendId` to LOCAL_BACKEND_ID. Lives outside the
 *  migration chain because it's not a structural schema change — just a
 *  runtime default — and needs to converge on every boot (e.g. after a
 *  user accidentally clears `connections` from disk).
 *
 *  Pure for testability; `loadConfig` calls it on the loaded config. */
export function applyConnectionDefaults(config: Config, now: number = Date.now()): Config {
  const next: Config = { ...config }
  if (!next.connections || next.connections.length === 0) {
    next.connections = [
      {
        id: LOCAL_BACKEND_ID,
        label: 'Local',
        url: '',
        kind: 'local',
        addedAt: now
      }
    ]
  }
  if (!next.activeBackendId) {
    next.activeBackendId = LOCAL_BACKEND_ID
  }
  return next
}

let saveTimeout: ReturnType<typeof setTimeout> | null = null

/** Write config.json atomically: write to a `.tmp` sibling, then rename over
 *  the target. rename is atomic on the same filesystem, so a crash or power
 *  loss mid-write can't leave a half-written (and thus unparseable) file. */
function writeFileAtomic(contents: string): void {
  const target = getConfigPath()
  const tmp = `${target}.tmp`
  writeFileSync(tmp, contents)
  renameSync(tmp, target)
}

function writeConfigAtomic(config: Config): void {
  writeFileAtomic(JSON.stringify(config, null, 2))
}

export function saveConfig(config: Config): void {
  if (writesSuspended) return
  if (saveTimeout) clearTimeout(saveTimeout)
  saveTimeout = setTimeout(() => {
    if (writesSuspended) return
    try {
      writeConfigAtomic(config)
    } catch (e) {
      console.error('Failed to save config:', e)
    }
  }, 500)
}

export function saveConfigSync(config: Config): void {
  if (writesSuspended) return
  try {
    writeConfigAtomic(config)
  } catch (e) {
    console.error('Failed to save config:', e)
  }
}

// --- Terminal scrollback persistence ---
// Each terminal's serialized xterm buffer is stored as a file named by a
// hash-free sanitized version of the terminal id.

function getHistoryDir(): string {
  const dir = join(userDataDir(), 'terminal-history')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function historyPath(id: string): string {
  return join(getHistoryDir(), `${sanitizeId(id)}.txt`)
}

export function saveTerminalHistory(id: string, content: string): void {
  try {
    writeFileSync(historyPath(id), content)
  } catch (e) {
    console.error('Failed to save terminal history:', e)
  }
}

export function loadTerminalHistory(id: string): string | null {
  try {
    return readFileSync(historyPath(id), 'utf-8')
  } catch {
    return null
  }
}

export function clearTerminalHistory(id: string): void {
  try {
    unlinkSync(historyPath(id))
  } catch {
    // ignore missing file
  }
}

/** Remove history files for terminals not present in `keepIds`. */
export function pruneTerminalHistory(keepIds: Set<string>): void {
  try {
    const dir = getHistoryDir()
    const keep = new Set(Array.from(keepIds).map((id) => `${sanitizeId(id)}.txt`))
    for (const file of readdirSync(dir)) {
      if (!keep.has(file)) {
        try { unlinkSync(join(dir, file)) } catch { /* ignore */ }
      }
    }
  } catch {
    // ignore
  }
}
