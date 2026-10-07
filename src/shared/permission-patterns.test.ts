import { describe, it, expect } from 'vitest'
import { suggestPermissionPatterns } from './permission-patterns'

describe('suggestPermissionPatterns', () => {
  it('Bash with multi-word command yields narrow + medium + broad', () => {
    const out = suggestPermissionPatterns('Bash', { command: 'git status' })
    expect(out).toEqual([
      {
        rule: { toolName: 'Bash', ruleContent: 'git status:*' },
        label: 'Bash(git status:*)',
        scope: 'narrow'
      },
      {
        rule: { toolName: 'Bash', ruleContent: 'git:*' },
        label: 'Bash(git:*)',
        scope: 'medium'
      },
      { rule: { toolName: 'Bash' }, label: 'Bash', scope: 'broad' }
    ])
  })

  it('Bash with one-word command collapses narrow into medium', () => {
    const out = suggestPermissionPatterns('Bash', { command: 'ls' })
    expect(out).toEqual([
      {
        rule: { toolName: 'Bash', ruleContent: 'ls:*' },
        label: 'Bash(ls:*)',
        scope: 'medium'
      },
      { rule: { toolName: 'Bash' }, label: 'Bash', scope: 'broad' }
    ])
  })

  it('Bash with extra whitespace tokenizes correctly', () => {
    const out = suggestPermissionPatterns('Bash', {
      command: '  npm   test  '
    })
    expect(out.map((s) => s.rule)).toEqual([
      { toolName: 'Bash', ruleContent: 'npm test:*' },
      { toolName: 'Bash', ruleContent: 'npm:*' },
      { toolName: 'Bash' }
    ])
  })

  it('Bash with no command falls back to broad-only', () => {
    const out = suggestPermissionPatterns('Bash', {})
    expect(out).toEqual([
      { rule: { toolName: 'Bash' }, label: 'Bash', scope: 'broad' }
    ])
  })

  it('Read with absolute path yields exact + parent glob + bare', () => {
    const out = suggestPermissionPatterns('Read', {
      file_path: '/abs/path/foo.ts'
    })
    expect(out).toEqual([
      {
        rule: { toolName: 'Read', ruleContent: '/abs/path/foo.ts' },
        label: 'Read(/abs/path/foo.ts)',
        scope: 'narrow'
      },
      {
        rule: { toolName: 'Read', ruleContent: '/abs/path/**' },
        label: 'Read(/abs/path/**)',
        scope: 'medium'
      },
      { rule: { toolName: 'Read' }, label: 'Read', scope: 'broad' }
    ])
  })

  it('Write with shallow path drops the parent-dir glob', () => {
    const out = suggestPermissionPatterns('Write', { file_path: '/foo.txt' })
    expect(out.map((s) => s.rule)).toEqual([
      { toolName: 'Write', ruleContent: '/foo.txt' },
      { toolName: 'Write' }
    ])
  })

  it('Edit / MultiEdit follow the same shape as Read/Write', () => {
    const edit = suggestPermissionPatterns('Edit', {
      file_path: '/repo/src/foo.ts'
    })
    expect(edit.map((s) => s.rule)).toEqual([
      { toolName: 'Edit', ruleContent: '/repo/src/foo.ts' },
      { toolName: 'Edit', ruleContent: '/repo/src/**' },
      { toolName: 'Edit' }
    ])

    const multi = suggestPermissionPatterns('MultiEdit', {
      file_path: '/repo/src/foo.ts'
    })
    expect(multi[0].rule).toEqual({
      toolName: 'MultiEdit',
      ruleContent: '/repo/src/foo.ts'
    })
  })

  it('Read with no file_path falls back to broad-only', () => {
    const out = suggestPermissionPatterns('Read', {})
    expect(out).toEqual([
      { rule: { toolName: 'Read' }, label: 'Read', scope: 'broad' }
    ])
  })

  it('Grep / Glob produce pattern + bare', () => {
    expect(
      suggestPermissionPatterns('Grep', { pattern: 'TODO' }).map((s) => s.rule)
    ).toEqual([
      { toolName: 'Grep', ruleContent: 'TODO' },
      { toolName: 'Grep' }
    ])
    expect(
      suggestPermissionPatterns('Glob', { pattern: '**/*.ts' }).map(
        (s) => s.rule
      )
    ).toEqual([
      { toolName: 'Glob', ruleContent: '**/*.ts' },
      { toolName: 'Glob' }
    ])
  })

  it('Grep with no pattern collapses to broad-only', () => {
    expect(suggestPermissionPatterns('Grep', {}).map((s) => s.rule)).toEqual([
      { toolName: 'Grep' }
    ])
  })

  it('WebFetch extracts host correctly from URL with path + query', () => {
    const out = suggestPermissionPatterns('WebFetch', {
      url: 'https://example.com/path?query=1'
    })
    expect(out.map((s) => s.rule)).toEqual([
      { toolName: 'WebFetch', ruleContent: 'https://example.com/path?query=1' },
      { toolName: 'WebFetch', ruleContent: 'domain:example.com' },
      { toolName: 'WebFetch' }
    ])
  })

  it('WebFetch with port retains it in the host', () => {
    const out = suggestPermissionPatterns('WebFetch', {
      url: 'http://localhost:3000/foo'
    })
    expect(out[1].rule).toEqual({
      toolName: 'WebFetch',
      ruleContent: 'domain:localhost:3000'
    })
  })

  it('WebFetch with no url collapses to broad-only', () => {
    expect(
      suggestPermissionPatterns('WebFetch', {}).map((s) => s.rule)
    ).toEqual([{ toolName: 'WebFetch' }])
  })

  it('MCP tool yields a single bare-name suggestion', () => {
    const out = suggestPermissionPatterns(
      'mcp__ness-control__create_worktree',
      { foo: 'bar' }
    )
    expect(out).toEqual([
      {
        rule: { toolName: 'mcp__ness-control__create_worktree' },
        label: 'mcp__ness-control__create_worktree',
        scope: 'narrow'
      }
    ])
  })

  it('Unknown tool name produces just the bare name', () => {
    const out = suggestPermissionPatterns('TodoWrite', undefined)
    expect(out).toEqual([
      { rule: { toolName: 'TodoWrite' }, label: 'TodoWrite', scope: 'narrow' }
    ])
  })

  it('Empty tool name returns a defensive any-tool suggestion', () => {
    const out = suggestPermissionPatterns('', undefined)
    expect(out).toEqual([
      { rule: { toolName: '*' }, label: '* (any tool)', scope: 'broad' }
    ])
  })

  // Path rules are matched by Ness (shared/permission-match.ts), which has
  // no destination root to anchor against, so a path outside the session's
  // worktree gets the same narrow/medium/broad ladder as one inside it.
  // Claude's own matcher used to silently drop those, which is why the
  // suggester once collapsed them to the bare-tool grant.
  describe('paths outside the session worktree', () => {
    it('emits narrow + medium + broad regardless of location', () => {
      const out = suggestPermissionPatterns('Write', { file_path: '/tmp/foo.txt' })
      expect(out.map((s) => s.rule)).toEqual([
        { toolName: 'Write', ruleContent: '/tmp/foo.txt' },
        { toolName: 'Write', ruleContent: '/tmp/**' },
        { toolName: 'Write' }
      ])
    })

    it('relative file_path still yields the full ladder', () => {
      const out = suggestPermissionPatterns('Read', { file_path: 'src/foo.ts' })
      expect(out.map((s) => s.scope)).toEqual(['narrow', 'medium', 'broad'])
    })
  })
})
