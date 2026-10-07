import { readFileSync, writeFileSync } from 'fs'
import { rename, writeFile } from 'fs/promises'
import { join } from 'path'
import { userDataDir } from './paths'
import { log } from './debug'

export type ActivityState = 'processing' | 'waiting' | 'needs-approval' | 'idle' | 'merged'

export interface ActivityEvent {
  /** epoch ms */
  t: number
  /** state entered at time t */
  s: ActivityState
}

export interface DiffStats {
  added: number
  removed: number
  files: number
}

export type PRState = 'open' | 'draft' | 'merged' | 'closed'

/** Everything we retain per worktree, including after it's been removed. */
export interface ActivityRecord {
  branch?: string
  repoRoot?: string
  /** First time we saw any event for this worktree. */
  createdAt?: number
  /** Stamped when the worktree is removed from disk. */
  removedAt?: number
  /** Final branch diff (committed work vs base) at removal time. */
  diffStats?: DiffStats
  prNumber?: number
  prState?: PRState
  events: ActivityEvent[]
}

export type ActivityLog = Record<string, ActivityRecord>

const MAX_EVENTS_PER_WORKTREE = 5000

/** How long a removed worktree's record is retained before it's pruned on
 *  the next boot. Deliberately longer than every finite range in the
 *  Activity UI's selector (max 30d), so pruning can only trim the deep tail
 *  of the "all" view. Weekly stats only looks back 7d. */
const REMOVED_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

let cache: ActivityLog | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
/** Serializes the async writes so a slow one can't be overtaken by the next. */
let writeChain: Promise<void> = Promise.resolve()
/** Set once sealAllActive() has written the final state at shutdown, so an
 *  async write already in flight can't rename stale content over it. */
let writesSealed = false

function getPath(): string {
  return join(userDataDir(), 'activity.json')
}

/** Migrate legacy `Record<path, ActivityEvent[]>` into the new record shape. */
function migrate(raw: unknown): ActivityLog {
  if (!raw || typeof raw !== 'object') return {}
  const out: ActivityLog = {}
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      const events = value as ActivityEvent[]
      out[path] = {
        events,
        createdAt: events[0]?.t
      }
    } else if (value && typeof value === 'object') {
      const rec = value as Partial<ActivityRecord>
      out[path] = {
        branch: rec.branch,
        repoRoot: rec.repoRoot,
        createdAt: rec.createdAt,
        removedAt: rec.removedAt,
        diffStats: rec.diffStats,
        prNumber: rec.prNumber,
        prState: rec.prState,
        events: Array.isArray(rec.events) ? rec.events : []
      }
    }
  }
  return out
}

/** Drop records for worktrees removed longer ago than the retention window.
 *  Live records (no `removedAt`) are kept regardless of age. Returns the
 *  input by reference when there's nothing to prune. */
export function pruneRemoved(logMap: ActivityLog, now: number): ActivityLog {
  const cutoff = now - REMOVED_RETENTION_MS
  const out: ActivityLog = {}
  let dropped = 0
  for (const [path, rec] of Object.entries(logMap)) {
    if (rec.removedAt != null && rec.removedAt < cutoff) {
      dropped++
      continue
    }
    out[path] = rec
  }
  if (dropped === 0) return logMap
  log('activity', `pruned ${dropped} removed worktree record(s) older than the retention window`)
  return out
}

function load(): ActivityLog {
  if (cache) return cache
  let parsed: ActivityLog
  try {
    parsed = migrate(JSON.parse(readFileSync(getPath(), 'utf-8')))
  } catch {
    parsed = {}
  }
  const pruned = pruneRemoved(parsed, Date.now())
  cache = pruned
  if (pruned !== parsed) scheduleSave()
  return cache
}

/** Debounced, asynchronous, and serialized. The write used to be a blocking
 *  writeFileSync of the whole log on the main thread once a second; the
 *  temp-then-rename keeps it atomic now that it can be interrupted.
 *
 *  Main-thread blocking here is reduced, NOT eliminated. The JSON.stringify
 *  below is still synchronous, and it is the larger half: on a 2.5MB log it
 *  measured ~10ms against ~6ms for the write it replaced. Getting rid of the
 *  remainder needs a worker or an append-only format, neither of which this
 *  debounce can do on its own — don't read the async write as "the blocking
 *  save was fixed." */
