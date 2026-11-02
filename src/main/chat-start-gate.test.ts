import { describe, it, expect, vi } from 'vitest'

vi.mock('./debug', () => ({
  log: () => {}
}))

import { ChatStartGate } from './chat-start-gate'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('ChatStartGate', () => {
  it('holds calls made while a start is in flight and runs them in order once it succeeds', async () => {
    const gate = new ChatStartGate()
    const probe = deferred()
    const calls: string[] = []
    const started = gate.begin('s1', async () => {
      await probe.promise
      calls.push('create')
      return true
    })
    gate.afterStart('s1', () => calls.push('send 1'))
    gate.afterStart('s1', () => calls.push('send 2'))
    expect(calls).toEqual([])

    probe.resolve()
    expect(await started).toBe(true)
    await Promise.resolve()
    expect(calls).toEqual(['create', 'send 1', 'send 2'])
  })

  it('runs a call immediately when nothing is starting', () => {
    const gate = new ChatStartGate()
    const fn = vi.fn()
    gate.afterStart('s1', fn)
    expect(fn).toHaveBeenCalledOnce()
  })

  it('lets a second begin join the first instead of starting again', async () => {
    const gate = new ChatStartGate()
    const probe = deferred()
    const start = vi.fn(async () => {
      await probe.promise
      return true
    })
    const a = gate.begin('s1', start)
    const b = gate.begin('s1', start)
    probe.resolve()
    expect(await Promise.all([a, b])).toEqual([true, true])
    expect(start).toHaveBeenCalledOnce()
  })

  it('drops held calls and resolves false when the start is cancelled', async () => {
    const gate = new ChatStartGate()
    const probe = deferred()
    const fn = vi.fn()
    const started = gate.begin('s1', async (isCancelled) => {
      await probe.promise
      return !isCancelled()
    })
    gate.afterStart('s1', fn)
    gate.cancel('s1')
    probe.resolve()
    expect(await started).toBe(false)
    await Promise.resolve()
    expect(fn).not.toHaveBeenCalled()
  })

  it('hands held calls to a start that replaces a cancelled one', async () => {
    const gate = new ChatStartGate()
    const first = deferred()
    const second = deferred()
    const fn = vi.fn()
    const a = gate.begin('s1', async (isCancelled) => {
      await first.promise
      return !isCancelled()
    })
    gate.afterStart('s1', fn)
    gate.cancel('s1')
    const b = gate.begin('s1', async () => {
      await second.promise
      return true
    })
    first.resolve()
    expect(await a).toBe(false)
    await Promise.resolve()
    expect(fn).not.toHaveBeenCalled()

    second.resolve()
    expect(await b).toBe(true)
    await Promise.resolve()
    expect(fn).toHaveBeenCalledOnce()
  })

  it('settled follows a replacement start instead of reporting the cancelled one', async () => {
    const gate = new ChatStartGate()
    const first = deferred()
    const second = deferred()
    void gate.begin('s1', async (isCancelled) => {
      await first.promise
      return !isCancelled()
    })
    const settled = gate.settled('s1')
    gate.cancel('s1')
    void gate.begin('s1', async () => {
      await second.promise
      return true
    })
    first.resolve()
    second.resolve()
    expect(await settled).toBe(true)
  })

  it('treats a throwing start as a failed one rather than an unhandled rejection', async () => {
    const gate = new ChatStartGate()
    const started = gate.begin('s1', async () => {
      throw new Error('spawn exploded')
    })
    expect(await started).toBe(false)
    expect(await gate.settled('s1')).toBe(true)
  })

  it('settled waits for the start in flight', async () => {
    const gate = new ChatStartGate()
    const probe = deferred()
    void gate.begin('s1', async () => {
      await probe.promise
      return false
    })
    const settled = gate.settled('s1')
    probe.resolve()
    expect(await settled).toBe(false)
    expect(await gate.settled('s1')).toBe(true)
  })
})
