import type { RendererPerfSample } from '../shared/perf-types'

export type { RendererPerfSample }

// Renderer-process performance instrumentation.
//
// This is deliberately NOT slice state. Two clients viewing the same workspace
// have two separate renderers with their own heaps, their own long tasks and
// their own frame budget — there is no shared truth to mirror. It's also
// high-frequency, which the "high-frequency streams" rule keeps out of the
// reducer regardless.
//
// The main process is structurally blind to everything measured here. A GC
// pause happens *between* tasks, in a different process from the one
// perf-monitor's event-loop sampler watches, so a renderer stalling for 300ms
// on grammar construction and garbage collection looks perfectly calm from
// main. Long tasks and heap churn are the two signals that catch it.
//
// Everything is aggregated into 1-second buckets in memory. Nothing is logged
// or sent per event — `longtask` can fire continuously under load, and the
// telemetry becoming the bottleneck is a mistake this codebase has already
// made once (perf.log reached 184MB of synchronous appends).

const HISTORY_SIZE = 120
const BUCKET_MS = 1000

/** Chromium's own long-task cutoff; blocking time is measured beyond it. */
const LONG_TASK_MS = 50

/** Report an input event only if it took longer than this end-to-end. */
const SLOW_EVENT_MS = 40

/** Emit a sample even when nothing is wrong, so perf.log always carries
 *  recent renderer heap for after-the-fact forensics. */
const HEARTBEAT_MS = 30000

export const THRESHOLDS = {
  /** ~3 dropped frames of blocking in one second. */
  blockingMs: 50,
  /** A single stall long enough to feel like a hitch rather than jank. */
  longTaskMaxMs: 100,
  /** The signal the old 16ms-per-commit gate could not see: hundreds of
   *  individually-fine commits that add up to a bad second. */
  reactTotalMs: 50,
  slowEventMaxMs: 100,
  /** Sustained allocate-and-collect churn — the RSS sawtooth. */
  heapReclaimedMB: 50,
} as const

/** Which thresholds a bucket tripped. Pure so it can be tested without a DOM.
 *  Empty result means the sample is only worth emitting as a heartbeat.
 *
 *  The time-integral metrics are compared per elapsed second, not per bucket.
 *  Chromium throttles timers in hidden windows, so a backgrounded renderer can
 *  hand us a 60-second "bucket" — flagging its raw totals would cry wolf every
 *  time the user switched apps, and a profiler that cries wolf gets ignored,
 *  which is the failure mode this whole module exists to fix. */
export function computeFlags(sample: Omit<RendererPerfSample, 'flags'>): string[] {
  const seconds = Math.max(sample.elapsedMs, 1) / 1000
  const flags: string[] = []
  if (sample.blockingMs / seconds >= THRESHOLDS.blockingMs) flags.push('blocking')
  if (sample.longTaskMaxMs >= THRESHOLDS.longTaskMaxMs) flags.push('longtask')
  if (sample.reactProfiling && sample.reactTotalMs / seconds >= THRESHOLDS.reactTotalMs)
    flags.push('react')
  if (sample.slowEventMaxMs >= THRESHOLDS.slowEventMaxMs) flags.push('input')
  if (sample.heapReclaimedMB >= THRESHOLDS.heapReclaimedMB) flags.push('gc')
  return flags
}

interface HeapReading {
  usedMB: number
  totalMB: number
  limitMB: number
}

function readHeap(): HeapReading | null {
  const perf = performance as unknown as {
    memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number }
  }
  const m = perf.memory
  if (!m) return null
  return {
    usedMB: m.usedJSHeapSize / 1024 / 1024,
    totalMB: m.totalJSHeapSize / 1024 / 1024,
    limitMB: m.jsHeapSizeLimit / 1024 / 1024,
  }
}

function round(n: number): number {
  return Math.round(n * 10) / 10
}

class RendererPerf {
  private longTasks = 0
  private longTaskTotalMs = 0
  private longTaskMaxMs = 0
  private blockingMs = 0

  private slowEvents = 0
  private slowEventMaxMs = 0
  private slowEventName: string | null = null

  private reactProfiling = false
  private reactCommits = 0
  private reactTotalMs = 0
  private reactMaxMs = 0

  private lastHeapUsedMB: number | null = null

  private history: RendererPerfSample[] = []
  private head = 0
  private len = 0
  private latest: RendererPerfSample = emptySample()

