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

  it('close() during CONNECTING stops the timeout and any retry', async () => {
    const { t } = make()
    t.connect().catch(() => {})
    t.close()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})
