import { describe, it, expect } from 'vitest'
import {
  extractArgs,
  formatActionCount,
  getToolAction,
  getToolDisplay,
  isNessControl,
  normalizeServerName,
  parseMcpToolName,
  prettyToolName
} from './tool-display'

describe('getToolAction', () => {
  it('resolves a ness-control browser action', () => {
    const action = getToolAction('mcp__ness-control__click_tab')
    expect(action?.one).toBe('click')
    expect(action?.many).toBe('clicks')
    expect(action?.icon).toBeTruthy()
  })

  it('resolves legacy harness-control transcripts too', () => {
    expect(getToolAction('mcp__harness-control__screenshot_tab')?.many).toBe(
      'screenshots'
    )
  })

  it('gives distinct icons to distinct actions', () => {
    // The whole point: the brand mark is identical for every
    // ness-control tool, so the timeline needs per-action icons.
    const click = getToolAction('mcp__ness-control__click_tab')?.icon
    const shot = getToolAction('mcp__ness-control__screenshot_tab')?.icon
    expect(click).not.toBe(shot)
  })

  it('is null for built-ins and other MCP servers', () => {
    expect(getToolAction('Read')).toBeNull()
    expect(getToolAction('mcp__claude_ai_Notion__notion-search')).toBeNull()
    expect(getToolAction(undefined)).toBeNull()
  })

  it('is null for an unmapped ness-control tool', () => {
    expect(getToolAction('mcp__ness-control__some_future_tool')).toBeNull()
  })
})

describe('formatActionCount', () => {
  it('pluralizes on count', () => {
    const action = getToolAction('mcp__ness-control__click_tab')!
    expect(formatActionCount(action, 1)).toBe('1 click')
    expect(formatActionCount(action, 4)).toBe('4 clicks')
  })
})

describe('parseMcpToolName', () => {
  it('parses claude.ai-hosted servers', () => {
    expect(parseMcpToolName('mcp__claude_ai_Notion__notion-get-users')).toEqual({
      server: 'claude_ai_Notion',
      tool: 'notion-get-users'
    })
  })

  it('parses ness-control tools', () => {
    expect(parseMcpToolName('mcp__ness-control__create_worktree')).toEqual({
      server: 'ness-control',
      tool: 'create_worktree'
    })
  })

  it('parses bare server names', () => {
    expect(parseMcpToolName('mcp__notion__authenticate')).toEqual({
      server: 'notion',
      tool: 'authenticate'
    })
  })

  it('returns null for built-in tools', () => {
    expect(parseMcpToolName('Read')).toBeNull()
    expect(parseMcpToolName('Bash')).toBeNull()
  })

  it('returns null for malformed mcp__ inputs', () => {
    expect(parseMcpToolName('mcp__')).toBeNull()
    expect(parseMcpToolName('mcp____tool')).toBeNull()
    expect(parseMcpToolName('mcp__server__')).toBeNull()
  })

  it('returns null for undefined / empty inputs', () => {
    expect(parseMcpToolName(undefined)).toBeNull()
    expect(parseMcpToolName('')).toBeNull()
  })

  it('keeps the tool half intact when it contains __', () => {
    // Some MCP authors use double underscores inside tool names; the
    // server boundary is the FIRST __ after mcp__, so the tool half
    // gets everything after that.
    expect(parseMcpToolName('mcp__server__tool__with__more')).toEqual({
      server: 'server',
      tool: 'tool__with__more'
    })
  })
})

describe('isNessControl', () => {
  it('recognises ness-control tools', () => {
    expect(isNessControl('mcp__ness-control__create_worktree')).toBe(true)
  })

  it('rejects everything else', () => {
    expect(isNessControl('Read')).toBe(false)
    expect(isNessControl('mcp__claude_ai_Notion__notion-get-users')).toBe(false)
    expect(isNessControl(undefined)).toBe(false)
  })
})

