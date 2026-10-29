import { execFile } from 'child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, appendFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { log } from '../debug'
import { makeHookCommand } from '../hooks'
import { loginShellCommandArgs, resolveUserShell } from '../user-shell'
import type { AgentSpawnOpts } from './index'
import type { StdioMcpServer } from '../ness-control-mcp'

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

// Codex strips unknown fields when it normalizes hooks.json, so dedup
// recognizes our entries by the status-dir path baked into the hook
// command instead of a sidecar marker.
const HARNESS_HOOK_COMMAND_SIGNATURE = '/tmp/harness-status'

export const defaultCommand = 'codex'
export const assignsSessionId = false

export const hookEvents = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop'
]

interface CodexHookEntry {
  matcher?: string
  hooks: { type: string; command: string; timeout?: number }[]
}

interface CodexHooksFile {
  hooks?: Record<string, CodexHookEntry[]>
}

function globalHooksPath(): string {
  return join(homedir(), '.codex', 'hooks.json')
}

function worktreeHooksPath(worktreePath: string): string {
  return join(worktreePath, '.codex', 'hooks.json')
}

function readHooksFile(path: string): CodexHooksFile {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return {}
  }
}

function writeHooksFile(path: string, data: CodexHooksFile): void {
  const dir = join(path, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2))
}

function makeHarnessHookEntry(command: string): CodexHookEntry {
  return {
    hooks: [{ type: 'command', command, timeout: 5 }]
  }
}

function isHarnessHookEntry(entry: CodexHookEntry): boolean {
  return !!entry.hooks?.some(
    (h) => typeof h.command === 'string' && h.command.includes(HARNESS_HOOK_COMMAND_SIGNATURE)
  )
}

function removeOldHarnessEntries(entries: CodexHookEntry[]): CodexHookEntry[] {
  return entries.filter((entry) => !isHarnessHookEntry(entry))
}

function ensureCodexHooksEnabled(): void {
  const configPath = join(homedir(), '.codex', 'config.toml')
  try {
    const content = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : ''
    if (content.includes('codex_hooks')) return
    const section = content.includes('[features]') ? '' : '\n[features]\n'
    const line = 'codex_hooks = true\n'
    appendFileSync(configPath, section + line)
    log('hooks', 'enabled codex_hooks in ~/.codex/config.toml')
  } catch (err) {
    log('hooks', 'failed to enable codex_hooks', err instanceof Error ? err.message : err)
  }
}

export function hooksInstalled(): boolean {
  const data = readHooksFile(globalHooksPath())
  const hooks = data.hooks
  if (!hooks) return false
  for (const entries of Object.values(hooks)) {
    for (const entry of entries) {
      if (isHarnessHookEntry(entry)) return true
    }
  }
  return false
}

export function installHooks(): void {
  const path = globalHooksPath()
  log('hooks', `installing Codex hooks into ${path}`)

  ensureCodexHooksEnabled()

  const data = readHooksFile(path)
  if (!data.hooks) data.hooks = {}

  for (const event of Object.keys(data.hooks)) {
    data.hooks[event] = removeOldHarnessEntries(data.hooks[event])
  }

  for (const event of hookEvents) {
    if (!data.hooks[event]) data.hooks[event] = []
    data.hooks[event].push(makeHarnessHookEntry(makeHookCommand(event)))
  }

  writeHooksFile(path, data)
}

export function uninstallHooks(): void {
  const path = globalHooksPath()
  if (!existsSync(path)) return
  const data = readHooksFile(path)
  if (!data.hooks) return
  for (const event of Object.keys(data.hooks)) {
    data.hooks[event] = removeOldHarnessEntries(data.hooks[event])
    if (data.hooks[event].length === 0) delete data.hooks[event]
  }
  if (Object.keys(data.hooks).length === 0) delete data.hooks
  writeHooksFile(path, data)
  log('hooks', `uninstalled Codex hooks from ${path}`)
}

export function stripHooksFromWorktree(worktreePath: string): boolean {
  const path = worktreeHooksPath(worktreePath)
  if (!existsSync(path)) return false
  const data = readHooksFile(path)
  if (!data.hooks) return false
  let changed = false
  for (const event of Object.keys(data.hooks)) {
    const before = data.hooks[event].length
    data.hooks[event] = removeOldHarnessEntries(data.hooks[event])
    if (data.hooks[event].length !== before) changed = true
    if (data.hooks[event].length === 0) delete data.hooks[event]
  }
  if (!changed) return false
  if (Object.keys(data.hooks).length === 0) delete data.hooks
  writeHooksFile(path, data)
  log('hooks', `stripped legacy Ness Codex entries from ${path}`)
  return true
}

