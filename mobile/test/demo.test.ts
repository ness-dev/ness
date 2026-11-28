import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { initialState, mergeWireSnapshot, rootReducer, type AppState, type StateEvent } from '../../src/shared/state'
import { buildBackend } from '../../src/renderer/build-backend'
import type { LocalTransportHandle } from '../../src/shared/transport/transport'
import { DemoWorld } from '../src/demo/world'
import { DemoTransport } from '../src/demo/DemoTransport'
import { DEMO_NOTICE_SIGNAL, DEMO_UNAVAILABLE } from '../src/demo/constants'
import { DemoGit } from '../src/demo/git'
import { buildDemoState, fixtureEvents } from '../src/demo/fixture'
import { TAB, UNITS_REQUEST_ID } from '../src/demo/conversations'
import { replySteps, tokenize } from '../src/demo/scripts'
import { COMMANDS, DemoShell, runCommand } from '../src/demo/shell'
import { UNITS_TS_BUGGY, UNITS_TS_FIXED, WORKTREES, WT } from '../src/demo/project'
import { tabsOf } from '../src/ness'

const NOW = Date.UTC(2026, 5, 1, 9, 30)

/** A world whose timers run only when flushed. */
function makeWorld() {
  const events: StateEvent[] = []
  const signals: Array<[string, unknown[]]> = []
  let timers: Array<() => void> = []
  const world = new DemoWorld({
    now: () => NOW,
    schedule: (fn) => {
      timers.push(fn)
      return () => {
        timers = timers.filter((t) => t !== fn)
      }
    },
    emitEvent: (e) => events.push(e),
    emitSignal: (name, ...args) => signals.push([name, args])
  })
  const flush = () => {
    for (let guard = 0; timers.length && guard < 100_000; guard++) timers.shift()!()
  }
  return { world, events, signals, flush }
}

const statusesOf = (events: StateEvent[], id: string) =>
  events.flatMap((e) => (e.type === 'terminals/statusChanged' && e.payload.id === id ? [e.payload.status] : []))