describe('getToolDisplay', () => {
  it('returns built-in name + icon for Claude tools', () => {
    const read = getToolDisplay('Read')
    expect(read.label).toBe('Read')
    expect(read.icon).not.toBeNull()

    const bash = getToolDisplay('Bash')
    expect(bash.label).toBe('Bash')
    expect(bash.icon).not.toBeNull()
  })

  it('returns name only (no icon) for unknown built-ins', () => {
    expect(getToolDisplay('SomeNewBuiltin')).toEqual({
      label: 'SomeNewBuiltin',
      compactLabel: 'SomeNewBuiltin',
      icon: null
    })
  })

  it('formats ness-control as "Ness · Title Cased Action"', () => {
    const display = getToolDisplay('mcp__ness-control__create_worktree')
    expect(display.label).toBe('Ness · Create Worktree')
    expect(display.icon).not.toBeNull()
  })

  it('formats Notion tools as "Notion · Action" and strips notion- prefix', () => {
    expect(getToolDisplay('mcp__claude_ai_Notion__notion-get-users').label).toBe(
      'Notion · Get Users'
    )
    expect(getToolDisplay('mcp__notion__authenticate').label).toBe(
      'Notion · Authenticate'
    )
  })

  it('formats Slack tools as "Slack · Action" and strips slack_ prefix', () => {
    expect(
      getToolDisplay('mcp__claude_ai_Slack__slack_send_message').label
    ).toBe('Slack · Send Message')
  })

  it('formats Google Drive tools with the multi-word label', () => {
    expect(
      getToolDisplay('mcp__claude_ai_Google_Drive__list_recent_files').label
    ).toBe('Google Drive · List Recent Files')
  })

  it('formats Google Calendar tools with the multi-word label', () => {
    expect(
      getToolDisplay('mcp__claude_ai_Google_Calendar__create_event').label
    ).toBe('Google Calendar · Create Event')
  })

  it('formats Gmail tools', () => {
    expect(getToolDisplay('mcp__claude_ai_Gmail__create_draft').label).toBe(
      'Gmail · Create Draft'
    )
  })

  it('falls back to title-cased server + generic icon for unknown brands', () => {
    const display = getToolDisplay('mcp__foo_bar__do_thing')
    expect(display.label).toBe('foo bar · Do Thing')
    expect(display.icon).not.toBeNull()
  })

  it('handles undefined gracefully', () => {
    expect(getToolDisplay(undefined)).toEqual({
      label: 'Tool',
      compactLabel: 'Tool',
      icon: null
    })
  })
})

describe('prettyToolName back-compat', () => {
  it('returns the same label as getToolDisplay', () => {
    expect(prettyToolName('mcp__ness-control__create_worktree')).toBe(
      'Ness · Create Worktree'
    )
    expect(prettyToolName('Read')).toBe('Read')
  })
})

describe('normalizeServerName', () => {
  it('collapses spellings of the same brand to one key', () => {
    expect(normalizeServerName('GitHub')).toBe('github')
    expect(normalizeServerName('github')).toBe('github')
    expect(normalizeServerName('claude_ai_GitHub')).toBe('github')
    expect(normalizeServerName('Google_Drive')).toBe('googledrive')
    expect(normalizeServerName('claude_ai_Google_Drive')).toBe('googledrive')
    expect(normalizeServerName('ness-control')).toBe('nesscontrol')
  })

  it('handles empty / separator-only strings', () => {
    expect(normalizeServerName('')).toBe('')
    expect(normalizeServerName('___')).toBe('')
    expect(normalizeServerName('---')).toBe('')
  })

  it('collapses runs of mixed separators', () => {
    expect(normalizeServerName('foo__-_-bar')).toBe('foobar')
    expect(normalizeServerName(' foo bar ')).toBe('foobar')
  })

  it('only strips the claude_ai_ prefix when it leads the name', () => {
    // Mid-string occurrence stays put (still collapsed by separator
    // stripping, just not treated as the prefix).
    expect(normalizeServerName('foo_claude_ai_bar')).toBe('fooclaudeaibar')
  })
})

