// NessClient.checkAlive: a socket that dies silently while the app is
// suspended must stop passing its pre-sleep state off as live. Fake
// WebSocket on the global, since NessClient constructs its own transport.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initialState } from '../../src/shared/state'
import { NessClient, PROBE_TIMEOUT_MS, waitingView } from '../src/ness'

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

  it('a dead socket drops to Connecting, reconnects at once and recovers with a fresh snapshot', async () => {
    const client = await connectedClient()
    const p = client.checkAlive()
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
})
