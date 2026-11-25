import { describe, it, expect, vi, beforeEach } from 'vitest'

const fsState: { files: Map<string, string> } = { files: new Map() }

vi.mock('fs', () => ({
  existsSync: (p: string) => fsState.files.has(p),
  readFileSync: (p: string) => {
    if (!fsState.files.has(p)) throw new Error(`ENOENT: ${p}`)
    return fsState.files.get(p) as string
  },
  writeFileSync: (p: string, data: string) => {
    fsState.files.set(p, data)
  },
  mkdirSync: () => {},
  readdirSync: () => [],
  statSync: () => ({ mtimeMs: 0 })
}))

vi.mock('../debug', () => ({
  log: () => {}
}))

vi.mock('../hooks', () => ({
  // Match the real shape — every Ness hook command embeds the
  // status-dir path. That substring is what dedup recognizes.
  makeHookCommand: (event: string) =>
    `bash -c 'd=/tmp/harness-status; printf "${event}" >> "$d/$h.ndjson"'`
}))

import { homedir } from 'os'
import { join } from 'path'
import {
  buildSpawnArgs,
  extractSessionId,
  hooksInstalled,
  installHooks,
  hookEvents,
  uninstallHooks
} from './claude'

const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json')

beforeEach(() => {
  fsState.files.clear()
})

