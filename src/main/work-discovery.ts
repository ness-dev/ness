// Finds the work a new user already has on this machine — repos, their
// worktrees, and the agent conversations in each — so onboarding can offer
// to open all of it instead of starting from one empty repo.
//
// Everything here is read-only. The sources are the transcripts and the
// live-session registry that Claude Code and Codex already keep; nothing
// tool-specific (tmux, VS Code, herdr) is consulted, because whichever
// tool launched the agent, the agent leaves the same files behind.

import { execFile } from 'child_process'
import { open, readdir, readFile, stat } from 'fs/promises'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import { claudeProjectDirName } from './claude-env'
import { listWorktrees } from './worktree'
import { log } from './debug'
import {
  isTempPath,
  type DiscoveredAgentKind,
  type DiscoveredRepo,
  type DiscoveredSession,
  type DiscoveredWork,
  type DiscoveredWorktree,
  type ExternalLiveStatus
} from '../shared/work-discovery'

export interface ScanOptions {
  claudeConfigDirs: string[]
  codexHome?: string
  addedRepoRoots: string[]
  /** Sessions Ness itself is running. They show up in Claude's live-session
   *  registry like any other, and must not be reported as "elsewhere". */
  ownSessionIds: Set<string>
  mayPreselectAgent?: boolean
  now?: number
}

interface FoundSession {
  agentKind: DiscoveredAgentKind
  sessionId: string
  cwd: string
  mtime: number
  /** Null for Codex, whose prompt we don't dig out. */
  transcriptPath: string | null
  size: number
}

interface LiveEntry {
  pid: number
  status: ExternalLiveStatus
}

const HEAD_BYTES = 64 * 1024
const TAIL_BYTES = 64 * 1024
const GIT_CONCURRENCY = 16
const FILE_CONCURRENCY = 16
const PROMPT_MAX_CHARS = 160

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

async function readSlice(path: string, start: number, length: number): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buf, 0, length, start)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

/** First JSON string value for `key` in a chunk of jsonl. A regex rather
 *  than a per-line parse because the chunk is cut at a byte offset, so its
 *  last line (often a huge first user message) is usually truncated. Keys
 *  quoted inside message text are backslash-escaped and can't match. */
