import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { log } from '../debug'
import { claudeProjectsDirFor, knownClaudeConfigDirs } from '../claude-env'
import { makeHookCommand } from '../hooks'
import { shellQuote } from '../shell-quote'
import type { AgentSpawnOpts } from './index'

// Claude Code strips unknown fields when it normalizes settings.json,
// so dedup recognizes our entries by the status-dir path baked into
// the hook command instead of a sidecar marker.
const HARNESS_HOOK_COMMAND_SIGNATURE = '/tmp/harness-status'

export const defaultCommand = 'claude'
export const assignsSessionId = true

export const hookEvents = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'Notification'
]

interface HookEntry {
  matcher?: string
  hooks: { type: string; command: string; timeout?: number }[]
}

interface SettingsFile {
  hooks?: Record<string, HookEntry[]>
  [key: string]: unknown
}

function settingsPathIn(configDir: string): string {
  return join(configDir, 'settings.json')
}

function worktreeSettingsPath(worktreePath: string): string {
  return join(worktreePath, '.claude', 'settings.local.json')
}

function readSettings(path: string): SettingsFile {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return {}
  }
}

function writeSettings(path: string, settings: SettingsFile): void {
  const dir = join(path, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(settings, null, 2))
}

function makeHarnessHookEntry(command: string): HookEntry {
  return {
    hooks: [{ type: 'command', command, timeout: 5 }]
  }
}

function isHarnessHookEntry(entry: HookEntry): boolean {
  return !!entry.hooks?.some(
    (h) => typeof h.command === 'string' && h.command.includes(HARNESS_HOOK_COMMAND_SIGNATURE)
  )
}

function removeOldHarnessEntries(entries: HookEntry[]): HookEntry[] {
  return entries.filter((entry) => !isHarnessHookEntry(entry))
}

export function hooksInstalled(): boolean {
  return knownClaudeConfigDirs().some((dir) => hooksInstalledIn(settingsPathIn(dir)))
}

function hooksInstalledIn(path: string): boolean {
  const settings = readSettings(path)
  const hooks = settings.hooks
  if (!hooks) return false
  for (const entries of Object.values(hooks)) {
    for (const entry of entries) {
      if (isHarnessHookEntry(entry)) return true
    }
  }
  return false
}

/** Every Claude home a Ness worktree resolves to gets the hooks: Claude
 *  only reads the settings.json under its own CLAUDE_CONFIG_DIR, so a
 *  worktree whose shell points elsewhere would otherwise report no
 *  status at all. */
export function installHooks(): void {
  for (const dir of knownClaudeConfigDirs()) installHooksInto(settingsPathIn(dir))
}

function installHooksInto(path: string): void {
  log('hooks', `installing Claude hooks into ${path}`)
  const settings = readSettings(path)
  if (!settings.hooks) settings.hooks = {}

  for (const event of Object.keys(settings.hooks)) {
    settings.hooks[event] = removeOldHarnessEntries(settings.hooks[event])
  }

  for (const event of hookEvents) {
    if (!settings.hooks[event]) settings.hooks[event] = []
    settings.hooks[event].push(makeHarnessHookEntry(makeHookCommand(event)))
  }

  writeSettings(path, settings)
}

/** Remove our entries from ~/.claude/settings.json but leave any user-authored
 *  hooks + unrelated keys intact. No-op if we're not installed. */
export function uninstallHooks(): void {
  for (const dir of knownClaudeConfigDirs()) uninstallHooksFrom(settingsPathIn(dir))
}

function uninstallHooksFrom(path: string): void {
  if (!existsSync(path)) return
  const settings = readSettings(path)
  if (!settings.hooks) return
  for (const event of Object.keys(settings.hooks)) {
    settings.hooks[event] = removeOldHarnessEntries(settings.hooks[event])
    if (settings.hooks[event].length === 0) delete settings.hooks[event]
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks
  writeSettings(path, settings)
  log('hooks', `uninstalled Claude hooks from ${path}`)
}

/** Strip any legacy Ness entries from a worktree's .claude/settings.local.json.
 *  Returns true if the file was modified. Leaves user-authored hooks alone. */
export function stripHooksFromWorktree(worktreePath: string): boolean {
  const path = worktreeSettingsPath(worktreePath)
  if (!existsSync(path)) return false
  const settings = readSettings(path)
  if (!settings.hooks) return false
  let changed = false
  for (const event of Object.keys(settings.hooks)) {
    const before = settings.hooks[event].length
    settings.hooks[event] = removeOldHarnessEntries(settings.hooks[event])
    if (settings.hooks[event].length !== before) changed = true
    if (settings.hooks[event].length === 0) delete settings.hooks[event]
  }
  if (!changed) return false
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks
  writeSettings(path, settings)
  log('hooks', `stripped legacy Ness entries from ${path}`)
  return true
}

export function sessionFileExists(cwd: string, sessionId: string): boolean {
  try {
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-')
    return existsSync(join(claudeProjectsDirFor(cwd), encoded, `${sessionId}.jsonl`))
  } catch {
    return false
  }
}

export function latestSessionId(cwd: string): string | null {
  try {
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-')
    const dir = join(claudeProjectsDirFor(cwd), encoded)
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    if (files.length === 0) return null
    let bestId: string | null = null
    let bestMtime = -Infinity
    for (const file of files) {
      const mtime = statSync(join(dir, file)).mtimeMs
      if (mtime > bestMtime) {
        bestMtime = mtime
        bestId = file.replace(/\.jsonl$/, '')
      }
    }
    return bestId
  } catch {
    return null
  }
}

// Claude takes our --session-id on first spawn, but `/clear` starts a fresh
// session under an ID it picks itself. Re-reading the ID from every hook
// payload is what keeps a cleared tab resumable at the session it's actually
// on rather than the one it was born with.
export function extractSessionId(payload: Record<string, unknown>): string | null {
  const sid = payload.session_id
  return typeof sid === 'string' && sid ? sid : null
}

export function buildSpawnArgs(opts: AgentSpawnOpts): string {
  const modelFlag = opts.model && !opts.command.includes('--model') ? ` --model ${shellQuote(opts.model)}` : ''
  const mcpFlag = opts.mcpConfigPath ? ` --mcp-config ${shellQuote(opts.mcpConfigPath)}` : ''
  const nameFlag = opts.sessionName ? ` --name ${shellQuote(opts.sessionName)}` : ''
  const systemPromptFlag = opts.systemPrompt ? ` --append-system-prompt ${shellQuote(opts.systemPrompt)}` : ''
  const tuiPrefix = opts.tuiFullscreen ? 'CLAUDE_CODE_NO_FLICKER=1 ' : ''
  const cmd = `${tuiPrefix}${opts.command}${modelFlag}${mcpFlag}${nameFlag}${systemPromptFlag}`

  if (opts.teleportSessionId && opts.sessionId) {
    const exists = sessionFileExists(opts.cwd, opts.sessionId)
    if (!exists) {
      return `${cmd} --teleport ${opts.teleportSessionId} --session-id ${opts.sessionId}`
    }
  }

  if (!opts.sessionId) {
    return opts.initialPrompt ? `${cmd} ${shellQuote(opts.initialPrompt)}` : cmd
  }

  const exists = sessionFileExists(opts.cwd, opts.sessionId)
  const base = exists
    ? `${cmd} --resume ${opts.sessionId}`
    : `${cmd} --session-id ${opts.sessionId}`
  return opts.initialPrompt ? `${base} ${shellQuote(opts.initialPrompt)}` : base
}
