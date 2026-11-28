// The demo's transport: same contract NessClient uses for a WebSocket
// (requests, state events, signals, reconnect, connection status), served
// by an in-memory DemoWorld. No network, ever.
//
// The world (fixtures, transcripts, scripted turns) is imported lazily on
// connect, so a phone that never opens the demo never evaluates it.
import type { StateEvent, StateSnapshot } from '../../../src/shared/state'
import type { ClientSignalHandler, ReconnectListener, StateEventListener } from '../../../src/shared/transport/transport'
import type { ProbeResult } from '../../../src/shared/transport/transport-websocket'
import type { NessTransport, TransportCallbacks } from '../ness'
import type { DemoWorld, WorldHooks } from './world'
import { DEMO_CLIENT_ID } from './constants'

export class DemoTransport implements NessTransport {
  private world: DemoWorld | null = null
  private loading: Promise<DemoWorld> | null = null
  private closed = false
  private readonly events = new Set<StateEventListener>()
  private readonly signals = new Map<string, Set<ClientSignalHandler>>()
  private readonly reconnects = new Set<ReconnectListener>()

  constructor(
    private readonly callbacks: TransportCallbacks = {},
    private readonly hooks: Pick<WorldHooks, 'now' | 'schedule' | 'theme'> = {}
  ) {}

  private load(): Promise<DemoWorld> {
    if (!this.loading) {
      this.loading = import('./world').then(({ DemoWorld }) => {
        this.world = new DemoWorld({
          ...this.hooks,
          emitEvent: (event: StateEvent, seq: number) => {
            for (const l of this.events) l(event, seq)
          },
          emitSignal: (name: string, ...args: unknown[]) => {
            for (const h of this.signals.get(name) ?? []) h(...args)
          }
        })
        return this.world
      })
    }
    return this.loading
  }

  async connect(): Promise<void> {
    const world = await this.load()
    if (this.closed) return
    this.callbacks.onConnectionChange?.(true)
    this.callbacks.onSnapshot?.({ state: world.state, seq: world.seq })
    for (const cb of this.reconnects) cb(DEMO_CLIENT_ID)
  }

  /** Always connected; nothing to retry. */
  reconnectNow(): void {}

  async probe(): Promise<ProbeResult> {
    return this.world && !this.closed ? 'alive' : 'skipped'
  }

  close(): void {
    this.closed = true
    this.world?.close()
  }

  async getStateSnapshot(): Promise<StateSnapshot> {
    const world = await this.load()
    return { state: world.state, seq: world.seq }
  }

  onStateEvent(listener: StateEventListener): () => void {
    this.events.add(listener)
    return () => this.events.delete(listener)
  }

  async request(name: string, ...args: unknown[]): Promise<unknown> {
    const world = await this.load()
    if (this.closed) throw new Error('demo closed')
    return world.request(name, args)
  }

  send(name: string, ...args: unknown[]): void {
    if (this.closed) return
    if (this.world) this.world.signal(name, args)
    else void this.load().then((w) => w.signal(name, args))
  }

  onSignal(name: string, handler: ClientSignalHandler): () => void {
    let set = this.signals.get(name)
    if (!set) this.signals.set(name, (set = new Set()))
    set.add(handler)
    return () => set.delete(handler)
  }

  async getClientId(): Promise<string> {
    return DEMO_CLIENT_ID
  }

  onReconnect(cb: ReconnectListener): () => void {
    this.reconnects.add(cb)
    return () => this.reconnects.delete(cb)
  }

  /** For tests. */
  getWorld(): Promise<DemoWorld> {
    return this.load()
  }
}
