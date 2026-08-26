import { describe, it, expect } from 'vitest'
import { formatRendererSample } from './perf-monitor'
import type { RendererPerfSample } from '../shared/perf-types'

function sample(overrides: Partial<RendererPerfSample> = {}): RendererPerfSample {
  return {
    t: 0,
    elapsedMs: 1000,
    longTasks: 0,
    longTaskTotalMs: 0,
    longTaskMaxMs: 0,
    blockingMs: 0,
    slowEvents: 0,
    slowEventMaxMs: 0,
    slowEventName: null,
    heapUsedMB: 70,
    heapTotalMB: 90,
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
}

describe('formatRendererSample', () => {
  it('always reports heap, churn, long tasks and React time', () => {
    const line = formatRendererSample(sample({ reactCommits: 6, reactTotalMs: 15.5 }))
    expect(line).toContain('heap=70/90MB')
    expect(line).toContain('churn=+0/-0MB')
    expect(line).toContain('longtasks=0')
    expect(line).toContain('react=6c/15.5ms')
  })

  // A zero here reads as "React is idle", which sent two perf investigations
  // to the wrong process. Unmeasured has to look unmeasured.
  it('reports React as n/a when the build did not enable profiling', () => {
    const line = formatRendererSample(sample({ reactProfiling: false }))
    expect(line).toContain('react=n/a')
    expect(line).not.toContain('0c/')
  })

  it('omits input latency when no slow events occurred', () => {
    expect(formatRendererSample(sample())).not.toContain('input=')
  })

  it('names the worst input event when there was one', () => {
    const line = formatRendererSample(
      sample({ slowEvents: 2, slowEventMaxMs: 180, slowEventName: 'keydown' })
    )
    expect(line).toContain('input=180ms(keydown)')
  })

  // Without this the reader has no way to tell a genuinely bad second from a
  // minute of throttled background time collapsed into one bucket.
  it('marks a throttled window so the totals can be read in context', () => {
    expect(formatRendererSample(sample({ elapsedMs: 60000 }))).toContain('window=60.0s')
  })

  it('leaves the marker off a normal-length bucket', () => {
    expect(formatRendererSample(sample({ elapsedMs: 1050 }))).not.toContain('window=')
  })

  it('lists tripped flags', () => {
    const line = formatRendererSample(sample({ flags: ['blocking', 'gc'] }))
    expect(line).toContain('flags=blocking,gc')
  })
})
