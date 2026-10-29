import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./debug', () => ({
  log: () => {}
}))

import { Store } from './store'
import { JsonClaudeStatusDeriver } from './json-claude-status-deriver'
import { initialState, type StateEvent } from '../shared/state'
import type {
  JsonClaudeSession,
  JsonClaudeState
} from '../shared/state/json-claude'
import type { PtyStatus } from '../shared/state/terminals'

function makeSession(
  id: string,
  overrides: Partial<JsonClaudeSession> = {}
): JsonClaudeSession {
  return {
    sessionId: id,
    worktreePath: `/tmp/wt-${id}`,
    state: 'running',
    exitCode: null,
    exitReason: null,
    entries: [],
    entriesHydrated: false,
    busy: false,
    permissionMode: 'default',
    slashCommands: [],
    autoApprovedDecisions: {},
    sessionToolApprovals: [],
    sessionAllowedDecisions: {},
    backgroundAgents: {},
    ...overrides
  }
}

function makeStore(jc: JsonClaudeState): Store {
  return new Store({ ...initialState, jsonClaude: jc })
}

interface CapturedEvents {
  statusChanged: Array<{ id: string; status: PtyStatus; pendingTool: unknown }>
  removed: string[]
}

function startDeriverWithCapture(
  store: Store
): { deriver: JsonClaudeStatusDeriver; events: CapturedEvents } {
  const deriver = new JsonClaudeStatusDeriver(store)
  deriver.start()
  const events: CapturedEvents = { statusChanged: [], removed: [] }
  store.subscribe((event: StateEvent) => {
    if (event.type === 'terminals/statusChanged') {
      events.statusChanged.push(event.payload)
    } else if (event.type === 'terminals/removed') {
      events.removed.push(event.payload)
    }
  })
  return { deriver, events }
}

