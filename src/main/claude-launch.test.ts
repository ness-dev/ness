import { describe, it, expect } from 'vitest'
import { buildClaudeLaunchSettings } from './claude-launch'
import {
  DEFAULT_HARNESS_SYSTEM_PROMPT,
  DEFAULT_HARNESS_SYSTEM_PROMPT_MAIN,
  HARNESS_SYSTEM_PROMPT_FORK_PARAGRAPH,
  HARNESS_SYSTEM_PROMPT_TAB_NAMING_SECTION
} from './persistence'
import type { Worktree } from '../shared/state/worktrees'

/** Conversation fork is opt-in, so the default prompt omits its paragraph. */
const PROMPT_WITHOUT_FORK = DEFAULT_HARNESS_SYSTEM_PROMPT.replace(
  `\n\n${HARNESS_SYSTEM_PROMPT_FORK_PARAGRAPH}`,
  ''
)

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    path: '/tmp/repo/feat-x',
    branch: 'feat-x',
    head: 'deadbeef',
    isBare: false,
    isMain: false,
    createdAt: 0,
    repoRoot: '/tmp/repo',
    ...overrides
  }
}

describe('buildClaudeLaunchSettings', () => {
  it('returns the base harness system prompt for a non-main worktree', () => {
    const wt = makeWorktree()
    const out = buildClaudeLaunchSettings({
      cwd: wt.path,
      worktrees: [wt],
      config: {}
    })
    expect(out.systemPrompt).toBe(PROMPT_WITHOUT_FORK)
  })

  it('includes the fork paragraph only when conversationForkEnabled is true', () => {
    const wt = makeWorktree()
    const on = buildClaudeLaunchSettings({
      cwd: wt.path,
      worktrees: [wt],
      config: { conversationForkEnabled: true }
    })
    expect(on.systemPrompt).toBe(DEFAULT_HARNESS_SYSTEM_PROMPT)
    expect(on.systemPrompt).toContain(HARNESS_SYSTEM_PROMPT_FORK_PARAGRAPH)
    expect(PROMPT_WITHOUT_FORK).not.toContain(HARNESS_SYSTEM_PROMPT_FORK_PARAGRAPH)
  })

  it('includes the tab-naming section by default and drops it when disabled', () => {
    const wt = makeWorktree()
    const on = buildClaudeLaunchSettings({ cwd: wt.path, worktrees: [wt], config: {} })
    expect(on.systemPrompt).toContain(HARNESS_SYSTEM_PROMPT_TAB_NAMING_SECTION)

    const off = buildClaudeLaunchSettings({
      cwd: wt.path,
      worktrees: [wt],
      config: { agentTabNamingEnabled: false }
    })
    expect(off.systemPrompt).not.toContain(HARNESS_SYSTEM_PROMPT_TAB_NAMING_SECTION)
    expect(off.systemPrompt).not.toContain('set_tab_name')
  })

  it('leaves the surrounding tool list intact when the tab-naming section is dropped', () => {
    // The section is the tail of a bullet list, so a sloppy strip would
    // either eat the preceding newline or leave a dangling blank line.
    const wt = makeWorktree()
    const off = buildClaudeLaunchSettings({
      cwd: wt.path,
      worktrees: [wt],
      config: { agentTabNamingEnabled: false }
    })
    expect(off.systemPrompt).toContain(
      "- mcp__ness-control__clear_worktree_alias: Remove a worktree's display alias so its branch name shows again. Defaults to the caller's worktree.\n\nWhen the user wants to start a new task"
    )
    expect(off.systemPrompt).not.toMatch(/\n\n\n/)
  })

  it('leaves a custom system prompt untouched when fork is disabled', () => {
    const wt = makeWorktree()
    const out = buildClaudeLaunchSettings({
      cwd: wt.path,
      worktrees: [wt],
      config: { harnessSystemPrompt: 'MY PROMPT' }
    })
    expect(out.systemPrompt).toBe('MY PROMPT')
  })

  it('appends the main-worktree addition when isMain', () => {
    const wt = makeWorktree({ isMain: true, path: '/tmp/repo' })
    const out = buildClaudeLaunchSettings({
      cwd: wt.path,
      worktrees: [wt],
      config: {}
    })
    expect(out.systemPrompt).toBe(
      `${PROMPT_WITHOUT_FORK}\n\n${DEFAULT_HARNESS_SYSTEM_PROMPT_MAIN}`
    )
  })

  it('honors custom harnessSystemPrompt + harnessSystemPromptMain overrides', () => {
    const wt = makeWorktree({ isMain: true, path: '/tmp/repo' })
    const out = buildClaudeLaunchSettings({
      cwd: wt.path,
      worktrees: [wt],
      config: {
        harnessSystemPrompt: 'BASE',
        harnessSystemPromptMain: 'MAIN'
      }
    })
    expect(out.systemPrompt).toBe('BASE\n\nMAIN')
  })

  it('omits systemPrompt entirely when harnessSystemPromptEnabled is false', () => {
    const wt = makeWorktree()
    const out = buildClaudeLaunchSettings({
      cwd: wt.path,
      worktrees: [wt],
      config: { harnessSystemPromptEnabled: false }
    })
    expect(out.systemPrompt).toBeUndefined()
  })

  it('omits systemPrompt when both base and addition are blank strings', () => {
    const wt = makeWorktree({ isMain: true, path: '/tmp/repo' })
    const out = buildClaudeLaunchSettings({
      cwd: wt.path,
      worktrees: [wt],
      config: { harnessSystemPrompt: '   ', harnessSystemPromptMain: '   ' }
    })
    expect(out.systemPrompt).toBeUndefined()
  })

  it('returns model when claudeModel is set, undefined otherwise', () => {
    const wt = makeWorktree()
    expect(
      buildClaudeLaunchSettings({
        cwd: wt.path,
        worktrees: [wt],
        config: { claudeModel: 'opus' }
      }).model
    ).toBe('opus')
    expect(
      buildClaudeLaunchSettings({
        cwd: wt.path,
        worktrees: [wt],
        config: {}
      }).model
    ).toBeUndefined()
  })

  it('modelOverride wins over claudeModel and trims whitespace', () => {
    const wt = makeWorktree()
    expect(
      buildClaudeLaunchSettings({
        cwd: wt.path,
        worktrees: [wt],
        config: { claudeModel: 'opus' },
        modelOverride: 'sonnet-4-5'
      }).model
    ).toBe('sonnet-4-5')
    expect(
      buildClaudeLaunchSettings({
        cwd: wt.path,
        worktrees: [wt],
        config: {},
        modelOverride: '  haiku  '
      }).model
    ).toBe('haiku')
    // Blank/whitespace override falls through to settings.
    expect(
      buildClaudeLaunchSettings({
        cwd: wt.path,
        worktrees: [wt],
        config: { claudeModel: 'opus' },
        modelOverride: '   '
      }).model
    ).toBe('opus')
  })

  it('builds sessionName from repoLabel/branch when nameClaudeSessions is on', () => {
    const wt = makeWorktree({ repoRoot: '/Users/x/code/myrepo', branch: 'feat-x' })
    const out = buildClaudeLaunchSettings({
      cwd: wt.path,
      worktrees: [wt],
      config: { nameClaudeSessions: true }
    })
    expect(out.sessionName).toBe('myrepo/feat-x')
  })

  it('omits sessionName when nameClaudeSessions is unset', () => {
    const wt = makeWorktree()
    const out = buildClaudeLaunchSettings({
      cwd: wt.path,
      worktrees: [wt],
      config: {}
    })
    expect(out.sessionName).toBeUndefined()
  })

  it('omits sessionName when nameClaudeSessions is on but the worktree is unknown', () => {
    const out = buildClaudeLaunchSettings({
      cwd: '/tmp/unknown',
      worktrees: [],
      config: { nameClaudeSessions: true }
    })
    expect(out.sessionName).toBeUndefined()
  })

  it('tuiFullscreen defaults to true and respects an explicit false', () => {
    const wt = makeWorktree()
    expect(
      buildClaudeLaunchSettings({ cwd: wt.path, worktrees: [wt], config: {} })
        .tuiFullscreen
    ).toBe(true)
    expect(
      buildClaudeLaunchSettings({
        cwd: wt.path,
        worktrees: [wt],
        config: { claudeTuiFullscreen: false }
      }).tuiFullscreen
    ).toBe(false)
  })
})
