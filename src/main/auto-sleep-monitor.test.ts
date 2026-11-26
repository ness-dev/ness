import { describe, it, expect, vi } from 'vitest'

vi.mock('./debug', () => ({
  log: () => {}
}))
vi.mock('./perf-log', () => ({
  perfLog: () => {}
}))

import { Store } from './store'
import { AutoSleepMonitor } from './auto-sleep-monitor'
import { initialState, type AppState } from '../shared/state'
import type { PanesFSM } from './panes-fsm'

const WT = '/wt/a'
const TAB = 'chat-1'
const AGENT_TOOL_USE = 'toolu_agent'
const MINUTE = 60_000
const LAST_ACTIVE = 1_000_000

function makeStore(): Store {
  const state: AppState = {
    ...initialState,
    settings: { ...initialState.settings, autoSleepMinutes: 10 },
    terminals: {
      ...initialState.terminals,
      panes: {
        [WT]: {
          type: 'leaf',
          id: 'p1',
          tabs: [{ id: TAB, type: 'json-claude', label: 'Chat' }],
          activeTabId: TAB
        }
      },
      statuses: { [TAB]: 'waiting' },
      lastActive: { [WT]: LAST_ACTIVE }
    }
  }
  const store = new Store(state)
  store.dispatch({
    type: 'jsonClaude/sessionStarted',
    payload: { sessionId: TAB, worktreePath: WT }
  })
  store.dispatch({
    type: 'jsonClaude/sessionStateChanged',
    payload: { sessionId: TAB, state: 'running' }
  })
  store.dispatch({
    type: 'jsonClaude/backgroundAgentLaunched',
    payload: {
      sessionId: TAB,
      toolUseId: AGENT_TOOL_USE,
      agentId: 'a123',
      description: 'long job',
      taskType: 'local_agent',
      timestamp: LAST_ACTIVE
    }
  })
  return store
}

function makeMonitor(store: Store) {
  const sleepJsonClaudeTab = vi.fn()
  const monitor = new AutoSleepMonitor(store, { sleepJsonClaudeTab } as unknown as PanesFSM)
  return { monitor, sleepJsonClaudeTab }
}

describe('AutoSleepMonitor', () => {
  it('does not sleep an idle tab with a running background agent', () => {
    const store = makeStore()
    const { monitor, sleepJsonClaudeTab } = makeMonitor(store)
    monitor.sweep(LAST_ACTIVE + 30 * MINUTE)
    expect(sleepJsonClaudeTab).not.toHaveBeenCalled()
  })

  it('sleeps the tab once the agent settles and it has been idle past the threshold', () => {
    const store = makeStore()
    const { monitor, sleepJsonClaudeTab } = makeMonitor(store)
    store.dispatch({
      type: 'jsonClaude/backgroundAgentSettled',
      payload: {
        sessionId: TAB,
        toolUseId: AGENT_TOOL_USE,
        agentId: 'a123',
        status: 'completed',
        timestamp: LAST_ACTIVE + MINUTE
      }
    })
    // Under the threshold: still awake.
    monitor.sweep(LAST_ACTIVE + 5 * MINUTE)
    expect(sleepJsonClaudeTab).not.toHaveBeenCalled()
    monitor.sweep(LAST_ACTIVE + 30 * MINUTE)
    expect(sleepJsonClaudeTab).toHaveBeenCalledWith(WT, TAB)
  })

  it('does not sleep while a resumed agent is running again', () => {
    const store = makeStore()
    const { monitor, sleepJsonClaudeTab } = makeMonitor(store)
    store.dispatch({
      type: 'jsonClaude/backgroundAgentSettled',
      payload: {
        sessionId: TAB,
        toolUseId: AGENT_TOOL_USE,
        agentId: 'a123',
        status: 'completed',
        timestamp: LAST_ACTIVE + MINUTE
      }
    })
    // SendMessage resume: same task id, the SendMessage call's tool_use id.
    store.dispatch({
      type: 'jsonClaude/backgroundAgentLaunched',
      payload: {
        sessionId: TAB,
        toolUseId: 'toolu_sendmessage',
        agentId: 'a123',
        description: 'long job',
        taskType: 'local_agent',
        timestamp: LAST_ACTIVE + 2 * MINUTE
      }
    })
    monitor.sweep(LAST_ACTIVE + 30 * MINUTE)
    expect(sleepJsonClaudeTab).not.toHaveBeenCalled()
  })

  it('does not sleep while a background Bash task is running', () => {
    const store = makeStore()
    const { monitor, sleepJsonClaudeTab } = makeMonitor(store)
    store.dispatch({
      type: 'jsonClaude/backgroundAgentSettled',
      payload: {
        sessionId: TAB,
        toolUseId: AGENT_TOOL_USE,
        status: 'completed',
        timestamp: LAST_ACTIVE + MINUTE
      }
    })
    store.dispatch({
      type: 'jsonClaude/backgroundAgentLaunched',
      payload: {
        sessionId: TAB,
        toolUseId: 'toolu_bash',
        agentId: 'bvn3zclfg',
        description: 'sleep 600',
        taskType: 'local_bash',
        timestamp: LAST_ACTIVE + 2 * MINUTE
      }
    })
    monitor.sweep(LAST_ACTIVE + 30 * MINUTE)
    expect(sleepJsonClaudeTab).not.toHaveBeenCalled()
  })
})
