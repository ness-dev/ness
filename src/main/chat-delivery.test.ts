import { describe, it, expect, vi } from 'vitest'

import {
  deliverToTab,
  deliverToWorktreeChat,
  describeWorktree,
  resolveWorktreeQuery,
  type ChatDeliveryDeps
} from './chat-delivery'
import { initialState, type AppState } from '../shared/state'
import type { JsonClaudeSession } from '../shared/state/json-claude'
import type { PaneNode } from '../shared/state/terminals'
import type { Worktree } from '../shared/state/worktrees'

const A = '/wt/a'
const B = '/wt/b'

function worktree(path: string, branch: string, extra: Partial<Worktree> = {}): Worktree {
  return {
    path,
    branch,
    head: 'abc',
    isBare: false,
    isMain: false,
    createdAt: 0,
    repoRoot: '/repo',
    ...extra
  }
}

function session(worktreePath: string, lastTs: number): JsonClaudeSession {
  return {
    sessionId: 'ignored',
    worktreePath,
    state: 'running',
    exitCode: null,
    exitReason: null,
    entries: [{ entryId: 'e1', kind: 'user', timestamp: lastTs }],
    entriesHydrated: true,
    busy: false,
    permissionMode: 'acceptEdits',
    slashCommands: [],
    autoApprovedDecisions: {},
    backgroundAgents: {},
    sessionToolApprovals: [],
    sessionAllowedDecisions: {}
  }
}

function panes(
  tabs: Array<{ id: string; mode?: 'awake' | 'asleep' }>,
  activeTabId = tabs[0]?.id ?? ''
): PaneNode {
  return {
    type: 'leaf',
    id: 'p1',
    tabs: tabs.map((t) => ({
      id: t.id,
      type: 'json-claude' as const,
      label: 'Chat',
      ...(t.mode ? { mode: t.mode } : {})
    })),
    activeTabId
  }
}

function makeState(opts: {
  worktrees?: Worktree[]
  aliases?: Record<string, string>
  sessions?: Record<string, JsonClaudeSession>
  panes?: Record<string, PaneNode>
} = {}): AppState {
  return {
    ...initialState,
    worktrees: { ...initialState.worktrees, list: opts.worktrees ?? [] },
    aliases: { byPath: { ...(opts.aliases ?? {}) } },
    jsonClaude: { ...initialState.jsonClaude, sessions: opts.sessions ?? {} },
    terminals: { ...initialState.terminals, panes: { ...(opts.panes ?? {}) } }
  }
}

function deps(liveSessionIds: string[] = []): ChatDeliveryDeps & {
  send: ReturnType<typeof vi.fn>
  wake: ReturnType<typeof vi.fn>
  respawn: ReturnType<typeof vi.fn>
} {
  const live = new Set(liveSessionIds)
  const send = vi.fn()
  // Mirrors panesFSM.wakeJsonClaudeTab: the subprocess is live by the time
  // it returns.
  const wake = vi.fn((_wt: string, tabId: string) => {
    live.add(tabId)
  })
  const respawn = vi.fn((_wt: string, tabId: string) => {
    live.add(tabId)
  })
  return { send, wake, respawn, hasSession: (id) => live.has(id) }
}

