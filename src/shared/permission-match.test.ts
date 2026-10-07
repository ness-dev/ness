import { describe, it, expect } from 'vitest'
import {
  ruleKey,
  parseRuleKey,
  ruleMatches,
  findMatchingRule,
  type StoredPermissionRule
} from './permission-match'

function stored(toolName: string, ruleContent?: string): StoredPermissionRule {
  return {
    id: ruleKey({ toolName, ruleContent }),
    toolName,
    ...(ruleContent ? { ruleContent } : {}),
    grantedAt: 0
  }
}

describe('ruleKey', () => {
  it('renders a bare rule as the tool name', () => {
    expect(ruleKey({ toolName: 'Bash' })).toBe('Bash')
  })

  it('renders a scoped rule in Tool(content) form', () => {
    expect(ruleKey({ toolName: 'Bash', ruleContent: 'git status:*' })).toBe(
      'Bash(git status:*)'
    )
  })
})

describe('parseRuleKey', () => {
  it('round-trips a bare rule', () => {
    expect(parseRuleKey('Bash')).toEqual({ toolName: 'Bash' })
  })

  it('round-trips a scoped rule', () => {
    expect(parseRuleKey('Bash(git status:*)')).toEqual({
      toolName: 'Bash',
      ruleContent: 'git status:*'
    })
  })

  it('keeps nested parens inside ruleContent', () => {
    expect(parseRuleKey('Bash(echo (hi))')).toEqual({
      toolName: 'Bash',
      ruleContent: 'echo (hi)'
    })
  })

  it('rejects malformed entries rather than guessing', () => {
    expect(parseRuleKey('')).toBeNull()
    expect(parseRuleKey('   ')).toBeNull()
    expect(parseRuleKey('Bash(')).toBeNull()
    expect(parseRuleKey('Bash()')).toBeNull()
    expect(parseRuleKey('(nope)')).toBeNull()
    expect(parseRuleKey('Bash)x(')).toBeNull()
  })
})

describe('ruleMatches — tool name gate', () => {
  it('requires the tool name to match', () => {
    expect(ruleMatches({ toolName: 'Bash' }, 'Read', {})).toBe(false)
  })

  it('a bare rule allows any invocation of its tool', () => {
    expect(ruleMatches({ toolName: 'Bash' }, 'Bash', { command: 'rm -rf /' })).toBe(
      true
    )
  })

  it('`*` allows any tool', () => {
    expect(ruleMatches({ toolName: '*' }, 'WhateverTool', {})).toBe(true)
  })
})

describe('ruleMatches — Bash', () => {
  it('":*" matches the exact command and any longer one', () => {
    const rule = { toolName: 'Bash', ruleContent: 'git status:*' }
    expect(ruleMatches(rule, 'Bash', { command: 'git status' })).toBe(true)
    expect(ruleMatches(rule, 'Bash', { command: 'git status --short' })).toBe(true)
  })

  it('":*" only matches on a token boundary', () => {
    // Otherwise `git s:*` would authorize `git stash drop` by raw prefix.
    const rule = { toolName: 'Bash', ruleContent: 'git s:*' }
    expect(ruleMatches(rule, 'Bash', { command: 'git stash drop' })).toBe(false)
  })

  it('a rule without ":*" requires an exact command', () => {
    const rule = { toolName: 'Bash', ruleContent: 'git status' }
    expect(ruleMatches(rule, 'Bash', { command: 'git status' })).toBe(true)
    expect(ruleMatches(rule, 'Bash', { command: 'git status --short' })).toBe(false)
  })

  it('tolerates surrounding whitespace in the command', () => {
    const rule = { toolName: 'Bash', ruleContent: 'ls:*' }
    expect(ruleMatches(rule, 'Bash', { command: '  ls -la  ' })).toBe(true)
  })

  it('does not match when there is no command', () => {
    expect(ruleMatches({ toolName: 'Bash', ruleContent: 'ls:*' }, 'Bash', {})).toBe(
      false
    )
  })
})

