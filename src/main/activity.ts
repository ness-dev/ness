import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { userDataDir } from './paths'
import { log } from './debug'
import type { ActivityActor } from '../shared/state/terminals'

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

let cache: ActivityLog | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null

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

function load(): ActivityLog {
  if (cache) return cache
  try {
    const raw = readFileSync(getPath(), 'utf-8')
    cache = migrate(JSON.parse(raw))
  } catch {
    cache = {}
  }
  return cache
}

function scheduleSave(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (!cache) return
    try {
      writeFileSync(getPath(), JSON.stringify(cache))
    } catch (e) {
      log('activity', 'save failed', e instanceof Error ? e.message : e)
    }
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

/** Attribute a state transition to whoever caused it. Entering 'processing'
 *  only ever follows a submitted prompt, so it reads as human input; the
 *  turn-ending states are the agent reporting back. 'idle' and 'merged' are
 *  ambient and belong to neither. */
export function actorForState(state: ActivityState): ActivityActor | null {
  if (state === 'processing') return 'human'
  if (state === 'waiting' || state === 'needs-approval') return 'agent'
  return null
}

/** Replay the log to recover per-worktree human/agent recency. Without this
 *  the sidebar's recency sorts would fall back to arbitrary order after every
 *  relaunch, since the timestamps themselves aren't persisted. */
export function deriveActorTimestamps(): {
  human: Record<string, number>
  agent: Record<string, number>
} {
  const human: Record<string, number> = {}
  const agent: Record<string, number> = {}
  for (const [path, rec] of Object.entries(load())) {
    for (const ev of rec.events) {
      const actor = actorForState(ev.s)
      if (actor === 'human') human[path] = ev.t
      else if (actor === 'agent') agent[path] = ev.t
    }
  }
  return { human, agent }
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
 *  won't fire during shutdown. */
export function sealAllActive(): void {
  const logMap = load()
  let changed = false
  for (const rec of Object.values(logMap)) {
    if (rec.removedAt) continue
    const last = rec.events[rec.events.length - 1]
    if (last && last.s !== 'idle' && last.s !== 'merged') {
      rec.events.push({ t: Date.now(), s: 'idle' })
      changed = true
    }
  }
  if (!changed) return
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  try {
    writeFileSync(getPath(), JSON.stringify(cache))
  } catch (e) {
    log('activity', 'seal save failed', e instanceof Error ? e.message : e)
  }
}