describe('demo fixture', () => {
  const git = new DemoGit(NOW)
  const state = buildDemoState(NOW, git)

  it('is built from real events through rootReducer', () => {
    const events = fixtureEvents(NOW, git)
    expect(events.length).toBeGreaterThan(20)
    let s: AppState = initialState
    for (const e of events) {
      const next = rootReducer(s, e)
      // Every event does something; a renamed/retyped event would be a no-op.
      expect(next, e.type).not.toBe(s)
      s = next
    }
    expect(s).toEqual(state)
  })

  it('survives the wire like a real snapshot', () => {
    expect(mergeWireSnapshot(JSON.parse(JSON.stringify(state)))).toEqual(state)
  })

  it('has worktrees in every state the list shows', () => {
    expect(state.worktrees.list.map((w) => w.path)).toEqual(WORKTREES.map((w) => w.path))
    const statuses = new Set(Object.values(state.terminals.statuses))
    expect(statuses).toEqual(new Set(['idle', 'waiting', 'processing', 'needs-approval']))
    expect(state.prs.byPath[WT.hourly]?.checksOverall).toBe('success')
    expect(state.prs.byPath[WT.units]?.checksOverall).toBe('failure')
    expect(state.prs.byPath[WT.air]?.state).toBe('merged')
    expect(state.jsonClaude.pendingApprovals[UNITS_REQUEST_ID]?.toolName).toBe('Edit')
    for (const w of state.worktrees.list) expect(tabsOf(state.terminals.panes[w.path]).length).toBeGreaterThan(0)
  })

  it('shows every chat feature in the finished conversation', () => {
    const entries = state.jsonClaude.sessions[TAB.hourlyChat].entries
    const blocks = entries.flatMap((e) => e.blocks ?? [])
    const allText = blocks.map((b) => b.text ?? '').join('\n')
    expect(blocks.some((b) => b.type === 'thinking')).toBe(true)
    expect(blocks.filter((b) => b.type === 'tool_use').length).toBeGreaterThan(3)
    expect(allText).toContain('```mermaid')
    expect(allText).toMatch(/\n\| .* \|\n\|---/)
    expect(allText).toContain('```ts')
    expect(allText).toMatch(/^## /m)
    // Every tool call has its result.
    const uses = blocks.filter((b) => b.type === 'tool_use').map((b) => b.id)
    const results = new Set(blocks.filter((b) => b.type === 'tool_result').map((b) => b.toolUseId))
    for (const id of uses) expect(results.has(id), id).toBe(true)
  })

  it('has staged, unstaged, untracked and branch changes', () => {
    const working = git.changedFiles(WT.hourly)
    expect(working.some((f) => f.staged)).toBe(true)
    expect(working.some((f) => !f.staged && f.status === 'modified')).toBe(true)
    expect(working.some((f) => f.status === 'untracked')).toBe(true)
    expect(git.changedFiles(WT.hourly, 'branch').map((f) => f.path)).toContain('src/components/HourlyForecast.tsx')
    const [c] = git.branchCommits(WT.hourly)
    expect(git.commitChangedFiles(WT.hourly, c.hash).length).toBeGreaterThan(0)
    expect(git.commitDiff(WT.hourly, c.hash)?.diff).toMatch(/^@@ /m)
  })
})

describe('scripted turns', () => {
  it('tokenizes without losing text', () => {
    const s = 'Hello **there**,\n\n- one\n- two `code`'
    expect(tokenize(s).join('')).toBe(s)
  })

  it('a reply streams to a finished entry through the reducer', () => {
    let state = buildDemoState(NOW, new DemoGit(NOW))
    const steps = replySteps(TAB.hourlyChat, 'hi', 0, () => NOW)
    const events = steps.flatMap((s) => s.events)
    expect(events.filter((e) => e.type === 'jsonClaude/assistantTextDelta').length).toBeGreaterThan(30)
    for (const e of events) state = rootReducer(state, e)
    const session = state.jsonClaude.sessions[TAB.hourlyChat]
    const last = session.entries.at(-1)!
    expect(session.busy).toBe(false)
    expect(last.kind).toBe('assistant')
    expect(last.isPartial).toBeUndefined()
    expect(last.blocks?.[0].text).toContain('Ness demo')
    expect(session.entries.at(-2)?.text).toBe('hi')
  })

  it('sending a message goes processing → waiting', () => {
    const { world, events, flush } = makeWorld()
    world.signal('jsonClaude:send', [TAB.hourlyChat, 'What is this?'])
    flush()
    expect(statusesOf(events, TAB.hourlyChat)).toEqual(['processing', 'waiting'])
    expect(world.state.jsonClaude.sessions[TAB.hourlyChat].entries.at(-1)?.blocks?.[0].text).toContain('scripted reply')
  })

  it('a message typed during a turn is queued, then answered', () => {
    const { world, flush } = makeWorld()
    world.signal('jsonClaude:send', [TAB.darkChat, 'also add a toggle'])
    const queued = world.state.jsonClaude.sessions[TAB.darkChat].entries.at(-1)
    expect(queued?.isQueued).toBe(true)
    world.request('jsonClaude:setComposerVisible', [TAB.darkChat, true])
    flush()
    const session = world.state.jsonClaude.sessions[TAB.darkChat]
    expect(session.busy).toBe(false)
    expect(session.entries.some((e) => e.isQueued)).toBe(false)
    expect(session.entries.at(-1)?.kind).toBe('assistant')
  })

  it('approving applies the edit and streams the continuation', () => {
    const { world, events, signals, flush } = makeWorld()
    expect(world.git.changedFiles(WT.units)).toEqual([])
    world.request('jsonClaude:resolveApproval', [UNITS_REQUEST_ID, { behavior: 'allow', updatedInput: {} }])
    flush()
    expect(world.state.jsonClaude.pendingApprovals).toEqual({})
    expect(world.git.readFile(WT.units, 'src/units.ts')).toBe(UNITS_TS_FIXED)
    expect(world.git.changedFiles(WT.units)).toMatchObject([{ path: 'src/units.ts', staged: false, status: 'modified', additions: 1, deletions: 1 }])
    expect(signals).toContainEqual(['worktree:changedFilesInvalidated', [WT.units]])
    const results = world.state.jsonClaude.sessions[TAB.unitsChat].entries.flatMap((e) => e.blocks ?? []).filter((b) => b.type === 'tool_result')
    expect(results.find((b) => b.toolUseId === 'tu_u4')?.isError).toBe(false)
    expect(statusesOf(events, TAB.unitsChat).at(-1)).toBe('waiting')
    expect(statusesOf(events, TAB.unitsChat)).toContain('processing')
  })

  it('denying leaves the file alone and shows the denial', () => {
    const { world, flush } = makeWorld()
    world.request('jsonClaude:resolveApproval', [UNITS_REQUEST_ID, { behavior: 'deny', message: 'not yet' }])
    flush()
    expect(world.git.readFile(WT.units, 'src/units.ts')).toBe(UNITS_TS_BUGGY)
    const result = world.state.jsonClaude.sessions[TAB.unitsChat].entries
      .flatMap((e) => e.blocks ?? [])
      .find((b) => b.type === 'tool_result' && b.toolUseId === 'tu_u4')
    expect(result?.isError).toBe(true)
    expect(result?.content).toContain('not yet')
    expect(world.state.jsonClaude.sessions[TAB.unitsChat].busy).toBe(false)
  })

  it('interrupting finalizes the half-streamed message', () => {
    const { world, flush } = makeWorld()
    world.signal('jsonClaude:send', [TAB.hourlyChat, 'hi'])
    world.request('jsonClaude:interrupt', [TAB.hourlyChat])
    flush()
    const session = world.state.jsonClaude.sessions[TAB.hourlyChat]
    expect(session.busy).toBe(false)
    expect(session.entries.some((e) => e.isPartial)).toBe(false)
  })
})

// ── channel coverage ───────────────────────────────────────────────────

/** Every channel build-backend.ts can send, by calling each api method
 *  against a recording transport. */
function recordChannels(): { requests: Map<string, string>; signals: Map<string, string> } {
  const requests = new Map<string, string>()
  const signals = new Map<string, string>()
  let current = ''
  const handle: LocalTransportHandle = {
    getStateSnapshot: async () => ({ state: initialState, seq: 0 }),
    onStateEvent: () => () => {},
    request: async (name) => {
      requests.set(name, current)
    },
    send: (name) => {
      signals.set(name, current)
    },
    onSignal: () => () => {},
    getClientId: async () => 'x',
    onReconnect: () => () => {}
  }
  const api = buildBackend(() => handle, () => handle, null) as unknown as Record<string, unknown>
  for (const [method, fn] of Object.entries(api)) {
    if (typeof fn !== 'function') continue
    current = method
    try {
      const r = (fn as (...a: unknown[]) => unknown)('x', 'x', 'x', 'x', 'x')
      if (r instanceof Promise) r.catch(() => {})
    } catch {
      // electron-only helpers
    }
  }
  return { requests, signals }
}

/** api methods the mobile app actually calls. */
function mobileApiMethods(): Set<string> {
  const out = new Set<string>()
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.tsx?$/.test(name) && !p.includes('/demo/')) {
        for (const m of readFileSync(p, 'utf8').matchAll(/\bapi\.([a-zA-Z]+)\(/g)) out.add(m[1])
      }
    }
  }
  walk(join(__dirname, '../src'))
  return out
}

