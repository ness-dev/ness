import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type {
  GitHubApiEntry,
  GitHubApiLogSnapshot,
  GitHubApiRateLimit
} from '../types'
import { useBackend } from '../backend'

interface Props {
  onClose: () => void
}

type StatusFilter = 'all' | 'ok' | 'client-error' | 'server-error' | 'errored'

const POLL_INTERVAL_MS = 1000
const CHART_WIDTH = 720
const CHART_HEIGHT = 96
const MINUTE_COUNT = 60

const EMPTY_SNAPSHOT: GitHubApiLogSnapshot = {
  entries: [],
  minuteBuckets: [],
  rateLimit: undefined,
  totalRecorded: 0,
  maxEntries: 2000
}

export function GitHubApiLogPanel({ onClose }: Props): JSX.Element {
  const backend = useBackend()
  const [snapshot, setSnapshot] = useState<GitHubApiLogSnapshot>(EMPTY_SNAPSHOT)
  const [filter, setFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    try {
      const snap = await backend.getGitHubApiLog()
      setSnapshot(snap)
    } catch {
      // ignore
    }
  }, [backend])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!autoRefresh) return
    const timer = setInterval(() => {
      void load()
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [autoRefresh, load])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [onClose])

  const handleClear = useCallback(async () => {
    await backend.clearGitHubApiLog()
    setSnapshot(EMPTY_SNAPSHOT)
    setExpandedId(null)
  }, [backend])

  const filteredEntries = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const source = [...snapshot.entries].reverse()
    return source.filter((entry) => {
      if (statusFilter !== 'all') {
        const kind = classifyStatus(entry)
        if (kind !== statusFilter) return false
      }
      if (!needle) return true
      const hay = [
        entry.shortPath,
        entry.operationName ?? '',
        entry.error ?? '',
        String(entry.status ?? '')
      ]
        .join(' ')
        .toLowerCase()
      return hay.includes(needle)
    })
  }, [snapshot.entries, filter, statusFilter])

  const filterCounts = useMemo(() => {
    const counts = { all: 0, ok: 0, 'client-error': 0, 'server-error': 0, errored: 0 }
    for (const entry of snapshot.entries) {
      counts.all++
      counts[classifyStatus(entry)]++
    }
    return counts
  }, [snapshot.entries])

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center pt-[6vh] bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-full max-w-5xl bg-surface rounded-xl shadow-2xl border border-border overflow-hidden flex flex-col"
        style={{ maxHeight: '88vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div className="flex items-baseline gap-3">
            <h2 className="text-sm font-semibold text-fg-bright">GitHub API Log</h2>
            <span className="text-xs text-faint">
              {snapshot.entries.length} in buffer · {snapshot.totalRecorded} total
              {snapshot.totalRecorded > snapshot.maxEntries && ' (older dropped)'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer select-none">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="accent-current"
              />
              Auto-refresh
            </label>
            <button
              className="text-xs px-2 py-1 rounded border border-border text-fg hover:bg-surface-hover"
              onClick={() => void handleClear()}
            >
              Clear
            </button>
            <button
              className="p-1 rounded hover:bg-surface-hover text-muted"
              onClick={onClose}
              aria-label="Close"
            >
              <X className="icon-sm" />
            </button>
          </div>
        </div>

        <div className="px-5 py-3 border-b border-border flex items-start gap-6 flex-wrap">
          <RateLimitCard rateLimit={snapshot.rateLimit} now={now} />
          <VolumeChart buckets={snapshot.minuteBuckets} now={now} />
        </div>

        <div className="px-5 py-2.5 border-b border-border flex items-center gap-2 flex-wrap">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by path, operation name, error…"
            className="flex-1 min-w-[220px] text-sm px-2.5 py-1.5 rounded border border-border bg-bg text-fg placeholder:text-faint focus:outline-none focus:border-accent"
          />
          <div className="flex items-center gap-1">
            <FilterChip
              active={statusFilter === 'all'}
              onClick={() => setStatusFilter('all')}
              label="All"
              count={filterCounts.all}
            />
            <FilterChip
              active={statusFilter === 'ok'}
              onClick={() => setStatusFilter('ok')}
              label="OK"
              count={filterCounts.ok}
              tone="ok"
            />
            <FilterChip
              active={statusFilter === 'client-error'}
              onClick={() => setStatusFilter('client-error')}
              label="4xx"
              count={filterCounts['client-error']}
              tone="warning"
            />
            <FilterChip
              active={statusFilter === 'server-error'}
              onClick={() => setStatusFilter('server-error')}
              label="5xx"
              count={filterCounts['server-error']}
              tone="error"
            />
            <FilterChip
              active={statusFilter === 'errored'}
              onClick={() => setStatusFilter('errored')}
              label="Errored"
              count={filterCounts.errored}
              tone="error"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {filteredEntries.length === 0 ? (
            <div className="p-10 text-center text-sm text-muted">
              {snapshot.entries.length === 0
                ? 'No GitHub API calls recorded yet. They’ll show up here as soon as the PR poller runs.'
                : 'No calls match the current filter.'}
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-surface border-b border-border">
                <tr className="text-left text-faint uppercase tracking-wider">
                  <th className="px-4 py-2 font-medium w-[14%]">Time</th>
                  <th className="px-2 py-2 font-medium w-[8%]">Method</th>
                  <th className="px-2 py-2 font-medium">Path</th>
                  <th className="px-2 py-2 font-medium w-[10%]">Status</th>
                  <th className="px-2 py-2 font-medium w-[10%] text-right">Duration</th>
                  <th className="px-2 py-2 font-medium w-[12%] text-right">Quota left</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {filteredEntries.map((entry) => (
                  <EntryRow
                    key={entry.id}
                    entry={entry}
                    now={now}
                    expanded={expandedId === entry.id}
                    onToggle={() =>
                      setExpandedId((prev) => (prev === entry.id ? null : entry.id))
                    }
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

function classifyStatus(entry: GitHubApiEntry): Exclude<StatusFilter, 'all'> {
  if (entry.error != null) return 'errored'
  const s = entry.status
  if (s == null) return 'errored'
  if (s >= 500) return 'server-error'
  if (s >= 400) return 'client-error'
  return 'ok'
}

function statusColorClass(entry: GitHubApiEntry): string {
  const k = classifyStatus(entry)
  if (k === 'ok') return 'text-success'
  if (k === 'client-error') return 'text-warning'
  return 'text-danger'
}

function durationColorClass(ms: number): string {
  if (ms < 500) return 'text-fg'
  if (ms < 2000) return 'text-warning'
  return 'text-danger'
}

function formatRelative(pastMs: number, now: number): string {
  const s = Math.max(0, Math.floor((now - pastMs) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return `${h}h ago`
}

function formatUntil(futureEpochSec: number, now: number): string {
  const diff = futureEpochSec * 1000 - now
  if (diff <= 0) return 'now'
  const s = Math.floor(diff / 1000)
  if (s < 60) return `in ${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  if (m < 60) return `in ${m}m ${r}s`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return `in ${h}h ${rm}m`
}

function formatIso(epochMs: number): string {
  try {
    return new Date(epochMs).toISOString()
  } catch {
    return String(epochMs)
  }
}

function displayPath(entry: GitHubApiEntry): string {
  if (entry.operationName && entry.shortPath.endsWith('/graphql')) {
    return `graphql: ${entry.operationName}`
  }
  return entry.shortPath
}

function EntryRow({
  entry,
  now,
  expanded,
  onToggle
}: {
  entry: GitHubApiEntry
  now: number
  expanded: boolean
  onToggle: () => void
}): JSX.Element {
  const statusLabel = entry.error != null ? 'error' : String(entry.status ?? '—')
  return (
    <>
      <tr
        className="border-b border-border/40 cursor-pointer hover:bg-surface-hover"
        onClick={onToggle}
      >
        <td className="px-4 py-1.5 text-muted whitespace-nowrap">
          {formatRelative(entry.startedAt, now)}
        </td>
        <td className="px-2 py-1.5 text-fg">{entry.method}</td>
        <td className="px-2 py-1.5 text-fg-bright truncate max-w-0">
          {displayPath(entry)}
        </td>
        <td className={`px-2 py-1.5 ${statusColorClass(entry)}`}>{statusLabel}</td>
        <td className={`px-2 py-1.5 text-right ${durationColorClass(entry.durationMs)}`}>
          {entry.durationMs}ms
        </td>
        <td className="px-2 py-1.5 text-right text-muted">
          {entry.rateLimitRemaining != null ? entry.rateLimitRemaining : '—'}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-border/40 bg-bg">
          <td colSpan={6} className="px-4 py-2">
            <div className="grid gap-1 text-xs text-fg">
              <DetailRow label="URL" value={entry.url} />
              <DetailRow label="Started" value={formatIso(entry.startedAt)} />
              {entry.statusText && (
                <DetailRow label="Status text" value={entry.statusText} />
              )}
              {entry.error && (
                <DetailRow label="Error" value={entry.error} tone="error" />
              )}
              {entry.rateLimitLimit != null && (
                <DetailRow
                  label="Rate limit"
                  value={`${entry.rateLimitRemaining ?? '?'} of ${entry.rateLimitLimit} left · resets ${
                    entry.rateLimitReset != null
                      ? formatUntil(entry.rateLimitReset, now)
                      : '?'
                  }`}
                />
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function DetailRow({
  label,
  value,
  tone
}: {
  label: string
  value: string
  tone?: 'error'
}): JSX.Element {
  return (
    <div className="flex gap-3">
      <span className="text-faint w-24 flex-shrink-0">{label}</span>
      <span
        className={`flex-1 break-all font-mono ${tone === 'error' ? 'text-danger' : 'text-fg'}`}
      >
        {value}
      </span>
    </div>
  )
}

function RateLimitCard({
  rateLimit,
  now
}: {
  rateLimit: GitHubApiRateLimit | undefined
  now: number
}): JSX.Element {
  if (!rateLimit) {
    return (
      <div className="min-w-[220px]">
        <div className="text-xs uppercase tracking-wider text-faint mb-1">
          Rate limit
        </div>
        <div className="text-sm text-muted">Waiting for first response…</div>
      </div>
    )
  }
  const pct =
    rateLimit.limit > 0 ? Math.max(0, rateLimit.remaining / rateLimit.limit) : 0
  const remainingTone =
    pct < 0.05 ? 'text-danger' : pct < 0.2 ? 'text-warning' : 'text-success'
  const used = Math.max(0, rateLimit.limit - rateLimit.remaining)
  return (
    <div className="min-w-[240px]">
      <div className="text-xs uppercase tracking-wider text-faint mb-1">
        Rate limit
      </div>
      <div className="flex items-baseline gap-2">
        <span className={`text-lg font-mono ${remainingTone}`}>
          {rateLimit.remaining.toLocaleString()}
        </span>
        <span className="text-xs text-muted">
          of {rateLimit.limit.toLocaleString()} left ({used.toLocaleString()} used)
        </span>
      </div>
      <div className="text-xs text-muted">
        resets {formatUntil(rateLimit.reset, now)} · updated{' '}
        {formatRelative(rateLimit.lastUpdatedAt, now)}
      </div>
    </div>
  )
}

function VolumeChart({
  buckets,
  now
}: {
  buckets: GitHubApiLogSnapshot['minuteBuckets']
  now: number
}): JSX.Element {
  const { grid, maxCount } = useMemo(() => {
    const minuteFloor = (t: number): number => Math.floor(t / 60_000) * 60_000
    const nowMin = minuteFloor(now)
    const byMinute = new Map<number, { count: number; errorCount: number }>()
    for (const b of buckets) byMinute.set(b.startedAt, b)
    const cells: Array<{ count: number; errorCount: number; startedAt: number }> = []
    let max = 0
    for (let i = MINUTE_COUNT - 1; i >= 0; i--) {
      const start = nowMin - i * 60_000
      const b = byMinute.get(start) ?? { count: 0, errorCount: 0 }
      cells.push({ count: b.count, errorCount: b.errorCount, startedAt: start })
      if (b.count > max) max = b.count
    }
    return { grid: cells, maxCount: max }
  }, [buckets, now])

  const totalCalls = grid.reduce((sum, c) => sum + c.count, 0)
  const totalErrors = grid.reduce((sum, c) => sum + c.errorCount, 0)
  const barWidth = CHART_WIDTH / MINUTE_COUNT

  return (
    <div className="flex-1 min-w-[320px]">
      <div className="text-xs uppercase tracking-wider text-faint mb-1 flex items-baseline gap-3">
        <span>Volume · last hour</span>
        <span className="text-muted normal-case tracking-normal">
          {totalCalls} calls
          {totalErrors > 0 && (
            <span className="text-danger"> · {totalErrors} errors</span>
          )}
          {maxCount > 0 && ` · peak ${maxCount}/min`}
        </span>
      </div>
      <svg
        width="100%"
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        preserveAspectRatio="none"
        style={{ display: 'block', height: CHART_HEIGHT }}
      >
        <rect
          x={0}
          y={0}
          width={CHART_WIDTH}
          height={CHART_HEIGHT}
          fill="rgba(255,255,255,0.02)"
        />
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={0}
            x2={CHART_WIDTH}
            y1={f * CHART_HEIGHT}
            y2={f * CHART_HEIGHT}
            stroke="rgba(255,255,255,0.04)"
          />
        ))}
        {grid.map((cell, i) => {
          if (cell.count === 0) return null
          const scale = maxCount > 0 ? CHART_HEIGHT / maxCount : 0
          const h = cell.count * scale
          const errH = cell.errorCount * scale
          const okH = h - errH
          const x = i * barWidth
          const w = Math.max(barWidth - 1, 1)
          const yOk = CHART_HEIGHT - h
          const yErr = CHART_HEIGHT - errH
          return (
            <g key={cell.startedAt}>
              {okH > 0 && (
                <rect x={x} y={yOk} width={w} height={okH} fill="#60a5fa" />
              )}
              {errH > 0 && (
                <rect x={x} y={yErr} width={w} height={errH} fill="#f87171" />
              )}
              <title>
                {`${new Date(cell.startedAt).toLocaleTimeString()} · ${cell.count} calls${
                  cell.errorCount > 0 ? ` (${cell.errorCount} errors)` : ''
                }`}
              </title>
            </g>
          )
        })}
      </svg>
      <div className="flex justify-between text-[10px] text-faint mt-0.5">
        <span>-60m</span>
        <span>-30m</span>
        <span>now</span>
      </div>
    </div>
  )
}

function FilterChip({
  active,
  onClick,
  label,
  count,
  tone
}: {
  active: boolean
  onClick: () => void
  label: string
  count: number
  tone?: 'ok' | 'warning' | 'error'
}): JSX.Element {
  const toneClass =
    tone === 'ok'
      ? 'text-success'
      : tone === 'warning'
        ? 'text-warning'
        : tone === 'error'
          ? 'text-danger'
          : 'text-fg'
  return (
    <button
      onClick={onClick}
      className={`text-xs px-2 py-1 rounded border ${
        active
          ? 'border-accent bg-accent/15 text-fg-bright'
          : 'border-border text-muted hover:bg-surface-hover'
      }`}
    >
      <span className={active ? '' : toneClass}>{label}</span>
      <span className="ml-1 text-faint">{count}</span>
    </button>
  )
}
