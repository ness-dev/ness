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
  appendFileSync: (p: string, data: string) => {
    fsState.files.set(p, (fsState.files.get(p) ?? '') + data)
  },
  mkdirSync: () => {},
  readdirSync: () => [],
  statSync: () => ({ mtimeMs: 0 })
}))

vi.mock('../debug', () => ({
  log: () => {}
}))

const execState: { calls: string[]; reply: { err: Error | null; stdout: string } } = {
  calls: [],
  reply: { err: null, stdout: '' }
}

vi.mock('child_process', () => ({
  execFile: (
    _shell: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string) => void
  ) => {
    execState.calls.push(args[args.length - 1])
    cb(execState.reply.err, execState.reply.stdout)
  }
}))

vi.mock('../user-shell', () => ({
  resolveUserShell: () => '/bin/zsh',
  loginShellCommandArgs: (cmd: string) => ['-ilc', cmd]
}))

vi.mock('../hooks', () => ({
  makeHookCommand: (event: string) =>
    `bash -c 'd=/tmp/harness-status; printf "${event}" >> "$d/$h.ndjson"'`
}))

import { homedir } from 'os'
import { join } from 'path'
import {
  buildSpawnArgs,
  extractSessionId,
  supportsNoDaemon,
  launchExtras,
  mcpServerOverrides,
  hooksInstalled,
  installHooks,
  hookEvents,
  uninstallHooks
} from './codex'

const HOOKS_PATH = join(homedir(), '.codex', 'hooks.json')

beforeEach(() => {
  fsState.files.clear()
})

describe('codex hook install / dedup', () => {
  it('hooksInstalled() recognizes normalized entries with no _marker field', () => {
    const data = {
      hooks: {
        SessionStart: [
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
    fsState.files.set(HOOKS_PATH, JSON.stringify(data))
    expect(hooksInstalled()).toBe(true)
  })

  it('hooksInstalled() returns false when only user-authored hooks exist', () => {
    fsState.files.set(
      HOOKS_PATH,
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: 'echo user hook', timeout: 5 }] }
          ]
        }
      })
    )
    expect(hooksInstalled()).toBe(false)
  })

  it('installHooks() called twice yields exactly one harness entry per event', () => {
    installHooks()
    installHooks()
    const data = JSON.parse(fsState.files.get(HOOKS_PATH) as string)
    for (const event of hookEvents) {
      const entries = data.hooks[event]
      expect(entries).toHaveLength(1)
      expect(entries[0].hooks[0].command).toContain('/tmp/harness-status')
    }
  })

  it('installHooks() collapses pre-existing duplicates left by buggy passes', () => {
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
    const data: { hooks: Record<string, unknown[]> } = { hooks: {} }
    for (const event of hookEvents) {
      data.hooks[event] = [dupEntry, dupEntry, dupEntry]
    }
    fsState.files.set(HOOKS_PATH, JSON.stringify(data))

    installHooks()

    const after = JSON.parse(fsState.files.get(HOOKS_PATH) as string)
    for (const event of hookEvents) {
      expect(after.hooks[event]).toHaveLength(1)
    }
  })

  it('installHooks() preserves user-authored hooks', () => {
    const userHook = {
      hooks: [{ type: 'command', command: 'echo user hook', timeout: 10 }]
    }
    fsState.files.set(
      HOOKS_PATH,
      JSON.stringify({
        hooks: { SessionStart: [userHook], PreToolUse: [userHook] }
      })
    )

    installHooks()

    const after = JSON.parse(fsState.files.get(HOOKS_PATH) as string)
    expect(after.hooks.SessionStart).toContainEqual(userHook)
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
    const after = JSON.parse(fsState.files.get(HOOKS_PATH) as string)
    after.hooks.SessionStart.push({
      hooks: [{ type: 'command', command: 'echo user hook' }]
    })
    fsState.files.set(HOOKS_PATH, JSON.stringify(after))

    uninstallHooks()

    const final = JSON.parse(fsState.files.get(HOOKS_PATH) as string)
    expect(final.hooks?.SessionStart).toEqual([
      { hooks: [{ type: 'command', command: 'echo user hook' }] }
    ])
    expect(final.hooks?.PreToolUse).toBeUndefined()
  })
})

describe('codex extractSessionId', () => {
  it('reads session_id from the payload', () => {
    expect(extractSessionId({ session_id: 'sess-abc' })).toBe('sess-abc')
  })

  it('ignores fields belonging to other agents', () => {
    expect(extractSessionId({ conversation_id: 'cursor-only' })).toBeNull()
    expect(extractSessionId({ chat_id: 'nope', chatId: 'nope' })).toBeNull()
  })

  it('returns null for missing or non-string values', () => {
    expect(extractSessionId({})).toBeNull()
    expect(extractSessionId({ session_id: '' })).toBeNull()
    expect(extractSessionId({ session_id: 42 })).toBeNull()
  })
})

describe('codex --no-daemon', () => {
  it('detects support from --help and caches per command', async () => {
    execState.calls = []
    execState.reply = { err: null, stdout: '  --no-daemon\n      Run without the shared background server' }
    await expect(supportsNoDaemon('codex-a')).resolves.toBe(true)
    await expect(supportsNoDaemon('codex-a')).resolves.toBe(true)
    expect(execState.calls).toEqual(['codex-a --help'])
  })

  it('reports no support when the flag is absent or the probe fails', async () => {
    execState.reply = { err: null, stdout: 'Usage: codex [OPTIONS]' }
    await expect(supportsNoDaemon('codex-old')).resolves.toBe(false)
    execState.reply = { err: new Error('not found'), stdout: '' }
    await expect(supportsNoDaemon('codex-missing')).resolves.toBe(false)
  })

  it('reports --no-daemon support through launchExtras', async () => {
    execState.reply = { err: null, stdout: '--no-daemon' }
    await expect(launchExtras('codex-extras')).resolves.toEqual({ noDaemon: true })
  })

  it('adds --no-daemon to fresh and resumed launches only when asked', () => {
    expect(buildSpawnArgs({ command: 'codex', cwd: '/x', noDaemon: true })).toBe('codex --no-daemon')
    expect(buildSpawnArgs({ command: 'codex', cwd: '/x' })).toBe('codex')
    expect(buildSpawnArgs({ command: 'codex --no-daemon', cwd: '/x', noDaemon: true })).toBe('codex --no-daemon')
  })
})

describe('codex Ness MCP overrides', () => {
  const server = {
    command: '/Applications/Ness Dev.app/Contents/MacOS/Ness',
    args: ['/res/mcp-bridge.js'],
    env: { ELECTRON_RUN_AS_NODE: '1', HARNESS_TOKEN: 'a"b' }
  }

  it('encodes the server as TOML -c values with env inline', () => {
    expect(mcpServerOverrides('ness-control', server)).toEqual([
      'mcp_servers.ness-control.command="/Applications/Ness Dev.app/Contents/MacOS/Ness"',
      'mcp_servers.ness-control.args=["/res/mcp-bridge.js"]',
      'mcp_servers.ness-control.env={ELECTRON_RUN_AS_NODE = "1", HARNESS_TOKEN = "a\\"b"}'
    ])
  })

  it('adds shell-quoted -c flags to the launch command', () => {
    const cmd = buildSpawnArgs({ command: 'codex', cwd: '/x', nessMcp: server })
    expect(cmd.startsWith("codex -c 'mcp_servers.ness-control.command=")).toBe(true)
    expect(cmd.match(/ -c '/g)).toHaveLength(3)
  })
})
