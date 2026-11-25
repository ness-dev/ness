import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  NESS_ASK_TOOLS,
  NESS_AUTO_ALLOWED_TOOLS,
  isAutoAllowedNessTool,
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

  it('auto-allows plumbing tools under the current and legacy server names', () => {
    expect(isAutoAllowedNessTool('mcp__ness-control__report_progress')).toBe(true)
    expect(isAutoAllowedNessTool('mcp__ness-control__set_tab_name')).toBe(true)
    expect(isAutoAllowedNessTool('mcp__harness-control__list_worktrees')).toBe(true)
  })

  it('keeps asking for tools that run arbitrary code', () => {
    expect(isAutoAllowedNessTool('mcp__ness-control__eval_tab')).toBe(false)
    expect(isAutoAllowedNessTool('mcp__ness-control__create_shell')).toBe(false)
  })

  it('ignores other servers and built-ins', () => {
    expect(isAutoAllowedNessTool('mcp__other__report_progress')).toBe(false)
    expect(isAutoAllowedNessTool('Bash')).toBe(false)
    expect(nessControlToolName('Bash')).toBeNull()
  })

  it('builds a comma-separated --allowedTools value without the ask tools', () => {
    const value = nessAllowedToolsFlagValue()
    expect(value.split(',')).toContain('mcp__ness-control__report_progress')
    expect(value).not.toContain('eval_tab')
    expect(value).not.toContain('create_shell')
  })
})
