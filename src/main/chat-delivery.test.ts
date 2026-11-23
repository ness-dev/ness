import { describe, it, expect, vi } from 'vitest'

vi.mock('./debug', () => ({
  log: () => {}
}))

import { ChatStartGate } from './chat-start-gate'
import {
  deliverToTab,
  deliverToWorktreeChat,
  describeWorktree,
  resolveChatQuery,
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
  return { send, wake, respawn, hasSession: (id) => live.has(id), isStarting: () => false }
}

describe('resolveChatQuery', () => {
  function chatState(labels: Array<{ id: string; label?: string; customLabel?: string; type?: 'json-claude' | 'agent' }>): AppState {
    return makeState({
      worktrees: [worktree(A, 'feat-a'), worktree(B, 'feat-b')],
      aliases: { [A]: 'Site' },
      panes: {
        [A]: {
          type: 'leaf',
          id: 'p1',
          tabs: labels.map((t) => ({
            id: t.id,
            type: t.type ?? ('json-claude' as const),
            label: t.label ?? 'Chat',
            ...(t.customLabel ? { customLabel: t.customLabel } : {})
          })),
          activeTabId: labels[0]?.id ?? ''
        }
      }
    })
  }

  it('resolves by tab id or by the slug of the tab name, with or without @', () => {
    const state = chatState([{ id: 't1', customLabel: 'Fix Login Bug' }, { id: 't2' }])
    expect(resolveChatQuery(state, '@chat:repo/feat-a#fix-login-bug')).toEqual({ path: A, tabId: 't1' })
    expect(resolveChatQuery(state, 'chat:Site#t2')).toEqual({ path: A, tabId: 't2' })
    expect(resolveChatQuery(state, 'CHAT:repo/feat-a#Fix-Login-Bug')).toEqual({ path: A, tabId: 't1' })
  })

  it('refuses a slug shared by two tabs rather than guessing', () => {
    const state = chatState([{ id: 't1' }, { id: 't2' }])
    const r = resolveChatQuery(state, 'chat:repo/feat-a#chat')
    expect(r).toEqual({ error: expect.stringMatching(/matches 2 Chat tabs/) })
  })

  it('does not resolve terminal agent tabs or tabs in another worktree', () => {
    const state = chatState([{ id: 'term', type: 'agent', label: 'Claude' }])
    expect(resolveChatQuery(state, 'chat:repo/feat-a#term')).toEqual({ error: expect.stringMatching(/no Chat tab/) })
    expect(resolveChatQuery(state, 'chat:repo/feat-b#term')).toEqual({ error: expect.stringMatching(/no Chat tab/) })
  })

  it('narrows an ambiguous worktree handle by the tab ref', () => {
    // Two clones named `app` on the same branch share the handle app/main.
    const C = '/other/app'
    const state = makeState({
      worktrees: [worktree(A, 'main', { repoRoot: '/x/app' }), worktree(C, 'main', { repoRoot: '/y/app' })],
      panes: {
        [A]: { type: 'leaf', id: 'p1', tabs: [{ id: 'ta', type: 'json-claude', label: 'Chat', customLabel: 'Deploy' }], activeTabId: 'ta' },
        [C]: { type: 'leaf', id: 'p2', tabs: [{ id: 'tc', type: 'json-claude', label: 'Chat', customLabel: 'Docs' }, { id: 'tc2', type: 'json-claude', label: 'Chat', customLabel: 'Deploy' }], activeTabId: 'tc' }
      }
    })
    expect(resolveChatQuery(state, 'chat:app/main#tc')).toEqual({ path: C, tabId: 'tc' })
    expect(resolveChatQuery(state, 'chat:app/main#docs')).toEqual({ path: C, tabId: 'tc' })
    // The slug exists in both candidates — still refused.
    expect(resolveChatQuery(state, 'chat:app/main#deploy')).toEqual({ error: expect.stringMatching(/matches 2 Chat tabs/) })
  })

  it('ignores punctuation trailing the token in prose', () => {
    const state = chatState([{ id: 't1', customLabel: 'Review' }])
    expect(resolveChatQuery(state, '@chat:repo/feat-a#review,')).toEqual({ path: A, tabId: 't1' })
    expect(resolveChatQuery(state, 'chat:repo/feat-a#t1).')).toEqual({ path: A, tabId: 't1' })
  })

  it('reports a bad worktree half or a malformed token', () => {
    const state = chatState([{ id: 't1' }])
    expect(resolveChatQuery(state, 'chat:nope#t1')).toEqual({ error: expect.stringMatching(/no worktree/) })
    expect(resolveChatQuery(state, 'chat:repo/feat-a')).toEqual({ error: expect.stringMatching(/not a chat mention/) })
  })
})

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
      { send, hasSession: () => false, isStarting: () => false, wake: () => {}, respawn: () => {} },
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

