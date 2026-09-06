import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

// Mock child_process.spawn before importing JsonClaudeManager. Each spawn()
// call returns a fresh fake process: an EventEmitter with .stdout, .stderr,
// .stdin, and .kill — enough for the manager to wire its handlers and for
// the test to fire 'exit' / 'data' events at will.
function makeFakeProc() {
  const stdout = new EventEmitter() as EventEmitter & { on: typeof EventEmitter.prototype.on }
  const stderr = new EventEmitter()
  const stdin = { write: vi.fn(), end: vi.fn() }
  const proc = new EventEmitter() as EventEmitter & {
    stdout: typeof stdout
    stderr: typeof stderr
    stdin: typeof stdin
    kill: ReturnType<typeof vi.fn>
    spawnArgs: string[]
  }
  Object.assign(proc, { stdout, stderr, stdin, kill: vi.fn(), spawnArgs: [] })
  return proc
}

const spawnedProcs: ReturnType<typeof makeFakeProc>[] = []
const spawnCalls: Array<{ command: string; args: string[] }> = []

vi.mock('child_process', () => ({
  spawn: vi.fn((command: string, args: string[]) => {
    spawnCalls.push({ command, args })
    const proc = makeFakeProc()
    proc.spawnArgs = args
    spawnedProcs.push(proc)
    return proc
  })
}))

/** Filter to the real json-claude session spawns, excluding the
 *  slash-command probe that JsonClaudeManager fires alongside each
 *  create(). The session command line passes --permission-prompt-tool;
 *  the probe doesn't. */
function sessionProcs(): typeof spawnedProcs {
  return spawnedProcs.filter((p) =>
    p.spawnArgs.some((a) => a.includes('--permission-prompt-tool'))
  )
}

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', setPath: () => {}, isPackaged: false }
}))

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    // The manager checks existsSync for two things: (1) the pre-flight
    // worktree-cwd guard added for issue #185 (needs true so tests
    // can spawn a session), and (2) the transcript-file existence
    // check that decides --resume vs --session-id (needs false so
    // tests spawn fresh sessions). Discriminate on the transcript
    // path shape — paths under ~/.claude/projects/ are transcripts.
    existsSync: (p: string) =>
      typeof p === 'string' && !p.includes('.claude/projects') && !p.endsWith('.jsonl'),
    readFileSync: () => ''
  }
})

import { Store } from './store'
import { JsonClaudeManager } from './json-claude-manager'
import { wrapAutomatedMessage } from '../shared/state/json-claude'
import type { ClaudeLaunchSettings } from './claude-launch'