describe('DemoTransport channel coverage', () => {
  const { requests, signals } = recordChannels()

  it('found the channels', () => {
    expect(requests.size).toBeGreaterThan(150)
    expect(signals.has('jsonClaude:send')).toBe(true)
  })

  it('every request channel settles: handled, or "Not available in the demo"', async () => {
    const transport = new DemoTransport({}, { schedule: () => () => {} })
    await transport.connect()
    const hung: string[] = []
    const crashed: string[] = []
    for (const channel of requests.keys()) {
      const outcome = await Promise.race([
        transport.request(channel, 'x', 'x', 'x', 'x').then(
          () => 'ok',
          (e: Error) => (e.message === DEMO_UNAVAILABLE ? 'unavailable' : `threw: ${e.message}`)
        ),
        new Promise<string>((r) => setTimeout(() => r('hung'), 500))
      ])
      if (outcome === 'hung') hung.push(channel)
      else if (outcome.startsWith('threw')) crashed.push(`${channel} ${outcome}`)
    }
    expect(hung).toEqual([])
    expect(crashed).toEqual([])
    transport.close()
  })

  it('every signal is accepted without throwing', async () => {
    const transport = new DemoTransport({}, { schedule: () => () => {} })
    await transport.connect()
    for (const channel of signals.keys()) expect(() => transport.send(channel, 'x', 'x', 'x'), channel).not.toThrow()
    transport.close()
  })

  it('every channel the mobile app uses is handled, not turned away', async () => {
    const { world } = makeWorld()
    const used = mobileApiMethods()
    expect(used.size).toBeGreaterThan(40)
    const missing: string[] = []
    for (const [channel, method] of requests) if (used.has(method) && !world.handlers[channel]) missing.push(`${method} (${channel})`)
    for (const [channel, method] of signals) if (used.has(method) && !world.signals[channel]) missing.push(`${method} (${channel})`)
    expect(missing).toEqual([])
  })

  it('an unknown channel says so instead of hanging', async () => {
    const transport = new DemoTransport({}, { schedule: () => () => {} })
    const notices: unknown[] = []
    transport.onSignal(DEMO_NOTICE_SIGNAL, (m) => notices.push(m))
    await expect(transport.request('repo:add')).rejects.toThrow(DEMO_UNAVAILABLE)
    expect(notices).toEqual([DEMO_UNAVAILABLE])
    await expect(transport.request('pr:merge', WT.hourly, 'squash')).resolves.toEqual({ ok: false, error: DEMO_UNAVAILABLE })
  })

  it('a reset keeps the theme it was given', async () => {
    const transport = new DemoTransport({}, { theme: { mode: 'light', light: 'solarized-light', dark: 'dark' } })
    const { state } = await transport.getStateSnapshot()
    expect(state.settings.themeMode).toBe('light')
    expect(state.settings.themeLight).toBe('solarized-light')
  })

  it('connects with a snapshot and no network', async () => {
    const changes: boolean[] = []
    let snapshot: AppState | null = null
    const transport = new DemoTransport({ onConnectionChange: (c) => changes.push(c), onSnapshot: (s) => (snapshot = s.state as AppState) })
    await transport.connect()
    expect(changes).toEqual([true])
    expect(snapshot!.worktrees.list.length).toBe(WORKTREES.length)
    expect(await transport.probe()).toBe('alive')
    transport.close()
  })
})

