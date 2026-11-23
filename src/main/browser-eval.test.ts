import { describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'vm'
import {
  BLOCK_UNDEFINED_HINT,
  EVAL_ENCODE_BUDGET,
  EVAL_MAX_TIMEOUT_MS,
  EVAL_TRUNCATED_MARKER,
  explainEvalTimeout,
  EVAL_TIMEOUT_MS,
  buildEvalScript,
  clampEvalTimeout,
  evalWithTimeout,
  evalBlockedReason
} from './browser-eval'

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

describe('buildEvalScript', () => {
  /** Runs the injected script the way a page would, minus the DOM. */
  async function run(code: string, opts?: { awaitPromise?: boolean }): Promise<unknown> {
    const built = buildEvalScript(code, opts)
    if ('error' in built) return { syntax: built.error }
    return await runInNewContext(built.script, { setTimeout })
  }

  it('evaluates a bare expression', async () => {
    expect(await run('1 + 2')).toEqual({ ok: true, value: '3' })
  })

  it('treats a trailing semicolon as still an expression', async () => {
    expect(await run('"a" + "b";')).toEqual({ ok: true, value: '"ab"' })
  })

  it('evaluates an object literal as an object, not a block', async () => {
    expect(await run('{a: 1, b: [2]}')).toEqual({ ok: true, value: '{"a":1,"b":[2]}' })
  })

  it('runs a statement block that returns', async () => {
    expect(await run('const x = 2\nreturn x * 21')).toEqual({ ok: true, value: '42' })
  })

  it('supports top-level await in both forms', async () => {
    expect(await run('await Promise.resolve(5)')).toEqual({ ok: true, value: '5' })
    expect(await run('const v = await Promise.resolve(6)\nreturn v')).toEqual({ ok: true, value: '6' })
  })

  it('awaits a returned promise by default, and skips it when asked', async () => {
    expect(await run('Promise.resolve("done")')).toEqual({ ok: true, value: '"done"' })
    expect(await run('new Promise(() => {})', { awaitPromise: false })).toEqual({
      ok: true,
      value: '"[Promise — not awaited]"'
    })
  })

  it('awaits code that uses await even when await_promise is off', async () => {
    expect(await run('await Promise.resolve(7)', { awaitPromise: false })).toEqual({
      ok: true,
      value: '7'
    })
    expect(
      await run('const v = await Promise.resolve(8)\nreturn v', { awaitPromise: false })
    ).toEqual({ ok: true, value: '8' })
  })

  it('explains that a block without return yields nothing', async () => {
    expect(await run('const r = {w: 3}; r.w')).toEqual({ ok: true, value: BLOCK_UNDEFINED_HINT })
    // A bare expression that really is undefined is not a missing return.
    expect(await run('({}).nope')).toEqual({ ok: true, value: 'undefined' })
  })

  it('truncates an exponential shared-reference graph instead of hanging', async () => {
    const r = (await run(
      'const a = {}\nlet o = {l: a, r: a}\nfor (let i = 0; i < 30; i++) o = {l: o, r: o, s: o, t: o}\nreturn o'
    )) as { ok: true; value: string }
    expect(r.ok).toBe(true)
    expect(r.value).toContain(EVAL_TRUNCATED_MARKER)
  })

  it('stops a huge array at the budget and says how much is left', async () => {
    const r = (await run('Array.from({length: 200000}, (_, i) => i)')) as { value: string }
    const arr = JSON.parse(r.value) as unknown[]
    expect(arr.length).toBeLessThanOrEqual(EVAL_ENCODE_BUDGET + 1)
    expect(String(arr[arr.length - 1])).toMatch(/more items$/)
  })

  it('reports undefined distinctly from null', async () => {
    expect(await run('undefined')).toEqual({ ok: true, value: 'undefined' })
    expect(await run('let x = 1')).toEqual({ ok: true, value: BLOCK_UNDEFINED_HINT })
    expect(await run('null')).toEqual({ ok: true, value: 'null' })
  })

  it('encodes values JSON.stringify would throw on or drop', async () => {
    const r = (await run(
      'const o = {n: NaN, big: 10n, f: function named() {}, u: undefined, m: new Map([["k", 1]]), s: new Set([1])}\no.self = o\nreturn o'
    )) as { ok: true; value: string }
    expect(JSON.parse(r.value)).toEqual({
      n: 'NaN',
      big: '10n',
      f: '[Function named]',
      m: [['k', 1]],
      s: [1],
      self: '[Circular]'
    })
  })

  it('does not mistake a shared reference for a cycle', async () => {
    const r = (await run('const a = {x: 1}\nreturn [a, a]')) as { value: string }
    expect(JSON.parse(r.value)).toEqual([{ x: 1 }, { x: 1 }])
  })

  it('returns a throw as an error result with its message', async () => {
    const r = (await run('throw new TypeError("bad thing")')) as { ok: boolean; error: string }
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/TypeError: bad thing/)
    const rejected = (await run('Promise.reject(new Error("later"))')) as { error: string }
    expect(rejected.error).toMatch(/later/)
    const thrownString = (await run('throw "plain"')) as { error: string }
    expect(thrownString.error).toBe('Uncaught plain')
  })

  it('reports a syntax error up front, without touching the page', () => {
    const built = buildEvalScript('return (')
    expect('error' in built && built.error).toMatch(/^SyntaxError:/)
  })
})

describe('clampEvalTimeout', () => {
  it('defaults garbage and caps the maximum', () => {
    expect(clampEvalTimeout(undefined)).toBe(EVAL_TIMEOUT_MS)
    expect(clampEvalTimeout(-1)).toBe(EVAL_TIMEOUT_MS)
    expect(clampEvalTimeout(1500)).toBe(1500)
    expect(clampEvalTimeout(10 * 60_000)).toBe(EVAL_MAX_TIMEOUT_MS)
  })
})

describe('explainEvalTimeout', () => {
  it('points a timed-out eval at reload_tab', () => {
    const err = explainEvalTimeout(new Error('evalTab tab=t1 timed out after 5000ms')) as Error
    expect(err.message).toMatch(/timed out after 5000ms .*reload_tab/)
  })

  it('leaves other failures alone', () => {
    const original = new Error('tab renderer crashed — reload the tab')
    expect(explainEvalTimeout(original)).toBe(original)
  })
})