describe('expanded brand registry', () => {
  it('matches GitHub regardless of spelling', () => {
    expect(getToolDisplay('mcp__github__create_issue').label).toBe(
      'GitHub · Create Issue'
    )
    expect(getToolDisplay('mcp__GitHub__create_issue').label).toBe(
      'GitHub · Create Issue'
    )
    expect(getToolDisplay('mcp__claude_ai_GitHub__create_issue').label).toBe(
      'GitHub · Create Issue'
    )
  })

  it('strips the brand prefix from tool names with hyphen or underscore', () => {
    expect(getToolDisplay('mcp__github__github-list-pull-requests').label).toBe(
      'GitHub · List Pull Requests'
    )
    expect(getToolDisplay('mcp__stripe__stripe_create_customer').label).toBe(
      'Stripe · Create Customer'
    )
  })

  it('does NOT strip a substring that happens to match the brand prefix', () => {
    // "githubbed_something" must not have "github" lopped off — the
    // prefix-stripping requires a separator (- or _) after the brand
    // name, so substring false-positives are blocked.
    expect(getToolDisplay('mcp__github__githubbed_action').label).toBe(
      'GitHub · Githubbed Action'
    )
  })

  it('handles tool names that are exactly the brand prefix', () => {
    // After stripping "github-" the tool is empty; should not crash
    // and label should fall back gracefully.
    const display = getToolDisplay('mcp__github__github')
    // No separator suffix on bare "github", so the prefix doesn't
    // strip — we read it as the action.
    expect(display.label).toBe('GitHub · Github')
  })

  it('handles common dev/data/comms brands', () => {
    expect(getToolDisplay('mcp__linear__create_issue').label).toBe(
      'Linear · Create Issue'
    )
    expect(getToolDisplay('mcp__postgres__query').label).toBe('Postgres · Query')
    expect(getToolDisplay('mcp__postgresql__query').label).toBe(
      'Postgres · Query'
    )
    expect(getToolDisplay('mcp__discord__send_message').label).toBe(
      'Discord · Send Message'
    )
    expect(getToolDisplay('mcp__figma__get_file').label).toBe(
      'Figma · Get File'
    )
  })

  it('treats Twitter as X (rename)', () => {
    expect(getToolDisplay('mcp__twitter__post_tweet').label).toBe(
      'X · Post Tweet'
    )
    expect(getToolDisplay('mcp__x__post_tweet').label).toBe('X · Post Tweet')
  })

  it('returns an icon for every known brand', () => {
    const brands = [
      'github', 'gitlab', 'bitbucket', 'linear', 'jira', 'sentry', 'vercel',
      'netlify', 'cloudflare', 'supabase', 'firebase', 'postgres', 'mysql',
      'mongodb', 'redis', 'sqlite', 'snowflake', 'elasticsearch', 'discord',
      'telegram', 'whatsapp', 'zoom', 'mailchimp', 'twilio', 'intercom',
      'asana', 'trello', 'clickup', 'confluence', 'stripe', 'paypal',
      'shopify', 'hubspot', 'salesforce', 'zendesk', 'openai', 'huggingface',
      'perplexity', 'brave', 'anthropic', 'figma', 'spotify', 'youtube',
      'reddit', 'x', 'bluesky', 'cloudinary'
    ]
    for (const b of brands) {
      const d = getToolDisplay(`mcp__${b}__do_thing`)
      expect(d.icon, `${b} should have an icon`).not.toBeNull()
    }
  })
})

