import { describe, it, expect } from 'vitest'
import { computeFlags, THRESHOLDS } from './renderer-perf'
import type { RendererPerfSample } from '../shared/perf-types'

function bucket(overrides: Partial<RendererPerfSample> = {}): Omit<RendererPerfSample, 'flags'> {
  const { flags: _flags, ...rest } = {
    t: 0,
    elapsedMs: 1000,
    longTasks: 0,
    longTaskTotalMs: 0,
    longTaskMaxMs: 0,
    blockingMs: 0,
    slowEvents: 0,
    slowEventMaxMs: 0,
    slowEventName: null,
    heapUsedMB: 100,
    heapTotalMB: 200,
    heapLimitMB: 4096,
    heapGrowthMB: 0,
    heapReclaimedMB: 0,
    reactProfiling: true,
    reactCommits: 0,
    reactTotalMs: 0,
    reactMaxMs: 0,
    flags: [],
    ...overrides,
  }
  return rest
}

describe('computeFlags', () => {
  it('flags nothing for an idle bucket', () => {
    expect(computeFlags(bucket())).toEqual([])
  })

  it('flags sustained blocking time', () => {
    expect(computeFlags(bucket({ blockingMs: THRESHOLDS.blockingMs }))).toContain('blocking')
  })

  it('flags a single long stall', () => {
    expect(computeFlags(bucket({ longTaskMaxMs: 250 }))).toContain('longtask')
  })

  it('flags heavy input latency', () => {
    expect(computeFlags(bucket({ slowEvents: 1, slowEventMaxMs: 180 }))).toContain('input')
  })

  it('flags allocate-and-collect churn', () => {
    expect(computeFlags(bucket({ heapReclaimedMB: 300 }))).toContain('gc')
  })

  // The regression this instrumentation exists for: the old per-commit gate
  // was 16ms, so a second made of many sub-16ms commits scored zero. The
  // aggregate has to catch it.
  it('flags death by a thousand sub-frame commits', () => {
    const manySmallCommits = bucket({ reactCommits: 40, reactTotalMs: 180, reactMaxMs: 6 })
    expect(manySmallCommits.reactMaxMs).toBeLessThan(16)
    expect(computeFlags(manySmallCommits)).toContain('react')
  })

  it('does not flag a quiet second with one cheap commit', () => {
    expect(computeFlags(bucket({ reactCommits: 1, reactTotalMs: 3, reactMaxMs: 3 }))).toEqual([])
  })

  it('never flags react when profiling is off, whatever the counters say', () => {
    const notMeasured = bucket({ reactProfiling: false, reactCommits: 40, reactTotalMs: 180 })
    expect(computeFlags(notMeasured)).not.toContain('react')
  })

  // Chromium throttles timers in hidden windows, so a backgrounded renderer
  // hands back one enormous bucket. Flagging its raw totals would fire every
  // time the user switched apps.
  it('normalizes time-integral metrics over a throttled window', () => {
    const throttled = bucket({ elapsedMs: 60000, blockingMs: 400, reactTotalMs: 400 })
    expect(computeFlags(throttled)).toEqual([])

    const sameTotalsInOneSecond = bucket({ blockingMs: 400, reactTotalMs: 400 })
    expect(computeFlags(sameTotalsInOneSecond).sort()).toEqual(['blocking', 'react'])
  })

  it('still flags a single long stall inside a throttled window', () => {
    // A max, not a rate — 300ms of unresponsiveness happened regardless of
    // how long the window was.
    expect(computeFlags(bucket({ elapsedMs: 60000, longTaskMaxMs: 300 }))).toContain('longtask')
  })

  it('reports every tripped threshold, not just the first', () => {
    const bad = bucket({
      blockingMs: 400,
      longTaskMaxMs: 300,
      reactTotalMs: 200,
      slowEventMaxMs: 250,
      slowEvents: 3,
      heapReclaimedMB: 120,
    })
    expect(computeFlags(bad).sort()).toEqual(['blocking', 'gc', 'input', 'longtask', 'react'])
  })
})
