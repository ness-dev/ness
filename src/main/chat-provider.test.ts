import { describe, it, expect, vi } from 'vitest'

vi.mock('./debug', () => ({
  log: () => {}
}))

import { Store } from './store'
import { ChatRouter, type ChatProvider } from './chat-provider'
import { initialState } from '../shared/state'
import type { AgentKind } from '../shared/state/terminals'

function fakeProvider(running: string[] = []): ChatProvider {
  return {
    hasSession: vi.fn((id: string) => running.includes(id)),
    seedFromTranscript: vi.fn(),
    create: vi.fn(),
    send: vi.fn(),
    cancelQueued: vi.fn(),
    interrupt: vi.fn(),
    kill: vi.fn(),
    killAll: vi.fn(),
    rewindTo: vi.fn(() => ({ ok: true })),
    forkAt: vi.fn(() => ({ ok: true, newSessionId: 'forked' })),
    setPermissionMode: vi.fn()
  }
}

function startSession(store: Store, sessionId: string, agentKind?: AgentKind): void {
  store.dispatch({
    type: 'jsonClaude/sessionStarted',
    payload: { sessionId, worktreePath: '/tmp/wt', ...(agentKind ? { agentKind } : {}) }
  })
}

describe('ChatRouter', () => {
  it('routes a session without an agentKind to the claude provider', () => {
    const store = new Store(initialState)
    const claude = fakeProvider()
    const codex = fakeProvider()
    const router = new ChatRouter(store, { claude, codex })
    startSession(store, 's1')

    router.send('s1', 'hi')
    router.interrupt('s1')

    expect(claude.send).toHaveBeenCalledWith('s1', 'hi', undefined)
    expect(claude.interrupt).toHaveBeenCalledWith('s1')
    expect(codex.send).not.toHaveBeenCalled()
  })

  it('routes by the agentKind recorded on the session', async () => {
    const store = new Store(initialState)
    const claude = fakeProvider()
    const codex = fakeProvider()
    const router = new ChatRouter(store, { claude, codex })
    startSession(store, 's1', 'codex')

    router.create('s1', '/tmp/wt', 'default', 'gpt-x')
    await expect(router.forkAt('s1', 'e1')).resolves.toEqual({ ok: true, newSessionId: 'forked' })

    expect(codex.create).toHaveBeenCalledWith('s1', '/tmp/wt', 'default', 'gpt-x')
    expect(codex.forkAt).toHaveBeenCalledWith('s1', 'e1')
    expect(claude.create).not.toHaveBeenCalled()
  })

  it('hasSession asks every provider, since it runs before the session is recorded', () => {
    const store = new Store(initialState)
    const router = new ChatRouter(store, { claude: fakeProvider(), codex: fakeProvider(['s1']) })
    expect(router.hasSession('s1')).toBe(true)
    expect(router.hasSession('s2')).toBe(false)
  })

  it('create marks the session exited when no provider backs its agent', () => {
    const store = new Store(initialState)
    const claude = fakeProvider()
    const router = new ChatRouter(store, { claude })
    startSession(store, 's1', 'cursor')

    router.create('s1', '/tmp/wt', 'default')

    const session = store.getSnapshot().state.jsonClaude.sessions['s1']
    expect(session.state).toBe('exited')
    expect(session.exitReason).toMatch(/cursor/)
    expect(claude.create).not.toHaveBeenCalled()
  })

  it('rewind and fork fail cleanly when no provider backs the agent', async () => {
    const store = new Store(initialState)
    const router = new ChatRouter(store, { claude: fakeProvider() })
    startSession(store, 's1', 'cursor')
    expect((await router.rewindTo('s1', 'e1')).ok).toBe(false)
    expect((await router.forkAt('s1', 'e1')).ok).toBe(false)
  })

  it('killAll reaches every provider', () => {
    const store = new Store(initialState)
    const claude = fakeProvider()
    const codex = fakeProvider()
    new ChatRouter(store, { claude, codex }).killAll()
    expect(claude.killAll).toHaveBeenCalled()
    expect(codex.killAll).toHaveBeenCalled()
  })
})