describe('buildSpawnArgs', () => {
  const base = { command: 'claude', cwd: '/tmp/test' }

  it('includes --append-system-prompt when systemPrompt is provided', () => {
    const result = buildSpawnArgs({ ...base, systemPrompt: 'You are in Ness.' })
    expect(result).toContain('--append-system-prompt')
    expect(result).toContain('You are in Ness.')
  })

  it('omits --append-system-prompt when systemPrompt is undefined', () => {
    const result = buildSpawnArgs({ ...base })
    expect(result).not.toContain('--append-system-prompt')
  })

  it('omits --append-system-prompt when systemPrompt is empty', () => {
    const result = buildSpawnArgs({ ...base, systemPrompt: '' })
    expect(result).not.toContain('--append-system-prompt')
  })

  it('shell-quotes the system prompt safely', () => {
    const prompt = "it's a \"test\" with\nnewlines"
    const result = buildSpawnArgs({ ...base, systemPrompt: prompt })
    expect(result).toContain('--append-system-prompt')
    expect(result).toContain("'\\''")
  })

  it('pre-allows Ness tools right before --mcp-config when Ness MCP is injected', () => {
    const result = buildSpawnArgs({ ...base, mcpConfigPath: '/cfg.json', initialPrompt: 'go' })
    expect(result).toMatch(/--allowedTools '[^']*mcp__ness-control__report_progress[^']*' --mcp-config/)
    expect(result).not.toContain('create_shell')
    expect(result.endsWith("'go'")).toBe(true)
  })

  it('leaves --allowedTools off without Ness MCP or when the user already set it', () => {
    expect(buildSpawnArgs({ ...base })).not.toContain('--allowedTools')
    expect(
      buildSpawnArgs({ ...base, command: 'claude --allowedTools Read', mcpConfigPath: '/cfg.json' })
        .match(/--allowedTools/g)
    ).toHaveLength(1)
  })

  const sessionPath = (cwd: string, id: string): string =>
    join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`)

  it('passes the initial prompt through on the --resume path', () => {
    // A worktree forked from an existing conversation resumes a transcript
    // AND needs its new instructions; dropping the prompt here left the
    // agent sitting idle with history it was never told what to do with.
    fsState.files.set(sessionPath('/tmp/test', 'abc'), '{}')
    const result = buildSpawnArgs({ ...base, sessionId: 'abc', initialPrompt: 'do the thing' })
    expect(result).toContain('--resume abc')
    expect(result).toContain("'do the thing'")
  })

  it('omits a positional prompt on --resume when there is none', () => {
    fsState.files.set(sessionPath('/tmp/test', 'abc'), '{}')
    const result = buildSpawnArgs({ ...base, sessionId: 'abc' })
    expect(result).toBe('claude --resume abc')
  })

  it('uses --session-id with the prompt when no transcript exists yet', () => {
    const result = buildSpawnArgs({ ...base, sessionId: 'abc', initialPrompt: 'hello' })
    expect(result).toContain('--session-id abc')
    expect(result).toContain("'hello'")
  })

  it('shell-quotes the initial prompt on the resume path', () => {
    fsState.files.set(sessionPath('/tmp/test', 'abc'), '{}')
    const result = buildSpawnArgs({ ...base, sessionId: 'abc', initialPrompt: "it's got quotes" })
    expect(result).toContain("'\\''")
  })
})

describe('claude extractSessionId', () => {
  it('reads session_id', () => {
    expect(extractSessionId({ session_id: 'sess-abc' })).toBe('sess-abc')
  })

  it("ignores another agent's field name", () => {
    expect(extractSessionId({ conversation_id: 'cursor-only' })).toBeNull()
  })

  it('returns null for missing, empty, or non-string values', () => {
    expect(extractSessionId({})).toBeNull()
    expect(extractSessionId({ session_id: '' })).toBeNull()
    expect(extractSessionId({ session_id: 42 })).toBeNull()
  })
})

describe('hook install / dedup', () => {
  it('hooksInstalled() recognizes normalized entries with no _marker field', () => {
    // Simulate what Claude Code leaves behind after normalizing settings.json:
    // the _marker and _version sidecar fields are stripped, only the
    // {type, command, timeout} triple remains.
    const settings = {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command',
                command:
                  "bash -c 'd=/tmp/harness-status; printf hi >> \"$d/$h.ndjson\"'",
                timeout: 5
              }
            ]
          }
        ]
      }
    }
    fsState.files.set(SETTINGS_PATH, JSON.stringify(settings))
    expect(hooksInstalled()).toBe(true)
  })

  it('hooksInstalled() returns false when only user-authored hooks exist', () => {
    const settings = {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [{ type: 'command', command: 'echo user hook', timeout: 5 }]
          }
        ]
      }
    }
    fsState.files.set(SETTINGS_PATH, JSON.stringify(settings))
    expect(hooksInstalled()).toBe(false)
  })

  it('installHooks() called twice yields exactly one harness entry per event', () => {
    installHooks()
    installHooks()
    const settings = JSON.parse(fsState.files.get(SETTINGS_PATH) as string)
    for (const event of hookEvents) {
      const entries = settings.hooks[event]
      expect(entries).toHaveLength(1)
      expect(entries[0].hooks[0].command).toContain('/tmp/harness-status')
    }
  })

  it('installHooks() collapses pre-existing duplicates left by buggy passes', () => {
    // Three duplicate harness entries per event, all in normalized form
    // (no _marker / _version). This is the exact shape the user reports
    // after several buggy install passes.
    const dupEntry = {
      hooks: [
        {
          type: 'command',
          command:
            "bash -c 'd=/tmp/harness-status; printf hi >> \"$d/$h.ndjson\"'",
          timeout: 5
        }
      ]
    }
    const settings: { hooks: Record<string, unknown[]> } = { hooks: {} }
    for (const event of hookEvents) {
      settings.hooks[event] = [dupEntry, dupEntry, dupEntry]
    }
    fsState.files.set(SETTINGS_PATH, JSON.stringify(settings))

    installHooks()

    const after = JSON.parse(fsState.files.get(SETTINGS_PATH) as string)
    for (const event of hookEvents) {
      expect(after.hooks[event]).toHaveLength(1)
    }
  })

  it('installHooks() preserves user-authored hooks (commands not pointing at /tmp/harness-status)', () => {
    const userHook = {
      hooks: [{ type: 'command', command: 'echo user hook', timeout: 10 }]
    }
    fsState.files.set(
      SETTINGS_PATH,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [userHook],
          PreToolUse: [userHook]
        },
        unrelatedKey: 'preserve-me'
      })
    )

    installHooks()

    const after = JSON.parse(fsState.files.get(SETTINGS_PATH) as string)
    expect(after.unrelatedKey).toBe('preserve-me')
    // User hook still there + one harness entry appended
    expect(after.hooks.UserPromptSubmit).toContainEqual(userHook)
    expect(after.hooks.PreToolUse).toContainEqual(userHook)
    for (const event of hookEvents) {
      const harnessEntries = (after.hooks[event] as Array<{ hooks: { command: string }[] }>).filter(
        (e) => e.hooks.some((h) => h.command.includes('/tmp/harness-status'))
      )
      expect(harnessEntries).toHaveLength(1)
    }
  })

  it('uninstallHooks() removes harness entries but preserves user-authored hooks', () => {
    installHooks()
    // Add a user-authored hook alongside
    const after = JSON.parse(fsState.files.get(SETTINGS_PATH) as string)
    after.hooks.UserPromptSubmit.push({
      hooks: [{ type: 'command', command: 'echo user hook' }]
    })
    fsState.files.set(SETTINGS_PATH, JSON.stringify(after))

    uninstallHooks()

    const final = JSON.parse(fsState.files.get(SETTINGS_PATH) as string)
    expect(final.hooks?.UserPromptSubmit).toEqual([
      { hooks: [{ type: 'command', command: 'echo user hook' }] }
    ])
    // Other events had no user hooks, so they should be gone entirely.
    expect(final.hooks?.PreToolUse).toBeUndefined()
  })
})
