import { describe, it, expect, vi } from 'vitest'

vi.mock('./debug', () => ({
  log: () => {}
}))

import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import { Store } from './store'
import { initialState } from '../shared/state'
import {
  CodexChatProvider,
  turnsToEntries,
  unwrapShellCommand,
  displayCommand,
  type CodexChatProviderOptions
} from './codex-chat-provider'
import type { CodexTurn } from './codex-app-server'

type Msg = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown }

/** A scripted stand-in for `codex app-server`: answers requests through
 *  `handlers`, records everything the provider wrote, and lets the test
 *  push notifications / server requests. */
function fakeAppServer(handlers: Record<string, (params: Record<string, unknown>) => unknown>) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const proc = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 4242,
    kill: vi.fn()
  }) as unknown as ChildProcessWithoutNullStreams
  const received: Msg[] = []
  let buf = ''
  stdin.on('data', (c: Buffer) => {
    buf += c.toString()
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i)) as Msg
      buf = buf.slice(i + 1)
      received.push(msg)
      if (msg.method && msg.id !== undefined) {
        const h = handlers[msg.method]
        const result = h ? h(msg.params ?? {}) : {}
        const reply =
          result instanceof Error
            ? { id: msg.id, error: { code: -32600, message: result.message } }
            : { id: msg.id, result }
        stdout.write(JSON.stringify(reply) + '\n')
      }
    }
  })
  const emit = (msg: Msg): void => {
    stdout.write(JSON.stringify(msg) + '\n')
  }
  return { proc, received, emit }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

function setup(handlers: Record<string, (params: Record<string, unknown>) => unknown> = {}, threadId?: string) {
  const store = new Store(initialState)
  const server = fakeAppServer({
    initialize: () => ({}),
    'thread/start': () => ({ thread: { id: 'thread-new' }, model: 'gpt-test' }),
    'thread/resume': (p) => ({ thread: { id: p.threadId }, model: 'gpt-test' }),
    'turn/start': () => ({ turn: { id: 'turn-1', items: [], status: 'inProgress', error: null } }),
    'thread/turns/list': () => ({ data: [], nextCursor: null }),
    'model/list': () => ({
      data: [
        { id: 'gpt-6-luna', displayName: 'GPT-6 Luna', hidden: false },
        { id: 'secret-model', displayName: 'Secret', hidden: true }
      ]
    }),
    ...handlers
  })
  const opts: CodexChatProviderOptions = {
    getBinPath: () => '/bin/codex',
    clientVersion: '0.0.0-test',
    getThreadId: vi.fn(() => threadId),
    setThreadId: vi.fn(),
    getModel: () => undefined,
    requestApproval: vi.fn(async () => ({ behavior: 'allow' as const })),
    cancelApprovalsForSession: vi.fn(),
    cancelApprovalForToolUse: vi.fn(),
    spawnProcess: () => server.proc
  }
  const provider = new CodexChatProvider(store, opts)
  store.dispatch({
    type: 'jsonClaude/sessionStarted',
    payload: { sessionId: 's1', worktreePath: process.cwd(), agentKind: 'codex' }
  })
  const session = () => store.getSnapshot().state.jsonClaude.sessions['s1']
  return { store, server, opts, provider, session }
}