describe('JsonClaudeManager', () => {
  beforeEach(() => {
    spawnedProcs.length = 0
    spawnCalls.length = 0
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  function makeManager(
    store: Store,
    launchSettings: ClaudeLaunchSettings = { tuiFullscreen: true },
    useSystemClaude = false
  ): JsonClaudeManager {
    return new JsonClaudeManager(store, {
      getClaudeCommand: () => 'claude',
      getUseSystemClaude: () => useSystemClaude,
      getApprovalSocketPath: (sid) => `/tmp/sock-${sid}`,
      closeApprovalSession: vi.fn(),
      getClaudeEnvVars: () => ({}),
      getControlServer: () => null,
      getControlBridgeScriptPath: () => '/tmp/bridge.js',
      isHarnessMcpEnabled: () => false,
      getCallerScope: () => null,
      getLaunchSettings: () => launchSettings
    })
  }

  /** Return the last session spawn's CLI args joined as a string. For the
   *  bundled path this is the args array; for the system-claude path
   *  (`<user-shell> -ilc <cmdLine>`) it's the cmdLine inside -ilc. Skips the
   *  slash-command probe spawn (which doesn't pass --permission-prompt-tool). */
  function lastSpawnCmdLine(): string {
    const sessionCalls = spawnCalls.filter((c) =>
      c.args.some((a) => a.includes('--permission-prompt-tool'))
    )
    const call = sessionCalls[sessionCalls.length - 1]
    expect(call).toBeDefined()
    if (call.args[0] === '-ilc') {
      return call.args[1]
    }
    return call.args.join(' ')
  }

  it('pre-flight cwd guard: missing worktree dir short-circuits + dispatches spawn-failed (issue #185)', () => {
    const store = new Store()
    const mgr = makeManager(store)
    const sessionId = 'sess-cwd-missing'
    const cwd = '/tmp/gone/.claude/projects/fake-missing-cwd'
    // Path shape matches the transcript-blacklist in the fs mock so
    // existsSync returns false — same as a real missing worktree.
    store.dispatch({
      type: 'jsonClaude/sessionStarted',
      payload: { sessionId, worktreePath: cwd }
    })

    mgr.create(sessionId, cwd)

    // No spawn attempted — pre-flight guard fired.
    expect(sessionProcs().length).toBe(0)
    const session = store.getSnapshot().state.jsonClaude.sessions[sessionId]
    expect(session?.state).toBe('exited')
    const errorEntry = session?.entries.find(
      (e) => e.kind === 'error' && e.errorKind === 'spawn-failed'
    )
    expect(errorEntry).toBeDefined()
    expect(errorEntry?.errorMessage).toContain('no longer exists')
  })

  it("kill+create cycle: late exit from killed proc doesn't clobber the new instance", () => {
    const store = new Store()
    const mgr = makeManager(store)
    const sessionId = 'sess-A'
    const cwd = '/tmp/wt'

    // Initial spawn — instance A.
    store.dispatch({ type: 'jsonClaude/sessionStarted', payload: { sessionId, worktreePath: cwd } })
    mgr.create(sessionId, cwd)
    const procA = sessionProcs()[0]
    expect(procA).toBeDefined()
    expect(store.getSnapshot().state.jsonClaude.sessions[sessionId]?.state).toBe('running')

    // Kill A. SIGTERM is async; A's exit hasn't fired yet.
    mgr.kill(sessionId)
    expect(procA.kill).toHaveBeenCalledWith('SIGTERM')
    expect(store.getSnapshot().state.jsonClaude.sessions[sessionId]?.state).toBe('exited')

    // The convertTabType path also clears the slice entry; mirror that
    // here so we see the same starting state the production code lands
    // in before the renderer fires its mount-time start.
    store.dispatch({ type: 'jsonClaude/sessionCleared', payload: { sessionId } })
    expect(store.getSnapshot().state.jsonClaude.sessions[sessionId]).toBeUndefined()

    // Re-create — instance B. Same sessionId, fresh proc.
    store.dispatch({ type: 'jsonClaude/sessionStarted', payload: { sessionId, worktreePath: cwd } })
    mgr.create(sessionId, cwd)
    const procB = sessionProcs()[1]
    expect(procB).toBeDefined()
    expect(procB).not.toBe(procA)
    expect(store.getSnapshot().state.jsonClaude.sessions[sessionId]?.state).toBe('running')

    // Now the OS finally kills proc A — its 'exit' event fires LATE,
    // after B is already registered. Without the stale-exit guard, this
    // would dispatch state='exited' against B and close B's approval
    // socket. With the guard, it's a no-op.
    procA.emit('exit', null, 'SIGTERM')

    // B's state must still be 'running'.
    expect(store.getSnapshot().state.jsonClaude.sessions[sessionId]?.state).toBe('running')
  })

  it("multi-client safety: re-entering sessionStarted after running doesn't get stuck on 'connecting'", () => {
    // Repro of the two-viewer bug: when desktop + mobile both watch the
    // same json-claude tab during a tab-type swap, both renderers fire
    // startJsonClaude. The IPC handler used to dispatch sessionStarted
    // unconditionally on every call, and sessionStarted resets state to
    // 'connecting' — leaving the slice stuck because create() would
    // short-circuit (instance already running) and never re-emit
    // 'running'.
    //
    // The fix gates the start path on hasSession() in the IPC handler.
    // This test models a caller that respects the guard.
    const store = new Store()
    const mgr = makeManager(store)
    const sessionId = 'sess-C'
    const cwd = '/tmp/wt'

    function startIfFresh(): void {
      if (mgr.hasSession(sessionId)) return
      store.dispatch({
        type: 'jsonClaude/sessionStarted',
        payload: { sessionId, worktreePath: cwd }
      })
      mgr.create(sessionId, cwd)
    }

    startIfFresh()
    expect(store.getSnapshot().state.jsonClaude.sessions[sessionId]?.state).toBe('running')

    // Second client mounts and races into the start path.
    startIfFresh()

    // Without the guard, state would be reset to 'connecting' here.
    expect(store.getSnapshot().state.jsonClaude.sessions[sessionId]?.state).toBe('running')
    // Only one session proc was actually spawned — guard short-circuited
    // the second call. (Probes are per-cwd, also one.)
    expect(sessionProcs().length).toBe(1)
  })

  it('passes --append-system-prompt, --model, --name when launch settings are set (system claude path)', () => {
    const store = new Store()
    const mgr = makeManager(
      store,
      {
        systemPrompt: 'BASE\n\nMAIN',
        model: 'opus',
        sessionName: 'myrepo/feat-x',
        tuiFullscreen: true
      },
      true
    )
    store.dispatch({ type: 'jsonClaude/sessionStarted', payload: { sessionId: 'sess-flags', worktreePath: '/tmp/wt' } })
    mgr.create('sess-flags', '/tmp/wt')
    const cmd = lastSpawnCmdLine()
    expect(cmd).toContain('--append-system-prompt')
    expect(cmd).toContain("'BASE\n\nMAIN'")
    expect(cmd).toContain('--model')
    expect(cmd).toContain("'opus'")
    expect(cmd).toContain('--name')
    expect(cmd).toContain("'myrepo/feat-x'")
  })

  // Regression: the system prompt contains literal backticks (e.g.
  // `key`, `zsh -ilc <command>`). When args were JSON.stringified into
  // double quotes, zsh -ilc would still command-substitute the
  // backticks (→ "command not found: key", exit 127) and parse-error
  // on the redirection token inside the substitution. Single-quoted
  // form makes everything inert. Specific to the system-claude path —
  // bundled spawn passes args as an array, no shell parses them.
  it('single-quotes args so backticks in the system prompt are not command-substituted (system claude path)', () => {
    const store = new Store()
    const mgr = makeManager(
      store,
      {
        systemPrompt: 'a `key` b',
        tuiFullscreen: true
      },
      true
    )
    store.dispatch({ type: 'jsonClaude/sessionStarted', payload: { sessionId: 'sess-bt', worktreePath: '/tmp/wt' } })
    mgr.create('sess-bt', '/tmp/wt')
    const cmd = lastSpawnCmdLine()
    expect(cmd).toContain("'a `key` b'")
    expect(cmd).not.toContain('"a `key` b"')
  })

  it('bundled path: spawns the resolved binary directly with args as an array (no shell wrapping)', () => {
    const store = new Store()
    const mgr = makeManager(store, {
      systemPrompt: 'BASE',
      model: 'opus',
      sessionName: 'r/b',
      tuiFullscreen: true
    })
    store.dispatch({ type: 'jsonClaude/sessionStarted', payload: { sessionId: 'sess-bundled', worktreePath: '/tmp/wt' } })
    mgr.create('sess-bundled', '/tmp/wt')
    const sessionCalls = spawnCalls.filter((c) =>
      c.args.some((a) => a.includes('--permission-prompt-tool'))
    )
    const call = sessionCalls[sessionCalls.length - 1]
    expect(call).toBeDefined()
    expect(call.args[0]).not.toBe('-ilc')
    // Resolves to the platform-matching native binary inside the bundled
    // optional subpackage. Filename is `claude` on POSIX, `claude.exe` on
    // Windows; either is fine here.
    expect(call.command).toMatch(/[/\\]claude(\.exe)?$/)
    expect(call.args).toContain('--append-system-prompt')
    expect(call.args).toContain('BASE')
    expect(call.args).toContain('--model')
    expect(call.args).toContain('opus')
    expect(call.args).toContain('--name')
    expect(call.args).toContain('r/b')
  })

  it('omits --append-system-prompt, --model, --name when launch settings are unset', () => {
    const store = new Store()
    const mgr = makeManager(store, { tuiFullscreen: true })
    store.dispatch({ type: 'jsonClaude/sessionStarted', payload: { sessionId: 'sess-empty', worktreePath: '/tmp/wt' } })
    mgr.create('sess-empty', '/tmp/wt')
    const cmd = lastSpawnCmdLine()
    expect(cmd).not.toContain('--append-system-prompt')
    expect(cmd).not.toContain('--model')
    expect(cmd).not.toContain('--name')
  })

  // Mid-turn messages used to stay dashed/"queued" until the whole turn
  // ended, even though claude picks them up at the next agent-loop step.
  // Claude drains its input queue right before building the next API
  // request and emits {system, status: 'requesting'} at that moment — so
  // that event, not `result`, is when the bubble should go solid.
  describe('mid-turn queued messages', () => {
    function startBusySession(store: Store, sessionId: string) {
      const mgr = makeManager(store)
      const cwd = '/tmp/wt'
      store.dispatch({
        type: 'jsonClaude/sessionStarted',
        payload: { sessionId, worktreePath: cwd }
      })
      mgr.create(sessionId, cwd)
      mgr.send(sessionId, 'first turn')
      return { mgr, proc: sessionProcs()[0] }
    }

    const queuedCount = (store: Store, sessionId: string) =>
      (store.getSnapshot().state.jsonClaude.sessions[sessionId]?.entries ?? []).filter(
        (e) => e.isQueued
      ).length

    it("clears isQueued on the next 'requesting' status, before the turn ends", () => {
      const store = new Store()
      const sessionId = 'sess-queued-requesting'
      const { mgr, proc } = startBusySession(store, sessionId)

      mgr.send(sessionId, 'interjection')
      expect(queuedCount(store, sessionId)).toBe(1)

      // A tool result mid-turn doesn't mean the message was picked up.
      proc.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            type: 'user',
            message: {
              role: 'user',
              content: [
                { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }
              ]
            }
          }) + '\n'
        )
      )
      expect(queuedCount(store, sessionId)).toBe(1)

      proc.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({ type: 'system', subtype: 'status', status: 'requesting' }) +
            '\n'
        )
      )
      expect(queuedCount(store, sessionId)).toBe(0)
      // Still mid-turn: busy stays true, the bubble just isn't queued.
      expect(store.getSnapshot().state.jsonClaude.sessions[sessionId]?.busy).toBe(true)
    })

    it('repositions the message after the content it interrupted', () => {
      const store = new Store()
      const sessionId = 'sess-queued-reorder'
      const { mgr, proc } = startBusySession(store, sessionId)

      // The user interjects while claude is mid-stream, so the bubble is
      // appended ahead of the assistant message that was already in
      // flight — then claude finishes it.
      mgr.send(sessionId, 'interjection')
      proc.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            type: 'assistant',
            message: { id: 'msg_a', content: [{ type: 'text', text: 'still talking' }] }
          }) + '\n'
        )
      )
      // Assistant entries carry `blocks`, user entries carry `text`.
      const order = (): Array<string | undefined> =>
        (store.getSnapshot().state.jsonClaude.sessions[sessionId]?.entries ?? []).map(
          (e) =>
            e.kind === 'user'
              ? e.text
              : e.blocks?.map((b) => ('text' in b ? b.text : '')).join('')
        )
      expect(order()).toEqual(['first turn', 'interjection', 'still talking'])

      proc.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({ type: 'system', subtype: 'status', status: 'requesting' }) +
            '\n'
        )
      )
      expect(order()).toEqual(['first turn', 'still talking', 'interjection'])
    })

    it('leaves a message queued while a non-requesting status streams by', () => {
      const store = new Store()
      const sessionId = 'sess-queued-other-status'
      const { mgr, proc } = startBusySession(store, sessionId)
      mgr.send(sessionId, 'interjection')

      proc.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({ type: 'system', subtype: 'status', status: 'compacting' }) +
            '\n'
        )
      )
      expect(queuedCount(store, sessionId)).toBe(1)
    })

    it('still unqueues on result for messages that land after the last request', () => {
      const store = new Store()
      const sessionId = 'sess-queued-result'
      const { mgr, proc } = startBusySession(store, sessionId)
      mgr.send(sessionId, 'interjection')

      proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result' }) + '\n'))
      expect(queuedCount(store, sessionId)).toBe(0)
    })
  })

  describe('permission mode reconciliation from init', () => {
    function startWithMode(store: Store, sessionId: string, mode: 'default' | 'plan' | 'auto') {
      const cwd = '/tmp/wt'
      store.dispatch({
        type: 'jsonClaude/sessionStarted',
        payload: { sessionId, worktreePath: cwd }
      })
      store.dispatch({
        type: 'jsonClaude/permissionModeChanged',
        payload: { sessionId, mode }
      })
      const mgr = makeManager(store)
      mgr.create(sessionId, cwd, mode)
      return sessionProcs()[sessionProcs().length - 1]
    }

    const emitInit = (proc: ReturnType<typeof makeFakeProc>, permissionMode?: string) =>
      proc.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({ type: 'system', subtype: 'init', permissionMode }) + '\n'
        )
      )

    const modeOf = (store: Store, sessionId: string) =>
      store.getSnapshot().state.jsonClaude.sessions[sessionId].permissionMode

    it('adopts the mode the CLI reports when it drifted behind our back', () => {
      const store = new Store()
      const sessionId = 'sess-mode-drift'
      const proc = startWithMode(store, sessionId, 'auto')

      // The model called EnterPlanMode, so the subprocess is really in
      // plan while the toggle still shows auto.
      emitInit(proc, 'plan')

      expect(modeOf(store, sessionId)).toBe('plan')
    })

    it('leaves the mode alone when init agrees with the slice', () => {
      const store = new Store()
      const sessionId = 'sess-mode-agree'
      const proc = startWithMode(store, sessionId, 'auto')
      const before = store.getSnapshot().seq

      emitInit(proc, 'auto')

      expect(modeOf(store, sessionId)).toBe('auto')
      expect(store.getSnapshot().seq).toBe(before)
    })

    it('ignores modes we do not expose and init payloads with no mode', () => {
      const store = new Store()
      const sessionId = 'sess-mode-unknown'
      const proc = startWithMode(store, sessionId, 'plan')

      emitInit(proc, 'bypassPermissions')
      expect(modeOf(store, sessionId)).toBe('plan')

      emitInit(proc, undefined)
      expect(modeOf(store, sessionId)).toBe('plan')
    })
  })

  it('rate_limit_event over threshold emits one warning card; back-to-back duplicates dedup', () => {
    const store = new Store()
    const mgr = makeManager(store)
    const sessionId = 'sess-rl-warn'
    const cwd = '/tmp/wt'
    store.dispatch({
      type: 'jsonClaude/sessionStarted',
      payload: { sessionId, worktreePath: cwd }
    })
    mgr.create(sessionId, cwd)
    const proc = sessionProcs()[0]
    const event = {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'warning',
        utilization: 0.9,
        resetsAt: 1_700_000_000,
        rateLimitType: 'five_hour'
      }
    }
    const line = JSON.stringify(event) + '\n'
    proc.stdout.emit('data', Buffer.from(line))
    proc.stdout.emit('data', Buffer.from(line))
    const entries =
      store.getSnapshot().state.jsonClaude.sessions[sessionId]?.entries ?? []
    const warnings = entries.filter(
      (e) => e.errorKind === 'rate-limit-warning'
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0].kind).toBe('system')
    expect(warnings[0].rateLimitDetail?.utilization).toBe(0.9)
    expect(warnings[0].rateLimitDetail?.tier).toBe('five_hour')
    // resetsAt was seconds (< 1e12) → coerced to ms.
    expect(warnings[0].rateLimitDetail?.resetAt).toBe(1_700_000_000_000)
  })

  it('rate_limit_event below threshold does not emit a card and clears dedup', () => {
    const store = new Store()
    const mgr = makeManager(store)
    const sessionId = 'sess-rl-low'
    const cwd = '/tmp/wt'
    store.dispatch({
      type: 'jsonClaude/sessionStarted',
      payload: { sessionId, worktreePath: cwd }
    })
    mgr.create(sessionId, cwd)
    const proc = sessionProcs()[0]
    proc.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          type: 'rate_limit_event',
          rate_limit_info: { status: 'allowed', utilization: 0.4 }
        }) + '\n'
      )
    )
    proc.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          type: 'rate_limit_event',
          rate_limit_info: { status: 'warning', utilization: 0.85 }
        }) + '\n'
      )
    )
    const entries =
      store.getSnapshot().state.jsonClaude.sessions[sessionId]?.entries ?? []
    const warnings = entries.filter(
      (e) => e.errorKind === 'rate-limit-warning'
    )
    // Only the over-threshold event surfaced.
    expect(warnings).toHaveLength(1)
  })

  it('result subtype error_during_execution with rate-limit terminal_reason emits an error card', () => {
    const store = new Store()
    const mgr = makeManager(store)
    const sessionId = 'sess-rl-err'
    const cwd = '/tmp/wt'
    store.dispatch({
      type: 'jsonClaude/sessionStarted',
      payload: { sessionId, worktreePath: cwd }
    })
    mgr.create(sessionId, cwd)
    const proc = sessionProcs()[0]
    proc.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          type: 'result',
          subtype: 'error_during_execution',
          terminal_reason: 'blocking_limit',
          errors: ['429 rate_limit: usage limit reached']
        }) + '\n'
      )
    )
    const entries =
      store.getSnapshot().state.jsonClaude.sessions[sessionId]?.entries ?? []
    const errs = entries.filter((e) => e.errorKind === 'rate-limit-error')
    expect(errs).toHaveLength(1)
    expect(errs[0].kind).toBe('error')
    expect(errs[0].errorMessage).toContain('429')
  })

  // Regression for the auth-card-no-longer-firing bug introduced by
  // a073810: that commit added an `is_error` gate to the auth detector
  // (correct) but also stripped the `result`/`message` fallbacks out of
  // pickErrorString. Real auth failures often arrive as
  // {type:'result', is_error:true, result:'Failed to authenticate ...'}
  // — with the strip, the detector returned null and no card surfaced.
  // The fix re-broadens to result/message inside the post-is_error
  // branch (the gate still defends against the original false-positive).
  describe('auth-failure detection from result events', () => {
    function feedResult(payload: Record<string, unknown>): Array<{
      kind?: string
      errorKind?: string
      errorMessage?: string
    }> {
      const store = new Store()
      const mgr = makeManager(store)
      const sessionId = 'sess-auth'
      const cwd = '/tmp/wt'
      store.dispatch({
        type: 'jsonClaude/sessionStarted',
        payload: { sessionId, worktreePath: cwd }
      })
      mgr.create(sessionId, cwd)
      const proc = sessionProcs()[0]
      proc.stdout.emit(
        'data',
        Buffer.from(JSON.stringify({ type: 'result', ...payload }) + '\n')
      )
      const entries =
        store.getSnapshot().state.jsonClaude.sessions[sessionId]?.entries ?? []
      return entries.filter((e) => e.errorKind === 'auth-failure')
    }

    it('is_error:true with auth message in result emits the auth card', () => {
      const cards = feedResult({
        is_error: true,
        result: 'Failed to authenticate. API Error: 401 Unauthorized'
      })
      expect(cards).toHaveLength(1)
      expect(cards[0].kind).toBe('error')
      expect(cards[0].errorMessage).toContain('401')
    })

    it('is_error:true with auth message in message emits the auth card', () => {
      const cards = feedResult({
        is_error: true,
        message: 'Please run /login to refresh your credentials'
      })
      expect(cards).toHaveLength(1)
      expect(cards[0].errorMessage).toContain('/login')
    })

    it('is_error:true with auth message in error still emits the card (strict path)', () => {
      const cards = feedResult({
        is_error: true,
        error: '401 unauthorized'
      })
      expect(cards).toHaveLength(1)
      expect(cards[0].errorMessage).toContain('401')
    })

    it('is_error:false with auth-keyword content in result does NOT emit a card', () => {
      const cards = feedResult({
        is_error: false,
        result:
          'Sure, here is how to configure authentication for your API: ...'
      })
      expect(cards).toHaveLength(0)
    })

    it('is_error:true but message has no auth keyword does NOT emit a card', () => {
      const cards = feedResult({
        is_error: true,
        result: 'Build succeeded'
      })
      expect(cards).toHaveLength(0)
    })
  })

  // Envelopes below are verbatim from a stream-json capture against the
  // bundled binary (claude_code_version 2.1.221) launching an Agent with
  // run_in_background: true.
  describe('background agent lifecycle', () => {
    const TOOL_USE_ID = 'toolu_01STMJPUVRK9XDsKNYodS3yt'
    const TASK_ID = 'a05e8b79e720910e8'

    function setup(): { store: Store; feed: (ev: object) => void } {
      const store = new Store()
      const mgr = makeManager(store)
      const sessionId = 'sess-bg'
      store.dispatch({
        type: 'jsonClaude/sessionStarted',
        payload: { sessionId, worktreePath: '/tmp/wt' }
      })
      mgr.create(sessionId, '/tmp/wt')
      const proc = sessionProcs()[0]
      return {
        store,
        feed: (ev: object) =>
          proc.stdout.emit('data', Buffer.from(JSON.stringify(ev) + '\n'))
      }
    }

    function agents(store: Store) {
      return store.getSnapshot().state.jsonClaude.sessions['sess-bg']
        ?.backgroundAgents
    }

    const started = {
      type: 'system',
      subtype: 'task_started',
      task_id: TASK_ID,
      tool_use_id: TOOL_USE_ID,
      description: 'Run echo/sleep command',
      subagent_type: 'general-purpose',
      task_type: 'local_agent'
    }

    it('task_started records a running agent keyed by tool_use id', () => {
      const { store, feed } = setup()
      feed(started)
      const agent = agents(store)?.[TOOL_USE_ID]
      expect(agent?.status).toBe('running')
      expect(agent?.agentId).toBe(TASK_ID)
      expect(agent?.description).toBe('Run echo/sleep command')
    })

    it('task_notification settles the agent and records usage', () => {
      const { store, feed } = setup()
      feed(started)
      feed({
        type: 'system',
        subtype: 'task_notification',
        task_id: TASK_ID,
        tool_use_id: TOOL_USE_ID,
        status: 'completed',
        summary: 'Command run: `echo alpha`',
        usage: { total_tokens: 10854, tool_uses: 1, duration_ms: 10133 }
      })
      const agent = agents(store)?.[TOOL_USE_ID]
      expect(agent?.status).toBe('completed')
      expect(agent?.usage).toEqual({
        totalTokens: 10854,
        toolUses: 1,
        durationMs: 10133
      })
    })

    it('a non-completed status settles as failed', () => {
      const { store, feed } = setup()
      feed(started)
      feed({
        type: 'system',
        subtype: 'task_notification',
        task_id: TASK_ID,
        tool_use_id: TOOL_USE_ID,
        status: 'cancelled'
      })
      expect(agents(store)?.[TOOL_USE_ID]?.status).toBe('failed')
    })

    // The card must show the agent's answer, not the "Async agent launched
    // successfully…" stub that resolved the tool_use immediately.
    it('the notification summary supersedes the launch stub tool_result', () => {
      const { store, feed } = setup()
      feed(started)
      feed({
        type: 'user',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: TOOL_USE_ID,
              content: 'Async agent launched successfully.'
            }
          ]
        }
      })
      feed({
        type: 'system',
        subtype: 'task_notification',
        task_id: TASK_ID,
        tool_use_id: TOOL_USE_ID,
        status: 'completed',
        summary: 'Exact stdout: alpha'
      })
      const entries =
        store.getSnapshot().state.jsonClaude.sessions['sess-bg']?.entries ?? []
      const results = entries
        .flatMap((e) => e.blocks ?? [])
        .filter((b) => b.type === 'tool_result' && b.toolUseId === TOOL_USE_ID)
      expect(results[results.length - 1]?.content).toBe('Exact stdout: alpha')
    })

    it('ignores a task event with no tool_use_id', () => {
      const { store, feed } = setup()
      feed({ type: 'system', subtype: 'task_started', task_id: TASK_ID })
      expect(Object.keys(agents(store) ?? {})).toHaveLength(0)
    })
  })

  it("new proc's own exit event still updates state (guard doesn't block legitimate exits)", () => {
    const store = new Store()
    const mgr = makeManager(store)
    const sessionId = 'sess-B'
    const cwd = '/tmp/wt'

    store.dispatch({ type: 'jsonClaude/sessionStarted', payload: { sessionId, worktreePath: cwd } })
    mgr.create(sessionId, cwd)
    const proc = sessionProcs()[0]
    expect(store.getSnapshot().state.jsonClaude.sessions[sessionId]?.state).toBe('running')

    // Subprocess exits on its own — guard should NOT bail because this is
    // the currently-registered instance's own exit.
    proc.emit('exit', 1, null)
    expect(store.getSnapshot().state.jsonClaude.sessions[sessionId]?.state).toBe('exited')
  })

  describe('automated turns', () => {
    function sendAndRead(text: string) {
      const store = new Store()
      const mgr = makeManager(store)
      const sessionId = 'sess-auto'
      const cwd = '/tmp/wt'
      store.dispatch({
        type: 'jsonClaude/sessionStarted',
        payload: { sessionId, worktreePath: cwd }
      })
      mgr.create(sessionId, cwd)
      const proc = sessionProcs()[0]
      mgr.send(sessionId, text)
      const entries =
        store.getSnapshot().state.jsonClaude.sessions[sessionId]?.entries ?? []
      const stdin = proc.stdin.write.mock.calls.map((c) => String(c[0])).join('')
      return { entry: entries[entries.length - 1], stdin }
    }

    it('flags an injected turn and strips the sentinel from the slice text', () => {
      const { entry } = sendAndRead(
        wrapAutomatedMessage('ci-failure', 'CI is failing on PR #7')
      )
      expect(entry.kind).toBe('user')
      expect(entry.automation).toBe('ci-failure')
      expect(entry.text).toBe('CI is failing on PR #7')
    })

    it('still sends the sentinel to claude so the model sees it is automated', () => {
      const { stdin } = sendAndRead(wrapAutomatedMessage('ci-failure', 'body'))
      expect(stdin).toContain('ness-automated-message')
    })

    it('leaves a human-typed turn untouched', () => {
      const { entry } = sendAndRead('fix the build')
      expect(entry.automation).toBeUndefined()
      expect(entry.text).toBe('fix the build')
    })
  })

  describe('entry ids across a sleep/wake', () => {
    it('does not reuse an entryId after the subprocess is respawned', () => {
      const store = new Store()
      const mgr = makeManager(store)
      const sessionId = 'sess-wake'
      const cwd = '/tmp/wt'
      // Mirrors startJsonClaudeSession: dispatch then spawn, on both the
      // initial start and the wake.
      const start = (): void => {
        store.dispatch({
          type: 'jsonClaude/sessionStarted',
          payload: { sessionId, worktreePath: cwd }
        })
        mgr.create(sessionId, cwd)
      }
      start()
      mgr.send(sessionId, 'first')
      // Sleep tears the subprocess down but deliberately leaves the
      // entries in the slice so the transcript is still readable.
      mgr.kill(sessionId)
      start()
      mgr.send(sessionId, 'after wake')

      const entries =
        store.getSnapshot().state.jsonClaude.sessions[sessionId]?.entries ?? []
      const userEntries = entries.filter((e) => e.kind === 'user')
      expect(userEntries.map((e) => e.text)).toEqual(['first', 'after wake'])
      const ids = entries.map((e) => e.entryId)
      expect(new Set(ids).size).toBe(ids.length)
    })
  })
})