  private observers: PerformanceObserver[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private lastEmitAt = 0
  private lastTickAt = 0

  private report: ((sample: RendererPerfSample) => void) | null = null

  start(report: (sample: RendererPerfSample) => void): void {
    if (this.timer) return
    this.report = report

    this.observeLongTasks()
    this.observeSlowEvents()

    this.lastTickAt = Date.now()
    this.timer = setInterval(() => this.tick(), BUCKET_MS)
  }

  /** Declared by whichever entry mounted the root <Profiler>. Without it every
   *  react* field stays 0, and 0 is indistinguishable from an idle app — the
   *  flag is what lets consumers say "not measured" instead. */
  markReactProfilingEnabled(): void {
    this.reactProfiling = true
  }

  /** Called from the root <Profiler>'s onRender for every React commit.
   *  Counter bumps only — no threshold check, no IPC, nothing that could make
   *  the measurement part of what it measures. */
  recordCommit(actualDuration: number): void {
    this.reactCommits++
    this.reactTotalMs += actualDuration
    if (actualDuration > this.reactMaxMs) this.reactMaxMs = actualDuration
  }

  private observeLongTasks(): void {
    // Not implemented outside Chromium; the web client may run anywhere.
    if (typeof PerformanceObserver === 'undefined') return
    try {
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const d = entry.duration
          this.longTasks++
          this.longTaskTotalMs += d
          if (d > this.longTaskMaxMs) this.longTaskMaxMs = d
          this.blockingMs += Math.max(0, d - LONG_TASK_MS)
        }
      })
      obs.observe({ entryTypes: ['longtask'] })
      this.observers.push(obs)
    } catch {
      // Unsupported entry type — leave the counters at zero.
    }
  }

  private observeSlowEvents(): void {
    if (typeof PerformanceObserver === 'undefined') return
    try {
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const d = entry.duration
          if (d < SLOW_EVENT_MS) continue
          this.slowEvents++
          if (d > this.slowEventMaxMs) {
            this.slowEventMaxMs = d
            this.slowEventName = entry.name
          }
        }
      })
      obs.observe({ type: 'event', durationThreshold: SLOW_EVENT_MS } as PerformanceObserverInit)
      this.observers.push(obs)
    } catch {
      // Event Timing unsupported.
    }
  }

  private tick(): void {
    const now = Date.now()
    const elapsedMs = this.lastTickAt === 0 ? BUCKET_MS : Math.max(1, now - this.lastTickAt)
    this.lastTickAt = now

    const heap = readHeap()
    const usedMB = heap?.usedMB ?? 0
    const prev = this.lastHeapUsedMB
    const delta = prev === null ? 0 : usedMB - prev
    this.lastHeapUsedMB = heap ? usedMB : null

    const base: Omit<RendererPerfSample, 'flags'> = {
      t: now,
      elapsedMs,
      longTasks: this.longTasks,
      longTaskTotalMs: round(this.longTaskTotalMs),
      longTaskMaxMs: round(this.longTaskMaxMs),
      blockingMs: round(this.blockingMs),
      slowEvents: this.slowEvents,
      slowEventMaxMs: round(this.slowEventMaxMs),
      slowEventName: this.slowEventName,
      heapUsedMB: round(usedMB),
      heapTotalMB: round(heap?.totalMB ?? 0),
      heapLimitMB: round(heap?.limitMB ?? 0),
      heapGrowthMB: round(Math.max(0, delta)),
      heapReclaimedMB: round(Math.max(0, -delta)),
      reactProfiling: this.reactProfiling,
      reactCommits: this.reactCommits,
      reactTotalMs: round(this.reactTotalMs),
      reactMaxMs: round(this.reactMaxMs),
    }
    const sample: RendererPerfSample = { ...base, flags: computeFlags(base) }

    this.latest = sample
    this.push(sample)
    this.resetBucket()

    // At most one signal per second under pathology, one per 30s at idle.
    const heartbeatDue = sample.t - this.lastEmitAt >= HEARTBEAT_MS
    if (sample.flags.length > 0 || heartbeatDue) {
      this.lastEmitAt = sample.t
      this.report?.(sample)
    }
  }

  private resetBucket(): void {
    this.longTasks = 0
    this.longTaskTotalMs = 0
    this.longTaskMaxMs = 0
    this.blockingMs = 0
    this.slowEvents = 0
    this.slowEventMaxMs = 0
    this.slowEventName = null
    this.reactCommits = 0
    this.reactTotalMs = 0
    this.reactMaxMs = 0
  }

  getLatest(): RendererPerfSample {
    return this.latest
  }

  getHistory(): RendererPerfSample[] {
    const out: RendererPerfSample[] = []
    for (let i = 0; i < this.len; i++) {
      out.push(this.history[(this.head + i) % HISTORY_SIZE])
    }
    return out
  }

  stop(): void {
    for (const o of this.observers) o.disconnect()
    this.observers = []
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private push(s: RendererPerfSample): void {
    if (this.len < HISTORY_SIZE) {
      this.history[this.len] = s
      this.len++
    } else {
      this.history[this.head] = s
      this.head = (this.head + 1) % HISTORY_SIZE
    }
  }
}

function emptySample(): RendererPerfSample {
  return {
    t: 0,
    elapsedMs: BUCKET_MS,
    longTasks: 0,
    longTaskTotalMs: 0,
    longTaskMaxMs: 0,
    blockingMs: 0,
    slowEvents: 0,
    slowEventMaxMs: 0,
    slowEventName: null,
    heapUsedMB: 0,
    heapTotalMB: 0,
    heapLimitMB: 0,
    heapGrowthMB: 0,
    heapReclaimedMB: 0,
    reactProfiling: false,
    reactCommits: 0,
    reactTotalMs: 0,
    reactMaxMs: 0,
    flags: [],
  }
}

export const rendererPerf = new RendererPerf()
