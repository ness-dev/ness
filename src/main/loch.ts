// Runs the `loch` CLI for the file viewer's blame gutter and its "ask the
// conversation that wrote this" action. loch's contract: every command takes
// `--json` and prints exactly one document on stdout, success or failure, so
// we parse stdout unconditionally and branch on `ok` / `code`, never on the
// exit status or the prose.

import { execFile } from 'child_process'
import { statSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'
import { cachedShellEnv, claudeConfigDirFor } from './claude-env'
import { log } from './debug'
import { parseBlameDocument, type LochBlameResult, type LochConversation } from '../shared/loch'

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

function runLoch(args: string[], cwd: string, timeout: number): Promise<RunOutcome> {
  return new Promise((done) => {
    execFile(
      'loch',
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
    const result: LochBlameResult = out.ok ? parseBlameDocument(out.doc) : out
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
