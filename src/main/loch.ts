// Runs the `loch` CLI for the file viewer's blame gutter and its "ask the
// conversation that wrote this" action. loch's contract: every command takes
// `--json` and prints exactly one document on stdout, success or failure, so
// we parse stdout unconditionally and branch on `ok` / `code`, never on the
// exit status or the prose.

import { execFile } from 'child_process'
import {
  accessSync,
  constants as fsConstants,
  createReadStream,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync
} from 'fs'
import { delimiter, isAbsolute, join, relative, resolve } from 'path'
import { createInterface } from 'readline'
import { cachedShellEnv, claudeConfigDirFor, knownClaudeConfigDirs } from './claude-env'
import { log } from './debug'
import {
  extractFirstPrompt,
  parseBlameDocument,
  isLochHookCommand,
  stripLochHooks,
  type LochBlameResult,
  type LochConversation,
  type LochSessionInfo
} from '../shared/loch'

const BLAME_TIMEOUT_MS = 15_000
const ASK_TIMEOUT_MS = 60_000
/** A file can be unchanged on disk while its blame still moves: the turn that
 *  edited it is only recorded when the turn ends. So an mtime hit is trusted
 *  for a short while, not forever. */
const BLAME_CACHE_TTL_MS = 20_000

type RunOutcome =
  | { ok: true; doc: Record<string, unknown> }
  | { ok: false; code: string; error?: string }

/** loch reads CLAUDE_CONFIG_DIR to find (and, for `ask`, write) transcripts.
 *  Pin it to the home Ness resolves for this worktree, so a fork lands where
 *  the Chat tab's `--resume` will look. */
function lochEnv(cwd: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(cachedShellEnv(cwd) ?? {}),
    CLAUDE_CONFIG_DIR: claudeConfigDirFor(cwd)
  }
}

/** Absolute path of the loch binary, resolved once from PATH (which boot
 *  merges with the login shell's). Absolute because it's also what the hook
 *  lines name — hooks run under whatever PATH Claude has, which may not
 *  include ~/.local/bin. A future bundled copy would slot in here. */
let cachedBinary: string | null | undefined
export function lochBinary(): string | null {
  if (cachedBinary !== undefined) return cachedBinary
  cachedBinary = null
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, 'loch')
    try {
      accessSync(candidate, fsConstants.X_OK)
      cachedBinary = realpathSync(candidate)
      break
    } catch {
      // not here
    }
  }
  return cachedBinary
}

function runLoch(args: string[], cwd: string, timeout: number): Promise<RunOutcome> {
  const bin = lochBinary()
  if (!bin) return Promise.resolve({ ok: false, code: 'not-installed' })
  return new Promise((done) => {
    execFile(
      bin,
      [...args, '--json'],
      { cwd, env: lochEnv(cwd), timeout, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null
        if (e?.code === 'ENOENT') return done({ ok: false, code: 'not-installed' })
        if (e?.killed) return done({ ok: false, code: 'timeout' })
        let doc: unknown
        try {
          doc = JSON.parse(stdout)
        } catch {
          log('loch', `unparseable output for ${args[0]} cwd=${cwd}`, e?.message ?? '')
          return done({ ok: false, code: 'bad-output', error: e?.message })
        }
        if (!doc || typeof doc !== 'object') return done({ ok: false, code: 'bad-output' })
        const d = doc as Record<string, unknown>
        if (d.ok !== true) {
          return done({
            ok: false,
            code: typeof d.code === 'string' ? d.code : 'bad-output',
            error: typeof d.error === 'string' ? d.error : undefined
          })
        }
        done({ ok: true, doc: d })
      }
    )
  })
}