export function sessionFileExists(_cwd: string, sessionId: string): boolean {
  try {
    const sessionsDir = join(homedir(), '.codex', 'sessions')
    const walkDir = (dir: string): boolean => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (walkDir(join(dir, entry.name))) return true
        } else if (entry.name.includes(sessionId) && entry.name.endsWith('.jsonl')) {
          return true
        }
      }
      return false
    }
    return walkDir(sessionsDir)
  } catch {
    return false
  }
}

export function latestSessionId(_cwd: string): string | null {
  try {
    const sessionsDir = join(homedir(), '.codex', 'sessions')
    let bestId: string | null = null
    let bestMtime = -Infinity
    const walkDir = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          walkDir(full)
        } else if (entry.name.endsWith('.jsonl')) {
          const mtime = statSync(full).mtimeMs
          if (mtime > bestMtime) {
            bestMtime = mtime
            const stem = entry.name.replace(/\.jsonl$/, '')
            const uuidMatch = stem.match(/([0-9a-f]{4,}-[0-9a-f-]+)$/)
            bestId = uuidMatch ? uuidMatch[1] : stem
          }
        }
      }
    }
    walkDir(sessionsDir)
    return bestId
  } catch {
    return null
  }
}

export function extractSessionId(payload: Record<string, unknown>): string | null {
  const sid = payload.session_id
  return typeof sid === 'string' && sid ? sid : null
}

// Recent Codex TUIs host their conversation on a shared background
// app-server daemon rather than in-process. The daemon keeps a thread loaded
// after the TUI exits, which locks it ("already has an active writer") — so
// switching a Codex tab from Terminal back to Chat, whose app-server must
// take the thread over, fails for as long as the daemon lives. `--no-daemon`
// keeps the conversation in the TUI process, released when the tab closes.
// Older codex builds predate the flag and would reject it, hence the probe.
const noDaemonSupport = new Map<string, Promise<boolean>>()

export function supportsNoDaemon(command: string): Promise<boolean> {
  let probe = noDaemonSupport.get(command)
  if (!probe) {
    probe = new Promise((resolve) => {
      execFile(
        resolveUserShell(),
        loginShellCommandArgs(`${command} --help`),
        { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          const supported = !err && /--no-daemon\b/.test(stdout)
          log('agents', `codex --no-daemon support command=${command} supported=${supported}`)
          resolve(supported)
        }
      )
    })
    noDaemonSupport.set(command, probe)
  }
  return probe
}

/** `-c` values that register an MCP server for one Codex invocation. The
 *  server's env rides inside the override (a TOML inline table) rather than
 *  the terminal's environment, so the control token reaches only the MCP
 *  subprocess — not every shell command the agent runs. JSON string and
 *  array literals are valid TOML, which keeps the quoting simple. */
export function mcpServerOverrides(name: string, server: StdioMcpServer): string[] {
  const env = Object.entries(server.env)
    .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
    .join(', ')
  return [
    `mcp_servers.${name}.command=${JSON.stringify(server.command)}`,
    `mcp_servers.${name}.args=${JSON.stringify(server.args)}`,
    `mcp_servers.${name}.env={${env}}`
  ]
}

export function buildSpawnArgs(opts: AgentSpawnOpts): string {
  // Codex has no per-invocation MCP config file, so Ness's server goes in as
  // `-c` overrides (opts.nessMcp); mcpConfigPath is the Claude-shaped file
  // and is unused here.
  let cmd = opts.command
  if (opts.noDaemon && !opts.command.includes('--no-daemon')) {
    cmd += ' --no-daemon'
  }
  if (opts.nessMcp) {
    for (const override of mcpServerOverrides('ness-control', opts.nessMcp)) {
      cmd += ` -c ${shellQuote(override)}`
    }
  }
  if (opts.model && !opts.command.includes('--model') && !opts.command.includes('-m ')) {
    cmd += ` --model ${shellQuote(opts.model)}`
  }

  if (!opts.sessionId) {
    return opts.initialPrompt ? `${cmd} ${shellQuote(opts.initialPrompt)}` : cmd
  }

  const exists = sessionFileExists(opts.cwd, opts.sessionId)
  if (exists) return `${cmd} resume ${opts.sessionId}`

  return opts.initialPrompt ? `${cmd} ${shellQuote(opts.initialPrompt)}` : cmd
}
