import { describe, expect, it, vi } from 'vitest'
import { EVAL_TIMEOUT_MS, evalWithTimeout, evalBlockedReason } from './browser-eval'

const LIVE = { hasDocument: true, lastLoadError: null, crashed: false, crashReason: null }

describe('evalWithTimeout', () => {
  it('resolves with the value when the eval settles', async () => {
    await expect(evalWithTimeout(async () => 'html', 'getDom')).resolves.toBe('html')
  })

  it('rejects rather than hanging when the eval never settles', async () => {
    vi.useFakeTimers()
    try {
      const pending = evalWithTimeout(() => new Promise<string>(() => {}), 'getDom tab=t1', 5000)
      const assertion = expect(pending).rejects.toThrow(/getDom tab=t1 timed out after 5000ms/)
      await vi.advanceTimersByTimeAsync(5000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('propagates a real eval failure unchanged', async () => {
    await expect(
      evalWithTimeout(async () => {
        throw new Error('SyntaxError')
      }, 'getDom')
    ).rejects.toThrow('SyntaxError')
  })

  it('clears the timer on the success path so it cannot hold the event loop open', async () => {
    vi.useFakeTimers()
    try {
      await evalWithTimeout(async () => 'ok', 'getDom')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('defaults to a bound short enough to beat the caller running out of patience', () => {
    expect(EVAL_TIMEOUT_MS).toBeLessThanOrEqual(10_000)
  })
})

describe('evalBlockedReason', () => {
  it('names the reload for a tab whose renderer died', () => {
    expect(evalBlockedReason({ ...LIVE, crashed: true, crashReason: 'crashed' })).toBe(
      'tab renderer crashed (reason: crashed) — reload the tab'
    )
  })

  it('still reports a crash when the reason is unknown', () => {
    expect(evalBlockedReason({ ...LIVE, crashed: true })).toBe(
      'tab renderer crashed — reload the tab'
    )
  })

  it('prefers the crash over the ERR_FAILED the crash also produced', () => {
    expect(
      evalBlockedReason({
        hasDocument: false,
        lastLoadError: 'ERR_FAILED (-2)',
        crashed: true,
        crashReason: 'oom'
      })
    ).toMatch(/renderer crashed \(reason: oom\)/)
  })

  it('reports the load failure for a tab that never committed a document', () => {
    expect(
      evalBlockedReason({
        ...LIVE,
        hasDocument: false,
        lastLoadError: "ERR_FAILED (-2) loading 'http://localhost:8765/local.html'"
      })
    ).toBe(
      "tab has no document loaded (last load failed: ERR_FAILED (-2) loading 'http://localhost:8765/local.html')"
    )
  })

  it('allows the eval once a document has committed, even after an earlier failure', () => {
    expect(evalBlockedReason({ ...LIVE, lastLoadError: 'ERR_FAILED (-2)' })).toBeNull()
  })

  it('allows the eval for a tab still on its first load, so it queues as before', () => {
    expect(evalBlockedReason({ ...LIVE, hasDocument: false })).toBeNull()
  })
})