/** Resolve a viewer path to one relative to its worktree, refusing escapes. */
export function worktreeRelativePath(worktreePath: string, filePath: string): string | null {
  const base = resolve(worktreePath)
  const target = isAbsolute(filePath) ? resolve(filePath) : resolve(base, filePath)
  const rel = relative(base, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel
}

interface CacheEntry {
  mtimeMs: number
  size: number
  at: number
  result: LochBlameResult
}
const blameCache = new Map<string, CacheEntry>()
const blameInflight = new Map<string, Promise<LochBlameResult>>()

export async function lochBlame(worktreePath: string, filePath: string): Promise<LochBlameResult> {
  const rel = worktreeRelativePath(worktreePath, filePath)
  if (!rel) return { ok: false, code: 'file-unreadable', error: 'path escapes worktree' }
  const abs = resolve(worktreePath, rel)
  let st: { mtimeMs: number; size: number }
  try {
    st = statSync(abs)
  } catch {
    return { ok: false, code: 'file-unreadable' }
  }
  const key = abs
  const hit = blameCache.get(key)
  if (
    hit &&
    hit.mtimeMs === st.mtimeMs &&
    hit.size === st.size &&
    Date.now() - hit.at < BLAME_CACHE_TTL_MS
  ) {
    return hit.result
  }
  const inflight = blameInflight.get(key)
  if (inflight) return inflight

  const p = (async (): Promise<LochBlameResult> => {
    const started = Date.now()
    const out = await runLoch(['blame', rel], worktreePath, BLAME_TIMEOUT_MS)
    let result: LochBlameResult = out.ok ? parseBlameDocument(out.doc) : out
    if (result.ok) {
      const ids = [...new Set(result.hunks.flatMap((h) => (h.conversation ? [h.conversation.session] : [])))]
      const infos = await Promise.all(ids.map((id) => sessionInfo(id, worktreePath)))
      const sessions: Record<string, LochSessionInfo> = {}
      ids.forEach((id, i) => {
        sessions[id] = infos[i]
      })
      result = { ...result, sessions }
    }
    log(
      'loch',
      `blame ${rel} ok=${result.ok}${result.ok ? ` hunks=${result.hunks.length}` : ` code=${result.code}`} ms=${Date.now() - started}`
    )
    blameCache.set(key, { mtimeMs: st.mtimeMs, size: st.size, at: Date.now(), result })
    return result
  })()
  blameInflight.set(key, p)
  try {
    return await p
  } finally {
    blameInflight.delete(key)
  }
}

// -- per-session info from the transcript ------------------------------------

/** A session's first prompt never changes, so a hit is kept for the life of
 *  the process. A miss (transcript not found) is not cached: it may be a
 *  session whose transcript lives only in loch's store until restored. */
const sessionInfoCache = new Map<string, LochSessionInfo>()
/** Stop reading after this much — the first prompt is near the top, and a
 *  session that never had one shouldn't cost a full multi-MB parse. */
const FIRST_PROMPT_SCAN_LINES = 400

/** loch blame names sessions, not files. Claude files a session under the
 *  encoded cwd it ended in, which we don't know, so look in every project
 *  dir of every Claude home Ness has seen. One stat per dir — a few hundred
 *  on a busy machine — and only for sessions not already cached. */
function findTranscript(sessionId: string, worktreePath: string): string | null {
  const homes = new Set([claudeConfigDirFor(worktreePath), ...knownClaudeConfigDirs()])
  for (const home of homes) {
    const projects = join(home, 'projects')
    let dirs: string[]
    try {
      dirs = readdirSync(projects)
    } catch {
      continue
    }
    for (const d of dirs) {
      const p = join(projects, d, `${sessionId}.jsonl`)
      if (existsSync(p)) return p
    }
  }
  return null
}

async function readFirstPrompt(path: string): Promise<string | null> {
  const stream = createReadStream(path, { encoding: 'utf8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  let seen = 0
  try {
    for await (const line of rl) {
      const found = extractFirstPrompt([line])
      if (found) return found
      if (++seen >= FIRST_PROMPT_SCAN_LINES) break
    }
    return null
  } finally {
    rl.close()
    stream.destroy()
  }
}

async function sessionInfo(sessionId: string, worktreePath: string): Promise<LochSessionInfo> {
  const hit = sessionInfoCache.get(sessionId)
  if (hit) return hit
  const path = findTranscript(sessionId, worktreePath)
  if (!path) return { firstPrompt: null }
  let firstPrompt: string | null = null
  try {
    firstPrompt = await readFirstPrompt(path)
  } catch (err) {
    log('loch', `first prompt read failed ${path}`, err instanceof Error ? err.message : err)
  }
  const info = { firstPrompt }
  sessionInfoCache.set(sessionId, info)
  return info
}

export interface LochFork {
  sessionId: string
  /** Absolute path of the transcript loch wrote. */
  path: string
  /** The directory the original session ran in — not necessarily this worktree. */
  cwd: string
  conversation: LochConversation
}

/** `loch ask <file>:<line> --no-launch`. Writes a real fork transcript into
 *  Claude's projects dir (under the ORIGINAL session's cwd), so only call it
 *  when the user has asked for a chat. */
export async function lochAsk(
  worktreePath: string,
  relPath: string,
  line: number,
  opts: { atTurn: boolean }
): Promise<{ ok: true; fork: LochFork } | { ok: false; code: string; error?: string }> {
  const args = ['ask', `${relPath}:${line}`, '--no-launch']
  if (opts.atTurn) args.push('--at-turn')
  const out = await runLoch(args, worktreePath, ASK_TIMEOUT_MS)
  if (!out.ok) {
    log('loch', `ask ${relPath}:${line} failed code=${out.code}`, out.error ?? '')
    return out
  }
  const fork = out.doc.fork as Record<string, unknown> | undefined
  const conversation = out.doc.conversation as LochConversation | undefined
  if (
    !fork ||
    typeof fork.sessionId !== 'string' ||
    typeof fork.path !== 'string' ||
    typeof fork.cwd !== 'string' ||
    !conversation
  ) {
    return { ok: false, code: 'bad-output' }
  }
  log('loch', `ask ${relPath}:${line} forked session=${fork.sessionId} cwd=${fork.cwd}`)
  return {
    ok: true,
    fork: { sessionId: fork.sessionId, path: fork.path, cwd: fork.cwd, conversation }
  }
}

// -- recording: hooks + backfill ------------------------------------------------

function settingsLocalPath(worktreePath: string): string {
  return join(worktreePath, '.claude', 'settings.local.json')
}

/** Take Ness-or-loch-written loch hook lines out of a worktree's
 *  settings.local.json. Leaves the file alone when there are none, and
 *  writes atomically when there are — Claude itself writes this file too. */
export function removeLochHooks(worktreePath: string): boolean {
  const path = settingsLocalPath(worktreePath)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return false
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    log('loch', `not touching unparseable ${path}`)
    return false
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const next = stripLochHooks(parsed as Record<string, unknown>)
  if (next === parsed) return false
  const tmp = `${path}.ness-${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
  return true
}

/** Whether the repo's committed `.claude/settings.json` already runs loch's
 *  hooks (loch's own repo does). Adding local ones too would fire every hook
 *  twice per turn. */
export function projectHasLochHooks(worktreePath: string): boolean {
  let parsed: { hooks?: Record<string, unknown> }
  try {
    parsed = JSON.parse(readFileSync(join(worktreePath, '.claude', 'settings.json'), 'utf8'))
  } catch {
    return false
  }
  for (const groups of Object.values(parsed.hooks ?? {})) {
    if (!Array.isArray(groups)) continue
    for (const g of groups) {
      const entries = (g as { hooks?: unknown })?.hooks
      if (Array.isArray(entries) && entries.some((e) => isLochHookCommand((e as { command?: unknown })?.command))) {
        return true
      }
    }
  }
  return false
}

/** Install loch's hooks into one worktree, naming the binary by absolute
 *  path. Strips any earlier loch lines first: `loch install` dedups by exact
 *  line, so a binary that moved would otherwise leave both behind. */
export async function installLochHooks(
  worktreePath: string
): Promise<{ ok: true; viaProject?: boolean } | { ok: false; code: string; error?: string }> {
  const bin = lochBinary()
  if (!bin) return { ok: false, code: 'not-installed' }
  if (projectHasLochHooks(worktreePath)) {
    // Still clear any local copies an earlier Ness wrote, for the same reason.
    try {
      removeLochHooks(worktreePath)
    } catch {
      // best effort
    }
    return { ok: true, viaProject: true }
  }
  try {
    removeLochHooks(worktreePath)
  } catch (err) {
    return { ok: false, code: 'settings-unwritable', error: err instanceof Error ? err.message : String(err) }
  }
  const out = await runLoch(['install', '--local', '--cwd', worktreePath, '--command', bin], worktreePath, BLAME_TIMEOUT_MS)
  if (!out.ok) {
    log('loch', `install failed in ${worktreePath} code=${out.code}`, out.error ?? '')
    return out
  }
  log('loch', `hooks installed in ${worktreePath}`)
  return { ok: true }
}

const BACKFILL_TIMEOUT_MS = 10 * 60_000
const backfillInflight = new Map<string, Promise<void>>()

/** One background backfill per repo (loch keys projects by root commit, so
 *  any worktree stands for the whole repo). Blame results cached before it
 *  finished are dropped so the next look picks up the reconstructed turns. */
export function backfillRepo(repoRoot: string): Promise<void> {
  const existing = backfillInflight.get(repoRoot)
  if (existing) return existing
  const p = (async () => {
    const started = Date.now()
    const out = await runLoch(['backfill', '--cwd', repoRoot], repoRoot, BACKFILL_TIMEOUT_MS)
    log(
      'loch',
      `backfill ${repoRoot} ok=${out.ok}${out.ok ? ` turns=${String(out.doc.turns)}` : ` code=${out.code}`} ms=${Date.now() - started}`
    )
    blameCache.clear()
  })().finally(() => backfillInflight.delete(repoRoot))
  backfillInflight.set(repoRoot, p)
  return p
}
