import type { AppState } from '../shared/state'
import { initialPRs } from '../shared/state/prs'
import { initialOnboarding } from '../shared/state/onboarding'
import { initialHooks } from '../shared/state/hooks'
import { initialWorktrees } from '../shared/state/worktrees'
import { initialTerminals } from '../shared/state/terminals'
import { initialUpdater } from '../shared/state/updater'
import { initialRepoConfigs } from '../shared/state/repo-configs'
import { initialCosts } from '../shared/state/costs'
import { initialContextWindow } from '../shared/state/context-window'
import { initialBrowser } from '../shared/state/browser'
import {
  initialJsonClaude,
  isJsonClaudePermissionMode
} from '../shared/state/json-claude'
import { initialSnooze } from '../shared/state/snooze'
import { initialCiNotify } from '../shared/state/ci-notify'
import { initialAnnouncements } from '../shared/state/announcements'
import { initialScratchpad } from '../shared/state/scratchpad'
import { initialSshBootstrap } from '../shared/state/ssh-bootstrap'
import { initialAssignedPRs } from '../shared/state/assigned-prs'
import { initialConfigHealth, type ConfigLoadError } from '../shared/state/config-health'
import { initialAliases } from '../shared/state/aliases'
import {
  initialSettings,
  nessieColorById,
  DEFAULT_LIGHT_THEME,
  DEFAULT_DARK_THEME,
  DEFAULT_PR_REVIEW_PROMPT,
  DEFAULT_SIDEBAR_DETAILS,
  BOTTOM_ICON_KEYS,
  resolveBottomIconOrder,
  isProjectSortMode,
  type PreventSleepMode,
  type BottomIconKey
} from '../shared/state/settings'
import {
  DEFAULT_CLAUDE_COMMAND,
  DEFAULT_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_FONT_SIZE,
  DEFAULT_WORKTREE_BASE,
  DEFAULT_MERGE_STRATEGY,
  DEFAULT_SIDEBAR_DENSITY,
  DEFAULT_HARNESS_SYSTEM_PROMPT,
  DEFAULT_HARNESS_SYSTEM_PROMPT_MAIN,
  type Config
} from './persistence'
import { DEFAULT_EDITOR_ID } from './editor'

/** Flatten the nested `repoRoot → worktreePath → text` shape on disk
 *  into the flat `worktreePath → text` map the slice carries in memory.
 *  Two repos shouldn't have overlapping worktree paths in practice; if
 *  they ever do, last-write-wins on iteration order. */
function flattenScratchpadNotes(
  nested: Record<string, Record<string, string>> | undefined
): Record<string, string> {
  if (!nested) return {}
  const out: Record<string, string> = {}
  for (const byPath of Object.values(nested)) {
    if (!byPath) continue
    for (const [worktreePath, text] of Object.entries(byPath)) {
      if (typeof text === 'string' && text !== '') out[worktreePath] = text
    }
  }
  return out
}

const PREVENT_SLEEP_MODES: PreventSleepMode[] = ['off', 'while-agents-running', 'always']

