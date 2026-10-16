// The environment a Claude session sees depends on where it starts:
// folder-scoped tooling (mise, direnv, asdf) sets variables such as
// CLAUDE_CONFIG_DIR per directory tree, and only a login shell started in
// that directory produces them. Terminal tabs get this for free because
// they run through `zsh -ilc`. The bundled json-mode binary is spawned
// directly, and everything that reads Claude's home on Ness's behalf
// (session lookups for --resume, transcripts, hook install) runs in main
// with Ness's own env — so all of those need the shell's answer for the
// worktree in question, which is what this module captures and caches.
//
// A probe costs one full login-shell startup (~1s with a heavy rc file),
// so it never runs on the hot path: spawn paths await `resolveShellEnv`,
// which only re-probes when the entry is older than FRESH_MS, and sync
// readers consult the cache without side effects.

import { spawn } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { resolveUserShell } from './user-shell'
import { log } from './debug'

const BEGIN = '__HARNESS_ENV_BEGIN__'
const END = '__HARNESS_ENV_END__'
const PROBE = `printf '${BEGIN}'; /usr/bin/env -0; printf '${END}'`
const DEFAULT_TIMEOUT_MS = 5000
const FRESH_MS = 60_000

export type ShellEnv = Record<string, string>

interface CacheEntry {
  env: ShellEnv | null
  capturedAt: number
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<ShellEnv | null>>()
let explicitConfigDir: () => string | undefined = () => undefined

export function parseEnvProbeOutput(stdout: string): ShellEnv | null {
  const beginIdx = stdout.indexOf(BEGIN)
  if (beginIdx < 0) return null
  const start = beginIdx + BEGIN.length
  const endIdx = stdout.indexOf(END, start)
  if (endIdx < 0) return null
  const env: ShellEnv = {}
  for (const entry of stdout.slice(start, endIdx).split('\0')) {
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    env[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return env
}

export async function captureShellEnv(
  shellPath: string,
  cwd: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<ShellEnv | null> {
  return new Promise((resolve) => {
    let stdout = ''
    let settled = false
    const finish = (value: ShellEnv | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }

    let child
    try {
      child = spawn(shellPath, ['-ilc', PROBE], {
        cwd,
        stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log('claude-env', `spawn failed (shell=${shellPath} cwd=${cwd}): ${msg}`)
      finish(null)
      return
    }

    const timer = setTimeout(() => {
      log('claude-env', `probe timed out after ${timeoutMs}ms (cwd=${cwd})`)
      try {
        child.kill('SIGKILL')
      } catch {
        // already dead
      }
      finish(null)
    }, timeoutMs)

    try {
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        log('claude-env', `spawn error (shell=${shellPath} cwd=${cwd}): ${err.message}`)
        finish(null)
      })
      child.on('close', () => {
        clearTimeout(timer)
        const captured = parseEnvProbeOutput(stdout)
        if (captured == null) {
          log('claude-env', `probe output missing sentinels (cwd=${cwd})`)
        }
        finish(captured)
      })
    } catch (err) {
      clearTimeout(timer)
      const msg = err instanceof Error ? err.message : String(err)
      log('claude-env', `probe wiring failed (cwd=${cwd}): ${msg}`)
      finish(null)
    }
  })
}

function refresh(cwd: string): Promise<ShellEnv | null> {
  const pending = inflight.get(cwd)
  if (pending) return pending
  const probe = captureShellEnv(resolveUserShell(), cwd)
    .then((env) => {
      // A failed probe must not erase a good earlier capture — a transient
      // timeout would otherwise flip the worktree back to the default home.
      const kept = env ?? cache.get(cwd)?.env ?? null
      cache.set(cwd, { env: kept, capturedAt: Date.now() })
      if (env?.CLAUDE_CONFIG_DIR) {
        log('claude-env', `cwd=${cwd} CLAUDE_CONFIG_DIR=${env.CLAUDE_CONFIG_DIR}`)
      }
      return kept
    })
    .finally(() => {
      inflight.delete(cwd)
    })
  inflight.set(cwd, probe)
  return probe
}

/** The login-shell environment for `cwd`, re-probed when the cached copy
 *  is older than FRESH_MS so env changes made while Ness runs are picked
 *  up by the next spawn. Null when the probe failed and nothing better is
 *  cached. */
export function resolveShellEnv(cwd: string): Promise<ShellEnv | null> {
  const hit = cache.get(cwd)
  if (hit && Date.now() - hit.capturedAt < FRESH_MS) return Promise.resolve(hit.env)
  return refresh(cwd)
}

/** Probe `cwd` only if nothing is cached for it yet. */
export function warmShellEnv(cwd: string): Promise<ShellEnv | null> {
  const hit = cache.get(cwd)
  if (hit) return Promise.resolve(hit.env)
  return refresh(cwd)
}

/** Last capture for `cwd` or its nearest cached ancestor (tabs can run in
 *  a subdirectory of their worktree). Pure cache read — never probes. */
export function cachedShellEnv(cwd: string): ShellEnv | null {
  const exact = cache.get(cwd)
  if (exact) return exact.env
  let best: { path: string; env: ShellEnv | null } | null = null
  for (const [path, entry] of cache) {
    if (!cwd.startsWith(path.endsWith('/') ? path : `${path}/`)) continue
    if (!best || path.length > best.path.length) best = { path, env: entry.env }
  }
  return best?.env ?? null
}

/** Settings-level override (the user's `claudeEnvVars` map) beats anything
 *  the shell reports, matching the precedence both spawn paths apply. */
export function setExplicitClaudeConfigDirSource(source: () => string | undefined): void {
  explicitConfigDir = source
}

export function defaultClaudeConfigDir(): string {
  return join(homedir(), '.claude')
}

/** Claude's home for sessions started in `cwd`. Falls back to Ness's own
 *  env, then ~/.claude, when nothing has been captured for the path. */
export function claudeConfigDirFor(cwd: string): string {
  const explicit = explicitConfigDir()
  if (explicit) return explicit
  const env = cachedShellEnv(cwd) ?? process.env
  return env.CLAUDE_CONFIG_DIR || defaultClaudeConfigDir()
}

export function claudeProjectsDirFor(cwd: string): string {
  return join(claudeConfigDirFor(cwd), 'projects')
}

/** Every Claude home Ness has seen a worktree resolve to, plus the
 *  defaults. Used where there is no single cwd to key off (cost roll-ups,
 *  hook install). */
export function knownClaudeConfigDirs(): string[] {
  const dirs = new Set<string>([defaultClaudeConfigDir()])
  if (process.env.CLAUDE_CONFIG_DIR) dirs.add(process.env.CLAUDE_CONFIG_DIR)
  const explicit = explicitConfigDir()
  if (explicit) dirs.add(explicit)
  for (const entry of cache.values()) {
    if (entry.env?.CLAUDE_CONFIG_DIR) dirs.add(entry.env.CLAUDE_CONFIG_DIR)
  }
  return [...dirs]
}

export function resetClaudeEnvCacheForTests(): void {
  cache.clear()
  inflight.clear()
  explicitConfigDir = () => undefined
}
