// Fan-out ServerTransport — delegates every call to a list of inner
// transports. Lets us run the Electron IPC transport and a WebSocket
// transport in parallel off a single `transport` variable in main,
// so none of the existing `transport.onRequest(...)` / `sendSignal(...)`
// registration sites in `index.ts` need to change.
//
// Every handler is registered on every inner transport, so a request
// from either the Electron renderer or a WS client hits the same
// function and dispatches through the same store — except channels
// `isLocalShellOnly` names, which refuse anything that didn't arrive
// over IPC. Enforcing that here rather than at each registration site is
// what keeps a new `connections:` / `ssh:` handler from shipping open.

import type { StateEvent } from '../shared/state'
import type {
  RequestHandler,
  ServerTransport,
  SignalHandler
} from '../shared/transport/transport'
import { isLocalShellOnly, localShellOnly } from './local-shell-only'

export class CompoundServerTransport implements ServerTransport {
  constructor(private readonly inner: ServerTransport[]) {}

  start(): void {
    for (const t of this.inner) t.start()
  }

  stop(): void {
    for (const t of this.inner) t.stop()
  }

  broadcastStateEvent(event: StateEvent, seq: number): void {
    for (const t of this.inner) t.broadcastStateEvent(event, seq)
  }

  onRequest(name: string, handler: RequestHandler): void {
    const guarded = isLocalShellOnly(name) ? localShellOnly(name, handler) : handler
    for (const t of this.inner) t.onRequest(name, guarded)
  }

  onSignal(name: string, handler: SignalHandler): void {
    for (const t of this.inner) t.onSignal(name, handler)
  }

  sendSignal(name: string, ...args: unknown[]): void {
    for (const t of this.inner) t.sendSignal(name, ...args)
  }

  onClientDisconnect(callback: (clientId: string) => void): void {
    for (const t of this.inner) t.onClientDisconnect(callback)
  }
}
