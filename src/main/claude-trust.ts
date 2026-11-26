// Pre-accepts Claude Code's "Do you trust the files in this folder?"
// prompt for worktrees Ness creates.
//
// Claude records trust per exact project path in its global config
// (`projects[<realpath>].hasTrustDialogAccepted`), and a git worktree is
// its own project root, so trusting the main repo doesn't cover it: every
// new worktree opened a terminal tab on the trust prompt. The user already
// chose the repo when they added it to Ness, and chat tabs never show this
// prompt at all, so asking again per worktree is only friction.
//
// The global config is shared with every running `claude`, which rewrites
// it constantly. Writes take the same `<file>.lock` directory Claude's
// proper-lockfile uses, re-read under the lock, and swap in a temp file, so
// neither side clobbers the other. Any failure leaves the file untouched:
// the worst case is the old behaviour, a trust prompt.

import { promises as fs } from 'fs'
import { realpathSync } from 'fs'
import { dirname, join } from 'path'
import { log } from './debug'

/** Matches proper-lockfile's default: a lock untouched this long is stale. */
const LOCK_STALE_MS = 10_000
const LOCK_WAIT_MS = 3_000
const LOCK_RETRY_MS = 50

async function acquireLock(lockPath: string, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      await fs.mkdir(lockPath)
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false
    }
    try {
      const st = await fs.stat(lockPath)
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        // Re-check right before removing, as proper-lockfile does: if
        // another contender broke the same stale lock and took a fresh one
        // in between, its mtime has moved and we must not delete it. A
        // sub-millisecond window between this stat and the rmdir remains;
        // a lock stale for 10 s is already rare, so that's accepted.
        const again = await fs.stat(lockPath)
        if (again.mtimeMs === st.mtimeMs) await fs.rmdir(lockPath).catch(() => {})
        continue
      }
    } catch {
      continue // released between mkdir and stat
    }
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, LOCK_RETRY_MS))
  }
}

/** Mark `projectPath` trusted in the Claude global config at `configPath`.
 *  Returns true when the path is trusted afterwards (already or newly).
 *  Never creates the config: if Claude has never run, there's nothing to
 *  pre-answer and a stub file could confuse its first-run setup. */
export async function trustClaudeProject(
  configPath: string,
  projectPath: string,
  opts: { lockWaitMs?: number } = {}
): Promise<boolean> {
  let key: string
  try {
    key = realpathSync(projectPath)
  } catch {
    return false
  }
  const lockPath = `${configPath}.lock`
  if (!(await acquireLock(lockPath, opts.lockWaitMs ?? LOCK_WAIT_MS))) {
    log('claude-trust', `could not lock ${configPath}; leaving ${key} untrusted`)
    return false
  }
  let tmp: string | null = null
  try {
    // Write through a symlinked config (stow, chezmoi, a synced folder)
    // to its real target: renaming onto the link itself would replace it
    // with a regular file and silently detach it. The lock stays at the
    // unresolved path, since that's the one Claude locks.
    let target: string
    let raw: string
    let mode: number
    try {
      target = await fs.realpath(configPath)
      raw = await fs.readFile(target, 'utf-8')
      mode = (await fs.stat(target)).mode & 0o777
    } catch {
      return false
    }
    let config: { projects?: Record<string, Record<string, unknown>> }
    try {
      config = JSON.parse(raw)
    } catch {
      log('claude-trust', `unparseable ${configPath}; not touching it`)
      return false
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) return false
    const projects = config.projects && typeof config.projects === 'object' ? config.projects : {}
    if (projects[key]?.hasTrustDialogAccepted === true) return true
    config.projects = { ...projects, [key]: { ...(projects[key] ?? {}), hasTrustDialogAccepted: true } }
    tmp = join(dirname(target), `.claude.json.ness-${process.pid}-${Date.now()}`)
    await fs.writeFile(tmp, JSON.stringify(config, null, 2), { mode })
    await fs.rename(tmp, target)
    tmp = null
    log('claude-trust', `trusted ${key} in ${target}`)
    return true
  } catch (err) {
    log('claude-trust', `failed to trust ${key}`, err instanceof Error ? err.message : String(err))
    return false
  } finally {
    if (tmp) await fs.unlink(tmp).catch(() => {})
    await fs.rmdir(lockPath).catch(() => {})
  }
}
