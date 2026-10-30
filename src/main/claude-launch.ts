import type { Worktree } from '../shared/state/worktrees'
import {
  DEFAULT_HARNESS_SYSTEM_PROMPT,
  DEFAULT_HARNESS_SYSTEM_PROMPT_MAIN,
  HARNESS_SYSTEM_PROMPT_FORK_PARAGRAPH,
  HARNESS_SYSTEM_PROMPT_TAB_NAMING_SECTION
} from './persistence'

export interface ClaudeLaunchConfig {
  claudeModel?: string
  harnessSystemPrompt?: string
  harnessSystemPromptEnabled?: boolean
  harnessSystemPromptMain?: string
  claudeTuiFullscreen?: boolean
  nameClaudeSessions?: boolean
  conversationForkEnabled?: boolean
  agentTabNamingEnabled?: boolean
}

export interface ClaudeLaunchSettings {
  systemPrompt?: string
  model?: string
  sessionName?: string
  tuiFullscreen: boolean
}

/** Resolves the Claude-specific launch flags (system prompt with isMain
 *  addition, --model, --name) for both spawn paths (xterm + json-claude).
 *  Pure of side effects so it's trivially testable; takes the worktree
 *  list rather than a Store reference for the same reason. */
export function buildClaudeLaunchSettings(input: {
  cwd: string
  worktrees: Worktree[]
  config: ClaudeLaunchConfig
  modelOverride?: string
}): ClaudeLaunchSettings {
  const { cwd, worktrees, config, modelOverride } = input
  const wt = worktrees.find((w) => w.path === cwd)
  const isMain = wt?.isMain ?? false

  let systemPrompt: string | undefined
  if (config.harnessSystemPromptEnabled !== false) {
    let base = config.harnessSystemPrompt || DEFAULT_HARNESS_SYSTEM_PROMPT
    if (config.conversationForkEnabled !== true) {
      base = base.replace(`\n\n${HARNESS_SYSTEM_PROMPT_FORK_PARAGRAPH}`, '')
    }
    if (config.agentTabNamingEnabled === false) {
      base = base.replace(`\n${HARNESS_SYSTEM_PROMPT_TAB_NAMING_SECTION}`, '')
    }
    if (isMain) {
      const mainAddition =
        config.harnessSystemPromptMain || DEFAULT_HARNESS_SYSTEM_PROMPT_MAIN
      systemPrompt = `${base}\n\n${mainAddition}`
    } else {
      systemPrompt = base
    }
    if (!systemPrompt.trim()) systemPrompt = undefined
  }

  const override = modelOverride && modelOverride.trim() ? modelOverride.trim() : undefined
  const model = override || (config.claudeModel ? config.claudeModel : undefined)

  let sessionName: string | undefined
  if (config.nameClaudeSessions && wt) {
    const repoLabel = wt.repoRoot.split('/').pop() || wt.repoRoot
    sessionName = `${repoLabel}/${wt.branch}`
  }

  const tuiFullscreen = config.claudeTuiFullscreen !== false

  return { systemPrompt, model, sessionName, tuiFullscreen }
}
