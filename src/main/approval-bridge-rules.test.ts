// Unit coverage for the persistent-allowlist short-circuit in
// ApprovalBridge. Talks to the bridge's unix socket directly with
// hand-written request frames instead of spawning `claude`, so it runs
// everywhere (unlike approval-bridge.test.ts, which needs the binary).

import { describe, it, expect, afterEach } from 'vitest'
import { createConnection, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { ApprovalBridge } from './approval-bridge'
import type { Store } from './store'
import { initialState, rootReducer, type StateEvent } from '../shared/state'
import type { StoredPermissionRule } from '../shared/permission-match'

class TestStore {
  private state = initialState
  private seq = 0
  dispatch(event: StateEvent): void {
    this.state = rootReducer(this.state, event)
    this.seq++
  }
  subscribe(): () => void {
    return () => {}
  }
  getSnapshot(): { state: typeof initialState; seq: number } {
    return { state: this.state, seq: this.seq }
  }
}

function rule(toolName: string, ruleContent?: string): StoredPermissionRule {
  return {
    id: ruleContent ? `${toolName}(${ruleContent})` : toolName,
    toolName,
    ...(ruleContent ? { ruleContent } : {}),
    grantedAt: 0
  }
}

const openSockets: Socket[] = []
const openBridges: ApprovalBridge[] = []

afterEach(() => {
  for (const s of openSockets.splice(0)) s.destroy()
  for (const b of openBridges.splice(0)) b.stopAll()
})

interface Harness {
  store: TestStore
  sessionId: string
  send: (frame: Record<string, unknown>) => Promise<Record<string, unknown> | null>
}

/** Boot a bridge with `rules` pre-loaded and return a `send` that writes one
 *  request frame and resolves with the response — or null if the bridge
 *  decided a human should see it (no response within the grace window). */
async function harness(rules: StoredPermissionRule[]): Promise<Harness> {
  const store = new TestStore()
  store.dispatch({ type: 'permissions/loaded', payload: { rules } })
  const bridge = new ApprovalBridge(store as unknown as Store, {
    getClaudeCommand: () => 'claude',
    // Off so an un-matched request parks as a card instead of spawning a
    // Haiku reviewer — this suite is only about the rule path.
    isAutoApproveEnabled: () => false,
    getAutoApproveSteerInstructions: () => ''
  })
  openBridges.push(bridge)
  const sessionId = randomUUID()
  const socketPath = bridge.startSession(sessionId)

  return {
    store,
    sessionId,
    send: (frame) =>
      new Promise((resolve, reject) => {
        const socket = createConnection(socketPath)
        openSockets.push(socket)
        let buf = ''
        const timer = setTimeout(() => resolve(null), 300)
        socket.on('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
        socket.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8')
          const idx = buf.indexOf('\n')
          if (idx < 0) return
          clearTimeout(timer)
          resolve(JSON.parse(buf.slice(0, idx)) as Record<string, unknown>)
        })
        socket.on('connect', () => {
          socket.write(JSON.stringify({ type: 'request', sessionId, ...frame }) + '\n')
        })
      })
  }
}

describe('ApprovalBridge — persistent allowlist', () => {
  it('allows a matching call without surfacing a card', async () => {
    const h = await harness([rule('Bash', 'git status:*')])
    const res = await h.send({
      id: 'req-1',
      tool_name: 'Bash',
      input: { command: 'git status --short' },
      tool_use_id: 'tu-1'
    })
    expect(res).toMatchObject({ type: 'response', id: 'req-1' })
    expect((res as { result: { behavior: string } }).result.behavior).toBe('allow')
    // No pending approval was published, so no card renders.
    expect(
      Object.keys(h.store.getSnapshot().state.jsonClaude.pendingApprovals)
    ).toHaveLength(0)
  })

  it('leaves a non-matching call for the user', async () => {
    const h = await harness([rule('Bash', 'git status:*')])
    const res = await h.send({
      id: 'req-2',
      tool_name: 'Bash',
      input: { command: 'rm -rf /' },
      tool_use_id: 'tu-2'
    })
    expect(res).toBeNull()
    const pending = h.store.getSnapshot().state.jsonClaude.pendingApprovals
    expect(pending['req-2']?.toolName).toBe('Bash')
  })

  it('a grant made in one worktree fires for a path in another', async () => {
    // The regression this whole change exists for: Claude persists grants
    // per-worktree, so this used to require re-approving in every sibling.
    const h = await harness([rule('Write', '/repo-a/**')])
    const res = await h.send({
      id: 'req-3',
      tool_name: 'Write',
      input: { file_path: '/repo-a/src/x.ts' },
      tool_use_id: 'tu-3'
    })
    expect((res as { result: { behavior: string } }).result.behavior).toBe('allow')
  })

  it('records which rule fired so the tool card can show provenance', async () => {
    const h = await harness([rule('Read', '/x/**')])
    h.store.dispatch({
      type: 'jsonClaude/sessionStarted',
      payload: { sessionId: h.sessionId, worktreePath: '/repo' }
    })
    await h.send({
      id: 'req-4',
      tool_name: 'Read',
      input: { file_path: '/x/y.ts' },
      tool_use_id: 'tu-4'
    })
    const decisions =
      h.store.getSnapshot().state.jsonClaude.sessions[h.sessionId]
        ?.sessionAllowedDecisions
    expect(decisions?.['tu-4']).toMatchObject({
      toolName: 'Read',
      rule: 'Read(/x/**)'
    })
  })

  it('never short-circuits AskUserQuestion, even with a bare grant', async () => {
    // Its answers ride back in the approval response, so auto-allowing it
    // would hand the model an empty answer set.
    const h = await harness([rule('*')])
    const res = await h.send({
      id: 'req-6',
      tool_name: 'AskUserQuestion',
      input: { questions: [] },
      tool_use_id: 'tu-6'
    })
    expect(res).toBeNull()
  })
})