// ── fake shell ─────────────────────────────────────────────────────────

describe('demo shell', () => {
  const git = new DemoGit(NOW)
  const ctx = (path: string) => ({ cwd: path, branch: WORKTREES.find((w) => w.path === path)!.branch, git })

  it.each(COMMANDS)('%s has output', (cmd) => {
    expect(runCommand(cmd, ctx(WT.hourly))).toBeTruthy()
  })

  it('anything else is not available', () => {
    expect(runCommand('rm -rf /', ctx(WT.hourly))).toBeNull()
    const shell = new DemoShell(ctx(WT.hourly))
    expect(shell.input('vim\r')).toContain('demo: command not available')
  })

  it('git status reflects the worktree', () => {
    const out = runCommand('git status', ctx(WT.hourly))!
    expect(out).toContain('Changes to be committed')
    expect(out).toContain('Untracked files')
    expect(runCommand('git status', ctx(WT.main))).toContain('nothing to commit')
  })

  it('npm test is coloured and fails where CI does', () => {
    const pass = runCommand('npm test', ctx(WT.hourly))!
    expect(pass).toContain('\x1b[32m')
    expect(pass).toContain('passed')
    expect(runCommand('npm test', ctx(WT.units))).toContain('3 failed')
  })

  it('line editing: echo, backspace, Ctrl+C, history', () => {
    const shell = new DemoShell(ctx(WT.main))
    expect(shell.start()).toContain('help')
    expect(shell.input('lx')).toBe('lx')
    expect(shell.input('\x7f')).toBe('\b \b')
    expect(shell.input('s\r')).toContain('README.md')
    expect(shell.input('abc\x03')).toContain('^C')
    expect(shell.input('\x1b[A')).toBe('ls')
    // An arrow key split across two writes.
    expect(shell.input('\x1b[')).toBe('')
    expect(shell.input('B')).toBe('\b \b\b \b')
    // The key row's Esc on its own is swallowed.
    expect(shell.input('\x1b')).toBe('')
    expect(shell.input('x')).toBe('x')
  })
})
