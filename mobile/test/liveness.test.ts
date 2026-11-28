// NessClient.checkAlive: a socket that dies silently while the app is
// suspended must stop passing its pre-sleep state off as live. Fake
// WebSocket on the global, since NessClient constructs its own transport.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initialState } from '../../src/shared/state'
import { NessClient, PROBE_TIMEOUT_MS, waitingView } from '../src/ness'
import { HEARTBEAT_IDLE_MS, HEARTBEAT_MS, watchLiveness, type LivenessClient } from '../src/liveness'

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []
  readyState = FakeWebSocket.CONNECTING
  sent: Array<{ t: string; id?: string; name?: string }> = []
  private handlers = new Map<string, Array<(e: unknown) => void>>()
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }
  addEventListener(type: string, h: (e: unknown) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), h])
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }
  close(): void {}
  fire(type: string, evt: unknown = {}): void {
    for (const h of this.handlers.get(type) ?? []) h(evt)
  }
  reply(frame: object): void {
    this.fire('message', { data: JSON.stringify(frame) })
  }
  lastId(): string {
    return this.sent.filter((f) => f.name === 'transport:getClientId').at(-1)!.id!
  }
  /** Open and answer the snapshot + clientId handshake. */
  async handshake(): Promise<void> {
    this.readyState = FakeWebSocket.OPEN
    this.fire('open')
    const snap = this.sent.find((f) => f.t === 'snapreq')!
    this.reply({ t: 'snapres', id: snap.id, ok: true, snapshot: { state: initialState, seq: 0 } })
    await vi.advanceTimersByTimeAsync(0)
    this.reply({ t: 'res', id: this.lastId(), ok: true, value: 'c1' })
    await vi.advanceTimersByTimeAsync(0)
  }
}

describe('NessClient.checkAlive', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  async function connectedClient() {
    const client = new NessClient('b1', 'Mac', 'ws://10.0.0.2:37292/', 'tok')
    client.connect()
    await FakeWebSocket.instances[0].handshake()
    expect(client.getConn()).toEqual({ connected: true, hasSnapshot: true, error: undefined })
    return client
  }

  it('a socket that answers keeps its state live', async () => {
    const client = await connectedClient()
    const ws = FakeWebSocket.instances[0]
    const p = client.checkAlive()
    ws.reply({ t: 'res', id: ws.lastId(), ok: true, value: 'c1' })
    await p
    expect(client.getConn().hasSnapshot).toBe(true)
    expect(FakeWebSocket.instances).toHaveLength(1)
    client.close()
  })

  it('on wake, a dead socket drops to Connecting, reconnects at once and recovers with a fresh snapshot', async () => {
    const client = await connectedClient()
    const p = client.checkAlive({ hideStale: true })
    // While the probe is out, the last state stays up.
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1)
    expect(client.getConn().hasSnapshot).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    await p
    expect(client.getConn()).toEqual({ connected: false, hasSnapshot: false })
    expect(waitingView([client.getConn()])).toEqual({ kind: 'connecting', pending: [0] })
    expect(FakeWebSocket.instances).toHaveLength(2)

    // New network can't reach it either → "Can't reach".
    await vi.advanceTimersByTimeAsync(8000)
    expect(waitingView([client.getConn()])).toEqual({ kind: 'unreachable', failed: [0] })

    // Network back: the retry's snapshot makes it live again.
    await vi.advanceTimersByTimeAsync(250)
    await FakeWebSocket.instances.at(-1)!.handshake()
    expect(client.getConn()).toEqual({ connected: true, hasSnapshot: true, error: undefined })
    client.close()
  })

  it('on a heartbeat, a dead socket is dropped and reconnected but its state stays up', async () => {
    const client = await connectedClient()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_IDLE_MS)
    const p = client.checkAlive({ ifIdleMs: HEARTBEAT_IDLE_MS })
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    await p
    expect(client.getConn()).toEqual({ connected: false, hasSnapshot: true, error: 'connection lost' })
    expect(FakeWebSocket.instances).toHaveLength(2)
    await FakeWebSocket.instances[1].handshake()
    expect(client.getConn()).toEqual({ connected: true, hasSnapshot: true, error: undefined })
    client.close()
  })
})

describe('watchLiveness', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function fakeAppState(initial: string) {
    const listeners = new Set<(st: string) => void>()
    return {
      currentState: initial as string | null,
      addEventListener: (_: 'change', cb: (st: string) => void) => {
        listeners.add(cb)
        return { remove: () => listeners.delete(cb) }
      },
      set(st: string) {
        this.currentState = st
        for (const l of listeners) l(st)
      },
      listenerCount: () => listeners.size
    }
  }
  function fakeClient() {
    const calls: string[] = []
    const c: LivenessClient = {
      wake: () => void calls.push('wake'),
      checkAlive: async (o) => void calls.push(`beat:${o?.ifIdleMs}`)
    }
    return { c, calls }
  }

  it('beats while active, wakes on return, and stops in the background', async () => {
    const as = fakeAppState('active')
    const { c, calls } = fakeClient()
    const stop = watchLiveness(as, () => [c])
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    expect(calls).toEqual([`beat:${HEARTBEAT_IDLE_MS}`])

    as.set('background')
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3)
    expect(calls).toHaveLength(1)

    as.set('active')
    expect(calls.at(-1)).toBe('wake')
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    expect(calls).toEqual([`beat:${HEARTBEAT_IDLE_MS}`, 'wake', `beat:${HEARTBEAT_IDLE_MS}`])

    stop()
    expect(as.listenerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3)
    expect(calls).toHaveLength(3)
  })

  it('inactive (Control Center) keeps the heartbeat; starting in the background waits for active', async () => {
    const as = fakeAppState('background')
    const { c, calls } = fakeClient()
    const stop = watchLiveness(as, () => [c])
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2)
    expect(calls).toEqual([])
    as.set('active')
    as.set('inactive')
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    expect(calls).toEqual(['wake', `beat:${HEARTBEAT_IDLE_MS}`])
    // A second 'active' doesn't start a second interval.
    as.set('active')
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    expect(calls.filter((x) => x.startsWith('beat'))).toHaveLength(2)
    stop()
  })
})