describe('extractArgs', () => {
  it('returns [] for non-object inputs', () => {
    expect(extractArgs(undefined)).toEqual([])
    expect(extractArgs(null)).toEqual([])
    expect(extractArgs('hi')).toEqual([])
    expect(extractArgs(42)).toEqual([])
    expect(extractArgs([1, 2])).toEqual([])
  })

  it('returns an entry per top-level key, preserving order', () => {
    const args = extractArgs({ branchName: 'feat-x', count: 3 })
    expect(args).toEqual([
      { key: 'branchName', value: 'feat-x', multiline: false },
      { key: 'count', value: '3', multiline: false }
    ])
  })

  it('stringifies nested objects and arrays as JSON', () => {
    const args = extractArgs({ rules: [{ a: 1 }], opts: { x: true } })
    expect(args[0].value).toBe('[{"a":1}]')
    expect(args[1].value).toBe('{"x":true}')
  })

  it('marks long or multi-line values as multiline', () => {
    const long = 'a'.repeat(120)
    const args = extractArgs({
      short: 'hi',
      long,
      hasNewline: 'one\ntwo'
    })
    expect(args[0].multiline).toBe(false)
    expect(args[1].multiline).toBe(true)
    expect(args[2].multiline).toBe(true)
  })

  it('handles null and booleans as scalars, not multiline', () => {
    const args = extractArgs({ enabled: true, missing: null })
    expect(args).toEqual([
      { key: 'enabled', value: 'true', multiline: false },
      { key: 'missing', value: 'null', multiline: false }
    ])
  })

  it('handles undefined values as the literal "undefined"', () => {
    const args = extractArgs({ explicit: undefined })
    expect(args).toEqual([
      { key: 'explicit', value: 'undefined', multiline: false }
    ])
  })

  it('returns [] for empty objects', () => {
    expect(extractArgs({})).toEqual([])
  })

  it('does not crash on circular references', () => {
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    const args = extractArgs(circular)
    expect(args.length).toBe(2)
    expect(args[0]).toEqual({ key: 'a', value: '1', multiline: false })
    // JSON.stringify throws on cycles; the catch falls back to
    // String(value) which is "[object Object]" — not pretty but won't
    // bring the renderer down.
    expect(args[1].key).toBe('self')
    expect(typeof args[1].value).toBe('string')
  })

  it('serialises bigint via the scalar branch', () => {
    // JSON.stringify(bigint) throws, so we must handle bigint
    // explicitly (otherwise the catch falls back to String() which
    // works but only by accident).
    const args = extractArgs({ big: 9007199254740993n })
    expect(args).toEqual([
      { key: 'big', value: '9007199254740993', multiline: false }
    ])
  })

  it('serialises Date via JSON.toJSON (ISO string)', () => {
    const d = new Date('2026-06-19T12:00:00Z')
    const args = extractArgs({ when: d })
    expect(args[0].value).toBe('"2026-06-19T12:00:00.000Z"')
  })
})

describe('compactLabel', () => {
  it('drops the brand prefix for known MCP brands (icon conveys it)', () => {
    expect(getToolDisplay('mcp__github__create_issue').compactLabel).toBe(
      'Create Issue'
    )
    expect(
      getToolDisplay('mcp__ness-control__create_worktree').compactLabel
    ).toBe('Create Worktree')
    expect(
      getToolDisplay('mcp__claude_ai_Google_Drive__list_recent_files').compactLabel
    ).toBe('List Recent Files')
  })

  it('matches label for built-ins (no prefix to drop)', () => {
    const read = getToolDisplay('Read')
    expect(read.compactLabel).toBe(read.label)
    expect(read.compactLabel).toBe('Read')
  })

  it('matches label for unknown MCPs (generic plug icon has no brand cue)', () => {
    const d = getToolDisplay('mcp__foo_bar__do_thing')
    expect(d.compactLabel).toBe(d.label)
    expect(d.compactLabel).toBe('foo bar · Do Thing')
  })

  it('handles undefined gracefully', () => {
    expect(getToolDisplay(undefined).compactLabel).toBe('Tool')
  })
})

describe('pre-rename harness-control tools in existing transcripts', () => {
  it('still recognises the legacy prefix so old cards keep Ness chrome', () => {
    expect(isNessControl('mcp__harness-control__create_worktree')).toBe(true)
  })

  it('still labels legacy tool calls as Ness', () => {
    expect(getToolDisplay('mcp__harness-control__create_worktree').label).toBe(
      'Ness · Create Worktree'
    )
  })
})
