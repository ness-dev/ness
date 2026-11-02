import { describe, it, expect, vi } from 'vitest'
import { CompoundServerTransport } from './transport-compound'
import type { RequestHandler, ServerTransport, SignalHandler } from '../shared/transport/transport'

function recordingTransport(): {
  transport: ServerTransport
  handlers: Map<string, RequestHandler>
  signals: Map<string, SignalHandler>
} {
  const handlers = new Map<string, RequestHandler>()
  const signals = new Map<string, SignalHandler>()
  const transport: ServerTransport = {
    start: () => undefined,
    stop: () => undefined,
    broadcastStateEvent: () => undefined,
    onRequest: (name, handler) => void handlers.set(name, handler),
    onSignal: (name, handler) => void signals.set(name, handler),
    sendSignal: () => undefined,
    onClientDisconnect: () => undefined
  }
  return { transport, handlers, signals }
}

describe('CompoundServerTransport local-shell guard', () => {
  it('refuses WS callers on a local-shell channel, on every inner transport', () => {
    const a = recordingTransport()
    const b = recordingTransport()
    new CompoundServerTransport([a.transport, b.transport]).onRequest(
      'ssh:reconnect',
      () => ({ url: 'ws://remote', token: 'secret' })
    )
    for (const { handlers } of [a, b]) {
      expect(() => handlers.get('ssh:reconnect')!({ clientId: 'c', via: 'ws' })).toThrow(
        /only available to the local Ness window/
      )
      expect(handlers.get('ssh:reconnect')!({ clientId: 'c', via: 'ipc' })).toEqual({
        url: 'ws://remote',
        token: 'secret'
      })
    }
  })

  it('leaves other channels open to WS callers', () => {
    const a = recordingTransport()
    new CompoundServerTransport([a.transport]).onRequest('config:getWsTransportInfo', () => 'info')
    expect(a.handlers.get('config:getWsTransportInfo')!({ clientId: 'c', via: 'ws' })).toBe('info')
  })

  it('drops WS signals on a local-shell channel and delivers IPC ones', () => {
    const a = recordingTransport()
    const inner = vi.fn()
    new CompoundServerTransport([a.transport]).onSignal('ssh:somethingFired', inner)
    a.signals.get('ssh:somethingFired')!({ clientId: 'c', via: 'ws' }, 1)
    expect(inner).not.toHaveBeenCalled()
    a.signals.get('ssh:somethingFired')!({ clientId: 'c', via: 'ipc' }, 1)
    expect(inner).toHaveBeenCalledWith({ clientId: 'c', via: 'ipc' }, 1)
  })
})
