import { describe, it, expect } from 'vitest'
import { homedir } from 'os'
import { checkDenyList, parseDecision, buildPrompt } from './auto-approver'

const HOME = homedir()

describe('checkDenyList', () => {
  it('approves a plain Read call inside the user\'s home (returns null)', () => {
    expect(
      checkDenyList('Read', { file_path: `${HOME}/proj/src/foo.ts` })
    ).toBeNull()
  })

  it('never sends browser-tab script eval to the reviewer', () => {
    expect(
      checkDenyList('mcp__ness-control__eval_tab', { tab_id: 't', expression: 'document.cookie' })
    ).toMatch(/deny list/)
  })

  it('blocks WebFetch and WebSearch outright', () => {
    expect(checkDenyList('WebFetch', { url: 'https://x' })).toMatch(/deny list/)
    expect(checkDenyList('WebSearch', { query: 'foo' })).toMatch(/deny list/)
  })

  it('blocks Slack send variants by prefix', () => {
    expect(
      checkDenyList('mcp__claude_ai_Slack__slack_send_message', { channel: 'x' })
    ).toMatch(/deny list/)
    expect(
      checkDenyList('mcp__claude_ai_Slack__slack_send_message_draft', { channel: 'x' })
    ).toMatch(/deny list/)
  })

  it('blocks Bash rm -rf and its flag-order variants', () => {
    expect(checkDenyList('Bash', { command: 'rm -rf foo' })).toMatch(/deny pattern/)
    expect(checkDenyList('Bash', { command: 'rm -fr foo' })).toMatch(/deny pattern/)
    expect(checkDenyList('Bash', { command: 'rm -Rf foo' })).toMatch(/deny pattern/)
  })

  it('blocks git push, git reset --hard, git branch -D', () => {
    expect(checkDenyList('Bash', { command: 'git push origin main' })).toMatch(
      /deny pattern/
    )
    expect(checkDenyList('Bash', { command: 'git reset --hard HEAD~3' })).toMatch(
      /deny pattern/
    )
    expect(checkDenyList('Bash', { command: 'git branch -D feature' })).toMatch(
      /deny pattern/
    )
  })

  it('blocks gh pr merge / create / close, gh release', () => {
    expect(checkDenyList('Bash', { command: 'gh pr merge 42 --squash' })).toMatch(
      /deny pattern/
    )
    expect(checkDenyList('Bash', { command: 'gh pr create' })).toMatch(/deny pattern/)
    expect(checkDenyList('Bash', { command: 'gh pr close 1' })).toMatch(/deny pattern/)
    expect(checkDenyList('Bash', { command: 'gh release upload v1' })).toMatch(
      /deny pattern/
    )
  })

  it('blocks publish commands', () => {
    expect(checkDenyList('Bash', { command: 'npm publish' })).toMatch(/deny pattern/)
    expect(checkDenyList('Bash', { command: 'pnpm publish' })).toMatch(/deny pattern/)
    expect(checkDenyList('Bash', { command: 'yarn publish' })).toMatch(/deny pattern/)
  })

  it('blocks sudo and writes to /etc', () => {
    expect(checkDenyList('Bash', { command: 'sudo ls' })).toMatch(/deny pattern/)
    expect(
      checkDenyList('Bash', { command: 'echo foo > /etc/hosts' })
    ).toMatch(/deny pattern/)
  })

  it('blocks references to ~/.aws, ~/.ssh, ~/.claude, ~/.gitconfig', () => {
    expect(checkDenyList('Bash', { command: 'cat ~/.aws/credentials' })).toMatch(
      /deny pattern/
    )
    expect(checkDenyList('Bash', { command: 'ls ~/.ssh/' })).toMatch(/deny pattern/)
    expect(checkDenyList('Bash', { command: 'rm ~/.claude/secrets.enc' })).toMatch(
      /deny pattern/
    )
  })

  it('blocks tool inputs that reference protected path substrings', () => {
    expect(
      checkDenyList('Read', { file_path: `${HOME}/.aws/credentials` })
    ).toMatch(/protected path/)
    expect(
      checkDenyList('Read', { file_path: `${HOME}/.ssh/id_rsa` })
    ).toMatch(/protected path/)
  })

  it('blocks absolute paths outside home (other than /tmp)', () => {
    expect(
      checkDenyList('Read', { file_path: '/etc/passwd' })
    ).toMatch(/outside home/)
    expect(
      checkDenyList('Read', { file_path: '/var/log/system.log' })
    ).toMatch(/outside home/)
  })

  it('still catches absolute paths in a Bash command', () => {
    expect(checkDenyList('Bash', { command: 'cat /etc/hosts' })).toMatch(/outside home/)
  })

  it('ignores URL routes and slash words in prose fields', () => {
    // Regression: both of these used to read as "absolute path outside
    // home: /health" and bypass the reviewer.
    expect(
      checkDenyList('Bash', {
        command: 'curl -si localhost:3000/health',
        description: 'Start server, curl /health and /, stop it'
      })
    ).toBeNull()
    expect(
      checkDenyList('mcp__other__notify', { message: '/health is added; run /review next' })
    ).toBeNull()
  })

  it('allows /tmp paths through to the reviewer', () => {
    expect(checkDenyList('Bash', { command: 'ls /tmp/foo' })).toBeNull()
  })

  it('allows benign Bash like git status / npm test', () => {
    expect(checkDenyList('Bash', { command: 'git status' })).toBeNull()
    expect(checkDenyList('Bash', { command: 'npm test' })).toBeNull()
    expect(checkDenyList('Bash', { command: 'ls -la' })).toBeNull()
  })
})