function firstJsonString(chunk: string, key: string): string | null {
  const match = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`).exec(chunk)
  if (!match) return null
  try {
    return JSON.parse(`"${match[1]}"`) as string
  } catch {
    return null
  }
}

function tidyPrompt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > PROMPT_MAX_CHARS ? `${flat.slice(0, PROMPT_MAX_CHARS - 1)}…` : flat
}

/** Claude Code appends a `last-prompt` record as a session goes on; the
 *  final one is the most recent thing the user typed. */
async function readLastPrompt(path: string, size: number): Promise<string | undefined> {
  try {
    const start = Math.max(0, size - TAIL_BYTES)
    const tail = await readSlice(path, start, Math.min(size, TAIL_BYTES))
    const lines = tail.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"type":"last-prompt"')) continue
      try {
        const prompt = (JSON.parse(lines[i]) as { lastPrompt?: unknown }).lastPrompt
        if (typeof prompt === 'string' && prompt.trim()) return tidyPrompt(prompt)
      } catch {
        // Cut mid-line by the tail offset — an earlier record may still parse.
      }
    }
  } catch {
    // Unreadable transcript: the row just shows no prompt.
  }
  return undefined
}

/** Whether a transcript holds a conversation at all. Ness's slash-command
 *  probe, and other SDK callers that start a session only to read its init
 *  event, leave transcripts with a queued prompt and an interrupt but no
 *  reply. There can be hundreds, and one is often the newest file in a
 *  worktree, so without this check it is what would get opened.
 *
 *  A transcript too big to read cheaply is assumed real: junk sessions
 *  are small. */
async function hasAssistantTurn(path: string, size: number): Promise<boolean> {
  if (size > HEAD_BYTES + TAIL_BYTES) return true
  try {
    return (await readSlice(path, 0, size)).includes('"type":"assistant"')
  } catch {
    return false
  }
}

async function collectClaudeSessions(projectsDir: string): Promise<FoundSession[]> {
  let dirNames: string[]
  try {
    dirNames = await readdir(projectsDir)
  } catch {
    return []
  }
  const perDir = await mapLimit(dirNames, FILE_CONCURRENCY, async (dirName) => {
    const dirPath = join(projectsDir, dirName)
    let names: string[]
    try {
      names = (await readdir(dirPath)).filter((n) => n.endsWith('.jsonl'))
    } catch {
      return []
    }
    const files: { name: string; path: string; mtime: number; size: number }[] = []
    for (const name of names) {
      try {
        const st = await stat(join(dirPath, name))
        if (st.isFile() && st.size > 0) {
          files.push({ name, path: join(dirPath, name), mtime: st.mtimeMs, size: st.size })
        }
      } catch {
        // Deleted between readdir and stat.
      }
    }
    if (files.length === 0) return []
    files.sort((a, b) => b.mtime - a.mtime)
    // Every transcript in a project dir shares one cwd, so one read settles
    // it. Try a second file in case the newest hasn't written a turn yet.
    let cwd: string | null = null
    for (const file of files.slice(0, 2)) {
      try {
        cwd = firstJsonString(await readSlice(file.path, 0, HEAD_BYTES), 'cwd')
      } catch {
        cwd = null
      }
      if (cwd) break
    }
    // A session started in a subdirectory, or under a symlinked spelling,
    // is filed under a dir that `--resume` from the worktree root won't
    // look in. Drop those rather than offer a conversation we can't open.
    if (!cwd || claudeProjectDirName(cwd) !== dirName) return []
    const sessionCwd = cwd
    return files.map(
      (file): FoundSession => ({
        agentKind: 'claude',
        sessionId: file.name.slice(0, -'.jsonl'.length),
        cwd: sessionCwd,
        mtime: file.mtime,
        transcriptPath: file.path,
        size: file.size
      })
    )
  })
  return perDir.flat()
}

async function collectCodexSessions(codexHome: string): Promise<FoundSession[]> {
  const paths: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      // sessions/YYYY/MM/DD/rollout-*.jsonl — the depth cap is only a guard
      // against a symlink loop.
      if (entry.isDirectory() && depth < 4) await walk(full, depth + 1)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) paths.push(full)
    }
  }
  await walk(join(codexHome, 'sessions'), 0)
  const found = await mapLimit(paths, FILE_CONCURRENCY, async (path): Promise<FoundSession | null> => {
    try {
      const st = await stat(path)
      const head = await readSlice(path, 0, 16 * 1024)
      // `codex exec` runs are scripted one-shots, not conversations anyone
      // would want back.
      if (firstJsonString(head, 'source') === 'exec') return null
      const cwd = firstJsonString(head, 'cwd')
      const sessionId = firstJsonString(head, 'session_id') ?? firstJsonString(head, 'id')
      if (!cwd || !sessionId) return null
      return { agentKind: 'codex', sessionId, cwd, mtime: st.mtimeMs, transcriptPath: null, size: st.size }
    } catch {
      return null
    }
  })
  return found.filter((s): s is FoundSession => s !== null)
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function toLiveStatus(raw: unknown): ExternalLiveStatus {
  return raw === 'busy' || raw === 'waiting' ? raw : 'idle'
}

/** Sessions with a process attached right now, keyed by session id. Claude
 *  Code keeps one `<pid>.json` per running instance; a stale file whose pid
 *  has exited is ignored. The format is undocumented, so every field is
 *  treated as optional. */
export async function readLiveClaudeSessions(
  claudeConfigDirs: string[],
  ownSessionIds: Set<string>
): Promise<Map<string, LiveEntry>> {
  const live = new Map<string, LiveEntry>()
  for (const configDir of claudeConfigDirs) {
    const dir = join(configDir, 'sessions')
    let names: string[]
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith('.json'))
    } catch {
      continue
    }
    for (const name of names) {
      try {
        const record = JSON.parse(await readFile(join(dir, name), 'utf8')) as {
          pid?: unknown
          sessionId?: unknown
          status?: unknown
        }
        if (typeof record.pid !== 'number' || typeof record.sessionId !== 'string') continue
        if (ownSessionIds.has(record.sessionId)) continue
        if (!isPidAlive(record.pid)) continue
        live.set(record.sessionId, { pid: record.pid, status: toLiveStatus(record.status) })
      } catch {
        // Half-written or foreign file.
      }
    }
  }
  return live
}

function gitLocate(cwd: string): Promise<{ commonDir: string; toplevel: string } | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve(null)
        const [commonDir, toplevel] = stdout.split('\n')
        resolve(commonDir && toplevel ? { commonDir, toplevel } : null)
      }
    )
  })
}

export async function scanExistingWork(opts: ScanOptions): Promise<DiscoveredWork> {
  const now = opts.now ?? Date.now()
  const startedAt = Date.now()
  const codexHome = opts.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')

  const [claudeLists, codexSessions, live] = await Promise.all([
    Promise.all(opts.claudeConfigDirs.map((dir) => collectClaudeSessions(join(dir, 'projects')))),
    collectCodexSessions(codexHome),
    readLiveClaudeSessions(opts.claudeConfigDirs, opts.ownSessionIds)
  ])
  const sessions = [...claudeLists.flat(), ...codexSessions]
  const collectedAt = Date.now()

  const byCwd = new Map<string, FoundSession[]>()
  for (const session of sessions) {
    const list = byCwd.get(session.cwd)
    if (list) list.push(session)
    else byCwd.set(session.cwd, [session])
  }

  // Stat before spawning git: most history points at worktrees deleted long
  // ago, and a failed `git -C <missing dir>` per path costs seconds in total.
  const present = (
    await mapLimit([...byCwd.keys()], FILE_CONCURRENCY, async (cwd) => {
      try {
        return (await stat(cwd)).isDirectory() ? cwd : null
      } catch {
        return null
      }
    })
  ).filter((cwd): cwd is string => cwd !== null)
  const located = await mapLimit(present, GIT_CONCURRENCY, async (cwd) => ({
    cwd,
    git: await gitLocate(cwd)
  }))

  const locatedAt = Date.now()

  const cwdsByRepo = new Map<string, Set<string>>()
  for (const { cwd, git } of located) {
    // Only sessions started at a worktree's root: that is the only cwd a
    // Ness tab resumes from. Bare repos and submodules (whose common dir
    // isn't `<root>/.git`) are out of scope.
    if (!git || git.toplevel !== cwd || basename(git.commonDir) !== '.git') continue
    const repoRoot = dirname(git.commonDir)
    const set = cwdsByRepo.get(repoRoot)
    if (set) set.add(cwd)
    else cwdsByRepo.set(repoRoot, new Set([cwd]))
  }

  const added = new Set(opts.addedRepoRoots)
  const agentCounts: Record<DiscoveredAgentKind, number> = { claude: 0, codex: 0 }
  const repos = await mapLimit(
    [...cwdsByRepo.keys()],
    GIT_CONCURRENCY,
    async (repoRoot): Promise<DiscoveredRepo | null> => {
      let listed
      try {
        listed = await listWorktrees(repoRoot)
      } catch {
        return null
      }
      const worktrees = await mapLimit(
        listed.filter((w) => !w.isBare && !w.prunable),
        FILE_CONCURRENCY,
        async (wt): Promise<DiscoveredWorktree> => {
          const candidates = byCwd.get(wt.path) ?? []
          const real = await mapLimit(candidates, FILE_CONCURRENCY, async (s) =>
            s.transcriptPath === null || (await hasAssistantTurn(s.transcriptPath, s.size))
          )
          const found = candidates.filter((_, i) => real[i]).sort((a, b) => b.mtime - a.mtime)
          for (const s of found) agentCounts[s.agentKind]++
          const pick = found.find((s) => live.has(s.sessionId)) ?? found[0]
          let session: DiscoveredSession | undefined
          if (pick) {
            session = {
              agentKind: pick.agentKind,
              sessionId: pick.sessionId,
              lastActiveAt: pick.mtime,
              lastPrompt: pick.transcriptPath
                ? await readLastPrompt(pick.transcriptPath, pick.size)
                : undefined,
              live: live.get(pick.sessionId)
            }
          }
          return {
            path: wt.path,
            branch: wt.branch,
            isMain: wt.isMain,
            session,
            sessionCount: found.length,
            lastActiveAt: found[0]?.mtime ?? null
          }
        }
      )
      worktrees.sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))
      const lastActiveAt = Math.max(0, ...worktrees.map((w) => w.lastActiveAt ?? 0))
      if (lastActiveAt === 0) return null
      return {
        repoRoot,
        name: basename(repoRoot),
        worktrees,
        sessionCount: worktrees.reduce((n, w) => n + w.sessionCount, 0),
        liveCount: worktrees.filter((w) => w.session?.live).length,
        lastActiveAt,
        isTemp: isTempPath(repoRoot),
        alreadyAdded: added.has(repoRoot)
      }
    }
  )

  const kept = repos
    .filter((r): r is DiscoveredRepo => r !== null)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)

  const { claude: claudeCount, codex: codexCount } = agentCounts
  const suggestedAgent: DiscoveredAgentKind | null =
    claudeCount + codexCount === 0 ? null : codexCount > claudeCount ? 'codex' : 'claude'

  log(
    'work-discovery',
    `scan found repos=${kept.length} sessions=${sessions.length} live=${live.size} in ${Date.now() - startedAt}ms ` +
      `(read=${collectedAt - startedAt}ms locate=${locatedAt - collectedAt}ms worktrees=${Date.now() - locatedAt}ms)`
  )
  return {
    repos: kept,
    suggestedAgent,
    mayPreselectAgent: opts.mayPreselectAgent ?? false,
    scannedAt: now
  }
}