describe('CodexChatProvider', () => {
  it('starts a thread, records its id and reports the model', async () => {
    const { provider, opts, session, server } = setup()
    provider.create('s1', process.cwd(), 'default')
    await settle()

    expect(server.received.map((m) => m.method).filter(Boolean)).toEqual([
      'initialize',
      'initialized',
      'model/list',
      'thread/start'
    ])
    expect(opts.setThreadId).toHaveBeenCalledWith('s1', 'thread-new')
    expect(session().state).toBe('running')
    expect(session().currentModel).toBe('gpt-test')
    expect(session().availableModels).toEqual([{ id: 'gpt-6-luna', displayName: 'GPT-6 Luna' }])
    expect(session().historyPending).toBeUndefined()
  })

  it('resumes the recorded thread and seeds its history', async () => {
    const turns: CodexTurn[] = [
      {
        id: 'turn-a',
        status: 'completed',
        error: null,
        items: [
          { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'hello' }] },
          { type: 'agentMessage', id: 'a1', text: 'hi there' }
        ]
      }
    ]
    const { provider, opts, session, server } = setup(
      { 'thread/turns/list': () => ({ data: turns, nextCursor: null }) },
      'thread-old'
    )
    provider.create('s1', process.cwd(), 'default')
    expect(session().historyPending).toBe(true)
    await settle()

    expect(session().historyPending).toBeUndefined()
    expect(server.received.find((m) => m.method === 'thread/resume')?.params?.threadId).toBe('thread-old')
    expect(opts.setThreadId).not.toHaveBeenCalled()
    expect(session().entries.map((e) => [e.kind, e.text ?? e.blocks?.[0]?.text])).toEqual([
      ['user', 'hello'],
      ['assistant', 'hi there']
    ])
  })

  it('streams a turn into an assistant entry tagged with the turn id', async () => {
    const { provider, session, server } = setup()
    provider.create('s1', process.cwd(), 'default')
    await settle()

    provider.send('s1', 'say hi')
    expect(session().busy).toBe(true)
    await settle()
    expect(server.received.find((m) => m.method === 'turn/start')?.params?.input).toEqual([
      { type: 'text', text: 'say hi', text_elements: [] }
    ])

    server.emit({ method: 'turn/started', params: { threadId: 'thread-new', turn: { id: 'turn-1' } } })
    server.emit({
      method: 'item/started',
      params: { threadId: 'thread-new', turnId: 'turn-1', item: { type: 'agentMessage', id: 'm1', text: '' } }
    })
    server.emit({ method: 'item/agentMessage/delta', params: { threadId: 'thread-new', itemId: 'm1', delta: 'Hel' } })
    server.emit({
      method: 'item/completed',
      params: { threadId: 'thread-new', turnId: 'turn-1', item: { type: 'agentMessage', id: 'm1', text: 'Hello' } }
    })
    server.emit({
      method: 'turn/completed',
      params: { threadId: 'thread-new', turn: { id: 'turn-1', status: 'completed', error: null, items: [] } }
    })
    await settle()

    const assistant = session().entries.find((e) => e.kind === 'assistant')!
    expect(assistant.blocks).toEqual([{ type: 'text', text: 'Hello' }])
    expect(assistant.turnId).toBe('turn-1')
    expect(assistant.isPartial).toBeUndefined()
    expect(session().busy).toBe(false)
  })

  it('relays a command approval through the bridge as an unwrapped Bash call', async () => {
    const { provider, opts, server } = setup()
    provider.create('s1', process.cwd(), 'default')
    await settle()

    server.emit({
      id: 99,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-new',
        itemId: 'exec-1',
        command: "/bin/zsh -lc 'npm test'",
        commandActions: [{ type: 'unknown', command: 'npm test' }]
      }
    })
    await settle()

    expect(opts.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', toolName: 'Bash', input: { command: 'npm test' }, toolUseId: 'exec-1' })
    )
    expect(server.received).toContainEqual({ id: 99, result: { decision: 'accept' } })
  })

  it('maps a deny with "interrupt turn" to cancel', async () => {
    const { provider, opts, server } = setup()
    ;(opts.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ behavior: 'deny', interrupt: true })
    provider.create('s1', process.cwd(), 'default')
    await settle()
    server.emit({
      id: 5,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-new', itemId: 'e', command: 'rm -rf x', commandActions: [] }
    })
    await settle()
    expect(server.received).toContainEqual({ id: 5, result: { decision: 'cancel' } })
  })

  it('closes tool cards left open by an interrupted turn', async () => {
    const { provider, session, server } = setup()
    provider.create('s1', process.cwd(), 'default')
    await settle()
    provider.send('s1', 'go')
    server.emit({ method: 'turn/started', params: { threadId: 'thread-new', turn: { id: 'turn-1' } } })
    server.emit({
      method: 'item/started',
      params: {
        threadId: 'thread-new',
        turnId: 'turn-1',
        item: { type: 'commandExecution', id: 'cmd-1', command: 'sleep 30', cwd: '/x', status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null }
      }
    })
    server.emit({
      method: 'turn/completed',
      params: { threadId: 'thread-new', turn: { id: 'turn-1', status: 'interrupted', error: null, items: [] } }
    })
    await settle()
    const result = session().entries.find((e) => e.kind === 'tool_result')
    expect(result?.blocks?.[0]).toMatchObject({ toolUseId: 'cmd-1', content: 'Interrupted', isError: true })
  })

  it('passes Ness MCP servers and developer instructions on thread/start', async () => {
    const { provider, opts, server } = setup()
    opts.getMcpServers = () => ({ 'ness-control': { command: '/bin/node', args: ['bridge.js'], env: { HARNESS_PORT: '1' } } })
    opts.getDeveloperInstructions = () => 'You are running inside Ness.'
    provider.create('s1', process.cwd(), 'default')
    await settle()
    expect(server.received.find((m) => m.method === 'thread/start')?.params).toMatchObject({
      developerInstructions: 'You are running inside Ness.',
      config: { mcp_servers: { 'ness-control': { command: '/bin/node', args: ['bridge.js'] } } }
    })
  })

  it('relays an MCP tool-call approval as an mcp__ tool and answers in elicitation shape', async () => {
    const { provider, opts, server } = setup()
    provider.create('s1', process.cwd(), 'default')
    await settle()
    server.emit({
      method: 'item/started',
      params: {
        threadId: 'thread-new',
        turnId: 't',
        item: { type: 'mcpToolCall', id: 'mcp-1', server: 'ness-control', tool: 'send_message', status: 'inProgress', arguments: {} }
      }
    })
    server.emit({
      id: 42,
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'thread-new',
        serverName: 'ness-control',
        mode: 'form',
        message: 'Allow the ness-control MCP server to run tool "send_message"?',
        _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: { worktree: 'repo/x', message: 'hi' } },
        requestedSchema: { type: 'object', properties: {} }
      }
    })
    await settle()
    expect(opts.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'mcp__ness-control__send_message',
        input: { worktree: 'repo/x', message: 'hi' },
        toolUseId: 'mcp-1'
      })
    )
    expect(server.received).toContainEqual({ id: 42, result: { action: 'accept', content: {}, _meta: null } })
  })

  it('declines MCP elicitations that are not tool-call approvals', async () => {
    const { provider, opts, server } = setup()
    provider.create('s1', process.cwd(), 'default')
    await settle()
    server.emit({
      id: 43,
      method: 'mcpServer/elicitation/request',
      params: { threadId: 'thread-new', serverName: 'other', mode: 'form', message: 'Pick a color', _meta: null, requestedSchema: {} }
    })
    await settle()
    expect(opts.requestApproval).not.toHaveBeenCalled()
    expect(server.received).toContainEqual({ id: 43, result: { action: 'decline', content: null, _meta: null } })
  })

  it('steers a busy turn instead of starting a new one', async () => {
    const { provider, session, server } = setup({ 'turn/steer': () => ({ turnId: 'turn-1' }) })
    provider.create('s1', process.cwd(), 'default')
    await settle()
    provider.send('s1', 'first')
    server.emit({ method: 'turn/started', params: { threadId: 'thread-new', turn: { id: 'turn-1' } } })
    await settle()

    provider.send('s1', 'also this')
    await settle()

    const steer = server.received.find((m) => m.method === 'turn/steer')
    expect(steer?.params).toMatchObject({ threadId: 'thread-new', expectedTurnId: 'turn-1' })
    expect(server.received.filter((m) => m.method === 'turn/start')).toHaveLength(1)
    expect(session().entries.at(-1)).toMatchObject({ kind: 'user', text: 'also this', isQueued: true })
  })

  it('rewinds to just after the clicked entry’s turn and reseeds', async () => {
    const all: CodexTurn[] = [
      { id: 't1', status: 'completed', error: null, items: [{ type: 'agentMessage', id: 'a1', text: 'one' }] },
      { id: 't2', status: 'completed', error: null, items: [{ type: 'agentMessage', id: 'a2', text: 'two' }] }
    ]
    let reverted = false
    const { provider, store, session, server } = setup({
      'thread/turns/list': () => ({ data: reverted ? all.slice(0, 1) : all, nextCursor: null }),
      'thread/revert': () => {
        reverted = true
        return { thread: { id: 'thread-new' } }
      }
    })
    provider.create('s1', process.cwd(), 'default')
    await settle()
    store.dispatch({
      type: 'jsonClaude/entriesSeeded',
      payload: { sessionId: 's1', entries: turnsToEntries('s1', all) }
    })
    const first = session().entries.find((e) => e.turnId === 't1')!

    await expect(provider.rewindTo('s1', first.entryId)).resolves.toEqual({ ok: true })
    expect(server.received.find((m) => m.method === 'thread/revert')?.params).toEqual({
      threadId: 'thread-new',
      beforeTurnId: 't2'
    })
    expect(session().entries.map((e) => e.blocks?.[0]?.text)).toEqual(['one'])
  })

  it('forks in the new tab’s own process, through the clicked turn, with the model passed', async () => {
    const { provider, store, opts } = setup()
    provider.create('s1', process.cwd(), 'default')
    await settle()
    store.dispatch({
      type: 'jsonClaude/entriesSeeded',
      payload: {
        sessionId: 's1',
        entries: turnsToEntries('s1', [
          { id: 't1', status: 'completed', error: null, items: [{ type: 'agentMessage', id: 'a1', text: 'one' }] }
        ])
      }
    })
    const entryId = store.getSnapshot().state.jsonClaude.sessions['s1'].entries[0].entryId

    const outcome = await provider.forkAt('s1', entryId)
    expect(outcome.ok).toBe(true)
    const forkId = outcome.newSessionId!

    // The fork tab spawns its own app-server; thread/fork must run there,
    // not in the source's process (which would keep the fork loaded and
    // block the new process from using it).
    const forkTurns: CodexTurn[] = [
      { id: 't1', status: 'completed', error: null, items: [{ type: 'agentMessage', id: 'a1', text: 'one' }] }
    ]
    const forkServer = fakeAppServer({
      initialize: () => ({}),
      'thread/fork': () => ({ thread: { id: 'thread-fork' }, model: 'gpt-test' }),
      'thread/turns/list': () => ({ data: forkTurns, nextCursor: null })
    })
    opts.spawnProcess = () => forkServer.proc
    store.dispatch({
      type: 'jsonClaude/sessionStarted',
      payload: { sessionId: forkId, worktreePath: process.cwd(), agentKind: 'codex' }
    })
    provider.create(forkId, process.cwd(), 'default')
    await settle()

    expect(forkServer.received.find((m) => m.method === 'thread/fork')?.params).toMatchObject({
      threadId: 'thread-new',
      lastTurnId: 't1',
      model: 'gpt-test'
    })
    expect(forkServer.received.some((m) => m.method === 'thread/start')).toBe(false)
    expect(opts.setThreadId).toHaveBeenCalledWith(forkId, 'thread-fork')
    const forkSession = store.getSnapshot().state.jsonClaude.sessions[forkId]
    expect(forkSession.state).toBe('running')
    expect(forkSession.entries.map((e) => e.blocks?.[0]?.text)).toEqual(['one'])
  })

  it('refuses to fork a turn that is still running', async () => {
    const { provider, store, server } = setup()
    provider.create('s1', process.cwd(), 'default')
    await settle()
    provider.send('s1', 'go')
    server.emit({ method: 'turn/started', params: { threadId: 'thread-new', turn: { id: 'turn-1' } } })
    server.emit({
      method: 'item/started',
      params: { threadId: 'thread-new', turnId: 'turn-1', item: { type: 'agentMessage', id: 'm1', text: '' } }
    })
    await settle()
    const entry = store.getSnapshot().state.jsonClaude.sessions['s1'].entries.find((e) => e.turnId === 'turn-1')!
    expect((await provider.forkAt('s1', entry.entryId)).ok).toBe(false)
  })

  it('starts a new thread quietly when the recorded one never got a rollout', async () => {
    const { provider, opts, session } = setup(
      { 'thread/resume': (p) => new Error(`no rollout found for thread id ${p.threadId}`) },
      'never-saved'
    )
    provider.create('s1', process.cwd(), 'default')
    await settle()
    expect(opts.setThreadId).toHaveBeenCalledWith('s1', 'thread-new')
    expect(session().state).toBe('running')
    expect(session().entries.filter((e) => e.kind === 'error')).toEqual([])
  })

  it('retries a resume while another process still holds the thread', async () => {
    let attempts = 0
    const { provider, opts, session } = setup(
      {
        'thread/resume': (p) =>
          ++attempts < 3
            ? new Error(`thread ${p.threadId} already has an active writer`)
            : { thread: { id: p.threadId }, model: 'gpt-test' }
      },
      'thread-old'
    )
    opts.resumeRetry = { intervalMs: 1, windowMs: 1000 }
    provider.create('s1', process.cwd(), 'default')
    for (let i = 0; i < 100 && session().state !== 'running'; i++) await new Promise((r) => setTimeout(r, 5))
    expect(attempts).toBe(3)
    expect(session().state).toBe('running')
    expect(opts.setThreadId).not.toHaveBeenCalled()
    expect(session().entries.filter((e) => e.kind === 'error')).toEqual([])
  })

  it('stops instead of starting a new thread when the holder never lets go', async () => {
    const { provider, opts, session, server } = setup(
      { 'thread/resume': (p) => new Error(`thread ${p.threadId} already has an active writer`) },
      'thread-old'
    )
    opts.resumeRetry = { intervalMs: 1, windowMs: 20 }
    provider.create('s1', process.cwd(), 'default')
    for (let i = 0; i < 100 && session().state !== 'exited'; i++) await new Promise((r) => setTimeout(r, 5))
    expect(session().state).toBe('exited')
    expect(server.received.some((m) => m.method === 'thread/start')).toBe(false)
    expect(session().historyPending).toBeUndefined()
    expect(opts.setThreadId).not.toHaveBeenCalled()
    expect(session().entries.at(-1)).toMatchObject({ errorKind: 'spawn-failed' })
    expect(session().entries.at(-1)?.errorMessage).toMatch(/still open in another Codex process/)
  })

  it('tells the user when an existing conversation fails to resume', async () => {
    const { provider, session } = setup(
      { 'thread/resume': () => new Error('rollout is corrupt') },
      'thread-old'
    )
    provider.create('s1', process.cwd(), 'default')
    await settle()
    const errors = session().entries.filter((e) => e.errorKind === 'agent-error')
    expect(errors).toHaveLength(1)
    expect(errors[0].errorMessage).toMatch(/rollout is corrupt/)
  })

  it('surfaces a non-retrying error once, not again on turn/completed', async () => {
    const { provider, session, server } = setup()
    provider.create('s1', process.cwd(), 'default')
    await settle()
    provider.send('s1', 'go')
    server.emit({
      method: 'error',
      params: { threadId: 'thread-new', turnId: 'turn-1', willRetry: false, error: { message: 'model not supported' } }
    })
    server.emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-new',
        turn: { id: 'turn-1', status: 'failed', error: { message: 'model not supported' }, items: [] }
      }
    })
    await settle()
    const errors = session().entries.filter((e) => e.errorKind === 'agent-error')
    expect(errors).toHaveLength(1)
    expect(errors[0].errorMessage).toBe('model not supported')
  })

  it('kill cancels approvals and marks the session exited', async () => {
    const { provider, opts, session } = setup()
    provider.create('s1', process.cwd(), 'default')
    await settle()
    provider.kill('s1')
    expect(opts.cancelApprovalsForSession).toHaveBeenCalledWith('s1', expect.any(String))
    expect(session().state).toBe('exited')
    expect(provider.hasSession('s1')).toBe(false)
  })
})

