import { describe, it, expect, vi } from 'vitest'
import { localShellOnly } from './local-shell-only'

describe('localShellOnly', () => {
  it('passes IPC calls through with their args', async () => {
    const inner = vi.fn((_ctx, a: string, b: number) => `${a}:${b}`)
    const wrapped = localShellOnly('connections:getToken', inner)
    expect(await wrapped({ clientId: 'c', via: 'ipc' }, 'x', 2)).toBe('x:2')
    expect(inner).toHaveBeenCalledOnce()
  })

  it('refuses WS calls without running the handler', () => {
    const inner = vi.fn(() => 'secret')
    const wrapped = localShellOnly('connections:getToken', inner)
    expect(() => wrapped({ clientId: 'c', via: 'ws' }, 'id')).toThrow(
      'connections:getToken is only available to the local Ness window'
    )
    expect(inner).not.toHaveBeenCalled()
  })
})
