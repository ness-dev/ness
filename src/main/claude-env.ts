// The environment a Claude session sees depends on where it starts:
// folder-scoped tooling such as mise sets variables like CLAUDE_CONFIG_DIR
// per directory tree, and only a login shell started in that directory
// produces them. Terminal tabs get this for free because they run through
// `zsh -ilc`. The bundled json-mode binary is spawned directly, and
// everything that reads Claude's home on Ness's behalf (session lookups
// for --resume, transcripts, hook install) runs in main with Ness's own
// env — so all of those need the shell's answer for the worktree in
// question, which is what this module captures and caches.
//
// The probe sees exactly what a terminal tab's `zsh -ilc` sees, on
// purpose: tooling that exports at shell startup (`mise activate`) shows
// up, tooling that only exports from a prompt or chpwd hook (direnv)
// does not, in either place. Running `direnv export` here would point
// Ness at a home the terminal tab's claude never uses.
//
// A probe costs one full login-shell startup (~1s with a heavy rc file),
// so it never runs on the hot path: spawn paths await `resolveShellEnv`,
// which only blocks when nothing good is cached and otherwise serves the
// cache while a stale entry refreshes in the background, and sync
// readers consult the cache without side effects. Probes also never run
// all at once: the boot warm-up covers every worktree, and fifty login
// shells starting together starve each other past any timeout, which
// would cache a failure for the very spawn that needed the answer.

import { spawn } from 'child_process'
import { realpathSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { resolveUserShell } from './user-shell'
import { log } from './debug'

const BEGIN = '__HARNESS_ENV_BEGIN__'
const END = '__HARNESS_ENV_END__'
const PROBE = `printf '${BEGIN}'; /usr/bin/env -0; printf '${END}'`
const DEFAULT_TIMEOUT_MS = 10_000
const FRESH_MS = 60_000
const MAX_CONCURRENT_PROBES = 2

export type ShellEnv = Record<string, string>

interface CacheEntry {
  env: ShellEnv | null
  capturedAt: number
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<ShellEnv | null>>()
const queue: Array<{ cwd: string; start: () => void }> = []
let running = 0
let explicitConfigDir: () => string | undefined = () => undefined
const captureListeners = new Set<() => void>()

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

function pump(): void {
  while (running < MAX_CONCURRENT_PROBES && queue.length > 0) {
    running++
    queue.shift()!.start()
  }
}

/** Queue a probe for `cwd`. `urgent` puts it ahead of queued warm-ups —
 *  a spawn waiting on its answer should not sit behind the boot sweep. */
function refresh(cwd: string, urgent: boolean): Promise<ShellEnv | null> {
  const pending = inflight.get(cwd)
  if (pending) {
    if (urgent) {
      const idx = queue.findIndex((q) => q.cwd === cwd)
      if (idx > 0) queue.unshift(...queue.splice(idx, 1))
    }
    return pending
  }
  const probe = new Promise<ShellEnv | null>((resolve) => {
    const start = (): void => {
      captureShellEnv(resolveUserShell(), cwd)
        .then(resolve)
        .finally(() => {
          running--
          pump()
        })
    }
    if (urgent) queue.unshift({ cwd, start })
    else queue.push({ cwd, start })
    pump()
  })
    .then((env) => {
      // A relative value means relative to the directory the shell ran in,
      // not to Ness's cwd — anchor it before anything else reads it.
      if (env?.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = resolve(cwd, env.CLAUDE_CONFIG_DIR)
      // A failed probe must not erase a good earlier capture — a transient
      // timeout would otherwise flip the worktree back to the default home.
      const kept = env ?? cache.get(cwd)?.env ?? null
      cache.set(cwd, { env: kept, capturedAt: Date.now() })
      if (env?.CLAUDE_CONFIG_DIR) {
        log('claude-env', `cwd=${cwd} CLAUDE_CONFIG_DIR=${env.CLAUDE_CONFIG_DIR}`)
      }
      if (env) for (const listener of captureListeners) listener()
      return kept
    })
    .finally(() => {
      inflight.delete(cwd)
    })
  inflight.set(cwd, probe)
  return probe
}

/** The login-shell environment for `cwd`. A good capture is served at
 *  once; when it is older than FRESH_MS a background re-probe picks up env
 *  changes made while Ness runs, for the spawn after this one. Only a path
 *  with nothing good cached waits on a probe. A cached failure is never an
 *  answer: it is retried on every call. Null when the probe failed and
 *  nothing better is cached. */
export function resolveShellEnv(cwd: string): Promise<ShellEnv | null> {
  const hit = cache.get(cwd)
  if (hit?.env) {
    if (Date.now() - hit.capturedAt >= FRESH_MS) void refresh(cwd, false)
    return Promise.resolve(hit.env)
  }
  return refresh(cwd, true)
}

/** Probe `cwd` only if it has never been probed. Background use only;
 *  a spawn that needs the answer goes through `resolveShellEnv`. */
export function warmShellEnv(cwd: string): Promise<ShellEnv | null> {
  const hit = cache.get(cwd)
  if (hit) return Promise.resolve(hit.env)
  return refresh(cwd, false)
}

/** Last capture for `cwd` or its nearest cached ancestor (tabs can run in
 *  a subdirectory of their worktree). Pure cache read — never probes. Its
 *  CLAUDE_CONFIG_DIR is already absolute, resolved against the probe's cwd. */
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

/** Called after every successful probe, so a Claude home first seen by a
 *  spawn or a background refresh still gets hooked. */
export function onShellEnvCaptured(listener: () => void): () => void {
  captureListeners.add(listener)
  return () => captureListeners.delete(listener)
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
  if (explicit) return resolve(explicit)
  const env = cachedShellEnv(cwd) ?? process.env
  return env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : defaultClaudeConfigDir()
}

export function claudeProjectsDirFor(cwd: string): string {
  return join(claudeConfigDirFor(cwd), 'projects')
}

/** Every Claude home Ness has seen a worktree resolve to, plus the
 *  defaults. Used where there is no single cwd to key off (cost roll-ups,
 *  hook install), so one home spelled two ways — trailing slash, symlink —
 *  must come out once or its sessions get counted twice. */
export function knownClaudeConfigDirs(): string[] {
  const byRealPath = new Map<string, string>()
  const add = (dir: string | undefined): void => {
    if (!dir) return
    const abs = resolve(dir)
    let key = abs
    try {
      key = realpathSync(abs)
    } catch {
      // Not created yet — the resolved spelling is the best identity we have.
    }
    if (!byRealPath.has(key)) byRealPath.set(key, abs)
  }
  add(defaultClaudeConfigDir())
  add(process.env.CLAUDE_CONFIG_DIR)
  add(explicitConfigDir())
  for (const entry of cache.values()) add(entry.env?.CLAUDE_CONFIG_DIR)
  return [...byRealPath.values()]
}

export function resetClaudeEnvCacheForTests(): void {
  cache.clear()
  inflight.clear()
  queue.length = 0
  running = 0
  explicitConfigDir = () => undefined
  captureListeners.clear()
}
