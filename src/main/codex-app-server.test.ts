import { describe, it, expect, vi } from 'vitest'
import { PassThrough } from 'stream'
import { CodexAppServerClient, CodexRpcRequestError } from './codex-app-server'

function harness() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const written: Record<string, unknown>[] = []
  let partial = ''
  stdin.on('data', (c: Buffer) => {
    partial += c.toString()
    let i: number
    while ((i = partial.indexOf('\n')) >= 0) {
      written.push(JSON.parse(partial.slice(0, i)))
      partial = partial.slice(i + 1)
    }
  })
  const onNotification = vi.fn()
  const onRequest = vi.fn()
  const client = new CodexAppServerClient(stdin, stdout, { onNotification, onRequest })
  const serverSays = (msg: unknown): void => {
    stdout.write(JSON.stringify(msg) + '\n')
  }
  return { client, written, serverSays, onNotification, onRequest }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

describe('CodexAppServerClient', () => {
  it('resolves a request with the matching response', async () => {
    const h = harness()
    const p = h.client.request('thread/start', { cwd: '/x' })
    await tick()
    expect(h.written[0]).toEqual({ id: 1, method: 'thread/start', params: { cwd: '/x' } })
    h.serverSays({ id: 1, result: { thread: { id: 't1' } } })
    await expect(p).resolves.toEqual({ thread: { id: 't1' } })
  })

  it('rejects with the RPC error', async () => {
    const h = harness()
    const p = h.client.request('turn/steer', {})
    h.serverSays({ id: 1, error: { code: -32600, message: 'no active turn to steer' } })
    await expect(p).rejects.toBeInstanceOf(CodexRpcRequestError)
  })

  it('routes server requests to onRequest', async () => {
    const h = harness()
    h.serverSays({ id: 7, method: 'item/commandExecution/requestApproval', params: { itemId: 'i1' } })
    await tick()
    expect(h.onRequest).toHaveBeenCalledWith(7, 'item/commandExecution/requestApproval', { itemId: 'i1' })
    expect(h.onNotification).not.toHaveBeenCalled()
  })

  it('routes a notification split across chunks', async () => {
    const stdout = new PassThrough()
    const onNotification = vi.fn()
    new CodexAppServerClient(new PassThrough(), stdout, { onNotification, onRequest: vi.fn() })
    const line = JSON.stringify({ method: 'turn/started', params: { threadId: 't1' } }) + '\n'
    stdout.write(line.slice(0, 10))
    stdout.write(line.slice(10))
    await tick()
    expect(onNotification).toHaveBeenCalledWith('turn/started', { threadId: 't1' })
  })

  it('writes responses to server requests', async () => {
    const h = harness()
    h.client.respond(7, { decision: 'accept' })
    h.client.respondError(8, -32601, 'unsupported')
    await tick()
    expect(h.written).toEqual([
      { id: 7, result: { decision: 'accept' } },
      { id: 8, error: { code: -32601, message: 'unsupported' } }
    ])
  })

  it('close rejects in-flight requests and refuses new ones', async () => {
    const h = harness()
    const p = h.client.request('thread/read', {})
    h.client.close()
    await expect(p).rejects.toThrow(/closed|exited/)
    await expect(h.client.request('x', {})).rejects.toThrow(/closed/)
  })
})