describe('JsonClaudeStatusDeriver', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('dedups repeated streaming deltas down to one statusChanged', () => {
    const jc: JsonClaudeState = {
      sessions: { A: makeSession('A') },
      pendingApprovals: {}
    }
    const store = makeStore(jc)
    const { events } = startDeriverWithCapture(store)

    for (let i = 0; i < 5; i++) {
      store.dispatch({
        type: 'jsonClaude/assistantTextDelta',
        payload: { sessionId: 'A', entryId: 'e1', textDelta: 'x' }
      })
    }

    expect(events.statusChanged).toHaveLength(1)
    expect(events.statusChanged[0]).toEqual({
      id: 'A',
      status: 'waiting',
      pendingTool: null
    })
  })

  it('scopes derivation to the session in the event payload', () => {
    const jc: JsonClaudeState = {
      sessions: { A: makeSession('A'), B: makeSession('B') },
      pendingApprovals: {}
    }
    const store = makeStore(jc)
    const { events } = startDeriverWithCapture(store)

    store.dispatch({
      type: 'jsonClaude/assistantTextDelta',
      payload: { sessionId: 'A', entryId: 'e1', textDelta: 'x' }
    })

    expect(events.statusChanged).toHaveLength(1)
    expect(events.statusChanged[0].id).toBe('A')
    expect(events.statusChanged.some((e) => e.id === 'B')).toBe(false)
  })

  it('emits processing once on busy:false → true and dedups a repeat', () => {
    const jc: JsonClaudeState = {
      sessions: { A: makeSession('A', { busy: false }) },
      pendingApprovals: {}
    }
    const store = makeStore(jc)
    const { events } = startDeriverWithCapture(store)

    store.dispatch({
      type: 'jsonClaude/busyChanged',
      payload: { sessionId: 'A', busy: true }
    })

    expect(events.statusChanged).toHaveLength(1)
    expect(events.statusChanged[0]).toEqual({
      id: 'A',
      status: 'processing',
      pendingTool: null
    })

    store.dispatch({
      type: 'jsonClaude/busyChanged',
      payload: { sessionId: 'A', busy: true }
    })

    expect(events.statusChanged).toHaveLength(1)
  })

  it('handles approvalRequested → approvalResolved without touching unrelated sessions', () => {
    const jc: JsonClaudeState = {
      sessions: { A: makeSession('A'), B: makeSession('B') },
      pendingApprovals: {}
    }
    const store = makeStore(jc)
    const { events } = startDeriverWithCapture(store)

    // Warm B's cache so the approvalResolved sweep can dedup it.
    store.dispatch({
      type: 'jsonClaude/assistantTextDelta',
      payload: { sessionId: 'B', entryId: 'eb', textDelta: 'x' }
    })
    expect(events.statusChanged).toHaveLength(1)
    expect(events.statusChanged[0]).toEqual({
      id: 'B',
      status: 'waiting',
      pendingTool: null
    })

    store.dispatch({
      type: 'jsonClaude/approvalRequested',
      payload: {
        requestId: 'r1',
        sessionId: 'A',
        toolName: 'Bash',
        input: { command: 'ls' },
        timestamp: 1
      }
    })

    expect(events.statusChanged).toHaveLength(2)
    expect(events.statusChanged[1]).toEqual({
      id: 'A',
      status: 'needs-approval',
      pendingTool: { name: 'Bash', input: { command: 'ls' } }
    })

    store.dispatch({
      type: 'jsonClaude/approvalResolved',
      payload: { requestId: 'r1' }
    })

    // Sweep: A flips back to waiting, B is deduped via the cache.
    expect(events.statusChanged).toHaveLength(3)
    expect(events.statusChanged[2]).toEqual({
      id: 'A',
      status: 'waiting',
      pendingTool: null
    })
    expect(events.statusChanged.filter((e) => e.id === 'B')).toHaveLength(1)
  })

  it('holds the pre-approval status while the auto-reviewer is deciding', () => {
    const jc: JsonClaudeState = {
      sessions: { A: makeSession('A', { busy: true }) },
      pendingApprovals: {}
    }
    const store = makeStore(jc)
    const { events } = startDeriverWithCapture(store)

    store.dispatch({
      type: 'jsonClaude/approvalRequested',
      payload: {
        requestId: 'r1',
        sessionId: 'A',
        toolName: 'Bash',
        input: { command: 'ls' },
        timestamp: 1,
        autoReview: { state: 'pending' }
      }
    })

    expect(events.statusChanged).toHaveLength(1)
    expect(events.statusChanged[0]).toEqual({
      id: 'A',
      status: 'processing',
      pendingTool: null
    })

    store.dispatch({
      type: 'jsonClaude/approvalAutoReviewFinished',
      payload: { requestId: 'r1', decision: 'ask', reason: 'needs a human' }
    })

    expect(events.statusChanged).toHaveLength(2)
    expect(events.statusChanged[1]).toEqual({
      id: 'A',
      status: 'needs-approval',
      pendingTool: { name: 'Bash', input: { command: 'ls' } }
    })
  })

  it('goes straight to needs-approval when the auto-reviewer already asked', () => {
    const jc: JsonClaudeState = {
      sessions: { A: makeSession('A', { busy: true }) },
      pendingApprovals: {}
    }
    const store = makeStore(jc)
    const { events } = startDeriverWithCapture(store)

    store.dispatch({
      type: 'jsonClaude/approvalRequested',
      payload: {
        requestId: 'r1',
        sessionId: 'A',
        toolName: 'Bash',
        input: { command: 'rm -rf /' },
        timestamp: 1,
        autoReview: { state: 'finished', decision: 'ask', reason: 'deny list' }
      }
    })

    expect(events.statusChanged).toHaveLength(1)
    expect(events.statusChanged[0].status).toBe('needs-approval')
  })

  it('emits terminals/removed exactly once when a session goes exited', () => {
    const jc: JsonClaudeState = {
      sessions: { A: makeSession('A') },
      pendingApprovals: {}
    }
    const store = makeStore(jc)
    const { events } = startDeriverWithCapture(store)

    store.dispatch({
      type: 'jsonClaude/sessionStateChanged',
      payload: { sessionId: 'A', state: 'exited', exitCode: 0 }
    })

    expect(events.removed).toEqual(['A'])
    expect(events.statusChanged).toHaveLength(0)

    // Re-dispatch the same exited transition — deriver should dedup.
    store.dispatch({
      type: 'jsonClaude/sessionStateChanged',
      payload: { sessionId: 'A', state: 'exited', exitCode: 0 }
    })
    // Any further event on the exited session shouldn't re-emit either.
    store.dispatch({
      type: 'jsonClaude/busyChanged',
      payload: { sessionId: 'A', busy: false }
    })

    expect(events.removed).toEqual(['A'])
    expect(events.statusChanged).toHaveLength(0)
  })
  it('flags a pending edit_copy draft as needs-approval and clears it on resolve', () => {
    const store = makeStore({ sessions: { A: makeSession('A', { busy: true }) }, pendingApprovals: {} })
    const { events } = startDeriverWithCapture(store)
    const draft = { id: 'd1', terminalId: 'A', worktreePath: '/tmp/wt-A', draft: 'hi', timestamp: 1 }

    store.dispatch({ type: 'copyDrafts/requested', payload: draft })
    expect(events.statusChanged.at(-1)).toMatchObject({ id: 'A', status: 'needs-approval' })

    store.dispatch({ type: 'copyDrafts/resolved', payload: { id: 'd1', terminalId: 'A' } })
    expect(events.statusChanged.at(-1)).toMatchObject({ id: 'A', status: 'processing' })
  })

  it('ignores copy drafts from terminal tabs', () => {
    const store = makeStore({ sessions: { A: makeSession('A') }, pendingApprovals: {} })
    const { events } = startDeriverWithCapture(store)
    store.dispatch({
      type: 'copyDrafts/requested',
      payload: { id: 'd1', terminalId: 'xterm-1', worktreePath: '/wt', draft: 'hi', timestamp: 1 }
    })
    expect(events.statusChanged).toEqual([])
  })
})
