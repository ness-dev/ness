import { describe, it, expect } from 'vitest'
import {
  DEFAULT_NESSIE_COLOR,
  NESSIE_COLORS,
  initialSettings,
  nessieColorById,
  settingsReducer,
  type SettingsEvent,
  type SettingsState
} from './settings'

function apply(state: SettingsState, event: SettingsEvent): SettingsState {
  return settingsReducer(state, event)
}

describe('settingsReducer', () => {
  it('themeModeChanged sets the mode', () => {
    expect(initialSettings.themeMode).toBe('system')
    const dark = apply(initialSettings, { type: 'settings/themeModeChanged', payload: 'dark' })
    expect(dark.themeMode).toBe('dark')
    const light = apply(dark, { type: 'settings/themeModeChanged', payload: 'light' })
    expect(light.themeMode).toBe('light')
    const sys = apply(light, { type: 'settings/themeModeChanged', payload: 'system' })
    expect(sys.themeMode).toBe('system')
  })

  it('themeLightChanged sets the light theme id', () => {
    expect(initialSettings.themeLight).toBe('solarized-light')
    const next = apply(initialSettings, {
      type: 'settings/themeLightChanged',
      payload: 'solarized-light'
    })
    expect(next.themeLight).toBe('solarized-light')
    const changed = apply(next, {
      type: 'settings/themeLightChanged',
      payload: 'custom-light'
    })
    expect(changed.themeLight).toBe('custom-light')
  })

  it('themeDarkChanged sets the dark theme id', () => {
    expect(initialSettings.themeDark).toBe('dark')
    const next = apply(initialSettings, { type: 'settings/themeDarkChanged', payload: 'dracula' })
    expect(next.themeDark).toBe('dracula')
  })

  it('customThemesChanged replaces the array', () => {
    expect(initialSettings.customThemes).toEqual([])
    const next = apply(initialSettings, {
      type: 'settings/customThemesChanged',
      payload: [
        { id: 'midnight', name: 'Midnight', mode: 'dark', colors: { app: '#000' } }
      ]
    })
    expect(next.customThemes).toHaveLength(1)
    expect(next.customThemes[0].id).toBe('midnight')
    const cleared = apply(next, { type: 'settings/customThemesChanged', payload: [] })
    expect(cleared.customThemes).toEqual([])
  })

  it('hotkeysChanged replaces the map (including null)', () => {
    const s1 = apply(initialSettings, {
      type: 'settings/hotkeysChanged',
      payload: { 'switch-worktree': 'Cmd+Shift+T' }
    })
    expect(s1.hotkeys).toEqual({ 'switch-worktree': 'Cmd+Shift+T' })
    const s2 = apply(s1, { type: 'settings/hotkeysChanged', payload: null })
    expect(s2.hotkeys).toBeNull()
  })

  it('claudeCommandChanged sets the command string', () => {
    const next = apply(initialSettings, {
      type: 'settings/claudeCommandChanged',
      payload: 'claude --verbose'
    })
    expect(next.claudeCommand).toBe('claude --verbose')
  })

  it('worktreeScriptsChanged replaces both setup and teardown', () => {
    const next = apply(initialSettings, {
      type: 'settings/worktreeScriptsChanged',
      payload: { setup: 'pnpm i', teardown: 'echo bye' }
    })
    expect(next.worktreeScripts).toEqual({ setup: 'pnpm i', teardown: 'echo bye' })
  })

  it('claudeEnvVarsChanged replaces the full map', () => {
    const next = apply(initialSettings, {
      type: 'settings/claudeEnvVarsChanged',
      payload: { FOO: 'bar', BAZ: 'qux' }
    })
    expect(next.claudeEnvVars).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('expandedDiagnosticLoggingEnabledChanged toggles the flag', () => {
    expect(initialSettings.expandedDiagnosticLoggingEnabled).toBe(false)
    const on = apply(initialSettings, {
      type: 'settings/expandedDiagnosticLoggingEnabledChanged',
      payload: true
    })
    expect(on.expandedDiagnosticLoggingEnabled).toBe(true)
    const off = apply(on, {
      type: 'settings/expandedDiagnosticLoggingEnabledChanged',
      payload: false
    })
    expect(off.expandedDiagnosticLoggingEnabled).toBe(false)
  })

  it('prReviewPromptChanged overrides the default review prompt', () => {
    expect(initialSettings.prReviewPrompt.length).toBeGreaterThan(0)
    const next = apply(initialSettings, {
      type: 'settings/prReviewPromptChanged',
      payload: 'Focus on security issues only.'
    })
    expect(next.prReviewPrompt).toBe('Focus on security issues only.')
  })

  it('autoUpdateEnabledChanged toggles auto-update flag', () => {
    expect(initialSettings.autoUpdateEnabled).toBe(true)
    const off = apply(initialSettings, {
      type: 'settings/autoUpdateEnabledChanged',
      payload: false
    })
    expect(off.autoUpdateEnabled).toBe(false)
    const on = apply(off, { type: 'settings/autoUpdateEnabledChanged', payload: true })
    expect(on.autoUpdateEnabled).toBe(true)
  })

  it('warnBeforeQuittingChanged toggles the warn-before-quitting flag', () => {
    expect(initialSettings.warnBeforeQuitting).toBe(true)
    const off = apply(initialSettings, {
      type: 'settings/warnBeforeQuittingChanged',
      payload: false
    })
    expect(off.warnBeforeQuitting).toBe(false)
    const on = apply(off, { type: 'settings/warnBeforeQuittingChanged', payload: true })
    expect(on.warnBeforeQuitting).toBe(true)
  })

  it('openPrInBrowserTabChanged toggles the in-app PR browser flag', () => {
    expect(initialSettings.openPrInBrowserTab).toBe(false)
    const on = apply(initialSettings, {
      type: 'settings/openPrInBrowserTabChanged',
      payload: true
    })
    expect(on.openPrInBrowserTab).toBe(true)
    const off = apply(on, { type: 'settings/openPrInBrowserTabChanged', payload: false })
    expect(off.openPrInBrowserTab).toBe(false)
  })

  it('terminalPlainClickOpensInAppChanged toggles the link-modifier swap', () => {
    expect(initialSettings.terminalPlainClickOpensInApp).toBe(false)
    const on = apply(initialSettings, {
      type: 'settings/terminalPlainClickOpensInAppChanged',
      payload: true
    })
    expect(on.terminalPlainClickOpensInApp).toBe(true)
    const off = apply(on, {
      type: 'settings/terminalPlainClickOpensInAppChanged',
      payload: false
    })
    expect(off.terminalPlainClickOpensInApp).toBe(false)
  })

  it('shareClaudeSettingsChanged toggles the share flag', () => {
    expect(initialSettings.shareClaudeSettings).toBe(true)
    const off = apply(initialSettings, {
      type: 'settings/shareClaudeSettingsChanged',
      payload: false
    })
    expect(off.shareClaudeSettings).toBe(false)
    const on = apply(off, { type: 'settings/shareClaudeSettingsChanged', payload: true })
    expect(on.shareClaudeSettings).toBe(true)
  })

  it('newWorktreeAdvancedOpenChanged remembers the disclosure state', () => {
    expect(initialSettings.newWorktreeAdvancedOpen).toBe(false)
    const open = apply(initialSettings, {
      type: 'settings/newWorktreeAdvancedOpenChanged',
      payload: true
    })
    expect(open.newWorktreeAdvancedOpen).toBe(true)
    const closed = apply(open, {
      type: 'settings/newWorktreeAdvancedOpenChanged',
      payload: false
    })
    expect(closed.newWorktreeAdvancedOpen).toBe(false)
  })

  it('starterTasksDismissedChanged hides the starter cards for good', () => {
    expect(initialSettings.starterTasksDismissed).toBe(false)
    const dismissed = apply(initialSettings, {
      type: 'settings/starterTasksDismissedChanged',
      payload: true
    })
    expect(dismissed.starterTasksDismissed).toBe(true)
  })

  it('harnessMcpEnabledChanged toggles mcp flag', () => {
    const off = apply(initialSettings, {
      type: 'settings/harnessMcpEnabledChanged',
      payload: false
    })
    expect(off.harnessMcpEnabled).toBe(false)
    const on = apply(off, { type: 'settings/harnessMcpEnabledChanged', payload: true })
    expect(on.harnessMcpEnabled).toBe(true)
  })

  it('nameClaudeSessionsChanged toggles flag', () => {
    const next = apply(initialSettings, {
      type: 'settings/nameClaudeSessionsChanged',
      payload: true
    })
    expect(next.nameClaudeSessions).toBe(true)
  })

  it('terminalFontFamilyChanged sets font family', () => {
    const next = apply(initialSettings, {
      type: 'settings/terminalFontFamilyChanged',
      payload: 'JetBrains Mono'
    })
    expect(next.terminalFontFamily).toBe('JetBrains Mono')
  })

  it('terminalFontSizeChanged sets font size', () => {
    const next = apply(initialSettings, {
      type: 'settings/terminalFontSizeChanged',
      payload: 16
    })
    expect(next.terminalFontSize).toBe(16)
  })

  it('editorChanged sets editor id', () => {
    const next = apply(initialSettings, { type: 'settings/editorChanged', payload: 'zed' })
    expect(next.editor).toBe('zed')
  })

  it('worktreeBaseChanged sets base mode', () => {
    const next = apply(initialSettings, {
      type: 'settings/worktreeBaseChanged',
      payload: 'local'
    })
    expect(next.worktreeBase).toBe('local')
  })

  it('mergeStrategyChanged sets strategy', () => {
    const next = apply(initialSettings, {
      type: 'settings/mergeStrategyChanged',
      payload: 'fast-forward'
    })
    expect(next.mergeStrategy).toBe('fast-forward')
  })

  it('sidebarDensityChanged toggles between comfy and compact', () => {
    expect(initialSettings.sidebarDensity).toBe('comfy')
    const compact = apply(initialSettings, {
      type: 'settings/sidebarDensityChanged',
      payload: 'compact'
    })
    expect(compact.sidebarDensity).toBe('compact')
    const comfy = apply(compact, {
      type: 'settings/sidebarDensityChanged',
      payload: 'comfy'
    })
    expect(comfy.sidebarDensity).toBe('comfy')
  })

  it('sidebarDetailsChanged replaces the whole per-mode prefs object', () => {
    // Comfy defaults: everything on.
    expect(initialSettings.sidebarDetails.comfy.diff).toBe(true)
    expect(initialSettings.sidebarDetails.comfy.assignee).toBe(true)
    // Compact defaults: only repoLabel + prNumber + assignee.
    expect(initialSettings.sidebarDetails.compact.branch).toBe(false)
    expect(initialSettings.sidebarDetails.compact.age).toBe(false)
    expect(initialSettings.sidebarDetails.compact.diff).toBe(false)
    expect(initialSettings.sidebarDetails.compact.milestone).toBe(false)
    expect(initialSettings.sidebarDetails.compact.repoLabel).toBe(true)
    expect(initialSettings.sidebarDetails.compact.prNumber).toBe(true)
    expect(initialSettings.sidebarDetails.compact.assignee).toBe(true)

    const next = apply(initialSettings, {
      type: 'settings/sidebarDetailsChanged',
      payload: {
        compact: {
          repoLabel: true,
          branch: true,
          age: false,
          diff: false,
          milestone: false,
          prNumber: true,
          assignee: true
        },
        comfy: {
          repoLabel: true,
          branch: true,
          age: true,
          diff: false,
          milestone: false,
          prNumber: true,
          assignee: false
        }
      }
    })
    expect(next.sidebarDetails.compact.branch).toBe(true)
    expect(next.sidebarDetails.comfy.diff).toBe(false)
    expect(next.sidebarDetails.comfy.assignee).toBe(false)
  })


  it('hasGithubTokenChanged flips the presence flag', () => {
    const hasIt = apply(initialSettings, {
      type: 'settings/hasGithubTokenChanged',
      payload: true
    })
    expect(hasIt.hasGithubToken).toBe(true)
    const gone = apply(hasIt, { type: 'settings/hasGithubTokenChanged', payload: false })
    expect(gone.hasGithubToken).toBe(false)
  })

  it('harnessStarredChanged tracks star state', () => {
    const yes = apply(initialSettings, { type: 'settings/harnessStarredChanged', payload: true })
    expect(yes.harnessStarred).toBe(true)
    const no = apply(yes, { type: 'settings/harnessStarredChanged', payload: false })
    expect(no.harnessStarred).toBe(false)
    const unknown = apply(no, { type: 'settings/harnessStarredChanged', payload: null })
    expect(unknown.harnessStarred).toBeNull()
  })

  it('githubAuthSourceChanged updates the source', () => {
    const gh = apply(initialSettings, {
      type: 'settings/githubAuthSourceChanged',
      payload: 'gh-cli'
    })
    expect(gh.githubAuthSource).toBe('gh-cli')
    const pat = apply(gh, { type: 'settings/githubAuthSourceChanged', payload: 'pat' })
    expect(pat.githubAuthSource).toBe('pat')
    const none = apply(pat, { type: 'settings/githubAuthSourceChanged', payload: null })
    expect(none.githubAuthSource).toBeNull()
  })

  it('claudeModelChanged sets the model', () => {
    const next = apply(initialSettings, {
      type: 'settings/claudeModelChanged',
      payload: 'claude-opus-4-7'
    })
    expect(next.claudeModel).toBe('claude-opus-4-7')
  })

  it('claudeModelChanged clears with null', () => {
    const withModel = apply(initialSettings, {
      type: 'settings/claudeModelChanged',
      payload: 'claude-opus-4-7'
    })
    const cleared = apply(withModel, {
      type: 'settings/claudeModelChanged',
      payload: null
    })
    expect(cleared.claudeModel).toBeNull()
  })

  it('codexModelChanged sets the model', () => {
    const next = apply(initialSettings, {
      type: 'settings/codexModelChanged',
      payload: 'o3'
    })
    expect(next.codexModel).toBe('o3')
  })

  it('codexModelChanged clears with null', () => {
    const withModel = apply(initialSettings, {
      type: 'settings/codexModelChanged',
      payload: 'o3'
    })
    const cleared = apply(withModel, {
      type: 'settings/codexModelChanged',
      payload: null
    })
    expect(cleared.codexModel).toBeNull()
  })

  it('cursorCommandChanged sets the command string', () => {
    const next = apply(initialSettings, {
      type: 'settings/cursorCommandChanged',
      payload: 'agent --force'
    })
    expect(next.cursorCommand).toBe('agent --force')
  })

  it('cursorEnvVarsChanged replaces the full map', () => {
    const next = apply(initialSettings, {
      type: 'settings/cursorEnvVarsChanged',
      payload: { CURSOR_API_KEY: 'secret' }
    })
    expect(next.cursorEnvVars).toEqual({ CURSOR_API_KEY: 'secret' })
  })

  it('cursorModelChanged sets the model', () => {
    const next = apply(initialSettings, {
      type: 'settings/cursorModelChanged',
      payload: 'composer-2.5'
    })
    expect(next.cursorModel).toBe('composer-2.5')
  })

  it('cursorModelChanged clears with null', () => {
    const withModel = apply(initialSettings, {
      type: 'settings/cursorModelChanged',
      payload: 'composer-2.5'
    })
    const cleared = apply(withModel, {
      type: 'settings/cursorModelChanged',
      payload: null
    })
    expect(cleared.cursorModel).toBeNull()
  })

  it('harnessSystemPromptEnabledChanged toggles flag', () => {
    const off = apply(initialSettings, {
      type: 'settings/harnessSystemPromptEnabledChanged',
      payload: false
    })
    expect(off.harnessSystemPromptEnabled).toBe(false)
    const on = apply(off, {
      type: 'settings/harnessSystemPromptEnabledChanged',
      payload: true
    })
    expect(on.harnessSystemPromptEnabled).toBe(true)
  })

  it('harnessSystemPromptChanged sets the prompt', () => {
    const next = apply(initialSettings, {
      type: 'settings/harnessSystemPromptChanged',
      payload: 'custom prompt'
    })
    expect(next.harnessSystemPrompt).toBe('custom prompt')
  })

  it('harnessSystemPromptMainChanged sets the main prompt', () => {
    const next = apply(initialSettings, {
      type: 'settings/harnessSystemPromptMainChanged',
      payload: 'main only text'
    })
    expect(next.harnessSystemPromptMain).toBe('main only text')
  })

  it('claudeTuiFullscreenChanged toggles flag', () => {
    expect(initialSettings.claudeTuiFullscreen).toBe(true)
    const off = apply(initialSettings, {
      type: 'settings/claudeTuiFullscreenChanged',
      payload: false
    })
    expect(off.claudeTuiFullscreen).toBe(false)
    const on = apply(off, { type: 'settings/claudeTuiFullscreenChanged', payload: true })
    expect(on.claudeTuiFullscreen).toBe(true)
  })

  it('wsTransportEnabledChanged toggles flag', () => {
    expect(initialSettings.wsTransportEnabled).toBe(false)
    const on = apply(initialSettings, {
      type: 'settings/wsTransportEnabledChanged',
      payload: true
    })
    expect(on.wsTransportEnabled).toBe(true)
    const off = apply(on, { type: 'settings/wsTransportEnabledChanged', payload: false })
    expect(off.wsTransportEnabled).toBe(false)
  })

  it('wsTransportPortChanged sets the port', () => {
    const next = apply(initialSettings, {
      type: 'settings/wsTransportPortChanged',
      payload: 55555
    })
    expect(next.wsTransportPort).toBe(55555)
  })

  it('wsTransportHostChanged sets the bind host', () => {
    expect(initialSettings.wsTransportHost).toBe('127.0.0.1')
    const lan = apply(initialSettings, {
      type: 'settings/wsTransportHostChanged',
      payload: '0.0.0.0'
    })
    expect(lan.wsTransportHost).toBe('0.0.0.0')
    const back = apply(lan, {
      type: 'settings/wsTransportHostChanged',
      payload: '127.0.0.1'
    })
    expect(back.wsTransportHost).toBe('127.0.0.1')
  })

  it('browserToolsEnabledChanged toggles flag', () => {
    expect(initialSettings.browserToolsEnabled).toBe(true)
    const off = apply(initialSettings, {
      type: 'settings/browserToolsEnabledChanged',
      payload: false
    })
    expect(off.browserToolsEnabled).toBe(false)
    const on = apply(off, { type: 'settings/browserToolsEnabledChanged', payload: true })
    expect(on.browserToolsEnabled).toBe(true)
  })

  it('conversationForkEnabledChanged toggles flag', () => {
    expect(initialSettings.conversationForkEnabled).toBe(false)
    const on = apply(initialSettings, {
      type: 'settings/conversationForkEnabledChanged',
      payload: true
    })
    expect(on.conversationForkEnabled).toBe(true)
    const off = apply(on, { type: 'settings/conversationForkEnabledChanged', payload: false })
    expect(off.conversationForkEnabled).toBe(false)
  })

  it('worktreeMessagingEnabledChanged toggles flag, defaulting off', () => {
    expect(initialSettings.worktreeMessagingEnabled).toBe(false)
    const on = apply(initialSettings, {
      type: 'settings/worktreeMessagingEnabledChanged',
      payload: true
    })
    expect(on.worktreeMessagingEnabled).toBe(true)
    const off = apply(on, {
      type: 'settings/worktreeMessagingEnabledChanged',
      payload: false
    })
    expect(off.worktreeMessagingEnabled).toBe(false)
  })

  it('browserToolsModeChanged switches between view and full', () => {
    expect(initialSettings.browserToolsMode).toBe('full')
    const view = apply(initialSettings, {
      type: 'settings/browserToolsModeChanged',
      payload: 'view'
    })
    expect(view.browserToolsMode).toBe('view')
    const full = apply(view, { type: 'settings/browserToolsModeChanged', payload: 'full' })
    expect(full.browserToolsMode).toBe('full')
  })

  it('chatPromotionDismissedChanged toggles the flag', () => {
    expect(initialSettings.chatPromotionDismissed).toBe(false)
    const on = apply(initialSettings, {
      type: 'settings/chatPromotionDismissedChanged',
      payload: true
    })
    expect(on.chatPromotionDismissed).toBe(true)
    const off = apply(on, {
      type: 'settings/chatPromotionDismissedChanged',
      payload: false
    })
    expect(off.chatPromotionDismissed).toBe(false)
  })

  it('defaultClaudeTabTypeChanged switches between xterm and json', () => {
    expect(initialSettings.defaultClaudeTabType).toBe('xterm')
    const json = apply(initialSettings, {
      type: 'settings/defaultClaudeTabTypeChanged',
      payload: 'json'
    })
    expect(json.defaultClaudeTabType).toBe('json')
    const xterm = apply(json, {
      type: 'settings/defaultClaudeTabTypeChanged',
      payload: 'xterm'
    })
    expect(xterm.defaultClaudeTabType).toBe('xterm')
  })

  it('autoApprovePermissionsChanged toggles the flag', () => {
    expect(initialSettings.autoApprovePermissions).toBe(false)
    const on = apply(initialSettings, {
      type: 'settings/autoApprovePermissionsChanged',
      payload: true
    })
    expect(on.autoApprovePermissions).toBe(true)
    const off = apply(on, {
      type: 'settings/autoApprovePermissionsChanged',
      payload: false
    })
    expect(off.autoApprovePermissions).toBe(false)
  })

  it('autoApproveSteerInstructionsChanged sets the steer text', () => {
    expect(initialSettings.autoApproveSteerInstructions).toBe('')
    const next = apply(initialSettings, {
      type: 'settings/autoApproveSteerInstructionsChanged',
      payload: 'approve npm install for this project'
    })
    expect(next.autoApproveSteerInstructions).toBe(
      'approve npm install for this project'
    )
    const cleared = apply(next, {
      type: 'settings/autoApproveSteerInstructionsChanged',
      payload: ''
    })
    expect(cleared.autoApproveSteerInstructions).toBe('')
  })

  it('jsonModeChatDensityChanged switches between compact and comfy', () => {
    expect(initialSettings.jsonModeChatDensity).toBe('compact')
    const comfy = apply(initialSettings, {
      type: 'settings/jsonModeChatDensityChanged',
      payload: 'comfy'
    })
    expect(comfy.jsonModeChatDensity).toBe('comfy')
    const compact = apply(comfy, {
      type: 'settings/jsonModeChatDensityChanged',
      payload: 'compact'
    })
    expect(compact.jsonModeChatDensity).toBe('compact')
  })

  it('uiScaleChanged walks through every step', () => {
    expect(initialSettings.uiScale).toBe('small')
    const medium = apply(initialSettings, {
      type: 'settings/uiScaleChanged',
      payload: 'medium'
    })
    expect(medium.uiScale).toBe('medium')
    const large = apply(medium, {
      type: 'settings/uiScaleChanged',
      payload: 'large'
    })
    expect(large.uiScale).toBe('large')
    const xl = apply(large, {
      type: 'settings/uiScaleChanged',
      payload: 'x-large'
    })
    expect(xl.uiScale).toBe('x-large')
    const back = apply(xl, {
      type: 'settings/uiScaleChanged',
      payload: 'small'
    })
    expect(back.uiScale).toBe('small')
  })

  it('nessieColorChanged swaps the brand colour preset', () => {
    expect(initialSettings.nessieColor).toBe(DEFAULT_NESSIE_COLOR)
    const legacy = apply(initialSettings, {
      type: 'settings/nessieColorChanged',
      payload: 'legacy'
    })
    expect(legacy.nessieColor).toBe('legacy')
    const back = apply(legacy, {
      type: 'settings/nessieColorChanged',
      payload: DEFAULT_NESSIE_COLOR
    })
    expect(back.nessieColor).toBe(DEFAULT_NESSIE_COLOR)
  })

  it('nessieColorById falls back to the default for an unknown id', () => {
    // Guards the upgrade path: a preset dropped in a later release must not
    // leave a user with no brand colour at all.
    expect(nessieColorById('no-such-preset').id).toBe(DEFAULT_NESSIE_COLOR)
    expect(nessieColorById('legacy').id).toBe('legacy')
  })

  it('every Nessie preset supplies a paintable gradient and flow', () => {
    // The gradient classes always paint background-image, so a preset with a
    // bare hex here would silently render nothing.
    for (const c of NESSIE_COLORS) {
      expect(c.gradient).toContain('gradient(')
      expect(c.flow).toContain('gradient(')
    }
  })

  it('jsonModeSendOnEnterChanged toggles the send-on-enter flag', () => {
    expect(initialSettings.jsonModeSendOnEnter).toBe(false)
    const on = apply(initialSettings, {
      type: 'settings/jsonModeSendOnEnterChanged',
      payload: true
    })
    expect(on.jsonModeSendOnEnter).toBe(true)
    const off = apply(on, {
      type: 'settings/jsonModeSendOnEnterChanged',
      payload: false
    })
    expect(off.jsonModeSendOnEnter).toBe(false)
  })

  it('autoScrollToBottomChanged toggles the auto-scroll flag', () => {
    expect(initialSettings.autoScrollToBottom).toBe(true)
    const off = apply(initialSettings, {
      type: 'settings/autoScrollToBottomChanged',
      payload: false
    })
    expect(off.autoScrollToBottom).toBe(false)
    const on = apply(off, {
      type: 'settings/autoScrollToBottomChanged',
      payload: true
    })
    expect(on.autoScrollToBottom).toBe(true)
  })

  it('jsonModeDefaultPermissionModeChanged sets the default and preserves other settings', () => {
    expect(initialSettings.jsonModeDefaultPermissionMode).toBe('acceptEdits')
    const start: SettingsState = {
      ...initialSettings,
      claudeCommand: 'pre-existing'
    }
    const planned = apply(start, {
      type: 'settings/jsonModeDefaultPermissionModeChanged',
      payload: 'plan'
    })
    expect(planned.jsonModeDefaultPermissionMode).toBe('plan')
    expect(planned.claudeCommand).toBe('pre-existing')
    const back = apply(planned, {
      type: 'settings/jsonModeDefaultPermissionModeChanged',
      payload: 'default'
    })
    expect(back.jsonModeDefaultPermissionMode).toBe('default')
    const auto = apply(back, {
      type: 'settings/jsonModeDefaultPermissionModeChanged',
      payload: 'auto'
    })
    expect(auto.jsonModeDefaultPermissionMode).toBe('auto')
  })

  it('useSystemClaudeForJsonModeChanged toggles the diagnostic flag', () => {
    expect(initialSettings.useSystemClaudeForJsonMode).toBe(false)
    const on = apply(initialSettings, {
      type: 'settings/useSystemClaudeForJsonModeChanged',
      payload: true
    })
    expect(on.useSystemClaudeForJsonMode).toBe(true)
    const off = apply(on, {
      type: 'settings/useSystemClaudeForJsonModeChanged',
      payload: false
    })
    expect(off.useSystemClaudeForJsonMode).toBe(false)
  })

  it('autoSleepMinutesChanged sets the threshold', () => {
    const next = apply(initialSettings, {
      type: 'settings/autoSleepMinutesChanged',
      payload: 15
    })
    expect(next.autoSleepMinutes).toBe(15)
    const off = apply(next, { type: 'settings/autoSleepMinutesChanged', payload: 0 })
    expect(off.autoSleepMinutes).toBe(0)
  })

  it('snoozeDefaultDaysChanged sets the default duration', () => {
    expect(initialSettings.snoozeDefaultDays).toBe(7)
    const next = apply(initialSettings, {
      type: 'settings/snoozeDefaultDaysChanged',
      payload: 3
    })
    expect(next.snoozeDefaultDays).toBe(3)
  })

  it('notifyChatOnCiFailureChanged toggles the global default', () => {
    expect(initialSettings.notifyChatOnCiFailure).toBe(false)
    const on = apply(initialSettings, {
      type: 'settings/notifyChatOnCiFailureChanged',
      payload: true
    })
    expect(on.notifyChatOnCiFailure).toBe(true)
    const off = apply(on, {
      type: 'settings/notifyChatOnCiFailureChanged',
      payload: false
    })
    expect(off.notifyChatOnCiFailure).toBe(false)
  })

  it('announcementDismissed appends the id and dedups', () => {
    expect(initialSettings.dismissedAnnouncementIds).toEqual([])
    const once = apply(initialSettings, {
      type: 'settings/announcementDismissed',
      payload: 'release-1.2'
    })
    expect(once.dismissedAnnouncementIds).toEqual(['release-1.2'])
    const twice = apply(once, {
      type: 'settings/announcementDismissed',
      payload: 'release-1.2'
    })
    expect(twice.dismissedAnnouncementIds).toEqual(['release-1.2'])
    expect(twice).toBe(once)
    const second = apply(twice, {
      type: 'settings/announcementDismissed',
      payload: 'hn-front-page'
    })
    expect(second.dismissedAnnouncementIds).toEqual(['release-1.2', 'hn-front-page'])
  })

  it('announcementsMutedChanged toggles the mute flag', () => {
    expect(initialSettings.announcementsMuted).toBe(false)
    const on = apply(initialSettings, {
      type: 'settings/announcementsMutedChanged',
      payload: true
    })
    expect(on.announcementsMuted).toBe(true)
    const off = apply(on, {
      type: 'settings/announcementsMutedChanged',
      payload: false
    })
    expect(off.announcementsMuted).toBe(false)
  })

  it('showAssignedPRsChanged toggles the flag', () => {
    expect(initialSettings.showAssignedPRs).toBe(false)
    const on = apply(initialSettings, {
      type: 'settings/showAssignedPRsChanged',
      payload: true
    })
    expect(on.showAssignedPRs).toBe(true)
    const off = apply(on, { type: 'settings/showAssignedPRsChanged', payload: false })
    expect(off.showAssignedPRs).toBe(false)
  })

  it('preventSleepModeChanged walks through every mode', () => {
    expect(initialSettings.preventSleepMode).toBe('off')
    const auto = apply(initialSettings, {
      type: 'settings/preventSleepModeChanged',
      payload: 'while-agents-running'
    })
    expect(auto.preventSleepMode).toBe('while-agents-running')
    const always = apply(auto, { type: 'settings/preventSleepModeChanged', payload: 'always' })
    expect(always.preventSleepMode).toBe('always')
    const off = apply(always, { type: 'settings/preventSleepModeChanged', payload: 'off' })
    expect(off.preventSleepMode).toBe('off')
  })

  it('preventSleepUntilChanged arms and clears the timer deadline', () => {
    expect(initialSettings.preventSleepUntil).toBeNull()
    const armed = apply(initialSettings, {
      type: 'settings/preventSleepUntilChanged',
      payload: 1_700_000_000_000
    })
    expect(armed.preventSleepUntil).toBe(1_700_000_000_000)
    const cleared = apply(armed, {
      type: 'settings/preventSleepUntilChanged',
      payload: null
    })
    expect(cleared.preventSleepUntil).toBeNull()
  })

  it('hiddenBottomIconsChanged replaces the whole hidden map', () => {
    expect(initialSettings.hiddenBottomIcons).toEqual({})
    const hidden = apply(initialSettings, {
      type: 'settings/hiddenBottomIconsChanged',
      payload: { activity: true, myWeek: true }
    })
    expect(hidden.hiddenBottomIcons).toEqual({ activity: true, myWeek: true })
    const cleared = apply(hidden, {
      type: 'settings/hiddenBottomIconsChanged',
      payload: {}
    })
    expect(cleared.hiddenBottomIcons).toEqual({})
  })

  it('bottomIconOrderChanged replaces the render order', () => {
    const reordered = apply(initialSettings, {
      type: 'settings/bottomIconOrderChanged',
      payload: ['settings', 'commandCenter', 'newProject']
    })
    expect(reordered.bottomIconOrder).toEqual(['settings', 'commandCenter', 'newProject'])
  })

  it('projectSortChanged replaces the sidebar project order mode', () => {
    const next = apply(initialSettings, {
      type: 'settings/projectSortChanged',
      payload: 'recent-agent'
    })
    expect(initialSettings.projectSort).toBe('manual')
    expect(next.projectSort).toBe('recent-agent')
  })

  it('returns a new object reference (no mutation)', () => {
    const next = apply(initialSettings, { type: 'settings/themeDarkChanged', payload: 'dracula' })
    expect(next).not.toBe(initialSettings)
    expect(initialSettings.themeDark).not.toBe('dracula')
  })

  it('leaves unrelated fields untouched', () => {
    const start: SettingsState = {
      ...initialSettings,
      claudeCommand: 'pre-existing',
      nameClaudeSessions: true
    }
    const next = apply(start, { type: 'settings/themeDarkChanged', payload: 'nord' })
    expect(next.claudeCommand).toBe('pre-existing')
    expect(next.nameClaudeSessions).toBe(true)
  })
})
