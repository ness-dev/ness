import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Flame, Clock, Zap, GitBranch, GitMerge, RefreshCw, CalendarDays } from 'lucide-react'
import type {
  Worktree,
  ActivityLog,
  ActivityEvent,
  ActivityRecord,
  ActivityState,
  PRStatus
} from '../types'
import { isPRMerged } from '../../shared/state/prs'
import { useBackend } from '../backend'
import { ActivityCosts } from './ActivityCosts'

interface ActivityProps {
  onClose: () => void
  onOpenMyWeek: () => void
  worktrees: Worktree[]
  prStatuses?: Record<string, PRStatus | null>
  mergedPaths?: Record<string, boolean>
}

type Range = '1h' | '6h' | '24h' | '7d' | '30d' | 'all'

const RANGES: { id: Range; label: string; ms: number }[] = [
  { id: '1h', label: '1h', ms: 60 * 60 * 1000 },
  { id: '6h', label: '6h', ms: 6 * 60 * 60 * 1000 },
  { id: '24h', label: '24h', ms: 24 * 60 * 60 * 1000 },
  { id: '7d', label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { id: '30d', label: '30d', ms: 30 * 24 * 60 * 60 * 1000 },
  { id: 'all', label: 'all', ms: Number.POSITIVE_INFINITY }
]

const STATE_COLOR: Record<ActivityState, string> = {
  processing: 'bg-success/80',
  waiting: 'bg-warning/80',
  'needs-approval': 'bg-danger/80',
  idle: 'bg-faint/20',
  merged: 'bg-accent/80'
}

const STATE_LABEL: Record<ActivityState, string> = {
  processing: 'working',
  waiting: 'waiting on you',
  'needs-approval': 'needs approval',
  idle: 'idle',
  merged: 'merged'
}

/** Convert an events list into a series of [start, end, state] segments
 *  clamped to [windowStart, windowEnd]. For removed worktrees the final
 *  segment is capped at removedAt so it doesn't stretch to "now". */
function eventsToSegments(
  events: ActivityEvent[],
  windowStart: number,
  windowEnd: number,
  removedAt?: number
): { start: number; end: number; state: ActivityState }[] {
  if (events.length === 0) return []
  const cap = removedAt ? Math.min(windowEnd, removedAt) : windowEnd
  const segs: { start: number; end: number; state: ActivityState }[] = []
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    const next = events[i + 1]
    const segStart = e.t
    const segEnd = next ? next.t : cap
    if (segEnd <= windowStart) continue
    if (segStart >= windowEnd) break
    segs.push({
      start: Math.max(segStart, windowStart),
      end: Math.min(segEnd, windowEnd),
      state: e.s
    })
  }
  return segs
}

