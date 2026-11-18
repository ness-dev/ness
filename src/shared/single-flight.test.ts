import { describe, it, expect, vi } from 'vitest'
import { createSingleFlight } from './single-flight'

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createSingleFlight', () => {
  it('shares one underlying call between concurrent callers with the same key', async () => {
    const flight = createSingleFlight<boolean>()
    const d = deferred<boolean>()
    const fn = vi.fn(() => d.promise)

    const calls = Array.from({ length: 50 }, () => flight('a', fn))
    expect(fn).toHaveBeenCalledTimes(1)

    d.resolve(true)
    expect(await Promise.all(calls)).toEqual(Array(50).fill(true))
  })

  it('keeps different keys separate', () => {
    const flight = createSingleFlight<boolean>()
    const fn = vi.fn(() => new Promise<boolean>(() => {}))
    void flight('a', fn)
    void flight('b', fn)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('runs fresh after the shared call resolves', async () => {
    const flight = createSingleFlight<number>()
    let n = 0
    const fn = vi.fn(async () => ++n)
    expect(await flight('a', fn)).toBe(1)
    expect(await flight('a', fn)).toBe(2)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('clears the entry on reject, so the next call retries', async () => {
    const flight = createSingleFlight<number>()
    const failing = vi.fn(() => Promise.reject(new Error('boom')))
    const a = flight('a', failing)
    const b = flight('a', failing)
    await expect(a).rejects.toThrow('boom')
    await expect(b).rejects.toThrow('boom')
    expect(failing).toHaveBeenCalledTimes(1)

    expect(await flight('a', async () => 7)).toBe(7)
  })
})