function scheduleSave(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (!cache) return
    const data = JSON.stringify(cache)
    writeChain = writeChain.then(async () => {
      if (writesSealed) return
      const path = getPath()
      const tmp = `${path}.tmp`
      try {
        await writeFile(tmp, data)
        await rename(tmp, path)
      } catch (e) {
        log('activity', 'save failed', e instanceof Error ? e.message : e)
      }
    })
  }, 1000)
}

function getOrCreate(path: string): ActivityRecord {
  const logMap = load()
  let rec = logMap[path]
  if (!rec) {
    rec = { events: [] }
    logMap[path] = rec
  }
  return rec
}

/** Record a state for a worktree. Deduplicates — only writes if state changed. */
export function recordActivity(worktreePath: string, state: ActivityState): void {
  const rec = getOrCreate(worktreePath)
  const last = rec.events[rec.events.length - 1]
  if (last && last.s === state) return
  const now = Date.now()
  if (!rec.createdAt) rec.createdAt = now
  rec.events.push({ t: now, s: state })
  if (rec.events.length > MAX_EVENTS_PER_WORKTREE) {
    rec.events.splice(0, rec.events.length - MAX_EVENTS_PER_WORKTREE)
  }
  scheduleSave()
}

/** Update live metadata (branch, repo) for a worktree. Called whenever
 *  worktrees are listed, so records stay in sync with current git state. */
export function touchActivityMeta(
  worktreePath: string,
  meta: { branch?: string; repoRoot?: string }
): void {
  const rec = getOrCreate(worktreePath)
  let changed = false
  if (meta.branch && meta.branch !== rec.branch) {
    rec.branch = meta.branch
    changed = true
  }
  if (meta.repoRoot && meta.repoRoot !== rec.repoRoot) {
    rec.repoRoot = meta.repoRoot
    changed = true
  }
  if (changed) scheduleSave()
}

/** Stamp removal metadata and push a terminal event so the timeline doesn't
 *  stretch the last known state to "now" forever. */
export function finalizeActivity(
  worktreePath: string,
  data: {
    diffStats?: DiffStats
    prNumber?: number
    prState?: PRState
  }
): void {
  const logMap = load()
  const rec = logMap[worktreePath]
  if (!rec) return
  rec.removedAt = Date.now()
  if (data.diffStats) rec.diffStats = data.diffStats
  if (data.prNumber != null) rec.prNumber = data.prNumber
  if (data.prState) rec.prState = data.prState
  const last = rec.events[rec.events.length - 1]
  const terminal: ActivityState =
    data.prState === 'merged' || data.prState === 'closed' ? 'merged' : 'idle'
  if (!last || last.s !== terminal) {
    rec.events.push({ t: rec.removedAt, s: terminal })
  }
  scheduleSave()
}

export function getActivityLog(): ActivityLog {
  return load()
}

/** Test-only: forget the in-memory cache and pending write state so the next
 *  read comes from disk. */
export function resetActivityCacheForTests(): void {
  cache = null
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  writeChain = Promise.resolve()
  writesSealed = false
}

/** Test-only: resolves once every queued async write has landed. */
export function flushActivityWritesForTests(): Promise<void> {
  return writeChain
}

export function clearActivityForWorktree(worktreePath: string): void {
  const logMap = load()
  delete logMap[worktreePath]
  scheduleSave()
}

export function clearAllActivity(): void {
  cache = {}
  scheduleSave()
}

/** Close out any non-idle worktree segments with an idle marker.
 *  Call on app quit so gaps while the app is closed don't render as the last
 *  known state stretching forever. Writes synchronously — the debounce timer
 *  won't fire during shutdown, and neither would an awaited write.
 *
 *  The write is unconditional: the routine save is async now, so at quit
 *  there may be an in-flight or debounced write carrying edits that never
 *  reached disk. Sealing writes and blocks those, rather than skipping when
 *  no idle marker happened to be needed. */
export function sealAllActive(): void {
  const logMap = load()
  for (const rec of Object.values(logMap)) {
    if (rec.removedAt) continue
    const last = rec.events[rec.events.length - 1]
    if (last && last.s !== 'idle' && last.s !== 'merged') {
      rec.events.push({ t: Date.now(), s: 'idle' })
    }
  }
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  writesSealed = true
  try {
    writeFileSync(getPath(), JSON.stringify(logMap))
  } catch (e) {
    log('activity', 'seal save failed', e instanceof Error ? e.message : e)
  }
}