function formatDuration(ms: number): string {
  if (ms < 1000) return '0s'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const mm = m % 60
  if (h < 24) return mm ? `${h}h ${mm}m` : `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

function basename(p: string): string {
  const parts = p.split('/')
  return parts[parts.length - 1] || p
}

function isLiveMerged(
  path: string,
  prStatuses?: Record<string, PRStatus | null>,
  mergedPaths?: Record<string, boolean>
): boolean {
  return !!mergedPaths?.[path] || isPRMerged(prStatuses?.[path])
}

type ActivityTab = 'timeline' | 'costs'

export function Activity({ onClose, onOpenMyWeek, worktrees, prStatuses, mergedPaths }: ActivityProps): JSX.Element {
  const backend = useBackend()
  const [tab, setTab] = useState<ActivityTab>('timeline')
  const [log, setLog] = useState<ActivityLog>({})
  const [range, setRange] = useState<Range>('24h')
  const [now, setNow] = useState(Date.now())
  const [loading, setLoading] = useState(true)

  const loadLog = async (): Promise<void> => {
    setLoading(true)
    try {
      const data = await backend.getActivityLog()
      setLog(data)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadLog()
  }, [])

  // Tick so active worktrees extend their current state in real time.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 2000)
    return () => clearInterval(id)
  }, [])

  const rangeMs = RANGES.find((r) => r.id === range)!.ms
  const windowStart = Number.isFinite(rangeMs) ? now - rangeMs : 0

  const livePaths = useMemo(() => new Set(worktrees.map((w) => w.path)), [worktrees])

  type Section = 'active' | 'merged' | 'archived'

  // Bucket every known path into active / merged / archived, sorted within each
  // section by most recent event. Live worktrees always appear; removed ones
  // only when they overlap the current window.
  const sections = useMemo(() => {
    const buckets: Record<Section, { path: string; lastT: number }[]> = {
      active: [],
      merged: [],
      archived: []
    }

    const classify = (path: string, rec: ActivityRecord | undefined): Section => {
      const isLive = livePaths.has(path)
      if (isLive) {
        return isLiveMerged(path, prStatuses, mergedPaths) ? 'merged' : 'active'
      }
      const prState = rec?.prState
      if (prState === 'merged' || prState === 'closed') return 'merged'
      return 'archived'
    }

    const inWindow = (rec: ActivityRecord | undefined): boolean => {
      if (!rec) return false
      const last = rec.events[rec.events.length - 1]?.t ?? rec.removedAt ?? 0
      const first = rec.createdAt ?? rec.events[0]?.t ?? 0
      if (!last) return false
      return last >= windowStart && first <= now
    }

    const pushed = new Set<string>()
    for (const [path, rec] of Object.entries(log)) {
      const isLive = livePaths.has(path)
      if (!isLive && !inWindow(rec)) continue
      const lastT =
        rec.events[rec.events.length - 1]?.t ?? rec.removedAt ?? rec.createdAt ?? 0
      buckets[classify(path, rec)].push({ path, lastT })
      pushed.add(path)
    }
    for (const wt of worktrees) {
      if (pushed.has(wt.path)) continue
      buckets[classify(wt.path, undefined)].push({ path: wt.path, lastT: 0 })
    }

    for (const key of Object.keys(buckets) as Section[]) {
      buckets[key].sort((a, b) => {
        if (a.lastT === 0 && b.lastT !== 0) return 1
        if (b.lastT === 0 && a.lastT !== 0) return -1
        return b.lastT - a.lastT
      })
    }
    return buckets
  }, [log, worktrees, livePaths, prStatuses, mergedPaths, windowStart, now])

  const visiblePaths = useMemo(
    () => [...sections.active, ...sections.merged, ...sections.archived].map((e) => e.path),
    [sections]
  )

  // Totals across the window
  const totals = useMemo(() => {
    const totalsByState: Record<ActivityState, number> = {
      processing: 0,
      waiting: 0,
      'needs-approval': 0,
      idle: 0,
      merged: 0
    }
    let longestFlow = 0
    let activeWorktrees = 0
    let mergedCount = 0
    let linesAdded = 0
    let linesRemoved = 0
    for (const path of visiblePaths) {
      const rec = log[path]
      const isMerged = livePaths.has(path)
        ? isLiveMerged(path, prStatuses, mergedPaths)
        : rec?.prState === 'merged' || rec?.prState === 'closed'
      if (isMerged) mergedCount++
      if (rec?.diffStats) {
        linesAdded += rec.diffStats.added
        linesRemoved += rec.diffStats.removed
      }
      const events = rec?.events || []
      const segs = eventsToSegments(events, windowStart, now, rec?.removedAt)
      let hadAny = false
      for (const seg of segs) {
        const dur = seg.end - seg.start
        totalsByState[seg.state] += dur
        if (seg.state === 'processing') {
          if (dur > longestFlow) longestFlow = dur
          hadAny = true
        }
        if (seg.state === 'waiting' || seg.state === 'needs-approval') hadAny = true
      }
      if (hadAny) activeWorktrees++
    }
    return { totalsByState, longestFlow, activeWorktrees, mergedCount, linesAdded, linesRemoved }
  }, [log, visiblePaths, livePaths, windowStart, now, prStatuses, mergedPaths])

  // Effective window for rendering the timeline. For finite ranges we anchor
  // on "now"; for "all" we stretch to fit the oldest event we're going to draw.
  const effectiveWindowStart = useMemo(() => {
    if (Number.isFinite(rangeMs)) return windowStart
    let earliest = now
    for (const path of visiblePaths) {
      const rec = log[path]
      const first = rec?.createdAt ?? rec?.events[0]?.t
      if (first && first < earliest) earliest = first
    }
    return earliest === now ? now - 60 * 60 * 1000 : earliest
  }, [rangeMs, windowStart, visiblePaths, log, now])

  const handleReset = async (): Promise<void> => {
    if (!confirm('Clear all activity history? This cannot be undone.')) return
    await backend.clearActivityLog()
    await loadLog()
  }

  return (
    <div className="flex flex-col h-full w-full bg-panel">
      <div className="drag-region h-10 shrink-0 border-b border-border relative">
        <button
          onClick={onClose}
          className="no-drag absolute left-4 top-1/2 -translate-y-1/2 flex items-center gap-1.5 text-xs text-muted hover:text-fg-bright transition-colors cursor-pointer"
        >
          <ArrowLeft className="icon-sm" />
          Back
        </button>
        <span className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 text-sm font-medium text-fg pointer-events-none">
          Activity
        </span>
        <div className="no-drag absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-2">
          <button
            onClick={onOpenMyWeek}
            className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted hover:text-fg-bright hover:bg-surface rounded transition-colors cursor-pointer"
            title="Weekly review"
          >
            <CalendarDays className="icon-sm" />
            My week
          </button>
          <button
            onClick={loadLog}
            className="text-muted hover:text-fg-bright transition-colors cursor-pointer p-1"
            title="Refresh"
          >
            <RefreshCw className="icon-sm" />
          </button>
          <button
            onClick={handleReset}
            className="text-xs text-muted hover:text-danger transition-colors cursor-pointer"
          >
            reset
          </button>
        </div>
      </div>

      <div className="shrink-0 border-b border-border flex items-center gap-1 px-4 bg-panel">
        {([
          ['timeline', 'Timeline'],
          ['costs', 'Costs']
        ] as const).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`px-3 py-2 text-xs transition-colors cursor-pointer border-b-2 -mb-px ${
              tab === id
                ? 'text-fg-bright border-accent'
                : 'text-muted hover:text-fg border-transparent'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'costs' && <ActivityCosts />}
        {tab === 'timeline' && (
        <div className="max-w-5xl mx-auto px-8 py-8">
          {/* Range selector */}
          <div className="flex items-center gap-2 mb-6">
            <span className="text-xs text-dim uppercase tracking-wider mr-2">Range</span>
            {RANGES.map((r) => (
              <button
                key={r.id}
                onClick={() => setRange(r.id)}
                className={`px-2.5 py-1 rounded text-xs font-mono transition-colors cursor-pointer ${
                  range === r.id
                    ? 'bg-accent/25 text-fg-bright border border-accent/40'
                    : 'bg-surface/40 text-muted hover:text-fg border border-transparent'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>

          {/* Stat cards */}
          <div className="grid grid-cols-5 gap-3 mb-8">
            <StatCard
              icon={Zap}
              label="Flow time"
              value={formatDuration(totals.totalsByState.processing)}
              tint="text-success"
              sub="Claude working"
            />
            <StatCard
              icon={Clock}
              label="Wait time"
              value={formatDuration(
                totals.totalsByState.waiting + totals.totalsByState['needs-approval']
              )}
              tint="text-warning"
              sub="waiting on you"
            />
            <StatCard
              icon={Flame}
              label="Longest flow"
              value={formatDuration(totals.longestFlow)}
              tint="text-danger"
              sub="single session"
            />
            <StatCard
              icon={GitBranch}
              label="Lines shipped"
              value={`+${totals.linesAdded.toLocaleString()} / -${totals.linesRemoved.toLocaleString()}`}
              tint="text-info"
              sub="from removed worktrees"
            />
            <StatCard
              icon={GitMerge}
              label="Merged"
              value={String(totals.mergedCount)}
              tint="text-accent"
              sub="PRs landed or closed"
            />
          </div>

          {/* Timeline */}
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-fg-bright">Timeline</h2>
            <Legend />
          </div>

          {loading && <div className="text-sm text-dim py-8 text-center">Loading…</div>}

          {!loading && visiblePaths.length === 0 && (
            <div className="text-sm text-dim py-12 text-center">
              No activity in this range.
            </div>
          )}

          {!loading && visiblePaths.length > 0 && (
            <div className="bg-app/50 border border-border rounded-xl p-5">
              <TimeAxis windowStart={effectiveWindowStart} windowEnd={now} />
              <div className="mt-2">
                {([
                  ['active', 'Active'],
                  ['merged', 'Merged'],
                  ['archived', 'Archived']
                ] as const).map(([key, label]) => {
                  const entries = sections[key]
                  if (entries.length === 0) return null
                  return (
                    <div key={key} className="mb-4 last:mb-0">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-xs uppercase tracking-wider text-dim font-semibold">
                          {label}
                        </span>
                        <span className="text-xs text-dim/60 tabular-nums">
                          {entries.length}
                        </span>
                        <div className="flex-1 h-px bg-border/50" />
                      </div>
                      <div className="space-y-2">
                        {entries.map(({ path }) => {
                          const rec = log[path]
                          const events = rec?.events || []
                          const segs = eventsToSegments(events, effectiveWindowStart, now, rec?.removedAt)
                          const live = worktrees.find((w) => w.path === path)
                          const rowLabel = live?.branch || rec?.branch || basename(path)
                          return (
                            <WorktreeRow
                              key={path}
                              label={rowLabel}
                              record={rec}
                              isLive={!!live}
                              segments={segs}
                              windowStart={effectiveWindowStart}
                              windowEnd={now}
                            />
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          <p className="text-xs text-dim mt-6 text-center">
            Activity is recorded locally from Claude Code hooks. Removed worktrees stay in the log so you can see historical trends.
          </p>
        </div>
        )}
      </div>
    </div>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  tint
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>
  label: string
  value: string
  sub: string
  tint: string
}): JSX.Element {
  return (
    <div className="bg-app/50 border border-border rounded-xl p-4">
      <div className="flex items-center gap-2 mb-2">
        <Icon className={`icon-sm ${tint}`} />
        <span className="text-xs uppercase tracking-wider text-dim">{label}</span>
      </div>
      <div className={`text-2xl font-bold ${tint} tabular-nums`}>{value}</div>
      <div className="text-xs text-dim mt-0.5">{sub}</div>
    </div>
  )
}

function Legend(): JSX.Element {
  return (
    <div className="flex items-center gap-3 text-xs text-dim">
      <span className="flex items-center gap-1.5">
        <span className="w-2.5 h-2.5 rounded-sm bg-success/80" />
        working
      </span>
      <span className="flex items-center gap-1.5">
        <span className="w-2.5 h-2.5 rounded-sm bg-warning/80" />
        waiting
      </span>
      <span className="flex items-center gap-1.5">
        <span className="w-2.5 h-2.5 rounded-sm bg-danger/80" />
        needs approval
      </span>
      <span className="flex items-center gap-1.5">
        <span className="w-2.5 h-2.5 rounded-sm bg-accent/80" />
        merged
      </span>
    </div>
  )
}

function TimeAxis({ windowStart, windowEnd }: { windowStart: number; windowEnd: number }): JSX.Element {
  // 5 evenly spaced tick marks
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  const span = windowEnd - windowStart
  const fmt = (t: number): string => {
    if (span <= 2 * 60 * 60 * 1000) {
      // short range — minutes ago
      const mAgo = Math.round((windowEnd - t) / 60000)
      return mAgo === 0 ? 'now' : `${mAgo}m`
    }
    if (span <= 48 * 60 * 60 * 1000) {
      // day range — HH:MM
      const d = new Date(t)
      return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
    }
    const d = new Date(t)
    return `${d.getMonth() + 1}/${d.getDate()}`
  }
  return (
    <div className="flex items-center ml-44 mb-1">
      <div className="flex-1 relative h-4">
        {ticks.map((p) => {
          const t = windowStart + p * span
          return (
            <div
              key={p}
              className="absolute text-xs text-dim tabular-nums -translate-x-1/2"
              style={{ left: `${p * 100}%` }}
            >
              {fmt(t)}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function WorktreeRow({
  label,
  record,
  isLive,
  segments,
  windowStart,
  windowEnd
}: {
  label: string
  record?: ActivityRecord
  isLive: boolean
  segments: { start: number; end: number; state: ActivityState }[]
  windowStart: number
  windowEnd: number
}): JSX.Element {
  const span = windowEnd - windowStart
  const diff = record?.diffStats
  const repoLabel = record?.repoRoot ? basename(record.repoRoot) : null
  const fullTitle = [label, repoLabel ? `(${repoLabel})` : null, isLive ? null : 'removed']
    .filter(Boolean)
    .join(' ')
  return (
    <div className="flex items-center gap-3">
      <div className="w-44 shrink-0 flex flex-col leading-tight" title={fullTitle}>
        <div className="flex items-center gap-1.5">
          <span
            className={`text-xs font-mono truncate ${isLive ? 'text-muted' : 'text-dim italic'}`}
          >
            {label}
          </span>
          {!isLive && (
            <span className="text-xs uppercase tracking-wider text-dim/70 bg-faint/10 px-1 py-px rounded">
              removed
            </span>
          )}
        </div>
        {(repoLabel || diff) && (
          <div className="flex items-center gap-1.5 text-xs text-dim/80 tabular-nums">
            {repoLabel && <span className="truncate">{repoLabel}</span>}
            {diff && (diff.added || diff.removed) ? (
              <span className="shrink-0">
                <span className="text-success/80">+{diff.added}</span>
                <span className="text-danger/80"> -{diff.removed}</span>
              </span>
            ) : null}
          </div>
        )}
      </div>
      <div className="flex-1 relative h-6 rounded-md overflow-hidden border border-border bg-faint/5">
        {segments.map((seg, i) => {
          if (seg.state === 'idle') return null
          const leftPct = ((seg.start - windowStart) / span) * 100
          const widthPct = ((seg.end - seg.start) / span) * 100
          if (widthPct <= 0) return null
          return (
            <div
              key={i}
              className={`absolute top-0 h-full ${STATE_COLOR[seg.state]} hover:brightness-125 transition-all`}
              style={{
                left: `${leftPct}%`,
                width: `${Math.max(widthPct, 0.15)}%`
              }}
              title={`${STATE_LABEL[seg.state]} — ${formatDuration(seg.end - seg.start)}`}
            />
          )
        })}
      </div>
    </div>
  )
}
