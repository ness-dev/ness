import type { Store } from './store'
import type { PerfMetrics, PerfSample, RendererPerfSample } from '../shared/perf-types'
import { perfLog } from './perf-log'

export type { PerfMetrics, PerfSample }

/** Renderer samples arrive at most once a second, so this only ever formats
 *  lines that are already being written. */
export function formatRendererSample(s: RendererPerfSample): string {
  const parts = [
    `heap=${s.heapUsedMB}/${s.heapTotalMB}MB`,
    `churn=+${s.heapGrowthMB}/-${s.heapReclaimedMB}MB`,
    `longtasks=${s.longTasks}`,
    `blocked=${s.blockingMs}ms`,
    `maxtask=${s.longTaskMaxMs}ms`,
    s.reactProfiling ? `react=${s.reactCommits}c/${s.reactTotalMs}ms` : 'react=n/a'
  ]
  if (s.slowEvents > 0) {
    parts.push(`input=${s.slowEventMaxMs}ms(${s.slowEventName ?? '?'})`)
  }
  // Only worth printing when the window wasn't the nominal second — it means
  // the window was hidden and timers were throttled, so the totals above cover
  // far more than a second of wall time.
  if (s.elapsedMs > 1500) parts.push(`window=${(s.elapsedMs / 1000).toFixed(1)}s`)
  if (s.flags.length > 0) parts.push(`flags=${s.flags.join(',')}`)
  return parts.join(' ')
}

const HISTORY_SIZE = 120
const LAG_CHECK_INTERVAL_MS = 500
const LAG_SPIKE_THRESHOLD_MS = 100
const SNAPSHOT_INTERVAL_MS = 30000
const MICROTASK_PROBE_INTERVAL_MS = 50
const MICROTASK_DRIFT_THRESHOLD_MS = 50

/** Real per-process renderer usage, measured from main via app.getAppMetrics().
 *  The renderer's own `performance.memory` is quantized and ~20min stale. */
export interface RendererProcessMetrics {
  rssMB: number
  cpuPct: number
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

export class PerfMonitor {
  private storeEventCount = 0
  private storeEventsPerSec = 0
  private eventTypeCountsCurrent: Record<string, number> = {}

  private ipcMessageCount = 0
  private ipcMessagesPerSec = 0

  private githubApiCallCount = 0
  private githubApiCallsPerSec = 0
  // 60 one-minute buckets. Current write position rotates as wall-clock
  // minutes elapse; sum across all 60 = calls in the last hour.
  private githubApiCallsByMinute: number[] = new Array(60).fill(0)
  private githubMinuteIndex = 0
  private githubLastMinuteAt = 0

  private terminalBytes: Record<string, number> = {}
  private terminalBytesPerSec: Record<string, number> = {}
  private totalTerminalBytesPerSec = 0

  private eventLoopLagMs = 0
  private lagExpected = 0
  private lagTimer: NodeJS.Timeout | null = null
  private rateTimer: NodeJS.Timeout | null = null
  private snapshotTimer: NodeJS.Timeout | null = null
  private microtaskTimer: NodeJS.Timeout | null = null
  private microtaskLastTick = 0
  private startTime = Date.now()

  // Ring buffer: fixed capacity HISTORY_SIZE, oldest at head / newest at tail.
  private history: PerfSample[] = []
  private historyHead = 0
  private historyLen = 0

  private activePtyCountFn: (() => number) | null = null
  private unsubscribe: (() => void) | null = null

  // Latest bucket reported by a renderer, kept only so the periodic snapshot
  // can name both heaps. Before this, `[snapshot]` reported the main heap
  // under a bare `memoryHeapUsedMB` — it read 30MB while the renderer sat at
  // 900MB, which is worse than not reporting memory at all.
  private lastRendererSample: RendererPerfSample | null = null

  // Real renderer RSS/CPU, sampled in main. The renderer CANNOT measure its
  // own memory usefully: `performance.memory` is quantized and Chrome serves a
  // cached value for ~20 minutes on pages that aren't cross-origin isolated.
  // Observed in the wild — heapUsedMB sat at exactly 560.8 for 40 minutes
  // across 617 samples (9 distinct values in an entire log) while the real RSS
  // swung 600MB inside 30 seconds. So the renderer's heap* fields cannot show
  // an allocate-and-collect sawtooth, which is precisely the shape this
  // telemetry exists to catch. Injected rather than imported so the headless
  // build doesn't pull in electron; null there, and the fields log as null.
  private rendererProcessMetricsFn: (() => RendererProcessMetrics | null) | null = null

  setRendererProcessMetricsProvider(fn: () => RendererProcessMetrics | null): void {
    this.rendererProcessMetricsFn = fn
  }

