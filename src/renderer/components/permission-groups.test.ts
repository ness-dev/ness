import { describe, expect, it } from 'vitest'
import type { StoredPermissionRule } from '../../shared/permission-match'
import {
  commandHead,
  filterGroups,
  groupPermissionRules,
  redundancy,
  redundantRules
} from './permission-groups'

function rule(toolName: string, ruleContent?: string): StoredPermissionRule {
  return {
    id: ruleContent ? `${toolName}(${ruleContent})` : toolName,
    toolName,
    ...(ruleContent ? { ruleContent } : {}),
    grantedAt: 0
  }
}

// Shaped like a real long-lived install: a scripting session's worth of
// exact Bash grants, a few file/web grants, several MCP servers, and Ness
// tools under both server names.
const REALISTIC: StoredPermissionRule[] = [
  rule('Bash', 'kubectl get:*'),
  rule('Bash', 'kubectl describe:*'),
  rule('Bash', 'gh run:*'),
  rule('Bash'),
  rule('Bash', 'vimm N64 "Super Mario 64"'),
  rule('Bash', 'vimm --format curl N64 "Banjo-Kazooie"'),
  rule('Bash', 'vimm --format tsv PS1 "Ridge Racer"'),
  rule('Bash', 'curl -s https://example.com/a'),
  rule('Bash', 'curl -sI https://example.com/b'),
  rule('Bash', 'godot --headless --editor --quit'),
  rule('Bash', '/Applications/Godot.app/Contents/MacOS/Godot:*'),
  rule('Bash', 'FOO=1 BAR=2 vimm --download N64 "Blast Corps"'),
  rule('Bash', 'chmod +x /tmp/vimm/search.sh'),
  rule('Bash', 'bash -x /Users/me/bin/vimm --format curl N64 "Wave Race 64"'),
  rule('Bash', 'timeout 45 godot --headless -s tests/smoke.gd'),
  rule('Read', '/Users/me/**'),
  rule('Read'),
  rule('WebFetch', 'domain:example.com'),
  rule('WebSearch'),
  rule('mcp__claude_ai_Notion__notion-fetch'),
  rule('mcp__claude_ai_Notion__notion-create-pages'),
  rule('mcp__claude_ai_Gmail__search_threads'),
  rule('mcp__papermark__list_datarooms'),
  rule('mcp__papermark__upload_document'),
  rule('mcp__ness-control__report_progress'),
  rule('mcp__ness-control__eval_tab'),
  rule('mcp__harness-control__list_worktrees'),
  rule('TodoWrite')
]

describe('commandHead', () => {
  it('takes the first word, without :* or env assignments', () => {
    expect(commandHead('kubectl get:*')).toBe('kubectl')
    expect(commandHead('FOO=1 BAR=2 vimm --download x')).toBe('vimm')
  })

  it('reduces path-invoked programs to their last segment, case-folded', () => {
    expect(commandHead('/tmp/vimm/search.sh "N64"')).toBe('search.sh')
    expect(commandHead('/Applications/Godot.app/Contents/MacOS/Godot:*')).toBe('godot')
  })

  it('strips wrapping parens and quotes', () => {
    expect(commandHead('(node index.js & echo $!)')).toBe('node')
    expect(commandHead('"my tool" --x')).toBe('my')
  })

  it('looks through wrapper commands to what they run', () => {
    expect(commandHead('timeout 45 godot --headless')).toBe('godot')
    expect(commandHead('bash -x /Users/me/bin/vimm --format curl')).toBe('vimm')
    expect(commandHead('bash -c "npm test"')).toBe('npm')
    expect(commandHead('sudo env FOO=1 make install')).toBe('make')
    // A wrapper on its own is still a program.
    expect(commandHead('bash:*')).toBe('bash')
  })

  it('is null for a bare grant', () => {
    expect(commandHead(undefined)).toBeNull()
    expect(commandHead('   ')).toBeNull()
  })
})