describe('resolveWorktreeQuery', () => {
  const state = makeState({
    worktrees: [worktree(A, 'feat/auth'), worktree(B, 'feat/billing')],
    aliases: { [A]: 'Auth Refactor' }
  })

  it('resolves an absolute path', () => {
    expect(resolveWorktreeQuery(state, A)).toEqual({ path: A })
  })

  it('resolves an alias case-insensitively', () => {
    expect(resolveWorktreeQuery(state, 'auth refactor')).toEqual({ path: A })
  })

  it('resolves a branch name', () => {
    expect(resolveWorktreeQuery(state, 'feat/billing')).toEqual({ path: B })
  })

  it('strips the worktree: prefix from a composer mention token', () => {
    expect(resolveWorktreeQuery(state, 'worktree:repo/feat/billing')).toEqual({ path: B })
    expect(resolveWorktreeQuery(state, 'Worktree: Auth Refactor')).toEqual({ path: A })
  })

  it('disambiguates a branch shared across repos via the <repo>/<branch> handle', () => {
    const twoRepos = makeState({
      worktrees: [
        worktree(A, 'main', { repoRoot: '/src/harness' }),
        worktree(B, 'main', { repoRoot: '/src/chicken' })
      ]
    })
    expect(resolveWorktreeQuery(twoRepos, 'harness/main')).toEqual({ path: A })
    expect(resolveWorktreeQuery(twoRepos, 'worktree:chicken/main')).toEqual({ path: B })
    // The bare branch is still ambiguous, and stays an error rather than a guess.
    expect(resolveWorktreeQuery(twoRepos, 'main')).toEqual({
      error: '"main" matches 2 worktrees — pass the absolute path instead'
    })
  })

  it('errors on an unknown handle', () => {
    expect(resolveWorktreeQuery(state, 'nope')).toEqual({
      error: 'no worktree matching "nope"'
    })
  })

  it('errors rather than guessing when a handle is ambiguous', () => {
    const ambiguous = makeState({
      worktrees: [worktree(A, 'feat/auth'), worktree(B, 'shared')],
      aliases: { [A]: 'shared' }
    })
    const result = resolveWorktreeQuery(ambiguous, 'shared')
    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toMatch(/matches 2 worktrees/)
  })

  it('ignores a prunable worktree whose directory is gone', () => {
    const stale = makeState({
      worktrees: [worktree(A, 'feat/auth', { prunable: true })]
    })
    expect(resolveWorktreeQuery(stale, 'feat/auth')).toHaveProperty('error')
    expect(resolveWorktreeQuery(stale, A)).toHaveProperty('error')
  })
})

describe('describeWorktree', () => {
  it('prefers the alias, falling back to the branch', () => {
    const state = makeState({
      worktrees: [worktree(A, 'feat/auth'), worktree(B, 'feat/billing')],
      aliases: { [A]: 'Auth Refactor' }
    })
    expect(describeWorktree(state, A)).toBe('Auth Refactor')
    expect(describeWorktree(state, B)).toBe('feat/billing')
  })

  it('falls back to the path for an unknown worktree', () => {
    expect(describeWorktree(makeState(), '/wt/ghost')).toBe('/wt/ghost')
  })
})

describe('deliverToWorktreeChat', () => {
  it('sends to a live session without waking anything', () => {
    const state = makeState({ sessions: { s1: session(A, 100) } })
    const d = deps(['s1'])
    expect(deliverToWorktreeChat(state, d, A, 'hi')).toEqual({
      ok: true,
      sessionId: 's1',
      woke: false
    })
    expect(d.send).toHaveBeenCalledWith('s1', 'hi')
    expect(d.wake).not.toHaveBeenCalled()
  })

  it('prefers the most recently active live session', () => {
    const state = makeState({
      sessions: { s1: session(A, 100), s2: session(A, 200) }
    })
    const d = deps(['s1', 's2'])
    expect(deliverToWorktreeChat(state, d, A, 'hi')).toMatchObject({ sessionId: 's2' })
  })

  it('ignores sessions belonging to another worktree', () => {
    const state = makeState({ sessions: { s1: session(B, 100) } })
    expect(deliverToWorktreeChat(state, deps(['s1']), A, 'hi')).toEqual({
      ok: false,
      reason: 'no-chat-tab'
    })
  })

  it('wakes a slept tab when no session is live', () => {
    const state = makeState({ panes: { [A]: panes([{ id: 't1', mode: 'asleep' }]) } })
    const d = deps()
    expect(deliverToWorktreeChat(state, d, A, 'hi')).toEqual({
      ok: true,
      sessionId: 't1',
      woke: true
    })
    expect(d.wake).toHaveBeenCalledWith(A, 't1')
    expect(d.send).toHaveBeenCalledWith('t1', 'hi')
  })

  it('prefers the pane\'s focused tab when waking', () => {
    const state = makeState({
      panes: {
        [A]: panes([{ id: 't1', mode: 'asleep' }, { id: 't2', mode: 'asleep' }], 't2')
      }
    })
    expect(deliverToWorktreeChat(state, deps(), A, 'hi')).toMatchObject({
      sessionId: 't2'
    })
  })

  it('reports no-chat-tab for a terminal-only worktree', () => {
    expect(deliverToWorktreeChat(makeState(), deps(), A, 'hi')).toEqual({
      ok: false,
      reason: 'no-chat-tab'
    })
  })

  it('reports wake-failed and sends nothing when the spawn does not take', () => {
    const state = makeState({ panes: { [A]: panes([{ id: 't1', mode: 'asleep' }]) } })
    const send = vi.fn()
    const result = deliverToWorktreeChat(
      state,
      { send, hasSession: () => false, wake: () => {}, respawn: () => {} },
      A,
      'hi'
    )
    expect(result).toEqual({ ok: false, reason: 'wake-failed' })
    expect(send).not.toHaveBeenCalled()
  })
})

