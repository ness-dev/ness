// Connect / handshake timeouts and reconnectNow, against a fake WebSocket
// under fake timers. A real socket can't be made to hang in CONNECTING on
// demand, which is the case these cover (a phone off its backend's LAN).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initialState } from '../shared/state'
import { WebSocketClientTransport } from '../shared/transport/transport-websocket'

type Handler = (evt: unknown) => void

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING
  sent: Array<{ t: string; id?: string; name?: string }> = []
  closeCalls = 0
  private handlers = new Map<string, Handler[]>()

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, h: Handler): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), h])
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }

  /** Like a socket stuck on an unroutable SYN: close() doesn't produce a
   *  close event unless the test fires one. */
  close(): void {
    this.closeCalls++
  }

  fire(type: string, evt: unknown = {}): void {
    for (const h of this.handlers.get(type) ?? []) h(evt)
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.fire('open')
  }

  serverClose(code = 1006): void {
    this.readyState = FakeWebSocket.CLOSED
    this.fire('close', { code, reason: '' })
  }

  reply(frame: object): void {
    this.fire('message', { data: JSON.stringify(frame) })
  }

  /** Answer the snapshot + clientId handshake. */
  answerHandshake(): void {
    const snap = this.sent.find((f) => f.t === 'snapreq')!
    this.reply({ t: 'snapres', id: snap.id, ok: true, snapshot: { state: initialState, seq: 0 } })
  }
}

function make(extra: Partial<ConstructorParameters<typeof WebSocketClientTransport>[0]> = {}) {
  const changes: Array<[boolean, string | undefined]> = []
  const t = new WebSocketClientTransport({
    url: 'ws://10.255.255.1:37292',
    token: 'tok',
    initialBackoffMs: 100,
    maxBackoffMs: 1000,
    connectTimeoutMs: 8000,
    handshakeTimeoutMs: 10000,
    onConnectionChange: (connected, reason) => changes.push([connected, reason]),
    WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
    ...extra
  })
  return { t, changes }
}

/** Let promise continuations run (fake timers don't drain microtasks). */
const flush = () => vi.advanceTimersByTimeAsync(0)

