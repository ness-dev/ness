import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import type { PerfMetrics, PerfSample } from '../types'
import { rendererPerf, type RendererPerfSample } from '../renderer-perf'
import { useBackend } from '../backend'

const COLOR_NEUTRAL = '#9ca3af'
const COLOR_WARNING = '#fbbf24'
const COLOR_ERROR = '#f87171'

const LINE_COLORS = {
  storeEvents: '#60a5fa',
  ipcMessages: '#c084fc',
  githubApi: '#a78bfa',
  terminalBytes: '#34d399',
  eventLoopLag: '#fbbf24',
  memory: '#f472b6',
  reactCommits: '#22d3ee',
  reactRenderMs: '#fb923c',
  blockingMs: '#ef4444',
  rendererHeap: '#38bdf8',
} as const

type MetricKey = keyof typeof LINE_COLORS
type WindowMode = '1s' | '10s'

interface CombinedSample extends PerfSample {
  reactCommits: number
  reactRenderMs: number
  reactMaxMs: number
  blockingMs: number
  rendererHeap: number
}

/** Neither good nor bad — the number simply wasn't collected. */
const NOT_MEASURED_CLASS = 'text-faint'

function statusClass(value: number, green: number, amber: number): string {
  if (value < green) return 'text-success'
  if (value < amber) return 'text-warning'
  return 'text-error'
}

function fpsClass(fps: number): string {
  if (fps >= 50) return 'text-success'
  if (fps >= 30) return 'text-warning'
  return 'text-error'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B/s`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB/s`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB/s`
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m ${seconds % 60}s`
}

function formatPerSec(v: number): string {
  if (v >= 10) return `${v.toFixed(0)}/s`
  if (v >= 1) return `${v.toFixed(1)}/s`
  return `${v.toFixed(2)}/s`
}

function zipHistories(
  main: PerfSample[],
  render: RendererPerfSample[]
): CombinedSample[] {
  const n = Math.min(main.length, render.length)
  if (n === 0) return []
  const out: CombinedSample[] = []
  const mStart = main.length - n
  const rStart = render.length - n
  for (let i = 0; i < n; i++) {
    const m = main[mStart + i]
    const r = render[rStart + i]
    out.push({
      ...m,
      reactCommits: r.reactCommits,
      reactRenderMs: r.reactTotalMs,
      reactMaxMs: r.reactMaxMs,
      blockingMs: r.blockingMs,
      rendererHeap: r.heapUsedMB,
    })
  }
  return out
}

function downsample(samples: CombinedSample[], bucketSize: number): CombinedSample[] {
  if (bucketSize <= 1 || samples.length === 0) return samples
  const out: CombinedSample[] = []
  for (let i = 0; i < samples.length; i += bucketSize) {
    const bucket = samples.slice(i, i + bucketSize)
    if (bucket.length === 0) continue
    const n = bucket.length
    const merged: Record<string, number> = {}
    let ss = 0,
      is = 0,
      ga = 0,
      ts = 0,
      ls = 0,
      rs = 0,
      hus = 0,
      hts = 0,
      rc = 0,
      rm = 0,
      rx = 0,
      bm = 0,
      rh = 0
    for (const s of bucket) {
      bm += s.blockingMs
      rh += s.rendererHeap
      ss += s.storeEventsPerSec
      is += s.ipcMessagesPerSec
      ga += s.githubApiCallsPerSec
      ts += s.totalTerminalBytesPerSec
      ls += s.eventLoopLagMs
      rs += s.memoryRssMB
      hus += s.memoryHeapUsedMB
      hts += s.memoryHeapTotalMB
      rc += s.reactCommits
      rm += s.reactRenderMs
      if (s.reactMaxMs > rx) rx = s.reactMaxMs
      for (const [k, v] of Object.entries(s.eventTypeCounts)) {
        merged[k] = (merged[k] || 0) + v
      }
    }
    const avg: Record<string, number> = {}
    for (const [k, v] of Object.entries(merged)) avg[k] = v / n
    out.push({
      t: bucket[bucket.length - 1].t,
      storeEventsPerSec: ss / n,
      ipcMessagesPerSec: is / n,
      githubApiCallsPerSec: ga / n,
      totalTerminalBytesPerSec: ts / n,
      eventLoopLagMs: ls / n,
      memoryRssMB: rs / n,
      memoryHeapUsedMB: hus / n,
      memoryHeapTotalMB: hts / n,
      eventTypeCounts: avg,
      reactCommits: rc / n,
      reactRenderMs: rm / n,
      reactMaxMs: rx,
      blockingMs: bm / n,
      rendererHeap: rh / n,
    })
  }
  return out
}