describe('deliverToTab', () => {
  it('sends to a live chat session without waking it', () => {
    const state = makeState({ sessions: { s1: session(A, 1) }, panes: { [A]: panes([{ id: 's1' }]) } })
    const d = deps(['s1'])
    expect(deliverToTab(state, d, A, 's1', 'hi')).toEqual({ ok: true, tabId: 's1', woke: false })
    expect(d.send).toHaveBeenCalledWith('s1', 'hi')
    expect(d.wake).not.toHaveBeenCalled()
  })

  it('does not send to a live session that belongs to another worktree', () => {
    const state = makeState({ sessions: { s1: session(B, 1) }, panes: { [B]: panes([{ id: 's1' }]) } })
    const d = deps(['s1'])
    expect(deliverToTab(state, d, A, 's1', 'hi')).toEqual({ ok: false, reason: 'no-tab' })
    expect(d.send).not.toHaveBeenCalled()
  })

  it('wakes the named tab even when another chat tab is live', () => {
    const state = makeState({
      sessions: { live: session(A, 5) },
      panes: { [A]: panes([{ id: 'live' }, { id: 'slept', mode: 'asleep' }]) }
    })
    const d = deps(['live'])
    expect(deliverToTab(state, d, A, 'slept', 'hi')).toEqual({ ok: true, tabId: 'slept', woke: true })
    expect(d.wake).toHaveBeenCalledWith(A, 'slept')
    expect(d.send).toHaveBeenCalledWith('slept', 'hi')
  })

  it('respawns an awake tab whose subprocess is gone instead of waking it', () => {
    const state = makeState({ panes: { [A]: panes([{ id: 's1' }]) } })
    const d = deps()
    expect(deliverToTab(state, d, A, 's1', 'hi')).toEqual({ ok: true, tabId: 's1', woke: true })
    expect(d.respawn).toHaveBeenCalledWith(A, 's1')
    expect(d.wake).not.toHaveBeenCalled()
    expect(d.send).toHaveBeenCalledWith('s1', 'hi')
  })

  it('reports terminal agent tabs as unsupported and other tabs as not agents', () => {
    const tree: PaneNode = {
      type: 'leaf',
      id: 'p1',
      tabs: [
        { id: 't1', type: 'agent', label: 'Claude' },
        { id: 'sh', type: 'shell', label: 'zsh' }
      ],
      activeTabId: 't1'
    }
    const state = makeState({ panes: { [A]: tree } })
    expect(deliverToTab(state, deps(), A, 't1', 'hi')).toEqual({
      ok: false,
      reason: 'terminal-unsupported'
    })
    expect(deliverToTab(state, deps(), A, 'sh', 'hi')).toEqual({ ok: false, reason: 'not-agent-tab' })
    expect(deliverToTab(state, deps(), A, 'nope', 'hi')).toEqual({ ok: false, reason: 'no-tab' })
  })

  it('reports a failed wake', () => {
    const state = makeState({ panes: { [A]: panes([{ id: 's1', mode: 'asleep' }]) } })
    const d = { ...deps(), wake: vi.fn(), respawn: vi.fn(), hasSession: () => false }
    expect(deliverToTab(state, d, A, 's1', 'hi')).toEqual({ ok: false, reason: 'wake-failed' })
    expect(d.send).not.toHaveBeenCalled()
  })
})
