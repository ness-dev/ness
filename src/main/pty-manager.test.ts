import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tmpdir } from 'os'

// Regression coverage for bug #203: `createShell` must register the PTY
// synchronously so an agent's follow-up `read_shell_output` sees an alive
// shell instead of an empty buffer. The pre-spawn in `src/main/index.ts`
// depends on two load-bearing properties of `PtyManager.create`:
//   1. `hasTerminal(id)` becomes true immediately after `create()` returns.
//   2. A second `create()` for the same id is a no-op — required because
//      the renderer's XTerminal fires `pty:create` on mount, which would
//      otherwise kill+respawn the eagerly-spawned PTY.

// Minimal node-pty mock. The real spawn wants a compiled binary; the
// manager only touches the returned handle for onData/onExit/kill so a
// bare fake is enough.
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pid: 12345
  }))
}))

vi.mock('./debug', () => ({ log: vi.fn() }))

vi.mock('./hooks', () => ({ cleanupTerminalLog: vi.fn() }))

vi.mock('./persistence', () => ({
  saveTerminalHistory: vi.fn(),
  loadTerminalHistory: vi.fn(() => null),
  clearTerminalHistory: vi.fn()
}))

import { PtyManager } from './pty-manager'
import * as pty from 'node-pty'
import { loadTerminalHistory } from './persistence'

describe('PtyManager.create — eager spawn contract for createShell (#203)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers the PTY synchronously so a follow-up hasTerminal check succeeds', () => {
    const mgr = new PtyManager()
    const id = 'shell-eager-1'
    mgr.create(id, tmpdir(), '', ['-ilc', 'echo hi'], undefined, true)
    expect(mgr.hasTerminal(id)).toBe(true)
    expect(pty.spawn).toHaveBeenCalledTimes(1)
  })

  it('is idempotent — a second create for the same id (renderer XTerminal mount) does not respawn', () => {
    const mgr = new PtyManager()
    const id = 'shell-eager-2'
    mgr.create(id, tmpdir(), '', ['-ilc', 'echo hi'], undefined, true)
    mgr.create(id, tmpdir(), '', ['-ilc', 'echo hi'], undefined, true)
    expect(mgr.hasTerminal(id)).toBe(true)
    expect(pty.spawn).toHaveBeenCalledTimes(1)
  })

  it('does not register a PTY when cwd is missing (pre-flight guard)', () => {
    const mgr = new PtyManager()
    const id = 'shell-eager-3'
    mgr.create(id, '/definitely/does/not/exist', '', ['-il'], undefined, true)
    expect(mgr.hasTerminal(id)).toBe(false)
    expect(pty.spawn).not.toHaveBeenCalled()
  })
})

// On a cold app start the renderer asks for scrollback BEFORE it spawns, so
// getHistory has to reach the persisted file itself — reading only the
// in-memory map left restored tabs blank until something else seeded it.
describe('PtyManager.getHistory — persisted scrollback across an app restart', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the persisted scrollback when nothing is in memory yet', () => {
    vi.mocked(loadTerminalHistory).mockReturnValueOnce('previous run output')
    const mgr = new PtyManager()
    expect(mgr.getHistory('shell-restored-1')).toBe('previous run output')
  })

  it('returns empty string when no history was persisted', () => {
    const mgr = new PtyManager()
    expect(mgr.getHistory('shell-restored-2')).toBe('')
  })

  it('reads the file once per id — the spawn that follows reuses the buffer', () => {
    vi.mocked(loadTerminalHistory).mockReturnValueOnce('previous run output')
    const mgr = new PtyManager()
    const id = 'shell-restored-3'
    mgr.getHistory(id)
    mgr.create(id, tmpdir(), '', ['-il'], undefined, true)
    expect(loadTerminalHistory).toHaveBeenCalledTimes(1)
    expect(mgr.getHistory(id)).toBe('previous run output')
  })

  it('drops both the buffer and the file on forgetHistory so a closed tab does not resurrect', () => {
    vi.mocked(loadTerminalHistory).mockReturnValue('previous run output')
    const mgr = new PtyManager()
    const id = 'shell-restored-4'
    expect(mgr.getHistory(id)).toBe('previous run output')
    vi.mocked(loadTerminalHistory).mockReturnValue(null)
    mgr.forgetHistory(id)
    expect(mgr.getHistory(id)).toBe('')
  })
})

describe('PtyManager PTY ceiling', () => {
  // `pty:create` is an unbounded client-driven signal, so the server has to
  // defend itself: a client that mounts N terminals will ask for N spawns
  // as fast as it can send them. Without a ceiling a single misbehaving
  // client can OOM the host — which is exactly how a remote test box was
  // lost. These assert the ceiling holds AND that it can't lock out a
  // reconnecting client from terminals that are already running.
  const CWD = tmpdir()

  function makeManager(): InstanceType<typeof PtyManager> {
    const mgr = new PtyManager()
    mgr.setSendSignal(() => {})
    return mgr
  }

  beforeEach(() => {
    delete process.env.HARNESS_MAX_PTYS
  })

  it('refuses spawns past the limit instead of letting the host die', () => {
    process.env.HARNESS_MAX_PTYS = '3'
    const mgr = makeManager()
    for (let i = 0; i < 3; i++) mgr.create(`t${i}`, CWD, '/bin/sh', [], undefined, true)
    expect(mgr.getActivePtyCount()).toBe(3)

    mgr.create('one-too-many', CWD, '/bin/sh', [], undefined, true)
    expect(mgr.hasTerminal('one-too-many')).toBe(false)
    expect(mgr.getActivePtyCount()).toBe(3)
  })

  it('tells the client why, in the terminal it asked for', () => {
    process.env.HARNESS_MAX_PTYS = '1'
    const mgr = new PtyManager()
    const sent: { channel: string; id: string; data: string }[] = []
    mgr.setSendSignal((channel, ...args) => {
      sent.push({ channel, id: args[0] as string, data: args[1] as string })
    })
    mgr.create('first', CWD, '/bin/sh', [], undefined, true)
    sent.length = 0

    mgr.create('refused', CWD, '/bin/sh', [], undefined, true)
    const notice = sent.find((s) => s.channel === 'terminal:data' && s.id === 'refused')
    // A silent refusal would look identical to a hung terminal.
    expect(notice).toBeDefined()
    expect(notice!.data).toContain('limit 1')
    expect(notice!.data).toContain('HARNESS_MAX_PTYS')
  })

  it('still lets a client re-attach to a live terminal at the limit', () => {
    // The limit must not strand a reconnecting client: re-attaching costs
    // no new subprocess, so it is checked after the already-exists path.
    process.env.HARNESS_MAX_PTYS = '2'
    const mgr = makeManager()
    mgr.create('a', CWD, '/bin/sh', [], undefined, true)
    mgr.create('b', CWD, '/bin/sh', [], undefined, true)
    expect(mgr.getActivePtyCount()).toBe(2)

    mgr.create('a', CWD, '/bin/sh', [], undefined, true)
    expect(mgr.hasTerminal('a')).toBe(true)
    expect(mgr.getActivePtyCount()).toBe(2)
  })

  it('falls back to the default when the override is nonsense', () => {
    process.env.HARNESS_MAX_PTYS = 'not-a-number'
    const mgr = makeManager()
    // Must not resolve to 0 and refuse everything.
    mgr.create('t', CWD, '/bin/sh', [], undefined, true)
    expect(mgr.hasTerminal('t')).toBe(true)
  })
})
