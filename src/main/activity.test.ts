import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('./debug', () => ({ log: () => {} }))

vi.mock('./paths', () => ({
  userDataDir: () => tmpUserData
}))

// Populated in beforeEach so each test gets a fresh dir.
let tmpUserData = ''

import {
  flushActivityWritesForTests,
  getActivityLog,
  pruneRemoved,
  recordActivity,
  resetActivityCacheForTests,
  sealAllActive,
  type ActivityLog
} from './activity'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_700_000_000_000

function rec(removedAt?: number): ActivityLog[string] {
  return { events: [{ t: NOW - 200 * DAY, s: 'processing' }], removedAt }
}

function writeLog(contents: unknown): void {
  writeFileSync(join(tmpUserData, 'activity.json'), JSON.stringify(contents))
}

function readLog(): ActivityLog {
  return JSON.parse(readFileSync(join(tmpUserData, 'activity.json'), 'utf-8'))
}

beforeEach(() => {
  tmpUserData = join(tmpdir(), `harness-activity-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpUserData, { recursive: true })
  resetActivityCacheForTests()
})

afterEach(() => {
  vi.useRealTimers()
  resetActivityCacheForTests()
  try {
    rmSync(tmpUserData, { recursive: true, force: true })
  } catch {
    // best effort
  }
})

describe('pruneRemoved', () => {
  it('drops a removed record past the retention cutoff', () => {
    const out = pruneRemoved({ '/wt/old': rec(NOW - 91 * DAY) }, NOW)
    expect(Object.keys(out)).toEqual([])
  })

  it('keeps a removed record still inside the retention window', () => {
    const input = { '/wt/recent': rec(NOW - 89 * DAY) }
    expect(Object.keys(pruneRemoved(input, NOW))).toEqual(['/wt/recent'])
  })

  it('keeps a live record with no removedAt regardless of event age', () => {
    const input = { '/wt/live': rec(undefined) }
    expect(input['/wt/live'].events[0].t).toBeLessThan(NOW - 90 * DAY)
    expect(Object.keys(pruneRemoved(input, NOW))).toEqual(['/wt/live'])
  })

  it('prunes only the stale records from a mixed map', () => {
    const out = pruneRemoved(
      {
        '/wt/live': rec(undefined),
        '/wt/recent': rec(NOW - 10 * DAY),
        '/wt/old': rec(NOW - 120 * DAY),
        '/wt/ancient': rec(NOW - 400 * DAY)
      },
      NOW
    )
    expect(Object.keys(out).sort()).toEqual(['/wt/live', '/wt/recent'])
  })

  it('returns the input by reference when nothing is prunable', () => {
    const input = { '/wt/live': rec(undefined) }
    expect(pruneRemoved(input, NOW)).toBe(input)
  })

  it('treats removedAt exactly at the cutoff as still retained', () => {
    const input = { '/wt/edge': rec(NOW - 90 * DAY) }
    expect(Object.keys(pruneRemoved(input, NOW))).toEqual(['/wt/edge'])
  })
})

describe('load — migrate then prune', () => {
  it('keeps every record of a legacy Record<path, ActivityEvent[]> file', () => {
    writeLog({
      '/wt/a': [{ t: NOW - 500 * DAY, s: 'processing' }],
      '/wt/b': [{ t: NOW - 2 * DAY, s: 'waiting' }]
    })
    const out = getActivityLog()
    // Legacy entries carry no removedAt, so age can't prune them.
    expect(Object.keys(out).sort()).toEqual(['/wt/a', '/wt/b'])
    expect(out['/wt/a'].createdAt).toBe(NOW - 500 * DAY)
    expect(out['/wt/a'].events).toHaveLength(1)
  })

  it('prunes stale removed records from a current-shape file', () => {
    writeLog({
      '/wt/live': rec(undefined),
      '/wt/old': rec(Date.now() - 120 * DAY)
    })
    expect(Object.keys(getActivityLog())).toEqual(['/wt/live'])
  })

  it('persists the pruned map without waiting for another mutation', async () => {
    vi.useFakeTimers()
    writeLog({
      '/wt/live': rec(undefined),
      '/wt/old': rec(Date.now() - 120 * DAY)
    })
    getActivityLog()
    await vi.advanceTimersByTimeAsync(1000)
    vi.useRealTimers()
    await flushActivityWritesForTests()
    expect(Object.keys(readLog())).toEqual(['/wt/live'])
  })
})

describe('scheduleSave — async write', () => {
  it('writes the log to disk after the debounce', async () => {
    vi.useFakeTimers()
    recordActivity('/wt/a', 'processing')
    await vi.advanceTimersByTimeAsync(1000)
    vi.useRealTimers()
    await flushActivityWritesForTests()
    expect(readLog()['/wt/a'].events[0].s).toBe('processing')
  })

  it('serializes overlapping saves so the last write wins', async () => {
    vi.useFakeTimers()
    recordActivity('/wt/a', 'processing')
    await vi.advanceTimersByTimeAsync(1000)
    recordActivity('/wt/a', 'waiting')
    await vi.advanceTimersByTimeAsync(1000)
    vi.useRealTimers()
    await flushActivityWritesForTests()
    const events = readLog()['/wt/a'].events
    expect(events.map((e) => e.s)).toEqual(['processing', 'waiting'])
  })
})

describe('sealAllActive', () => {
  it('writes synchronously and blocks a pending async save from clobbering it', async () => {
    vi.useFakeTimers()
    recordActivity('/wt/a', 'processing')
    // Debounce is still pending — nothing has reached disk yet.
    sealAllActive()
    vi.useRealTimers()
    await flushActivityWritesForTests()
    const events = readLog()['/wt/a'].events
    expect(events.map((e) => e.s)).toEqual(['processing', 'idle'])
  })

  it('leaves removed records alone', async () => {
    writeLog({ '/wt/gone': { events: [{ t: NOW, s: 'processing' }], removedAt: Date.now() } })
    sealAllActive()
    await flushActivityWritesForTests()
    expect(readLog()['/wt/gone'].events.map((e) => e.s)).toEqual(['processing'])
  })
})