describe('ruleMatches — file tools', () => {
  it('matches an exact path', () => {
    const rule = { toolName: 'Write', ruleContent: '/a/b/c.ts' }
    expect(ruleMatches(rule, 'Write', { file_path: '/a/b/c.ts' })).toBe(true)
    expect(ruleMatches(rule, 'Write', { file_path: '/a/b/d.ts' })).toBe(false)
  })

  it('`/dir/**` matches anything beneath the dir, at any depth', () => {
    const rule = { toolName: 'Read', ruleContent: '/a/b/**' }
    expect(ruleMatches(rule, 'Read', { file_path: '/a/b/c.ts' })).toBe(true)
    expect(ruleMatches(rule, 'Read', { file_path: '/a/b/c/d/e.ts' })).toBe(true)
    expect(ruleMatches(rule, 'Read', { file_path: '/a/b' })).toBe(true)
    expect(ruleMatches(rule, 'Read', { file_path: '/a/x/c.ts' })).toBe(false)
  })

  it('does not treat a similarly-prefixed sibling dir as inside', () => {
    const rule = { toolName: 'Write', ruleContent: '/a/proj/**' }
    expect(ruleMatches(rule, 'Write', { file_path: '/a/proj-other/x.ts' })).toBe(
      false
    )
  })

  it('single `*` does not cross a path separator', () => {
    const rule = { toolName: 'Read', ruleContent: '/a/*.ts' }
    expect(ruleMatches(rule, 'Read', { file_path: '/a/b.ts' })).toBe(true)
    expect(ruleMatches(rule, 'Read', { file_path: '/a/b/c.ts' })).toBe(false)
  })

  it('treats regex metacharacters in the pattern as literals', () => {
    const rule = { toolName: 'Read', ruleContent: '/a/b+c.ts' }
    expect(ruleMatches(rule, 'Read', { file_path: '/a/b+c.ts' })).toBe(true)
    expect(ruleMatches(rule, 'Read', { file_path: '/a/bbc.ts' })).toBe(false)
  })

  it('matches outside any worktree — there is no anchor root', () => {
    // The whole point of owning the matcher: Claude would have dropped
    // this rule as unanchored and never fired it.
    const rule = { toolName: 'Write', ruleContent: '/tmp/**' }
    expect(ruleMatches(rule, 'Write', { file_path: '/tmp/scratch.txt' })).toBe(true)
  })

  it('reads NotebookEdit paths from notebook_path', () => {
    const rule = { toolName: 'NotebookEdit', ruleContent: '/a/**' }
    expect(
      ruleMatches(rule, 'NotebookEdit', { notebook_path: '/a/n.ipynb' })
    ).toBe(true)
  })
})

describe('ruleMatches — search tools', () => {
  it('requires an exact pattern match', () => {
    const rule = { toolName: 'Grep', ruleContent: 'TODO' }
    expect(ruleMatches(rule, 'Grep', { pattern: 'TODO' })).toBe(true)
    expect(ruleMatches(rule, 'Grep', { pattern: 'TODOs' })).toBe(false)
    expect(ruleMatches(rule, 'Grep', {})).toBe(false)
  })
})

describe('ruleMatches — WebFetch', () => {
  it('`domain:` matches the host and its subdomains', () => {
    const rule = { toolName: 'WebFetch', ruleContent: 'domain:example.com' }
    expect(ruleMatches(rule, 'WebFetch', { url: 'https://example.com/a' })).toBe(
      true
    )
    expect(
      ruleMatches(rule, 'WebFetch', { url: 'https://api.example.com/a' })
    ).toBe(true)
  })

  it('`domain:` does not match a lookalike host', () => {
    const rule = { toolName: 'WebFetch', ruleContent: 'domain:example.com' }
    expect(
      ruleMatches(rule, 'WebFetch', { url: 'https://notexample.com/a' })
    ).toBe(false)
    expect(
      ruleMatches(rule, 'WebFetch', { url: 'https://example.com.evil.tld/a' })
    ).toBe(false)
  })

  it('`domain:` comparison is case-insensitive on the host', () => {
    const rule = { toolName: 'WebFetch', ruleContent: 'domain:Example.COM' }
    expect(ruleMatches(rule, 'WebFetch', { url: 'https://EXAMPLE.com/a' })).toBe(
      true
    )
  })

  it('a bare url requires an exact match', () => {
    const rule = { toolName: 'WebFetch', ruleContent: 'https://example.com/a' }
    expect(ruleMatches(rule, 'WebFetch', { url: 'https://example.com/a' })).toBe(
      true
    )
    expect(ruleMatches(rule, 'WebFetch', { url: 'https://example.com/b' })).toBe(
      false
    )
  })
})

describe('ruleMatches — unmodelled tools', () => {
  it('refuses a scoped rule on a tool whose input shape we do not know', () => {
    // We can't tell which field `ruleContent` refers to, so the safe answer
    // is "no" — the user can still grant the bare tool.
    expect(
      ruleMatches(
        { toolName: 'mcp__thing__do', ruleContent: 'whatever' },
        'mcp__thing__do',
        { arg: 'whatever' }
      )
    ).toBe(false)
  })

  it('allows a bare grant on an MCP tool', () => {
    expect(
      ruleMatches({ toolName: 'mcp__thing__do' }, 'mcp__thing__do', { arg: 1 })
    ).toBe(true)
  })
})

describe('findMatchingRule', () => {
  it('returns the first rule that allows the call', () => {
    const rules = [stored('Read'), stored('Bash', 'git status:*'), stored('Bash')]
    expect(findMatchingRule(rules, 'Bash', { command: 'git status' })?.id).toBe(
      'Bash(git status:*)'
    )
  })

  it('returns null when nothing matches', () => {
    expect(findMatchingRule([stored('Read')], 'Bash', { command: 'ls' })).toBeNull()
  })

  it('returns null for an empty tool name rather than falling through to `*`', () => {
    expect(findMatchingRule([stored('*')], '', {})).toBeNull()
  })
})