/** Deps composed the way main/index.ts composes them: wake/respawn begin a
 *  start on a real ChatStartGate that waits on a probe, and send goes
 *  through afterStart. Also flips the tab awake, like wakeJsonClaudeTab. */
function gatedDeps(getState: () => AppState, setState: (s: AppState) => void) {
  const gate = new ChatStartGate()
  const live = new Set<string>()
  let release!: (ok: boolean) => void
  const probe = new Promise<boolean>((r) => {
    release = r
  })
  const delivered: string[] = []
  const woken: string[] = []
  const start = (wt: string, id: string): void => {
    void gate.begin(id, async () => {
      const ok = await probe
      if (ok) live.add(id)
      return ok
    })
    const st = getState()
    const tree = st.terminals.panes[wt]
    if (tree?.type === 'leaf') {
      setState({
        ...st,
        terminals: {
          ...st.terminals,
          panes: {
            ...st.terminals.panes,
            [wt]: { ...tree, tabs: tree.tabs.map((t) => (t.id === id ? { ...t, mode: 'awake' as const } : t)) }
          }
        }
      })
    }
  }
  const d: ChatDeliveryDeps = {
    hasSession: (id) => live.has(id),
    isStarting: (id) => gate.isStarting(id),
    wake: (wt, id) => {
      woken.push(id)
      start(wt, id)
    },
    respawn: (wt, id) => start(wt, id),
    send: (id, text) => gate.afterStart(id, () => delivered.push(`${id}:${text}`))
  }
  return { d, gate, delivered, woken, release }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('delivery while a start is in flight', () => {
  it('reports success on wake and delivers once the start resolves', async () => {
    let state = makeState({ panes: { [A]: panes([{ id: 's1', mode: 'asleep' }]) } })
    const { d, delivered, release } = gatedDeps(() => state, (s) => (state = s))
    expect(deliverToTab(state, d, A, 's1', 'hi')).toEqual({ ok: true, tabId: 's1', woke: true })
    expect(delivered).toEqual([])
    release(true)
    await flush()
    expect(delivered).toEqual(['s1:hi'])
  })

  it('delivers nothing when the start fails', async () => {
    let state = makeState({ panes: { [A]: panes([{ id: 's1', mode: 'asleep' }]) } })
    const { d, delivered, release } = gatedDeps(() => state, (s) => (state = s))
    deliverToTab(state, d, A, 's1', 'hi')
    release(false)
    await flush()
    expect(delivered).toEqual([])
  })

  it('routes a second worktree notification to the tab that is still starting', async () => {
    let state = makeState({
      panes: { [A]: panes([{ id: 's1', mode: 'asleep' }, { id: 's2', mode: 'asleep' }]) }
    })
    const { d, delivered, woken, release } = gatedDeps(() => state, (s) => (state = s))
    expect(deliverToWorktreeChat(state, d, A, 'one')).toMatchObject({ ok: true, sessionId: 's1' })
    expect(deliverToWorktreeChat(state, d, A, 'two')).toMatchObject({ ok: true, sessionId: 's1' })
    expect(woken).toEqual(['s1'])
    release(true)
    await flush()
    expect(delivered).toEqual(['s1:one', 's1:two'])
  })
})