describe('groupPermissionRules', () => {
  const groups = groupPermissionRules(REALISTIC)
  const byKey = new Map(groups.map((g) => [g.key, g]))

  it('orders shell, files, web, then MCP servers by size, then other', () => {
    expect(groups.map((g) => g.key)).toEqual([
      'shell',
      'files',
      'web',
      'mcp:ness',
      'mcp:notion',
      'mcp:papermark',
      'mcp:gmail',
      'other'
    ])
  })

  it('accounts for every rule exactly once', () => {
    const all = groups.flatMap((g) => g.rules)
    expect(all).toHaveLength(REALISTIC.length)
    expect(new Set(all.map((r) => r.id)).size).toBe(REALISTIC.length)
  })

  it('sub-groups shell grants by program, only for programs with 2+ grants', () => {
    const shell = byKey.get('shell')!
    expect(shell.subgroups.map((s) => [s.label, s.rules.length])).toEqual([
      ['vimm', 5],
      ['godot', 3],
      ['curl', 2],
      ['kubectl', 2],
      ['Other', 2]
    ])
    expect(shell.subgroups.map((s) => !!s.program)).toEqual([true, true, true, true, false])
    // One-off commands go in "Other"; only the bare grant stays loose.
    expect(shell.subgroups.at(-1)!.rules.map((r) => r.id)).toEqual([
      'Bash(chmod +x /tmp/vimm/search.sh)',
      'Bash(gh run:*)'
    ])
    expect(shell.loose.map((r) => r.id)).toEqual(['Bash'])
  })

  it('orders shell rows: any command, then programs, then Other', () => {
    const shell = byKey.get('shell')!
    const ids = shell.rules.map((r) => r.id)
    expect(ids[0]).toBe('Bash')
    expect(ids.slice(-2)).toEqual(['Bash(chmod +x /tmp/vimm/search.sh)', 'Bash(gh run:*)'])
    expect(commandHead(shell.rules[1].ruleContent)).toBe('vimm')
  })

  it('sub-groups dead MCP grants by reason, with live ones under Other', () => {
    const ness = byKey.get('mcp:ness')!
    expect(ness.loose).toEqual([])
    expect(ness.subgroups.map((s) => [s.label, s.rules.map((r) => r.toolName)])).toEqual([
      ['Old server name', ['mcp__harness-control__list_worktrees']],
      ['Built in', ['mcp__ness-control__report_progress']],
      ['Other', ['mcp__ness-control__eval_tab']]
    ])
  })

  it('stays flat when one sub-group would hold every row', () => {
    const [ness] = groupPermissionRules([
      rule('mcp__ness-control__report_progress'),
      rule('mcp__ness-control__list_worktrees')
    ])
    expect(ness.subgroups).toEqual([])
    expect(ness.loose).toHaveLength(2)
  })

  it('leaves groups with nothing to sub-group flat', () => {
    const notion = byKey.get('mcp:notion')!
    expect(notion.subgroups).toEqual([])
    expect(notion.loose).toHaveLength(2)
  })

  it('merges both Ness server names into one group', () => {
    expect(byKey.get('mcp:ness')!.rules.map((r) => r.toolName).sort()).toEqual([
      'mcp__harness-control__list_worktrees',
      'mcp__ness-control__eval_tab',
      'mcp__ness-control__report_progress'
    ])
    expect(byKey.get('mcp:ness')!.label).toBe('Ness')
  })

  it('labels unknown MCP servers from their name', () => {
    expect(byKey.get('mcp:papermark')!.label).toBe('papermark')
  })

  it('returns nothing for an empty list', () => {
    expect(groupPermissionRules([])).toEqual([])
  })
})

describe('redundantRules', () => {
  it('picks out built-in Ness tools and anything under the old server name', () => {
    const rules = [...REALISTIC, rule('mcp__harness-control__create_shell')]
    expect(redundantRules(rules).map((r) => r.id)).toEqual([
      'mcp__ness-control__report_progress',
      'mcp__harness-control__list_worktrees',
      'mcp__harness-control__create_shell'
    ])
  })

  it('says why each one is redundant', () => {
    expect(redundancy(rule('mcp__ness-control__report_progress'))).toBe('built-in')
    expect(redundancy(rule('mcp__harness-control__create_shell'))).toBe('old-name')
    // eval_tab still prompts, so a grant for it is doing real work.
    expect(redundancy(rule('mcp__ness-control__eval_tab'))).toBeNull()
    expect(redundancy(rule('Bash', 'ls:*'))).toBeNull()
  })

  it('keeps live grants for the URL-gated browser tools', () => {
    // Without the grant, a non-loopback URL prompts; with it, it doesn't.
    expect(redundancy(rule('mcp__ness-control__navigate_tab'))).toBeNull()
    expect(redundancy(rule('mcp__ness-control__create_browser_tab'))).toBeNull()
    // Same for create_worktree (a grant skips the setup-script check) and
    // add_repo (always asks without one).
    expect(redundancy(rule('mcp__ness-control__create_worktree'))).toBeNull()
    expect(redundancy(rule('mcp__ness-control__add_repo'))).toBeNull()
    // Under the old server name they can't match any call, so they're dead.
    expect(redundancy(rule('mcp__harness-control__navigate_tab'))).toBe('old-name')
  })
})

describe('filterGroups', () => {
  const groups = groupPermissionRules(REALISTIC)
  const label = (r: StoredPermissionRule): string => r.toolName

  it('returns the groups untouched for an empty query', () => {
    expect(filterGroups(groups, '  ', label)).toBe(groups)
  })

  it('keeps only matching rows and drops empty groups and subgroups', () => {
    const out = filterGroups(groups, 'banjo', label)
    expect(out.map((g) => g.key)).toEqual(['shell'])
    expect(out[0].subgroups.map((s) => s.label)).toEqual(['vimm'])
    expect(out[0].subgroups[0].rules.map((r) => r.ruleContent)).toEqual([
      'vimm --format curl N64 "Banjo-Kazooie"'
    ])
    expect(out[0].loose).toEqual([])
  })

  it('a group or program name match keeps the whole group or subgroup', () => {
    expect(filterGroups(groups, 'notion', label).find((g) => g.key === 'mcp:notion')!.rules).toHaveLength(2)
    const shell = filterGroups(groups, 'kubectl', label)[0]
    expect(shell.subgroups[0].rules).toHaveLength(2)
  })
})
