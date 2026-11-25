import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('./debug', () => ({ log: () => {} }))

type StopListener = (ev: { terminalId: string; sessionId: string; transcriptPath: string; ts: number }) => void
const stopListeners: StopListener[] = []
vi.mock('./hooks', () => ({
  onStopEvent: (l: StopListener) => {
    stopListeners.push(l)
    return () => {}
  }
}))

import { Store } from './store'
import { InboxDeriver, lastAssistantTextFromJsonl } from './inbox-deriver'
import { initialState } from '../shared/state'
import type { PaneNode, TerminalTab } from '../shared/state/terminals'
import type { JsonClaudeSession } from '../shared/state/json-claude'

const WT = '/wt/a'

function paneWith(tabs: TerminalTab[]): PaneNode {
  return { type: 'leaf', id: 'p1', tabs, activeTabId: tabs[0].id }
}

function chatSession(id: string, text: string): JsonClaudeSession {
  return {
    sessionId: id,
    worktreePath: WT,
    state: 'running',
    exitCode: null,
    exitReason: null,
    entries: [
      { entryId: '1', kind: 'user', text: 'go', timestamp: 1 },
      { entryId: '2', kind: 'assistant', blocks: [{ type: 'text', text }], timestamp: 2 },
      {
        entryId: '3',
        kind: 'assistant',
        parentToolUseId: 'task1',
        blocks: [{ type: 'text', text: 'sub-agent chatter?' }],
        timestamp: 3
      }
    ],
    entriesHydrated: true,
    busy: false,
    permissionMode: 'default',
    slashCommands: [],
    autoApprovedDecisions: {},
    sessionToolApprovals: [],
    sessionAllowedDecisions: {},
    backgroundAgents: {}
  }
}

function status(store: Store, id: string, s: 'processing' | 'waiting'): void {
  store.dispatch({ type: 'terminals/statusChanged', payload: { id, status: s, pendingTool: null } })
}

beforeEach(() => {
  stopListeners.length = 0
})

describe('InboxDeriver', () => {
  it('records a chat turn from its last top-level assistant message', () => {
    const store = new Store({
      ...initialState,
      terminals: {
        ...initialState.terminals,
        panes: { [WT]: paneWith([{ id: 'c1', type: 'json-claude', label: 'Chat' }]) }
      },
      jsonClaude: { ...initialState.jsonClaude, sessions: { c1: chatSession('c1', 'Shall I push it?') } }
    })
    new InboxDeriver(store).start()
    status(store, 'c1', 'processing')
    status(store, 'c1', 'waiting')
    const turn = store.getSnapshot().state.inbox.turns.c1
    expect(turn).toMatchObject({ worktreePath: WT, kind: 'question', text: 'Shall I push it?' })
  })

  it('does not treat a replayed boot status as a finished turn', () => {
    const store = new Store({
      ...initialState,
      terminals: {
        ...initialState.terminals,
        panes: { [WT]: paneWith([{ id: 'c1', type: 'json-claude', label: 'Chat' }]) }
      },
      jsonClaude: { ...initialState.jsonClaude, sessions: { c1: chatSession('c1', 'Done.') } }
    })
    new InboxDeriver(store).start()
    status(store, 'c1', 'waiting')
    expect(store.getSnapshot().state.inbox.turns.c1).toBeUndefined()
    expect(store.getSnapshot().state.inbox.statusSince.c1?.status).toBe('waiting')
  })

  it('fills a terminal Claude turn in from the Stop hook transcript', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inbox-deriver-'))
    const transcript = join(dir, 's.jsonl')
    writeFileSync(
      transcript,
      [
        JSON.stringify({ type: 'user', message: { content: 'hi' } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'All tests pass.' }] } }),
        ''
      ].join('\n')
    )
    const store = new Store({
      ...initialState,
      terminals: {
        ...initialState.terminals,
        panes: { [WT]: paneWith([{ id: 'a1', type: 'agent', label: 'Claude' }]) }
      }
    })
    new InboxDeriver(store).start()
    status(store, 'a1', 'processing')
    for (const l of stopListeners) l({ terminalId: 'a1', sessionId: 's', transcriptPath: transcript, ts: 0 })
    status(store, 'a1', 'waiting')
    expect(store.getSnapshot().state.inbox.turns.a1).toMatchObject({ kind: 'finished', text: '' })
    await vi.waitFor(() => {
      expect(store.getSnapshot().state.inbox.turns.a1?.text).toBe('All tests pass.')
    })
  })

  it('records Codex terminal turns as finished with no text', () => {
    const store = new Store({
      ...initialState,
      terminals: {
        ...initialState.terminals,
        panes: { [WT]: paneWith([{ id: 'x1', type: 'agent', label: 'Codex', agentKind: 'codex' }]) }
      }
    })
    new InboxDeriver(store).start()
    for (const l of stopListeners) l({ terminalId: 'x1', sessionId: 's', transcriptPath: '/nope', ts: 0 })
    status(store, 'x1', 'processing')
    status(store, 'x1', 'waiting')
    expect(store.getSnapshot().state.inbox.turns.x1).toMatchObject({ kind: 'finished', text: '' })
  })

  it('forgets turns for tabs closed in a worktree', () => {
    const store = new Store({
      ...initialState,
      terminals: {
        ...initialState.terminals,
        panes: { [WT]: paneWith([{ id: 'c1', type: 'json-claude', label: 'Chat' }]) }
      },
      jsonClaude: { ...initialState.jsonClaude, sessions: { c1: chatSession('c1', 'Done.') } }
    })
    new InboxDeriver(store).start()
    status(store, 'c1', 'processing')
    status(store, 'c1', 'waiting')
    store.dispatch({
      type: 'terminals/panesForWorktreeChanged',
      payload: { worktreePath: WT, panes: paneWith([{ id: 's1', type: 'shell', label: 'Shell' }]) }
    })
    expect(store.getSnapshot().state.inbox.turns.c1).toBeUndefined()
  })
})

describe('lastAssistantTextFromJsonl', () => {
  it('skips sidechain lines and a truncated first line', () => {
    const tail = [
      '{"type":"assistant","mess',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Main reply?' }] } }),
      JSON.stringify({
        type: 'assistant',
        isSidechain: true,
        message: { content: [{ type: 'text', text: 'sub-agent' }] }
      }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } })
    ].join('\n')
    expect(lastAssistantTextFromJsonl(tail)).toBe('Main reply?')
  })

  it('stops at the user prompt that started the turn', () => {
    const tail = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Old turn' }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'next' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } })
    ].join('\n')
    expect(lastAssistantTextFromJsonl(tail)).toBe('')
  })
})
