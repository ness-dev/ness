// Terminal tab plumbing that runs outside the WebView: key encoding, the
// output batching/backpressure queue, the page HTML and the xterm theme.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ctrlByte, encodeKey, encodeText } from '../src/terminal/keys'
import { MAX_BATCH, OutputQueue } from '../src/terminal/output-queue'
import { attachTerminal, RESET_MODES, RESTORED, type AttachDeps } from '../src/terminal/attach'
import { makeTerminalId } from '../../src/shared/terminal-id'
import { terminalPageHtml } from '../src/terminal/html'
import { terminalTheme } from '../src/terminal/theme'
import { applyTheme } from '../src/theme'
import { THEME_OPTIONS } from '../../src/renderer/themes'
import { TERM_PALETTES } from '../src/themes.generated'

describe('keys', () => {
  it('maps named keys to the bytes xterm sends', () => {
    expect(encodeKey('Escape')).toBe('\x1b')
    expect(encodeKey('ArrowUp')).toBe('\x1b[A')
    expect(encodeKey('Backspace')).toBe('\x7f')
    expect(encodeKey('\x03')).toBe('\x03')
  })

  it('applies sticky Ctrl to the first character only', () => {
    expect(encodeText('c', true)).toEqual({ data: '\x03', ctrlUsed: true })
    expect(encodeText('ab', true)).toEqual({ data: '\x01b', ctrlUsed: true })
    expect(encodeText('ab', false)).toEqual({ data: 'ab', ctrlUsed: false })
    // A character with no control form leaves the sticky on.
    expect(encodeText('1', true)).toEqual({ data: '1', ctrlUsed: false })
  })

  it('turns newlines into CR', () => {
    expect(encodeText('ls\n', false).data).toBe('ls\r')
    expect(encodeText('a\r\nb', false).data).toBe('a\rb')
  })

  it('ctrlByte matches the web client', () => {
    expect(ctrlByte('A')).toBe('\x01')
    expect(ctrlByte(' ')).toBe('\x00')
    expect(ctrlByte('[')).toBe('\x1b')
    expect(ctrlByte('ab')).toBeNull()
  })
})

describe('OutputQueue', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('coalesces frames and keeps one batch in flight', () => {
    const out: string[] = []
    const q = new OutputQueue((c) => out.push(c))
    q.push('a')
    q.push('b')
    expect(out).toEqual([])
    vi.advanceTimersByTime(20)
    expect(out).toEqual(['ab'])
    q.push('c')
    q.push('d')
    vi.advanceTimersByTime(100)
    // Still waiting for the page's ack.
    expect(out).toEqual(['ab'])
    q.ack()
    expect(out).toEqual(['ab', 'cd'])
  })

  it('splits oversized output without breaking a surrogate pair', () => {
    const out: string[] = []
    const q = new OutputQueue((c) => out.push(c))
    const big = 'x'.repeat(MAX_BATCH - 1) + '😀' + 'y'.repeat(10)
    q.push(big)
    vi.advanceTimersByTime(20)
    q.ack()
    q.ack()
    expect(out.join('')).toBe(big)
    expect(out[0].length).toBe(MAX_BATCH - 1)
  })

  it('drained() waits for the last ack', async () => {
    const q = new OutputQueue(() => {})
    q.push('history')
    let done = false
    const p = q.drained().then(() => (done = true))
    vi.advanceTimersByTime(20)
    await Promise.resolve()
    expect(done).toBe(false)
    q.ack()
    await p
    expect(done).toBe(true)
  })

  it('a 5000-line burst is a single injection', () => {
    const out: string[] = []
    const q = new OutputQueue((c) => out.push(c))
    for (let i = 0; i < 5000; i++) q.push('y\r\n')
    vi.advanceTimersByTime(20)
    expect(out.length).toBe(1)
  })
})