  start(store: Store, getActivePtyCount: () => number): void {
    this.activePtyCountFn = getActivePtyCount
    this.startTime = Date.now()
    this.githubLastMinuteAt = Date.now()

    this.unsubscribe = store.subscribe((event) => {
      this.storeEventCount++
      this.eventTypeCountsCurrent[event.type] =
        (this.eventTypeCountsCurrent[event.type] || 0) + 1
    })

    // Rate calculation — every 1 second, snapshot the counters, push a sample,
    // and reset.
    this.rateTimer = setInterval(() => {
      this.storeEventsPerSec = this.storeEventCount
      this.ipcMessagesPerSec = this.ipcMessageCount
      this.githubApiCallsPerSec = this.githubApiCallCount

      let total = 0
      const tSnapshot: Record<string, number> = {}
      for (const [id, bytes] of Object.entries(this.terminalBytes)) {
        tSnapshot[id] = bytes
        total += bytes
      }
      this.terminalBytesPerSec = tSnapshot
      this.totalTerminalBytesPerSec = total

      const mem = process.memoryUsage()
      const sample: PerfSample = {
        t: Date.now(),
        storeEventsPerSec: this.storeEventsPerSec,
        ipcMessagesPerSec: this.ipcMessagesPerSec,
        githubApiCallsPerSec: this.githubApiCallsPerSec,
        totalTerminalBytesPerSec: total,
        eventLoopLagMs: this.eventLoopLagMs,
        memoryRssMB: Math.round(mem.rss / 1024 / 1024),
        memoryHeapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
        memoryHeapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
        eventTypeCounts: this.eventTypeCountsCurrent,
      }
      this.pushSample(sample)

      this.storeEventCount = 0
      this.ipcMessageCount = 0
      this.githubApiCallCount = 0
      this.terminalBytes = {}
      this.eventTypeCountsCurrent = {}
    }, 1000)

    // Event loop lag detection
    this.lagExpected = Date.now() + LAG_CHECK_INTERVAL_MS
    this.lagTimer = setInterval(() => {
      const now = Date.now()
      this.eventLoopLagMs = Math.max(0, now - this.lagExpected)
      this.lagExpected = now + LAG_CHECK_INTERVAL_MS
      if (this.eventLoopLagMs >= LAG_SPIKE_THRESHOLD_MS) {
        perfLog('eventloop-spike', `${this.eventLoopLagMs}ms`, {
          lagMs: this.eventLoopLagMs,
          intervalMs: LAG_CHECK_INTERVAL_MS
        })
      }
    }, LAG_CHECK_INTERVAL_MS)

    // Periodic snapshot — cheap continuous trace (1 line / 30s) so we
    // can answer "what was the system doing at <timestamp>" after the fact.
    this.snapshotTimer = setInterval(() => this.writeSnapshot(), SNAPSHOT_INTERVAL_MS)

    // Higher-resolution main-thread block detector. Drift is the time
    // beyond the expected interval that elapsed before this timer fired —
    // i.e. how long the event loop was blocked on synchronous work.
    this.microtaskLastTick = performance.now()
    this.microtaskTimer = setInterval(() => {
      const now = performance.now()
      const drift = now - this.microtaskLastTick - MICROTASK_PROBE_INTERVAL_MS
      if (drift > MICROTASK_DRIFT_THRESHOLD_MS) {
        perfLog('microtask-drift', `${drift.toFixed(0)}ms`, { driftMs: +drift.toFixed(1) })
      }
      this.microtaskLastTick = now
    }, MICROTASK_PROBE_INTERVAL_MS)
  }

