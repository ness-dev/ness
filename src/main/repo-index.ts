import { existsSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { projectsRoot } from './session-scanner'
import { resolveRepoRoot } from './session-tree'
import type { RepoIndexEntry, RepoIndexResult } from '../shared/repo-index-types'

export type { RepoIndexEntry, RepoIndexResult } from '../shared/repo-index-types'

/** Answers "which repos has this person been working in?" without parsing a
 *  single transcript.
 *
 *  The deep scanner reads a 32KB head and 64KB tail of every session file to
 *  recover titles, branches and PR numbers. On a real corpus that is 9.1k
 *  files and 952MB, which takes seconds — far too slow to render a repo
 *  picker, and almost all of it is wasted when the question is only "which
 *  projects exist". Everything this needs is much cheaper: `readdir` plus
 *  `stat` gives chat counts and recency, and a session's `cwd` sits on the
 *  first line of its transcript.
 *
 *  Every syscall here is async and pooled. Statting those 9.1k files
 *  synchronously measured 2.5s of solid main-thread block — the picker would
 *  have been fast while the rest of the app froze. Across libuv's threadpool
 *  the whole scan is ~200ms cold, ~100ms warm, and blocks nothing.
 *
 *  Most historical cwds are worktrees that have since been deleted — 93% of
 *  them on the corpus above. Collapsing `<repo>-worktrees/<branch>` back to
 *  `<repo>` is what turns a graveyard of 566 dead paths into the 10 repos the
 *  user still has on disk, so that derivation is load-bearing rather than a
 *  tidy-up. Repos whose root no longer exists are dropped: we cannot create a
 *  worktree in a directory that is gone.
 *
 *  See findRepoRoot for how the remaining plain-checkout cwds are resolved. */

/** Transcripts open with a record carrying `cwd`. A few files lead with
 *  summary or meta records instead, so scan a handful of lines before giving
 *  up on a directory. */
const CWD_PROBE_BYTES = 8 * 1024
const CWD_PROBE_LINES = 5
const CWD_PROBE_FILES = 3

/** Enough parallelism to keep libuv's default four-thread pool saturated
 *  through the latency of each syscall, without queueing thousands of
 *  descriptors behind it. */
const DIR_CONCURRENCY = 8

async function pool<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await run(items[next++])
  })
  await Promise.all(workers)
}

function basename(path: string): string {
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
  const idx = trimmed.lastIndexOf('/')
  return idx === -1 ? trimmed : trimmed.slice(idx + 1) || trimmed
}

async function readCwd(path: string): Promise<string | null> {
  let text: string
  try {
    const handle = await open(path, 'r')
    try {
      const buf = Buffer.allocUnsafe(CWD_PROBE_BYTES)
      const { bytesRead } = await handle.read(buf, 0, CWD_PROBE_BYTES, 0)
      text = buf.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }

  const lines = text.split('\n', CWD_PROBE_LINES)
  for (const line of lines) {
    if (!line.startsWith('{')) continue
    try {
      const parsed = JSON.parse(line) as { cwd?: unknown }
      if (typeof parsed.cwd === 'string' && parsed.cwd) return parsed.cwd
    } catch {
      // Truncated by the probe window, or simply not a record with a cwd.
    }
  }
  return null
}

interface DirSummary {
  cwd: string
  chatCount: number
  lastActivityMs: number
}

/** Maps a session's cwd to the repo that owns it.
 *
 *  The worktree collapse has to come first and has to be purely textual:
 *  those directories are usually gone, so nothing on disk can answer for
 *  them. Everything else is a plain checkout — which is every chat a
 *  first-time user has, since they have no worktrees yet — and the cwd may be
 *  any subdirectory of the repo, so walk up until a `.git` turns up. */
export function findRepoRoot(cwd: string, hasGitDir: (dir: string) => boolean): string | null {
  const derived = resolveRepoRoot(cwd, [])
  if (derived) return derived

  let dir = cwd.length > 1 && cwd.endsWith('/') ? cwd.slice(0, -1) : cwd
  while (dir.startsWith('/') && dir !== '/') {
    if (hasGitDir(dir)) return dir
    const parent = dir.slice(0, dir.lastIndexOf('/'))
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** Groups per-directory summaries into per-repo rows. Split out from the walk
 *  so the aggregation is testable without a filesystem. */
export function aggregateRepos(
  dirs: DirSummary[],
  resolve: (cwd: string) => string | null
): RepoIndexEntry[] {
  const byRoot = new Map<string, RepoIndexEntry>()

  for (const dir of dirs) {
    const repoRoot = resolve(dir.cwd)
    if (!repoRoot) continue
    const existing = byRoot.get(repoRoot)
    if (existing) {
      existing.chatCount += dir.chatCount
      existing.lastActivityMs = Math.max(existing.lastActivityMs, dir.lastActivityMs)
    } else {
      byRoot.set(repoRoot, {
        repoRoot,
        repoLabel: basename(repoRoot),
        chatCount: dir.chatCount,
        lastActivityMs: dir.lastActivityMs
      })
    }
  }

  return [...byRoot.values()].sort((a, b) => b.lastActivityMs - a.lastActivityMs)
}

export interface RepoIndexOptions {
  root?: string
  /** Overridable so tests can assert resolution without creating git repos. */
  hasGitDir?: (dir: string) => boolean
}

export async function scanRepoIndex(options: RepoIndexOptions = {}): Promise<RepoIndexResult> {
  const started = Date.now()
  const root = options.root ?? projectsRoot()
  const probe = options.hasGitDir ?? ((dir: string) => existsSync(join(dir, '.git')))

  // One `.git` probe per distinct directory. Walking up from thousands of
  // cwds re-asks about the same handful of parents over and over.
  const probed = new Map<string, boolean>()
  const hasGitDir = (dir: string): boolean => {
    const cached = probed.get(dir)
    if (cached !== undefined) return cached
    const answer = probe(dir)
    probed.set(dir, answer)
    return answer
  }

  let dirNames: string[]
  try {
    dirNames = await readdir(root)
  } catch {
    return { repos: [], scannedDirs: 0, elapsedMs: Date.now() - started }
  }

  const summaries: DirSummary[] = []

  await pool(dirNames, DIR_CONCURRENCY, async (dirName) => {
    const dir = join(root, dirName)

    let files: string[]
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      files = entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => e.name)
    } catch {
      return
    }
    if (files.length === 0) return

    let lastActivityMs = 0
    await pool(files, DIR_CONCURRENCY, async (file) => {
      try {
        const st = await stat(join(dir, file))
        if (st.mtimeMs > lastActivityMs) lastActivityMs = st.mtimeMs
      } catch {
        // Deleted between readdir and stat; it just doesn't count for recency.
      }
    })

    let cwd: string | null = null
    for (const file of files.slice(0, CWD_PROBE_FILES)) {
      cwd = await readCwd(join(dir, file))
      if (cwd) break
    }
    if (!cwd) return

    summaries.push({ cwd, chatCount: files.length, lastActivityMs })
  })

  const repos = aggregateRepos(summaries, (cwd) => findRepoRoot(cwd, hasGitDir)).filter((repo) =>
    hasGitDir(repo.repoRoot)
  )

  return { repos, scannedDirs: dirNames.length, elapsedMs: Date.now() - started }
}