describe('terminal page', () => {
  it('inlines xterm without a stray closing tag', () => {
    const html = terminalPageHtml({ theme: terminalTheme(), fontSize: 12, fontFamily: 'Menlo' })
    // Options, xterm, fit addon, bridge.
    expect(html.match(/<\/script>/g)?.length).toBe(4)
    expect(html).toContain('.Terminal=')
    expect(html).not.toMatch(/https?:\/\/cdn/)
  })

  it('uses the theme ANSI palette when it has one, XTerminal fallbacks otherwise', () => {
    const light = THEME_OPTIONS.find((t) => t.mode === 'light' && TERM_PALETTES[t.id])!
    applyTheme({ themeMode: 'light', themeLight: light.id, themeDark: 'dark', customThemes: [], nessieColor: 'loch', systemScheme: 'light' })
    expect(terminalTheme().yellow).toBe(TERM_PALETTES[light.id].yellow)
    applyTheme({ themeMode: 'dark', themeLight: light.id, themeDark: 'dark', customThemes: [], nessieColor: 'loch', systemScheme: 'dark' })
    expect(terminalTheme().yellow).toBe('#facc15')
  })

  it('every light theme has an ANSI palette', () => {
    for (const t of THEME_OPTIONS.filter((t) => t.mode === 'light')) expect(TERM_PALETTES, t.id).toHaveProperty(t.id)
  })
})

describe('attachTerminal', () => {
  // A fake socket + page: `emit` delivers terminal:data, `pushed` is what
  // reached the page, and `drain` lets the test decide when the replay has
  // finished parsing.
  function harness(history = '') {
    const pushed: string[] = []
    const listeners = new Set<(d: string) => void>()
    const calls: string[] = []
    let releaseDrain: () => void = () => {}
    let current = true
    const deps: AttachDeps = {
      getHistory: async () => history,
      buildArgs: async () => {
        calls.push('buildArgs')
        return ['-il']
      },
      onData: (cb) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
      create: () => calls.push('create'),
      resize: () => calls.push('resize'),
      queue: {
        push: (d) => pushed.push(d),
        drained: () => new Promise<void>((r) => (releaseDrain = r))
      },
      isCurrent: () => current
    }
    return {
      deps,
      pushed,
      calls,
      listeners,
      emit: (d: string) => listeners.forEach((l) => l(d)),
      drain: () => releaseDrain(),
      supersede: () => (current = false)
    }
  }
  const tick = () => new Promise((r) => setTimeout(r, 0))

  it('replays history, then output that arrived during the replay, then spawns', async () => {
    const h = harness('old')
    const p = attachTerminal(h.deps, 'spawn')
    await tick()
    h.emit('during-replay')
    expect(h.pushed).toEqual(['old' + RESET_MODES + RESTORED])
    h.drain()
    const res = await p
    expect(h.pushed).toEqual(['old' + RESET_MODES + RESTORED, 'during-replay'])
    expect(h.calls).toEqual(['buildArgs', 'create'])
    expect(res.live).toBe(true)
    h.emit('live')
    expect(h.pushed.at(-1)).toBe('live')
  })

  it('reattach never sends pty:create', async () => {
    const h = harness('old')
    const p = attachTerminal(h.deps, 'reattach')
    await tick()
    h.drain()
    const res = await p
    expect(h.calls).toEqual(['resize'])
    expect(res.live).toBe(true)
  })

  it('a superseded load stops before creating and unsubscribes', async () => {
    const h = harness('old')
    const p = attachTerminal(h.deps, 'spawn')
    await tick()
    h.supersede()
    h.drain()
    const res = await p
    expect(res.live).toBe(false)
    expect(h.calls).toEqual([])
    expect(h.listeners.size).toBe(0)
  })
})

describe('makeTerminalId', () => {
  it('matches the desktop id shape', () => {
    expect(makeTerminalId('agent', '/private/tmp/x/repo')).toBe('agent-private-tmp-x-repo')
  })
})
