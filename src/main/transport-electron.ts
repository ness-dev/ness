// Electron implementation of the shared ServerTransport interface.
//
// Wraps the existing ipcMain + webContents.send primitives so that the
// store, main-process handlers, and preload can all talk through a
// single abstraction. A future ServerTransport implementation (WebSocket,
// SSH stdio) slots in here without any call site above needing to change.

import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'crypto'
import { stripSnapshotForWire, type StateEvent } from '../shared/state'
import type {
  ConnectionContext,
  RequestHandler,
  ServerTransport,
  SignalHandler
} from '../shared/transport/transport'
import type { Store } from './store'
import type { PerfMonitor } from './perf-monitor'
import { perfLog } from './perf-log'

const SLOW_IPC_MS = 50

export class ElectronServerTransport implements ServerTransport {
  private unsubscribeStore: (() => void) | null = null
  // One clientId per WebContents. Assigned lazily on first observation
  // (either a request/signal from the renderer or an explicit broadcast
  // target), cleared on webContents 'destroyed'. The clientId is a UUID
  // rather than webContents.id so it's indistinguishable over the wire
  // from a WebSocket clientId — gating handlers shouldn't care which
  // transport a peer is on.
  private readonly clientIdByWebContentsId = new Map<number, string>()
  private readonly watchedWebContents = new WeakSet<WebContents>()
  private readonly disconnectCallbacks: Array<(id: string) => void> = []

  constructor(
    private readonly store: Store,
    private readonly perfMonitor?: PerfMonitor
  ) {}

  start(): void {
    ipcMain.handle('state:getSnapshot', () =>
      stripSnapshotForWire(this.store.getSnapshot())
    )
    ipcMain.handle('transport:getClientId', (event) => {
      return this.ctxFor(event.sender).clientId
    })
    this.unsubscribeStore = this.store.subscribe((event, seq) => {
      this.broadcastStateEvent(event, seq)
    })
  }

  stop(): void {
    this.unsubscribeStore?.()
    this.unsubscribeStore = null
    ipcMain.removeHandler('state:getSnapshot')
    ipcMain.removeHandler('transport:getClientId')
  }

  broadcastStateEvent(event: StateEvent, seq: number): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      // During Electron's quit sequence webContents can be destroyed
      // before the BrowserWindow's isDestroyed flips — and a 'destroyed'
      // event on webContents is what fires our onClientDisconnect, which
      // dispatches terminals/clientDisconnected, which re-enters this
      // broadcast. Guard the send so we don't throw on the way out.
      const wc = win.webContents
      if (wc.isDestroyed()) continue
      this.perfMonitor?.recordIpcMessage()
      wc.send('state:event', event, seq)
    }
  }

  onRequest(name: string, handler: RequestHandler): void {
    ipcMain.handle(name, async (event, ...args) => {
      const ctx = this.ctxFor(event.sender)
      const t0 = performance.now()
      try {
        return await handler(ctx, ...args)
      } finally {
        const ms = performance.now() - t0
        if (ms >= SLOW_IPC_MS) {
          perfLog('ipc-slow', `${name} ${ms.toFixed(0)}ms`, {
            name,
            ms: +ms.toFixed(1),
            argCount: args.length
          })
        }
      }
    })
  }

  onSignal(name: string, handler: SignalHandler): void {
    ipcMain.on(name, (event, ...args) => {
      const ctx = this.ctxFor(event.sender)
      const t0 = performance.now()
      try {
        handler(ctx, ...args)
      } finally {
        const ms = performance.now() - t0
        if (ms >= SLOW_IPC_MS) {
          perfLog('ipc-slow', `${name} ${ms.toFixed(0)}ms (signal)`, {
            name,
            ms: +ms.toFixed(1),
            argCount: args.length,
            signal: true
          })
        }
      }
    })
  }

  sendSignal(name: string, ...args: unknown[]): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      const wc = win.webContents
      if (wc.isDestroyed()) continue
      wc.send(name, ...args)
    }
  }

  onClientDisconnect(callback: (clientId: string) => void): void {
    this.disconnectCallbacks.push(callback)
  }

  private ctxFor(sender: WebContents): ConnectionContext {
    let id = this.clientIdByWebContentsId.get(sender.id)
    if (!id) {
      id = randomUUID()
      this.clientIdByWebContentsId.set(sender.id, id)
    }
    if (!this.watchedWebContents.has(sender)) {
      this.watchedWebContents.add(sender)
      const fire = (): void => {
        const clientId = this.clientIdByWebContentsId.get(sender.id)
        if (!clientId) return
        this.clientIdByWebContentsId.delete(sender.id)
        for (const cb of this.disconnectCallbacks) cb(clientId)
      }
      sender.once('destroyed', fire)
    }
    return { clientId: id, via: 'ipc' }
  }
}