describe('codex mapping helpers', () => {
  it('unwraps the login-shell wrapper Codex puts around commands', () => {
    expect(unwrapShellCommand("/bin/zsh -lc 'echo hello > out.txt'")).toBe('echo hello > out.txt')
    expect(unwrapShellCommand("bash -lc 'echo '\\''hi'\\'''")).toBe("echo 'hi'")
    expect(unwrapShellCommand('ls -la')).toBe('ls -la')
  })

  it('prefers a single parsed command action', () => {
    expect(displayCommand("/bin/zsh -lc 'sleep 4 && echo slept'", [{ command: 'sleep 4 && echo slept' }])).toBe(
      'sleep 4 && echo slept'
    )
  })

  it('maps turns to user, assistant, tool_use and tool_result entries', () => {
    const entries = turnsToEntries('s', [
      {
        id: 't1',
        status: 'completed',
        error: null,
        items: [
          { type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'run it' }] },
          { type: 'reasoning', id: 'r', summary: ['thinking about it'], content: [] },
          {
            type: 'commandExecution',
            id: 'c',
            command: "/bin/zsh -lc 'false'",
            cwd: '/x',
            status: 'failed',
            commandActions: [],
            aggregatedOutput: 'boom',
            exitCode: 1
          },
          { type: 'agentMessage', id: 'a', text: 'done' }
        ]
      }
    ])
    expect(entries.map((e) => e.kind)).toEqual(['user', 'assistant', 'assistant', 'tool_result', 'assistant'])
    expect(entries[1].blocks?.[0]).toEqual({ type: 'thinking', text: 'thinking about it' })
    expect(entries[2].blocks?.[0]).toMatchObject({ type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'false' } })
    expect(entries[3].blocks?.[0]).toMatchObject({ toolUseId: 'c', content: 'boom', isError: true })
    expect(entries.filter((e) => e.kind === 'assistant').every((e) => e.turnId === 't1')).toBe(true)
  })
})