export function buildInitialAppState(
  config: Config,
  opts: { hasGithubToken: boolean; configLoadError?: ConfigLoadError | null }
): AppState {
  return {
    prs: initialPRs,
    configHealth: { ...initialConfigHealth, loadError: opts.configLoadError ?? null },
    onboarding: {
      ...initialOnboarding,
      quest: config.onboarding?.quest ?? 'hidden'
    },
    hooks: initialHooks,
    worktrees: { ...initialWorktrees, repoRoots: config.repoRoots || [] },
    terminals: initialTerminals,
    updater: initialUpdater,
    repoConfigs: initialRepoConfigs,
    costs: config.costs ? { ...initialCosts, ...config.costs } : initialCosts,
    // Not persisted — occupancy is recomputed from the transcript on the
    // first turn boundary after a client opens the panel.
    contextWindow: initialContextWindow,
    browser: initialBrowser,
    jsonClaude: initialJsonClaude,
    snooze: config.snooze ? { byPath: { ...config.snooze } } : initialSnooze,
    ciNotify: config.ciNotify ? { byPath: { ...config.ciNotify } } : initialCiNotify,
    announcements: initialAnnouncements,
    scratchpad: { byWorktreePath: flattenScratchpadNotes(config.scratchpadNotes) },
    sshBootstrap: initialSshBootstrap,
    assignedPRs: initialAssignedPRs,
    aliases: config.aliases
      ? { byPath: { ...config.aliases } }
      : initialAliases,
    settings: {
      ...initialSettings,
      themeMode:
        config.themeMode === 'light' || config.themeMode === 'dark'
          ? config.themeMode
          : 'system',
      themeLight: config.themeLight || DEFAULT_LIGHT_THEME,
      themeDark: config.themeDark || DEFAULT_DARK_THEME,
      hotkeys: config.hotkeys || null,
      defaultAgent: config.defaultAgent || 'claude',
      claudeCommand: config.claudeCommand || DEFAULT_CLAUDE_COMMAND,
      codexCommand: config.codexCommand || 'codex',
      cursorCommand: config.cursorCommand || 'agent',
      worktreeScripts: {
        setup: config.worktreeSetupCommand || '',
        teardown: config.worktreeTeardownCommand || ''
      },
      claudeEnvVars: config.claudeEnvVars || {},
      codexEnvVars: config.codexEnvVars || {},
      cursorEnvVars: config.cursorEnvVars || {},
      harnessMcpEnabled: config.harnessMcpEnabled !== false,
      nameClaudeSessions: config.nameClaudeSessions ?? false,
      terminalFontFamily: config.terminalFontFamily || DEFAULT_TERMINAL_FONT_FAMILY,
      terminalFontSize: config.terminalFontSize || DEFAULT_TERMINAL_FONT_SIZE,
      editor: config.editor || DEFAULT_EDITOR_ID,
      worktreeBase: config.worktreeBase || DEFAULT_WORKTREE_BASE,
      mergeStrategy: config.mergeStrategy || DEFAULT_MERGE_STRATEGY,
      sidebarDensity: config.sidebarDensity || DEFAULT_SIDEBAR_DENSITY,
      sidebarDetails: {
        compact: { ...DEFAULT_SIDEBAR_DETAILS.compact, ...(config.sidebarDetails?.compact || {}) },
        comfy: { ...DEFAULT_SIDEBAR_DETAILS.comfy, ...(config.sidebarDetails?.comfy || {}) }
      },
      claudeModel: config.claudeModel || null,
      codexModel: config.codexModel || null,
      cursorModel: config.cursorModel || null,
      hasGithubToken: opts.hasGithubToken,
      autoUpdateEnabled: config.autoUpdateEnabled !== false,
      warnBeforeQuitting: config.warnBeforeQuitting !== false,
      openPrInBrowserTab: config.openPrInBrowserTab === true,
      terminalPlainClickOpensInApp: config.terminalPlainClickOpensInApp === true,
      newWorktreeAdvancedOpen: config.newWorktreeAdvancedOpen === true,
      starterTasksDismissed: config.starterTasksDismissed === true,
      shareClaudeSettings: config.shareClaudeSettings !== false,
      harnessSystemPromptEnabled: config.harnessSystemPromptEnabled !== false,
      harnessSystemPrompt: config.harnessSystemPrompt || DEFAULT_HARNESS_SYSTEM_PROMPT,
      harnessSystemPromptMain: config.harnessSystemPromptMain || DEFAULT_HARNESS_SYSTEM_PROMPT_MAIN,
      claudeTuiFullscreen: config.claudeTuiFullscreen !== false,
      wsTransportEnabled: config.wsTransportEnabled === true,
      wsTransportPort: config.wsTransportPort ?? 37291,
      wsTransportHost: config.wsTransportHost ?? '127.0.0.1',
      browserToolsEnabled: config.browserToolsEnabled !== false,
      browserToolsMode: config.browserToolsMode === 'view' ? 'view' : 'full',
      conversationForkEnabled: config.conversationForkEnabled === true,
      worktreeMessagingEnabled: config.worktreeMessagingEnabled === true,
      defaultClaudeTabType: config.defaultClaudeTabType === 'json' ? 'json' : 'xterm',
      chatPromotionDismissed: config.chatPromotionDismissed === true,
      autoApprovePermissions: config.autoApprovePermissions === true,
      autoApproveSteerInstructions: config.autoApproveSteerInstructions || '',
      useSystemClaudeForJsonMode: config.useSystemClaudeForJsonMode === true,
      jsonModeChatDensity: config.jsonModeChatDensity === 'comfy' ? 'comfy' : 'compact',
      uiScale:
        config.uiScale === 'x-small' ||
        config.uiScale === 'medium' ||
        config.uiScale === 'large' ||
        config.uiScale === 'x-large'
          ? config.uiScale
          : 'small',
      nessieColor: nessieColorById(config.nessieColor ?? '').id,
      jsonModeSendOnEnter: config.jsonModeSendOnEnter === true,
      autoScrollToBottom: config.autoScrollToBottom !== false,
      jsonModeDefaultPermissionMode: isJsonClaudePermissionMode(
        config.jsonModeDefaultPermissionMode
      )
        ? config.jsonModeDefaultPermissionMode
        : 'acceptEdits',
      autoSleepMinutes:
        typeof config.autoSleepMinutes === 'number' &&
        Number.isFinite(config.autoSleepMinutes) &&
        config.autoSleepMinutes >= 0
          ? Math.floor(config.autoSleepMinutes)
          : 30,
      snoozeDefaultDays: Math.max(1, Math.floor(config.snoozeDefaultDays ?? 7)),
      notifyChatOnCiFailure: config.notifyChatOnCiFailure === true,
      expandedDiagnosticLoggingEnabled: config.expandedDiagnosticLoggingEnabled === true,
      prReviewPrompt: config.prReviewPrompt || DEFAULT_PR_REVIEW_PROMPT,
      dismissedAnnouncementIds: Array.isArray(config.dismissedAnnouncementIds)
        ? config.dismissedAnnouncementIds.filter((x): x is string => typeof x === 'string')
        : [],
      announcementsMuted: config.announcementsMuted === true,
      showAssignedPRs: config.showAssignedPRs === true,
      preventSleepMode: PREVENT_SLEEP_MODES.includes(config.preventSleepMode as PreventSleepMode)
        ? (config.preventSleepMode as PreventSleepMode)
        : 'off',
      // The temporary "+1h" timer never survives a relaunch — always seed null.
      preventSleepUntil: null,
      hiddenBottomIcons: sanitizeHiddenBottomIcons(config.hiddenBottomIcons),
      bottomIconOrder: resolveBottomIconOrder(
        sanitizeBottomIconOrder(config.bottomIconOrder)
      ),
      projectSort: isProjectSortMode(config.projectSort) ? config.projectSort : 'manual'
    }
  }
}

function sanitizeHiddenBottomIcons(
  input: unknown
): Partial<Record<BottomIconKey, boolean>> {
  if (!input || typeof input !== 'object') return {}
  const out: Partial<Record<BottomIconKey, boolean>> = {}
  for (const key of BOTTOM_ICON_KEYS) {
    const val = (input as Record<string, unknown>)[key]
    if (val === true) out[key] = true
  }
  return out
}

function sanitizeBottomIconOrder(input: unknown): BottomIconKey[] {
  if (!Array.isArray(input)) return []
  const out: BottomIconKey[] = []
  for (const k of input) {
    if (typeof k === 'string' && (BOTTOM_ICON_KEYS as readonly string[]).includes(k)) {
      out.push(k as BottomIconKey)
    }
  }
  return out
}