// Stable per-event-type color via FNV-1a hash → HSL hue.
function typeColor(type: string): string {
  let h = 2166136261
  for (let i = 0; i < type.length; i++) {
    h ^= type.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return `hsl(${(h >>> 0) % 360}, 62%, 58%)`
}

function aggregateEventTypes(
  samples: CombinedSample[]
): Array<{ type: string; perSec: number }> {
  if (samples.length === 0) return []
  const totals = new Map<string, number>()
  for (const s of samples) {
    for (const [type, count] of Object.entries(s.eventTypeCounts)) {
      totals.set(type, (totals.get(type) || 0) + count)
    }
  }
  return Array.from(totals.entries())
    .map(([type, count]) => ({ type, perSec: count / samples.length }))
    .filter((e) => e.perSec > 0)
    .sort((a, b) => b.perSec - a.perSec)
}

const CHART_WIDTH = 560
const LINE_H = 120
const BAR_H = 60
const GAP = 6
const CHART_H = LINE_H + GAP + BAR_H

function Chart({
  samples,
  enabled,
}: {
  samples: CombinedSample[]
  enabled: Set<MetricKey>
}): JSX.Element {
  const barBaseY = LINE_H + GAP

  if (samples.length === 0) {
    return (
      <svg width={CHART_WIDTH} height={CHART_H} style={{ display: 'block' }}>
        <rect x={0} y={0} width={CHART_WIDTH} height={LINE_H} fill="rgba(255,255,255,0.02)" />
        <rect x={0} y={barBaseY} width={CHART_WIDTH} height={BAR_H} fill="rgba(255,255,255,0.02)" />
        <text
          x={CHART_WIDTH / 2}
          y={CHART_H / 2}
          fill="#555"
          fontSize={10}
          textAnchor="middle"
        >
          collecting samples…
        </text>
      </svg>
    )
  }

  const stepX = samples.length > 1 ? CHART_WIDTH / (samples.length - 1) : 0
  const barStep = CHART_WIDTH / samples.length
  const barWidth = Math.max(barStep - 0.5, 1)

  const series: Record<MetricKey, number[]> = {
    storeEvents: samples.map((s) => s.storeEventsPerSec),
    ipcMessages: samples.map((s) => s.ipcMessagesPerSec),
    githubApi: samples.map((s) => s.githubApiCallsPerSec),
    terminalBytes: samples.map((s) => s.totalTerminalBytesPerSec),
    eventLoopLag: samples.map((s) => s.eventLoopLagMs),
    memory: samples.map((s) => s.memoryRssMB),
    reactCommits: samples.map((s) => s.reactCommits),
    reactRenderMs: samples.map((s) => s.reactRenderMs),
    blockingMs: samples.map((s) => s.blockingMs),
    rendererHeap: samples.map((s) => s.rendererHeap),
  }

  // Event type stacked bars: order types by total descending so the biggest
  // slice is always anchored at the bottom and the stack stays stable.
  const typeTotals = new Map<string, number>()
  let maxBarSum = 0
  for (const s of samples) {
    let sum = 0
    for (const [t, c] of Object.entries(s.eventTypeCounts)) {
      typeTotals.set(t, (typeTotals.get(t) || 0) + c)
      sum += c
    }
    if (sum > maxBarSum) maxBarSum = sum
  }
  const typeOrder = Array.from(typeTotals.keys()).sort(
    (a, b) => (typeTotals.get(b) || 0) - (typeTotals.get(a) || 0)
  )
  const barScale = maxBarSum > 0 ? BAR_H / maxBarSum : 0

  return (
    <svg width={CHART_WIDTH} height={CHART_H} style={{ display: 'block' }}>
      <rect x={0} y={0} width={CHART_WIDTH} height={LINE_H} fill="rgba(255,255,255,0.02)" />
      <rect x={0} y={barBaseY} width={CHART_WIDTH} height={BAR_H} fill="rgba(255,255,255,0.02)" />

      {[0.25, 0.5, 0.75].map((f) => (
        <line
          key={f}
          x1={0}
          y1={f * LINE_H}
          x2={CHART_WIDTH}
          y2={f * LINE_H}
          stroke="rgba(255,255,255,0.04)"
        />
      ))}

      {samples.map((s, i) => {
        let ySum = 0
        return (
          <g key={i} transform={`translate(${i * barStep}, ${barBaseY})`}>
            {typeOrder.map((type) => {
              const c = s.eventTypeCounts[type] || 0
              if (c === 0) return null
              const h = c * barScale
              const y = BAR_H - ySum - h
              ySum += h
              return (
                <rect
                  key={type}
                  x={0}
                  y={y}
                  width={barWidth}
                  height={h}
                  fill={typeColor(type)}
                />
              )
            })}
          </g>
        )
      })}

      {(Object.keys(series) as MetricKey[]).map((key) => {
        if (!enabled.has(key)) return null
        const values = series[key]
        if (values.length < 2) return null
        const max = Math.max(...values, 1)
        const pts = values
          .map((v, i) => {
            const x = i * stepX
            const y = LINE_H - 1 - (v / max) * (LINE_H - 2)
            return `${x.toFixed(1)},${y.toFixed(1)}`
          })
          .join(' ')
        return (
          <polyline
            key={key}
            points={pts}
            fill="none"
            stroke={LINE_COLORS[key]}
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )
      })}
    </svg>
  )
}

interface Props {
  onClose: () => void
}

const HUD_WIDTH = 580

export function PerfMonitorHUD({ onClose }: Props): JSX.Element {
  const backend = useBackend()
  const [metrics, setMetrics] = useState<PerfMetrics | null>(null)
  const [renderHistory, setRenderHistory] = useState<RendererPerfSample[]>([])
  const [renderLatest, setRenderLatest] = useState<RendererPerfSample>(() =>
    rendererPerf.getLatest()
  )
  const [fps, setFps] = useState(60)
  const [windowMode, setWindowMode] = useState<WindowMode>('1s')
  // Only true under HARNESS_REACT_PROFILING=1; otherwise onRender never fires
  // and the react* fields are zeros, not measurements.
  const reactProfiling = renderLatest.reactProfiling
  const [enabledMetrics, setEnabledMetrics] = useState<Set<MetricKey>>(() => {
    const keys: MetricKey[] = [
      'storeEvents',
      'ipcMessages',
      'githubApi',
      'terminalBytes',
      'eventLoopLag',
      'memory',
      'blockingMs',
      'rendererHeap',
    ]
    if (rendererPerf.getLatest().reactProfiling) keys.push('reactCommits', 'reactRenderMs')
    return new Set<MetricKey>(keys)
  })
  const frameCountRef = useRef(0)
  const lastFpsTimeRef = useRef(performance.now())
  const rafRef = useRef(0)

  useEffect(() => {
    let running = true
    const tick = (): void => {
      if (!running) return
      frameCountRef.current++
      const now = performance.now()
      const elapsed = now - lastFpsTimeRef.current
      if (elapsed >= 1000) {
        setFps(Math.round((frameCountRef.current * 1000) / elapsed))
        frameCountRef.current = 0
        lastFpsTimeRef.current = now
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      running = false
      cancelAnimationFrame(rafRef.current)
    }
  }, [])

  useEffect(() => {
    let active = true
    const poll = async (): Promise<void> => {
      if (!active) return
      try {
        const m = await backend.getPerfMetrics()
        if (active) {
          setMetrics(m)
          setRenderHistory(rendererPerf.getHistory())
          setRenderLatest(rendererPerf.getLatest())
        }
      } catch {
        // ignore
      }
    }
    void poll()
    const timer = setInterval(poll, 1000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [])

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onClose()
    },
    [onClose]
  )

  const toggleMetric = useCallback((key: MetricKey) => {
    setEnabledMetrics((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const windowed = useMemo(() => {
    const zipped = zipHistories(metrics?.history ?? [], renderHistory)
    return windowMode === '10s' ? downsample(zipped, 10) : zipped
  }, [metrics, renderHistory, windowMode])

  const eventRows = useMemo(() => aggregateEventTypes(windowed), [windowed])

  const metricDefs: Array<{
    key: MetricKey
    label: string
    value: string
    valueClassName: string
  }> = metrics
    ? [
        {
          key: 'storeEvents',
          label: 'Store events',
          value: `${metrics.storeEventsPerSec}/s`,
          valueClassName: statusClass(metrics.storeEventsPerSec, 20, 100),
        },
        {
          key: 'ipcMessages',
          label: 'IPC messages',
          value: `${metrics.ipcMessagesPerSec}/s`,
          valueClassName: statusClass(metrics.ipcMessagesPerSec, 30, 150),
        },
        {
          key: 'githubApi',
          label: 'GH API',
          value: formatPerSec(metrics.githubApiCallsPerSec),
          valueClassName: statusClass(metrics.githubApiCallsPerSec, 1, 5),
        },
        {
          key: 'terminalBytes',
          label: 'Terminal data',
          value: formatBytes(metrics.totalTerminalBytesPerSec),
          valueClassName: statusClass(
            metrics.totalTerminalBytesPerSec,
            100 * 1024,
            1024 * 1024
          ),
        },
        {
          key: 'eventLoopLag',
          label: 'Event loop',
          value: `${metrics.eventLoopLagMs}ms`,
          valueClassName: statusClass(metrics.eventLoopLagMs, 10, 50),
        },
        {
          key: 'memory',
          label: 'Memory (main)',
          value: `${metrics.memoryMB.rss} MB`,
          valueClassName: statusClass(metrics.memoryMB.rss, 200, 500),
        },
        {
          key: 'reactCommits',
          label: 'React commits',
          value: reactProfiling ? `${renderLatest.reactCommits}/s` : 'n/a',
          valueClassName: reactProfiling
            ? statusClass(renderLatest.reactCommits, 20, 60)
            : NOT_MEASURED_CLASS,
        },
        {
          key: 'reactRenderMs',
          label: 'React time',
          value: reactProfiling ? `${renderLatest.reactTotalMs.toFixed(1)}ms/s` : 'n/a',
          valueClassName: reactProfiling
            ? statusClass(renderLatest.reactTotalMs, 16, 50)
            : NOT_MEASURED_CLASS,
        },
        {
          key: 'blockingMs',
          label: 'Blocked (render)',
          value: `${renderLatest.blockingMs.toFixed(0)}ms/s`,
          valueClassName: statusClass(renderLatest.blockingMs, 10, 50),
        },
        {
          key: 'rendererHeap',
          label: 'Heap (render)',
          value: `${renderLatest.heapUsedMB.toFixed(0)} MB`,
          valueClassName: statusClass(renderLatest.heapUsedMB, 300, 700),
        },
      ]
    : []

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 16,
        right: 16,
        width: HUD_WIDTH,
        zIndex: 9999,
        pointerEvents: 'auto',
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
        fontSize: 12,
        lineHeight: '18px',
        backgroundColor: 'rgba(0, 0, 0, 0.88)',
        color: '#e0e0e0',
        borderRadius: 8,
        border: '1px solid rgba(255, 255, 255, 0.1)',
        overflow: 'hidden',
        backdropFilter: 'blur(8px)',
      }}
      tabIndex={-1}
    >
      <Header mode={windowMode} onModeChange={setWindowMode} onClose={handleClose} />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 1fr',
          gap: '2px 12px',
          padding: '6px 10px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <Scalar label="FPS" value={String(fps)} className={fpsClass(fps)} />
        <Scalar
          label="Active PTYs"
          value={metrics ? String(metrics.activePtyCount) : '—'}
        />
        <Scalar
          label="Uptime"
          value={metrics ? formatUptime(metrics.uptimeSeconds) : '—'}
        />
        <Scalar
          label="Heap (main)"
          value={metrics ? `${metrics.memoryMB.heapUsed} MB` : '—'}
        />
        <Scalar
          label="Long tasks"
          value={`${renderLatest.longTasks}/s`}
          className={statusClass(renderLatest.longTasks, 1, 4)}
        />
        <Scalar
          label="Max task"
          value={`${renderLatest.longTaskMaxMs.toFixed(0)}ms`}
          className={statusClass(renderLatest.longTaskMaxMs, 50, 100)}
        />
        <Scalar
          label="Max commit"
          value={reactProfiling ? `${renderLatest.reactMaxMs.toFixed(1)}ms` : 'n/a'}
          className={
            reactProfiling ? statusClass(renderLatest.reactMaxMs, 8, 16) : NOT_MEASURED_CLASS
          }
        />
        <Scalar
          label="GC churn"
          value={`-${renderLatest.heapReclaimedMB.toFixed(0)}/+${renderLatest.heapGrowthMB.toFixed(0)} MB`}
          className={statusClass(renderLatest.heapReclaimedMB, 20, 50)}
        />
        <Scalar
          label="Input lag"
          value={
            renderLatest.slowEvents > 0 ? `${renderLatest.slowEventMaxMs.toFixed(0)}ms` : '—'
          }
          className={statusClass(renderLatest.slowEventMaxMs, 50, 100)}
        />
        <Scalar
          label="GH (1h)"
          value={metrics ? String(metrics.githubApiCallsLastHour) : '—'}
          className={metrics ? statusClass(metrics.githubApiCallsLastHour, 500, 2000) : undefined}
        />
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '0 12px',
          padding: '6px 10px 4px',
        }}
      >
        {metricDefs.map((m) => (
          <MetricToggle
            key={m.key}
            label={m.label}
            value={m.value}
            color={LINE_COLORS[m.key]}
            valueClassName={m.valueClassName}
            enabled={enabledMetrics.has(m.key)}
            onToggle={() => toggleMetric(m.key)}
          />
        ))}
      </div>

      <div style={{ padding: '4px 10px 8px' }}>
        <Chart samples={windowed} enabled={enabledMetrics} />
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 9,
            color: '#555',
            marginTop: 2,
          }}
        >
          <span>
            {windowed.length}
            {windowMode === '10s' ? ' × 10s' : 's'} window · lines scaled per-metric
          </span>
          <span>events/sec stack →</span>
        </div>
      </div>

      {eventRows.length > 0 && (
        <div
          style={{
            padding: '6px 10px 8px',
            borderTop: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <div
            style={{
              fontSize: 10,
              color: '#777',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: 4,
            }}
          >
            Events by type · avg /sec
          </div>
          <div style={{ maxHeight: 140, overflowY: 'auto' }}>
            {eventRows.slice(0, 16).map((e) => (
              <div
                key={e.type}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '1px 0',
                  gap: 6,
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    background: typeColor(e.type),
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    color: '#aaa',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1,
                  }}
                >
                  {e.type}
                </span>
                <span
                  style={{
                    color:
                      e.perSec > 10
                        ? COLOR_ERROR
                        : e.perSec > 3
                          ? COLOR_WARNING
                          : COLOR_NEUTRAL,
                    flexShrink: 0,
                  }}
                >
                  {formatPerSec(e.perSec)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Header({
  mode,
  onModeChange,
  onClose,
}: {
  mode: WindowMode
  onModeChange: (m: WindowMode) => void
  onClose: (e: React.MouseEvent) => void
}): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '6px 10px',
        borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        color: '#999',
      }}
    >
      <span>Performance</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <WindowToggle mode={mode} onModeChange={onModeChange} />
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            color: '#999',
            cursor: 'pointer',
            fontSize: 14,
            lineHeight: 1,
            padding: '0 2px',
          }}
          tabIndex={-1}
        >
          &times;
        </button>
      </div>
    </div>
  )
}

function WindowToggle({
  mode,
  onModeChange,
}: {
  mode: WindowMode
  onModeChange: (m: WindowMode) => void
}): JSX.Element {
  const base: React.CSSProperties = {
    background: 'none',
    border: '1px solid rgba(255,255,255,0.15)',
    color: '#777',
    cursor: 'pointer',
    fontSize: 10,
    lineHeight: 1,
    padding: '2px 5px',
    fontFamily: 'inherit',
    textTransform: 'none',
    letterSpacing: 0,
  }
  const active: React.CSSProperties = {
    ...base,
    color: '#e0e0e0',
    background: 'rgba(255,255,255,0.08)',
  }
  return (
    <div style={{ display: 'flex', gap: 2 }}>
      {(['1s', '10s'] as const).map((m) => (
        <button
          key={m}
          onClick={() => onModeChange(m)}
          style={mode === m ? active : base}
          tabIndex={-1}
        >
          {m}
        </button>
      ))}
    </div>
  )
}

function Scalar({
  label,
  value,
  className,
}: {
  label: string
  value: string
  className?: string
}): JSX.Element {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <span style={{ color: '#999' }}>{label}</span>
      <span className={className}>{value}</span>
    </div>
  )
}

function MetricToggle({
  label,
  value,
  color,
  valueClassName,
  enabled,
  onToggle,
}: {
  label: string
  value: string
  color: string
  valueClassName?: string
  enabled: boolean
  onToggle: () => void
}): JSX.Element {
  return (
    <button
      onClick={onToggle}
      style={{
        background: 'none',
        border: 'none',
        padding: '2px 0',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 6,
        textAlign: 'left',
        fontFamily: 'inherit',
        fontSize: 12,
        color: enabled ? '#e0e0e0' : '#555',
        opacity: enabled ? 1 : 0.55,
      }}
      tabIndex={-1}
    >
      <span
        style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}
      >
        <span
          style={{
            width: 12,
            height: 2,
            background: enabled ? color : '#555',
            flexShrink: 0,
            borderRadius: 1,
          }}
        />
        <span
          style={{
            color: '#999',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </span>
      </span>
      <span className={enabled ? valueClassName : ''}>{value}</span>
    </button>
  )
}
