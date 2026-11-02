import { describe, it, expect } from 'vitest'
import { CompoundServerTransport } from './transport-compound'
import type { RequestHandler, ServerTransport } from '../shared/transport/transport'

function recordingTransport(): { transport: ServerTransport; handlers: Map<string, RequestHandler> } {
  const handlers = new Map<string, RequestHandler>()
  const transport: ServerTransport = {
    start: () => undefined,
    stop: () => undefined,
    broadcastStateEvent: () => undefined,
    onRequest: (name, handler) => void handlers.set(name, handler),
    onSignal: () => undefined,
    sendSignal: () => undefined,
    onClientDisconnect: () => undefined
  }
  return { transport, handlers }
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
})