describe('WebSocketClientTransport timeouts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeWebSocket.instances = []
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('gives up on a socket stuck in CONNECTING, reports it and retries', async () => {
    const { t, changes } = make()
    const p = t.connect()
    const rejected = expect(p).rejects.toThrow(/failed to open/)

    await vi.advanceTimersByTimeAsync(7999)
    expect(changes).toEqual([])

    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(changes).toEqual([[false, 'connection timed out']])
    expect(FakeWebSocket.instances[0].closeCalls).toBe(1)

    // Backoff retry opens a second socket.
    await vi.advanceTimersByTimeAsync(100)
    expect(FakeWebSocket.instances).toHaveLength(2)
    t.close()
  })

  it('ignores the abandoned socket when it finally opens or closes', async () => {
    const { t, changes } = make()
    t.connect().catch(() => {})
    await vi.advanceTimersByTimeAsync(8000)
    const stale = FakeWebSocket.instances[0]
    stale.open()
    stale.serverClose()
    await flush()
    expect(changes).toEqual([[false, 'connection timed out']])
    expect(stale.sent).toEqual([])
    t.close()
  })

  it('times out a socket that opens but never answers the snapshot', async () => {
    const { t, changes } = make()
    const rejected = expect(t.connect()).rejects.toThrow(/did not respond/)
    FakeWebSocket.instances[0].open()
    expect(changes).toEqual([[true, undefined]])

    // The connect timer is cleared on open; only the handshake one counts.
    await vi.advanceTimersByTimeAsync(9999)
    expect(changes).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(changes).toEqual([
      [true, undefined],
      [false, 'backend did not respond']
    ])
    await vi.advanceTimersByTimeAsync(100)
    expect(FakeWebSocket.instances).toHaveLength(2)
    t.close()
  })

  it('any frame during the handshake re-arms its timeout', async () => {
    const { t, changes } = make()
    const p = t.connect()
    const ws = FakeWebSocket.instances[0]
    ws.open()
    // A server streaming state events while the snapshot is still on its
    // way is alive, however long the whole handshake takes.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(9000)
      ws.reply({ t: 'state', event: { type: 'settings/themeChanged', payload: 'dracula' }, seq: i })
    }
    ws.answerHandshake()
    await flush()
    const idReq = ws.sent.find((f) => f.name === 'transport:getClientId')!
    ws.reply({ t: 'res', id: idReq.id, ok: true, value: 'c1' })
    await p
    expect(changes).toEqual([[true, undefined]])
    t.close()
  })

  it('doubles the handshake budget after each handshake timeout, resetting on success', async () => {
    const { t, changes } = make()
    t.connect().catch(() => {})
    FakeWebSocket.instances[0].open()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(changes.at(-1)).toEqual([false, 'backend did not respond'])

    // Second attempt gets 20s.
    await vi.advanceTimersByTimeAsync(100)
    const second = FakeWebSocket.instances[1]
    second.open()
    await vi.advanceTimersByTimeAsync(19_999)
    expect(changes.at(-1)).toEqual([true, undefined])
    await vi.advanceTimersByTimeAsync(1)
    expect(changes.at(-1)).toEqual([false, 'backend did not respond'])

    // Third attempt (40s budget) succeeds late, which resets the budget.
    await vi.advanceTimersByTimeAsync(100)
    const third = FakeWebSocket.instances[2]
    third.open()
    await vi.advanceTimersByTimeAsync(30_000)
    third.answerHandshake()
    await flush()
    const idReq = third.sent.find((f) => f.name === 'transport:getClientId')!
    third.reply({ t: 'res', id: idReq.id, ok: true, value: 'c1' })
    await flush()
    third.serverClose()
    await vi.advanceTimersByTimeAsync(100)
    const fourth = FakeWebSocket.instances[3]
    fourth.open()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(changes.at(-1)).toEqual([false, 'backend did not respond'])
    t.close()
  })

  it('a completed handshake clears the timers and later drops still reconnect', async () => {
    const { t, changes } = make()
    const p = t.connect()
    const ws = FakeWebSocket.instances[0]
    ws.open()
    ws.answerHandshake()
    await flush()
    const idReq = ws.sent.find((f) => f.name === 'transport:getClientId')!
    ws.reply({ t: 'res', id: idReq.id, ok: true, value: 'c1' })
    await p

    await vi.advanceTimersByTimeAsync(60_000)
    expect(changes).toEqual([[true, undefined]])
    expect(FakeWebSocket.instances).toHaveLength(1)

    ws.serverClose()
    expect(changes).toEqual([
      [true, undefined],
      [false, 'close code 1006']
    ])
    await vi.advanceTimersByTimeAsync(100)
    expect(FakeWebSocket.instances).toHaveLength(2)
    t.close()
  })

  it('reports an immediate refusal as failed to connect, as before', async () => {
    const { t, changes } = make()
    const rejected = expect(t.connect()).rejects.toThrow(/failed to open/)
    FakeWebSocket.instances[0].serverClose()
    await rejected
    expect(changes).toEqual([[false, 'failed to connect']])
    t.close()
  })

  it('reconnectNow skips the backoff and resets it', async () => {
    const { t } = make()
    t.connect().catch(() => {})
    // Fail a few times so the backoff grows to its 1000ms cap.
    for (let i = 0; i < 4; i++) {
      FakeWebSocket.instances.at(-1)!.serverClose()
      await vi.advanceTimersByTimeAsync(1000)
    }
    const before = FakeWebSocket.instances.length
    FakeWebSocket.instances.at(-1)!.serverClose()

    t.reconnectNow()
    expect(FakeWebSocket.instances).toHaveLength(before + 1)
    // The pending backoff timer was cancelled: no extra socket later.
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeWebSocket.instances).toHaveLength(before + 1)

    // And the backoff restarted from initialBackoffMs.
    FakeWebSocket.instances.at(-1)!.serverClose()
    await vi.advanceTimersByTimeAsync(100)
    expect(FakeWebSocket.instances).toHaveLength(before + 2)
    t.close()
  })

  it('reconnectNow abandons an attempt that is still connecting', async () => {
    const { t, changes } = make()
    const rejected = expect(t.connect()).rejects.toThrow(/failed to open/)
    await vi.advanceTimersByTimeAsync(3000)
    t.reconnectNow()
    await rejected
    expect(FakeWebSocket.instances).toHaveLength(2)
    // Never opened, so nothing to report: still disconnected.
    expect(changes).toEqual([])
    // The old attempt's timeout is gone; the new one has its own full 8s.
    await vi.advanceTimersByTimeAsync(7999)
    expect(changes).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(changes).toEqual([[false, 'connection timed out']])
    t.close()
  })

  it('reconnectNow mid-handshake reports the drop and starts over', async () => {
    const { t, changes } = make()
    t.connect().catch(() => {})
    FakeWebSocket.instances[0].open()
    t.reconnectNow()
    await flush()
    expect(changes).toEqual([
      [true, undefined],
      [false, 'reconnecting']
    ])
    expect(FakeWebSocket.instances).toHaveLength(2)
    t.close()
  })

  it('reconnectNow({ keepOpen }) leaves a socket mid-handshake alone', async () => {
    const { t, changes } = make()
    t.connect().catch(() => {})
    FakeWebSocket.instances[0].open()
    t.reconnectNow({ keepOpen: true })
    await flush()
    expect(changes).toEqual([[true, undefined]])
    expect(FakeWebSocket.instances).toHaveLength(1)
    t.close()
  })

  it('reconnectNow({ keepOpen }) still restarts an attempt stuck connecting', async () => {
    const { t } = make()
    t.connect().catch(() => {})
    t.reconnectNow({ keepOpen: true })
    expect(FakeWebSocket.instances).toHaveLength(2)
    t.close()
  })

  it('reconnectNow is a no-op while connected', async () => {
    const { t } = make()
    const p = t.connect()
    const ws = FakeWebSocket.instances[0]
    ws.open()
    ws.answerHandshake()
    await flush()
    const idReq = ws.sent.find((f) => f.name === 'transport:getClientId')!
    ws.reply({ t: 'res', id: idReq.id, ok: true, value: 'c1' })
    await p
    t.reconnectNow()
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(ws.closeCalls).toBe(0)
    t.close()
  })

  /** Connect and finish the handshake on a fresh socket. */
  async function connected(extra: Parameters<typeof make>[0] = {}) {
    const made = make(extra)
    const p = made.t.connect()
    const ws = FakeWebSocket.instances.at(-1)!
    ws.open()
    ws.answerHandshake()
    await flush()
    const idReq = ws.sent.find((f) => f.name === 'transport:getClientId')!
    ws.reply({ t: 'res', id: idReq.id, ok: true, value: 'c1' })
    await p
    return { ...made, ws }
  }

  const lastProbe = (ws: FakeWebSocket) => ws.sent.filter((f) => f.name === 'transport:getClientId').at(-1)!

  it('probe keeps a socket that answers', async () => {
    const { t, changes, ws } = await connected()
    const p = t.probe(3000)
    const req = lastProbe(ws)
    expect(req.t).toBe('req')
    ws.reply({ t: 'res', id: req.id, ok: true, value: 'c1' })
    await expect(p).resolves.toBe('alive')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(changes).toEqual([[true, undefined]])
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(ws.closeCalls).toBe(0)
    t.close()
  })

  it('probe counts an error response as alive', async () => {
    const { t, ws } = await connected()
    const p = t.probe(3000)
    ws.reply({ t: 'res', id: lastProbe(ws).id, ok: false, error: 'unknown request' })
    await expect(p).resolves.toBe('alive')
    expect(FakeWebSocket.instances).toHaveLength(1)
    t.close()
  })

  it('probe timeout drops the socket, fails pending requests and reconnects without backoff', async () => {
    const { t, changes, ws } = await connected({ initialBackoffMs: 5000, maxBackoffMs: 5000 })
    const hung = expect(t.request('worktrees:list')).rejects.toThrow(/closed before response/)
    await flush()
    const p = t.probe(3000)
    await vi.advanceTimersByTimeAsync(2999)
    expect(changes).toEqual([[true, undefined]])
    await vi.advanceTimersByTimeAsync(1)
    await expect(p).resolves.toBe('dead')
    await hung
    expect(changes).toEqual([
      [true, undefined],
      [false, 'connection lost']
    ])
    expect(ws.closeCalls).toBe(1)
    // Straight away, not after the 5s backoff.
    expect(FakeWebSocket.instances).toHaveLength(2)

    // The dead socket's late close is ignored; the new one carries on.
    ws.serverClose()
    const next = FakeWebSocket.instances[1]
    next.open()
    next.answerHandshake()
    await flush()
    expect(changes).toEqual([
      [true, undefined],
      [false, 'connection lost'],
      [true, undefined]
    ])
    t.close()
  })

  it('a timed-out probe whose answer arrives late changes nothing more', async () => {
    const { t, changes, ws } = await connected()
    const p = t.probe(3000)
    const req = lastProbe(ws)
    await vi.advanceTimersByTimeAsync(3000)
    await p
    ws.reply({ t: 'res', id: req.id, ok: true, value: 'c1' })
    await flush()
    expect(changes).toEqual([
      [true, undefined],
      [false, 'connection lost']
    ])
    expect(FakeWebSocket.instances).toHaveLength(2)
    t.close()
  })

  it('concurrent probes share one round trip', async () => {
    const { t, ws } = await connected()
    const before = ws.sent.length
    const a = t.probe(3000)
    const b = t.probe(3000)
    expect(ws.sent.length).toBe(before + 1)
    ws.reply({ t: 'res', id: lastProbe(ws).id, ok: true, value: 'c1' })
    await expect(a).resolves.toBe('alive')
    await expect(b).resolves.toBe('alive')
    t.close()
  })

  it('probe skips a socket that is connecting or mid-handshake', async () => {
    const { t, changes } = make()
    t.connect().catch(() => {})
    const ws = FakeWebSocket.instances[0]
    await expect(t.probe(3000)).resolves.toBe('skipped')
    ws.open()
    await expect(t.probe(3000)).resolves.toBe('skipped')
    // Only the handshake's own snapreq went out; the handshake timeout
    // still governs this socket.
    expect(ws.sent.map((f) => f.t)).toEqual(['snapreq'])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(changes.at(-1)).toEqual([false, 'backend did not respond'])
    t.close()
  })

  it('probe skips when the socket is closed, or after close()', async () => {
    const { t, ws } = await connected()
    ws.serverClose()
    await expect(t.probe(3000)).resolves.toBe('skipped')
    t.close()
    await expect(t.probe(3000)).resolves.toBe('skipped')
    expect(ws.sent.filter((f) => f.name === 'transport:getClientId')).toHaveLength(1)
  })

  it('probe ifIdleMs skips a connection with recent traffic', async () => {
    const { t, ws } = await connected()
    await vi.advanceTimersByTimeAsync(10_000)
    ws.reply({ t: 'state', event: { type: 'settings/themeChanged', payload: 'dracula' }, seq: 1 })
    await vi.advanceTimersByTimeAsync(20_000)
    const before = ws.sent.length
    await expect(t.probe(3000, { ifIdleMs: 30_000 })).resolves.toBe('skipped')
    expect(ws.sent.length).toBe(before)
    await vi.advanceTimersByTimeAsync(10_000)
    const p = t.probe(3000, { ifIdleMs: 30_000 })
    expect(ws.sent.length).toBe(before + 1)
    ws.reply({ t: 'res', id: lastProbe(ws).id, ok: true, value: 'c1' })
    await expect(p).resolves.toBe('alive')
    t.close()
  })

  it('close() during CONNECTING stops the timeout and any retry', async () => {
    const { t } = make()
    t.connect().catch(() => {})
    t.close()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})