  private writeSnapshot(): void {
    const mem = process.memoryUsage()
    const rssMB = Math.round(mem.rss / 1024 / 1024)
    const heapMB = Math.round(mem.heapUsed / 1024 / 1024)
    const ptys = this.activePtyCountFn?.() ?? 0
    const top: Array<[string, number]> = Object.entries(this.eventTypeCountsCurrent)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
    const r = this.lastRendererSample
    const rp = this.rendererProcessMetricsFn?.() ?? null
    // rendererRss is the trustworthy number; rendererHeap is quantized and can
    // be up to ~20 minutes stale (see rendererProcessMetricsFn). Keep the label
    // explicit so nobody reads the heap figure as a live value again.
    const rssPart = rp ? ` rendererRss=${rp.rssMB}MB rendererCpu=${rp.cpuPct}%` : ''
    // The renderer's bucket is nominally 1s but stretches without bound when
    // its timer is starved — a DevTools heap snapshot produced a single 104s
    // bucket. So `blockingMs` is a per-bucket total, not a rate, and dividing
    // by a presumed 1s overstated blocking by 20-100x. Normalize here and log
    // the window alongside so the raw total stays recoverable.
    const bucketSec = r ? Math.max(r.elapsedMs, 1) / 1000 : 1
    const blockedPerSec = r ? Math.round(r.blockingMs / bucketSec) : null
    const rendererPart = r
      ? `${rssPart} rendererHeapQuantized=${r.heapUsedMB}MB rendererBlocked=${blockedPerSec}ms/s window=${bucketSec.toFixed(1)}s`
      : `${rssPart} rendererHeapQuantized=n/a`
    perfLog(
      'snapshot',
      `store=${this.storeEventsPerSec}/s ipc=${this.ipcMessagesPerSec}/s gh=${this.githubApiCallsPerSec}/s term=${formatBytes(this.totalTerminalBytesPerSec)}/s lag=${this.eventLoopLagMs}ms mainRss=${rssMB}MB${rendererPart} ptys=${ptys}`,
      {
        storeEventsPerSec: this.storeEventsPerSec,
        ipcMessagesPerSec: this.ipcMessagesPerSec,
        githubApiCallsPerSec: this.githubApiCallsPerSec,
        totalTerminalBytesPerSec: this.totalTerminalBytesPerSec,
        eventLoopLagMs: this.eventLoopLagMs,
        mainRssMB: rssMB,
        mainHeapUsedMB: heapMB,
        rendererRssMB: rp?.rssMB ?? null,
        rendererCpuPct: rp?.cpuPct ?? null,
        // Suffixed, not bare: these come from `performance.memory` and are
        // quantized + cached for ~20min, so a delta between two adjacent
        // snapshots is meaningless. Compare rendererRssMB instead.
        rendererHeapUsedMBQuantized: r?.heapUsedMB ?? null,
        rendererHeapTotalMBQuantized: r?.heapTotalMB ?? null,
        rendererBlockingMsPerSec: blockedPerSec,
        rendererLongTasksPerSec: r ? Math.round(r.longTasks / bucketSec) : null,
        rendererBlockingMsTotal: r?.blockingMs ?? null,
        rendererLongTasksTotal: r?.longTasks ?? null,
        rendererBucketMs: r?.elapsedMs ?? null,
        rendererSampleAgeMs: r ? Date.now() - r.t : null,
        activePtyCount: ptys,
        topEventTypes: Object.fromEntries(top)
      }
    )
  }

  recordRendererSample(sample: RendererPerfSample): void {
    this.lastRendererSample = sample
  }

  recordIpcMessage(): void {
    this.ipcMessageCount++
  }

  recordGitHubApiCall(): void {
    this.advanceGithubMinuteIfNeeded()
    this.githubApiCallCount++
    this.githubApiCallsByMinute[this.githubMinuteIndex]++
  }

  private advanceGithubMinuteIfNeeded(): void {
    const now = Date.now()
    const elapsed = now - this.githubLastMinuteAt
    if (elapsed < 60_000) return
    let minutesElapsed = Math.floor(elapsed / 60_000)
    if (minutesElapsed > 60) minutesElapsed = 60
    for (let i = 0; i < minutesElapsed; i++) {
      this.githubMinuteIndex = (this.githubMinuteIndex + 1) % 60
      this.githubApiCallsByMinute[this.githubMinuteIndex] = 0
    }
    this.githubLastMinuteAt = now - (elapsed % 60_000)
  }

  private getGithubApiCallsLastHour(): number {
    this.advanceGithubMinuteIfNeeded()
    let sum = 0
    for (const c of this.githubApiCallsByMinute) sum += c
    return sum
  }

  recordTerminalBytes(id: string, byteCount: number): void {
    this.terminalBytes[id] = (this.terminalBytes[id] || 0) + byteCount
  }

  getMetrics(): PerfMetrics {
    const mem = process.memoryUsage()
    return {
      storeEventsPerSec: this.storeEventsPerSec,
      ipcMessagesPerSec: this.ipcMessagesPerSec,
      githubApiCallsPerSec: this.githubApiCallsPerSec,
      githubApiCallsLastHour: this.getGithubApiCallsLastHour(),
      terminalBytesPerSec: { ...this.terminalBytesPerSec },
      totalTerminalBytesPerSec: this.totalTerminalBytesPerSec,
      activePtyCount: this.activePtyCountFn?.() ?? 0,
      eventLoopLagMs: this.eventLoopLagMs,
      memoryMB: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      },
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      history: this.getHistory(),
    }
  }

  getHistory(): PerfSample[] {
    const out: PerfSample[] = []
    for (let i = 0; i < this.historyLen; i++) {
      const idx = (this.historyHead + i) % HISTORY_SIZE
      out.push(this.history[idx])
    }
    return out
  }

  stop(): void {
    if (this.rateTimer) clearInterval(this.rateTimer)
    if (this.lagTimer) clearInterval(this.lagTimer)
    if (this.snapshotTimer) clearInterval(this.snapshotTimer)
    if (this.microtaskTimer) clearInterval(this.microtaskTimer)
    this.unsubscribe?.()
  }

  private pushSample(sample: PerfSample): void {
    if (this.historyLen < HISTORY_SIZE) {
      this.history[this.historyLen] = sample
      this.historyLen++
    } else {
      this.history[this.historyHead] = sample
      this.historyHead = (this.historyHead + 1) % HISTORY_SIZE
    }
  }
}