describe('parseDecision', () => {
  it('parses an approve reply', () => {
    const out = parseDecision('{"decision":"approve","reason":"safe read"}')
    expect(out).toEqual({
      kind: 'approve',
      model: expect.any(String),
      reason: 'safe read'
    })
  })

  it('parses an ask reply', () => {
    const out = parseDecision('{"decision":"ask","reason":"network call"}')
    expect(out).toEqual({ kind: 'ask', reason: 'network call' })
  })

  it('extracts the first JSON object from chatty stdout', () => {
    const out = parseDecision(
      'Sure!\n{"decision":"approve","reason":"yes"}\n\nThanks.'
    )
    expect(out?.kind).toBe('approve')
  })

  it('handles braces inside string values', () => {
    const out = parseDecision('{"decision":"ask","reason":"saw { in input"}')
    expect(out).toEqual({ kind: 'ask', reason: 'saw { in input' })
  })

  it('returns null on garbage', () => {
    expect(parseDecision('lol no json here')).toBeNull()
    expect(parseDecision('{"decision":"banana"}')).toBeNull()
    expect(parseDecision('{"decision":"approve"')).toBeNull()
  })

  it('falls back to a default reason when missing', () => {
    const out = parseDecision('{"decision":"approve"}')
    expect(out?.kind).toBe('approve')
    expect(out && 'reason' in out ? out.reason : '').toBeTruthy()
  })
})

describe('buildPrompt', () => {
  it('includes tool name and input', () => {
    const p = buildPrompt('Read', { file_path: '/Users/me/x' })
    expect(p).toContain('Tool: Read')
    expect(p).toContain('/Users/me/x')
  })

  it('truncates oversized inputs and signals the truncation', () => {
    const big = 'x'.repeat(20_000)
    const p = buildPrompt('Write', { file_path: '/Users/me/y', content: big })
    expect(p).toContain('truncated')
    expect(p.length).toBeLessThan(8_000)
  })

  it('appends a steer block when steerInstructions is non-empty', () => {
    const p = buildPrompt(
      'Bash',
      { command: 'npm install foo' },
      'approve npm install for this project'
    )
    expect(p).toContain('Project-specific guidance')
    expect(p).toContain('approve npm install for this project')
  })

  it('omits the steer block when steerInstructions is empty/whitespace', () => {
    const p1 = buildPrompt('Read', { file_path: '/x' })
    const p2 = buildPrompt('Read', { file_path: '/x' }, '   \n  ')
    expect(p1).not.toContain('Project-specific guidance')
    expect(p2).not.toContain('Project-specific guidance')
  })
})
