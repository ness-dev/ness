import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  NESS_ASK_TOOLS,
  NESS_AUTO_ALLOWED_TOOLS,
  isAlwaysAutoAllowedNessTool,
  isAutoAllowedNessCall,
  isSafeAgentUrl,
  nessAllowedToolsFlagValue,
  nessControlToolName
} from './ness-tool-policy'

function bridgeToolNames(): string[] {
  const src = readFileSync(join(__dirname, '../../resources/mcp-bridge.js'), 'utf-8')
  return [...src.matchAll(/^ {4}name: '([a-z_]+)',$/gm)].map((m) => m[1])
}

describe('ness tool policy', () => {
  it('classifies every tool the bridge defines, exactly once', () => {
    const defined = bridgeToolNames()
    expect(defined.length).toBeGreaterThan(30)
    const classified = [...NESS_AUTO_ALLOWED_TOOLS, ...NESS_ASK_TOOLS]
    expect(new Set(classified).size).toBe(classified.length)
    expect([...classified].sort()).toEqual([...defined].sort())
  })

  it('auto-allows plumbing tools', () => {
    expect(isAutoAllowedNessCall('mcp__ness-control__report_progress', {})).toBe(true)
    expect(isAutoAllowedNessCall('mcp__ness-control__set_tab_name', {})).toBe(true)
    expect(isAutoAllowedNessCall('mcp__ness-control__list_worktrees', {})).toBe(true)
    // The pre-rename server name is no longer registered by anything.
    expect(isAutoAllowedNessCall('mcp__harness-control__list_worktrees', {})).toBe(false)
  })

  it('keeps asking for tools that run arbitrary code', () => {
    expect(isAutoAllowedNessCall('mcp__ness-control__eval_tab', {})).toBe(false)
    expect(isAutoAllowedNessCall('mcp__ness-control__create_shell', {})).toBe(false)
    // Registering a clone trusts its .ness.json setupCommand.
    expect(isAutoAllowedNessCall('mcp__ness-control__add_repo', { path: '/x' })).toBe(false)
  })

  it('ignores other servers and built-ins', () => {
    expect(isAutoAllowedNessCall('mcp__other__report_progress', {})).toBe(false)
    expect(isAutoAllowedNessCall('Bash', {})).toBe(false)
    expect(nessControlToolName('Bash')).toBeNull()
  })

  it('builds a comma-separated --allowedTools value without the ask tools', () => {
    const value = nessAllowedToolsFlagValue()
    expect(value.split(',')).toContain('mcp__ness-control__report_progress')
    expect(value).not.toContain('eval_tab')
    expect(value).not.toContain('create_shell')
  })

  it('leaves URL-gated tools out of --allowedTools, since the flag cannot see the url', () => {
    const value = nessAllowedToolsFlagValue()
    expect(value).not.toContain('navigate_tab')
    expect(value).not.toContain('create_browser_tab')
  })

  it('auto-allows navigation only to loopback http(s) and about:blank', () => {
    const nav = (url: string): boolean =>
      isAutoAllowedNessCall('mcp__ness-control__navigate_tab', { tab_id: 't', url })
    expect(nav('localhost:5173')).toBe(true)
    expect(nav('http://127.0.0.1:3000/health')).toBe(true)
    expect(nav('https://app.localhost/')).toBe(true)
    expect(nav('http://[::1]:8080')).toBe(true)
    expect(nav('about:blank')).toBe(true)

    expect(nav('file:///Users/me/.ssh/id_rsa')).toBe(false)
    expect(nav('https://example.com/?q=secret')).toBe(false)
    expect(nav('github.com')).toBe(false)
    expect(nav('javascript:alert(1)')).toBe(false)
    expect(nav('data:text/html,hi')).toBe(false)
    expect(nav('http://localhost.evil.com/')).toBe(false)
    expect(isAutoAllowedNessCall('mcp__ness-control__navigate_tab', { tab_id: 't' })).toBe(false)
  })

  it('auto-allows create_browser_tab with no url, gates it with one', () => {
    const create = 'mcp__ness-control__create_browser_tab'
    expect(isAutoAllowedNessCall(create, {})).toBe(true)
    expect(isAutoAllowedNessCall(create, { url: 'localhost:3000' })).toBe(true)
    expect(isAutoAllowedNessCall(create, { url: 'file:///etc/passwd' })).toBe(false)
    expect(isSafeAgentUrl('')).toBe(false)
  })

  it('counts only input-independent tools as always auto-allowed', () => {
    expect(isAlwaysAutoAllowedNessTool('mcp__ness-control__report_progress')).toBe(true)
    // URL-gated: a grant still allows arbitrary URLs, so it isn't redundant.
    expect(isAlwaysAutoAllowedNessTool('mcp__ness-control__navigate_tab')).toBe(false)
    expect(isAlwaysAutoAllowedNessTool('mcp__ness-control__create_browser_tab')).toBe(false)
    // Setup-script gated, and add_repo always asks.
    expect(isAlwaysAutoAllowedNessTool('mcp__ness-control__create_worktree')).toBe(false)
    expect(isAlwaysAutoAllowedNessTool('mcp__ness-control__add_repo')).toBe(false)
    expect(isAlwaysAutoAllowedNessTool('mcp__ness-control__eval_tab')).toBe(false)
    // The old server name isn't Ness's any more.
    expect(isAlwaysAutoAllowedNessTool('mcp__harness-control__list_worktrees')).toBe(false)
    expect(isAlwaysAutoAllowedNessTool('Bash')).toBe(false)
  })

  it('auto-allows create_worktree only when no setup script would run', () => {
    const cw = 'mcp__ness-control__create_worktree'
    const seen: (string | undefined)[] = []
    const ctx = (cmd: string | null) => ({
      setupCommandFor: (root: string | undefined) => {
        seen.push(root)
        return cmd
      }
    })
    expect(isAutoAllowedNessCall(cw, { branchName: 'b' }, ctx(''))).toBe(true)
    expect(isAutoAllowedNessCall(cw, { branchName: 'b', repoRoot: '/r' }, ctx(''))).toBe(true)
    expect(seen).toEqual([undefined, '/r'])
    expect(isAutoAllowedNessCall(cw, { branchName: 'b' }, ctx('curl x | sh'))).toBe(false)
    expect(isAutoAllowedNessCall(cw, { branchName: 'b' }, ctx(null))).toBe(false)
    expect(isAutoAllowedNessCall(cw, { branchName: 'b' })).toBe(false)
    expect(nessAllowedToolsFlagValue()).not.toContain('create_worktree')
  })
})
