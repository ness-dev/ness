export interface PerfSample {
  t: number
  storeEventsPerSec: number
  ipcMessagesPerSec: number
  githubApiCallsPerSec: number
  totalTerminalBytesPerSec: number
  eventLoopLagMs: number
  memoryRssMB: number
  memoryHeapUsedMB: number
  memoryHeapTotalMB: number
  eventTypeCounts: Record<string, number>
}

// One second of renderer-process activity, aggregated in the renderer and
// shipped to main over a fire-and-forget signal. Everything here is invisible
// to the main process: a GC pause or a layout thrash happens in a different
// process than the one perf-monitor's event-loop sampler watches.
export interface RendererPerfSample {
  t: number
  /** Wall time this bucket actually covers. Nominally 1000ms, but Chromium
   *  throttles timers in hidden windows, so it can be far longer. Counts
   *  below are totals over this window, not per-second rates. */
  elapsedMs: number
  /** Tasks the browser reported as >50ms. Catches GC, layout, non-React work. */
  longTasks: number
  longTaskTotalMs: number
  longTaskMaxMs: number
  /** Total Blocking Time: sum of each long task's duration beyond 50ms. */
  blockingMs: number
  /** Input events whose end-to-end duration exceeded the observer threshold. */
  slowEvents: number
  slowEventMaxMs: number
  slowEventName: string | null
  heapUsedMB: number
  heapTotalMB: number
  heapLimitMB: number
  /** Heap delta since the previous sample, split by sign. A large reclaimed
   *  value is the only direct evidence of a major GC we can observe from JS. */
  heapGrowthMB: number
  heapReclaimedMB: number
  /** False unless the build aliased react-dom/client to react-dom/profiling
   *  (HARNESS_REACT_PROFILING=1). When false the three react* fields below are
   *  not measurements — render them as "n/a", never as 0. */
  reactProfiling: boolean
  reactCommits: number
  reactTotalMs: number
  reactMaxMs: number
  /** Which thresholds this bucket tripped. Empty means it's a heartbeat. */
  flags: string[]
}

export interface PerfMetrics {
  storeEventsPerSec: number
  ipcMessagesPerSec: number
  githubApiCallsPerSec: number
  githubApiCallsLastHour: number
  terminalBytesPerSec: Record<string, number>
  totalTerminalBytesPerSec: number
  activePtyCount: number
  eventLoopLagMs: number
  memoryMB: { rss: number; heapUsed: number; heapTotal: number }
  uptimeSeconds: number
  history: PerfSample[]
}
