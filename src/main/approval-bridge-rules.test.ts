// Unit coverage for the ApprovalBridge paths that don't need a model:
// the persistent-allowlist short-circuit, and dropping an approval whose
// tool call Claude already abandoned. Talks to the bridge's unix socket
// directly with hand-written request frames instead of spawning
// `claude`, so it runs everywhere (unlike approval-bridge.test.ts,
// which needs the binary).

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
  bridge: ApprovalBridge
  send: (frame: Record<string, unknown>) => Promise<Record<string, unknown> | null>
  /** Every response frame the bridge has written back, in order —
   *  including ones that landed after `send` already gave up waiting. */
  responses: Record<string, unknown>[]
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
  const responses: Record<string, unknown>[] = []

  return {
    store,
    sessionId,
    bridge,
    responses,
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
          let idx: number
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx)
            buf = buf.slice(idx + 1)
            if (!line.trim()) continue
            const parsed = JSON.parse(line) as Record<string, unknown>
            responses.push(parsed)
            clearTimeout(timer)
            resolve(parsed)
          }
        })
        socket.on('connect', () => {
          socket.write(JSON.stringify({ type: 'request', sessionId, ...frame }) + '\n')
        })
      })
  }
}

function tick(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

describe('ApprovalBridge — abandoned tool calls', () => {
  it('drops a pending approval once a result lands for its tool_use', async () => {
    // Claude Code's MCP idle timeout aborts our `approve` call and
    // reports it as an is_error tool_result on the original tool_use.
    // Nothing reaches the socket, so without this the card and its
    // needs-approval dot would outlive the turn.
    const h = await harness([])
    expect(
      await h.send({
        id: 'req-stale',
        tool_name: 'AskUserQuestion',
        input: { questions: [] },
        tool_use_id: 'tu-stale'
      })
    ).toBeNull()
    expect(
      h.store.getSnapshot().state.jsonClaude.pendingApprovals['req-stale']
    ).toBeDefined()

    expect(h.bridge.cancelPendingForToolUse(h.sessionId, 'tu-stale')).toBe(true)
    await tick()

    expect(
      h.store.getSnapshot().state.jsonClaude.pendingApprovals['req-stale']
    ).toBeUndefined()
    // The MCP subprocess is still parked on the socket — answer it so it
    // unwinds instead of leaking until the session dies.
    expect(h.responses).toHaveLength(1)
    expect(h.responses[0]).toMatchObject({ type: 'response', id: 'req-stale' })
    expect(
      (h.responses[0] as { result: { behavior: string } }).result.behavior
    ).toBe('deny')
  })

  it('leaves approvals for other tool_use ids and other sessions alone', async () => {
    const h = await harness([])
    await h.send({
      id: 'req-keep',
      tool_name: 'Bash',
      input: { command: 'rm -rf /' },
      tool_use_id: 'tu-keep'
    })
    expect(h.bridge.cancelPendingForToolUse(h.sessionId, 'tu-other')).toBe(false)
    expect(h.bridge.cancelPendingForToolUse('some-other-session', 'tu-keep')).toBe(
      false
    )
    await tick()
    expect(
      h.store.getSnapshot().state.jsonClaude.pendingApprovals['req-keep']
    ).toBeDefined()
    expect(h.responses).toHaveLength(0)
  })

  it('is a no-op for an approval the user already answered', async () => {
    // The normal ordering: the user clicks Allow, the tool runs, and its
    // result arrives. One deny must not be written on top of the allow.
    const h = await harness([])
    await h.send({
      id: 'req-done',
      tool_name: 'Bash',
      input: { command: 'ls' },
      tool_use_id: 'tu-done'
    })
    expect(h.bridge.resolveApproval('req-done', { behavior: 'allow' })).toBe(true)
    await tick()
    expect(h.bridge.cancelPendingForToolUse(h.sessionId, 'tu-done')).toBe(false)
    await tick()
    expect(h.responses).toHaveLength(1)
    expect(
      (h.responses[0] as { result: { behavior: string } }).result.behavior
    ).toBe('allow')
  })
})
