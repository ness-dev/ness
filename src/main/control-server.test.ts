import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  startControlServer,
  getControlServerInfo,
  type ControlServerDeps,
  type CallerScope
} from './control-server'
import type { ChatDeliveryResult, TabDeliveryResult } from './chat-delivery'
import type { ChatTabInfo } from '../shared/agent-tabs'
import type { ReviewComment } from '../shared/state/reviews'
import type { CaptureResult } from './browser-manager-types'
import { parseAutomatedMessage } from '../shared/state/json-claude'

// Integration test for the local HTTP control server. Exercises the
// `/aliases` endpoint end-to-end (POST + DELETE, both scoped and
// explicit-path forms). The rest of the endpoints are not covered here
// — this file exists specifically to cover the alias-worktrees MCP
// path, which was called out in code review as untested.
//
// Vitest isolates each file in its own worker, so the one-time server
// startup + the module-level `serverInfo` state don't leak between
// files.

const setAlias = vi.fn<(worktreePath: string, alias: string) => void>()
const clearAlias = vi.fn<(worktreePath: string) => void>()
/** Stands in for PanesFSM.renameTab. Tests that need a refusal (the tab
 *  carries a user-set name) flip `renameTabApplies`. */
let renameTabApplies = true
/** Mutable so a test can flip the setting off without restarting the
 *  server — mirrors how the real dep re-reads config per request. */
let agentTabNamingEnabled = true
const renameTab = vi.fn<
  (worktreePath: string, tabId: string, label: string, source: 'user' | 'agent') => boolean
>(() => renameTabApplies)
/** Stands in for the real `git branch -m`. Tests that need a failure flip
 *  `renameFailure` rather than re-registering the mock. */
let renameFailure: string | null = null
const renameBranch = vi.fn(async (worktreePath: string, newBranch: string) =>
  renameFailure
    ? ({ ok: false as const, error: renameFailure })
    : ({ ok: true as const, oldBranch: 'old-branch', branch: newBranch, renamed: true })
)
const sendMessage = vi.fn<(worktreePath: string, message: string) => ChatDeliveryResult>(
  () => ({ ok: true, sessionId: 'tab-1', woke: false })
)
let messagingEnabled = true
const sendToTab = vi.fn<
  (worktreePath: string, tabId: string, message: string) => TabDeliveryResult
>((_wt, tabId) => ({ ok: true, tabId, woke: false }))

function chatTab(id: string, label: string): ChatTabInfo {
  return { id, label, agentKind: 'claude', lastActiveAt: 0, asleep: false }
}
const AUTHOR_TAB = 'author-tab'
const tabsByWorktree: Record<string, ChatTabInfo[]> = {}

function reviewComment(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 'c1',
    filePath: 'src/a.ts',
    side: 'new',
    line: 4,
    anchoredSha: 'sha',
    anchor: { commitSha: 'sha', line: 4, snippet: 'x' },
    author: { kind: 'agent', tabId: 'terminal-abc', label: 'Reviewer' },
    status: 'open',
    body: 'nit',
    createdAt: 0,
    ...over
  }
}
const reviews = {
  list: vi.fn<ControlServerDeps['reviews']['list']>(async () => [
    reviewComment({
      replies: [{ id: 'r1', author: { kind: 'human' }, body: 'agreed', createdAt: 1 }]
    })
  ]),
  addComment: vi.fn<ControlServerDeps['reviews']['addComment']>(async (_wt, tabId, input) =>
    input.line > 100
      ? { error: 'line 101 is out of range' }
      : reviewComment({
          filePath: input.filePath,
          line: input.line,
          author: { kind: 'agent', tabId, label: 'Reviewer' }
        })
  ),
  reply: vi.fn<ControlServerDeps['reviews']['reply']>((_wt, tabId, commentId, body) =>
    commentId === 'c1'
      ? {
          comment: reviewComment({
            replies: [{ id: 'r', author: { kind: 'agent', tabId }, body, createdAt: 1 }]
          })
        }
      : { error: 'no review comment' }
  ),
  setResolved: vi.fn<ControlServerDeps['reviews']['setResolved']>((_wt, _id, resolved) => ({
    comment: reviewComment({ status: resolved ? 'resolved' : 'open' })
  })),
  request: vi.fn<ControlServerDeps['reviews']['request']>((_wt, tabId, context) =>
    context.includes('fail')
      ? { ok: false, error: 'only a Chat tab can request a review' }
      : { ok: true, reviewerTabId: 'reviewer-tab', reused: false }
  ),
  submit: vi.fn<ControlServerDeps['reviews']['submit']>((_wt, tabId, input) => ({
    submission: {
      id: 'sub-1',
      author: { kind: 'agent', tabId },
      verdict: input.verdict,
      summary: input.summary,
      commentIds: ['c1'],
      createdAt: 0,
      state: 'draft',
      targetTabId: input.targetTabId ?? AUTHOR_TAB
    },
    delivery: null
  }))
}

const CALLER_TERMINAL = 'terminal-abc'
const CALLER_WORKTREE = '/repo/wt/callers-tree'
const EXPLICIT_WORKTREE = '/repo/wt/other'
/** Scoped to a worktree like a chat tab, but with no transcript on disk —
 * how a plain terminal tab looks to the fork path. */
const NO_TRANSCRIPT_TERMINAL = 'terminal-no-transcript'

const scope: CallerScope = {
  terminalId: CALLER_TERMINAL,
  worktreePath: CALLER_WORKTREE,
  repoRoot: '/repo',
  isMain: false,
  rendersMarkdown: true
}

/** Mutable so a test can flip the setting off without restarting the server —
 * mirrors how the real dep re-reads config per request. */
let conversationForkEnabled = true
let callerForkKind: 'claude' | 'codex' = 'claude'
let prReviewPrompt = ''

const runPendingPR = vi.fn<
  (params: { initialPrompt?: string }) => Promise<
    { ok: true; path: string; branch: string } | { ok: false; error: string }
  >
>(async () => ({ ok: false, error: 'not used in these tests' }))

const BROWSER_TAB = 'browser-tab-1'
let browserEnabled = false
let captureResult: CaptureResult | null = null
/** Stands in for BrowserManager.getDom, which rejects when the tab can't be
 * evaluated (load failed, or the eval timed out). */
let domResult: () => Promise<string | null> = async () => null

const deps: ControlServerDeps = {
  getRepoRoots: () => ['/repo'],
  getWorktreeBase: () => 'remote',
  getPrReviewPrompt: () => prReviewPrompt,
  broadcast: () => {},
  runWorktreeSetup: async () => {},
  runPendingPRWorktree: (params) => runPendingPR(params),
  resolveCallerScope: (terminalId) =>
    terminalId === CALLER_TERMINAL || terminalId === NO_TRANSCRIPT_TERMINAL ? scope : null,
  forkableConversationKind: (sessionId) => (sessionId === CALLER_TERMINAL ? callerForkKind : null),
  getConversationForkEnabled: () => conversationForkEnabled,
  getBrowserPerms: () => ({ enabled: browserEnabled, mode: 'full' }),
  getWorktreeStatus: () => ({ status: 'no-pr', statusLabel: 'Active' }),
  browser: {
    listTabsForWorktree: () => [],
    getTabWorktree: (tabId) => (tabId === BROWSER_TAB ? CALLER_WORKTREE : null),
    getTabUrl: () => null,
    getTabConsoleLogs: () => [],
    screenshotTab: async () => captureResult,
    getTabDom: () => domResult(),
    getTabClickables: async () => null,
    navigateTab: () => {},
    backTab: () => {},
    forwardTab: () => {},
    reloadTab: () => {},
    createTab: () => ({ id: 't', url: 'about:blank' }),
    clickTab: () => {},
    typeTab: () => {},
    scrollTab: async () => {},
    showCursor: async () => {},
    setTabViewport: async () => {}
  },
  shell: {
    listShellsForWorktree: () => [],
    getShellWorktree: () => null,
    readShellOutput: () => ({ output: '' }),
    createShell: () => ({ id: 's', label: 'shell' }),
    killShell: () => {}
  },
  setAlias: (path, alias) => setAlias(path, alias),
  clearAlias: (path) => clearAlias(path),
  getAgentTabNamingEnabled: () => agentTabNamingEnabled,
  renameTab: (path, tabId, label, source) => renameTab(path, tabId, label, source),
  messaging: {
    isEnabled: () => messagingEnabled,
    resolveTarget: (query) => {
      if (query === EXPLICIT_WORKTREE || query === 'Other Tree') {
        return { path: EXPLICIT_WORKTREE }
      }
      if (query === CALLER_WORKTREE || query === 'Callers Tree') {
        return { path: CALLER_WORKTREE }
      }
      return { error: `no worktree matching "${query}"` }
    },
    describe: (path) => (path === CALLER_WORKTREE ? 'Callers Tree' : 'Other Tree'),
    send: (path, message) => sendMessage(path, message),
    sendToTab: (path, tabId, message) => sendToTab(path, tabId, message)
  },
  reviews,
  listChatTabs: (path) => tabsByWorktree[path] ?? [],
  renameBranch: (worktreePath, newBranch) => renameBranch(worktreePath, newBranch)
}


tabsByWorktree[CALLER_WORKTREE] = [
  chatTab(CALLER_TERMINAL, 'Reviewer'),
  chatTab(AUTHOR_TAB, 'Chat')
]
tabsByWorktree[EXPLICIT_WORKTREE] = [chatTab('other-chat', 'Chat')]

let baseUrl: string
let token: string

async function get(
  path: string,
  extraHeaders?: Record<string, string>
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Harness-Terminal-Id': CALLER_TERMINAL,
      ...extraHeaders
    }
  })
  const text = await res.text()
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} }
}

async function call(
  method: 'POST' | 'DELETE',
  path: string,
  body: unknown,
  opts: { terminalId?: string | null } = {}
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  }
  if (opts.terminalId !== null) {
    headers['X-Harness-Terminal-Id'] = opts.terminalId ?? CALLER_TERMINAL
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: JSON.stringify(body)
  })
  const text = await res.text()
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  return { status: res.status, json }
}

beforeAll(async () => {
  await startControlServer(deps)
  const info = getControlServerInfo()
  if (!info) throw new Error('control server failed to start')
  baseUrl = `http://127.0.0.1:${info.port}`
  token = info.token
})

describe('control-server /worktrees/rename endpoint', () => {
  it('renames the branch and sets the alias in one call', async () => {
    renameBranch.mockClear()
    setAlias.mockClear()
    const r = await call('POST', '/worktrees/rename', {
      branchName: 'fix-login-redirect',
      alias: 'Login Redirect'
    })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({
      worktreePath: CALLER_WORKTREE,
      branch: 'fix-login-redirect',
      oldBranch: 'old-branch',
      renamed: true,
      alias: 'Login Redirect'
    })
    expect(renameBranch).toHaveBeenCalledWith(CALLER_WORKTREE, 'fix-login-redirect')
    expect(setAlias).toHaveBeenCalledWith(CALLER_WORKTREE, 'Login Redirect')
  })

  it('accepts an alias on its own without touching git', async () => {
    renameBranch.mockClear()
    const r = await call('POST', '/worktrees/rename', {
      worktreePath: EXPLICIT_WORKTREE,
      alias: 'Just A Label'
    })
    expect(r.status).toBe(200)
    expect(r.json.branch).toBeUndefined()
    expect(renameBranch).not.toHaveBeenCalled()
  })

  it('rejects a branch name that would need sanitizing', async () => {
    renameBranch.mockClear()
    const r = await call('POST', '/worktrees/rename', { branchName: 'fix the thing' })
    expect(r.status).toBe(400)
    expect(String(r.json.error)).toContain('not a valid git branch name')
    expect(renameBranch).not.toHaveBeenCalled()
  })

  it('requires at least one of branchName / alias', async () => {
    const r = await call('POST', '/worktrees/rename', {})
    expect(r.status).toBe(400)
    expect(r.json.error).toBe('branchName or alias required')
  })

  it('surfaces a git-level refusal as 409 and leaves the alias alone', async () => {
    setAlias.mockClear()
    renameFailure = 'branch "old-branch" is already published'
    const r = await call('POST', '/worktrees/rename', {
      branchName: 'renamed-anyway',
      alias: 'Should Not Apply'
    })
    renameFailure = null
    expect(r.status).toBe(409)
    expect(String(r.json.error)).toContain('already published')
    expect(setAlias).not.toHaveBeenCalled()
  })

  it('returns 400 when the caller has no scope and no explicit path', async () => {
    const r = await call(
      'POST',
      '/worktrees/rename',
      { branchName: 'orphan' },
      { terminalId: 'unknown-terminal' }
    )
    expect(r.status).toBe(400)
  })
})

describe('control-server /tab-name endpoint', () => {
  it('renames the caller\'s own tab, resolved entirely from scope', async () => {
    renameTab.mockClear()
    const r = await call('POST', '/tab-name', { name: 'Agent Tab Rename' })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ name: 'Agent Tab Rename', applied: true, clamped: false })
    expect(renameTab).toHaveBeenCalledWith(
      CALLER_WORKTREE,
      CALLER_TERMINAL,
      'Agent Tab Rename',
      'agent'
    )
  })

  it('ignores any tabId / worktreePath in the body — the caller cannot target another tab', async () => {
    renameTab.mockClear()
    await call('POST', '/tab-name', {
      name: 'Sneaky',
      tabId: 'someone-elses-tab',
      worktreePath: EXPLICIT_WORKTREE
    })
    expect(renameTab).toHaveBeenCalledWith(CALLER_WORKTREE, CALLER_TERMINAL, 'Sneaky', 'agent')
  })

  it('clamps a too-long name to 32 chars and says so', async () => {
    const r = await call('POST', '/tab-name', { name: 'N'.repeat(80) })
    expect(r.status).toBe(200)
    expect((r.json.name as string).length).toBe(32)
    expect(r.json.clamped).toBe(true)
  })

  it('reports applied: false with reason user-set when the rename is refused', async () => {
    renameTabApplies = false
    const r = await call('POST', '/tab-name', { name: 'Agent Pick' })
    renameTabApplies = true
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ name: 'Agent Pick', applied: false, reason: 'user-set' })
  })

  it('rejects an empty name rather than treating it as a reset', async () => {
    renameTab.mockClear()
    const r = await call('POST', '/tab-name', { name: '   ' })
    expect(r.status).toBe(400)
    expect(renameTab).not.toHaveBeenCalled()
  })

  it('returns 403 and never renames when the setting is off', async () => {
    renameTab.mockClear()
    agentTabNamingEnabled = false
    const r = await call('POST', '/tab-name', { name: 'Agent Pick' })
    agentTabNamingEnabled = true
    expect(r.status).toBe(403)
    expect(String(r.json.error)).toContain('disabled in Ness settings')
    expect(renameTab).not.toHaveBeenCalled()
  })

  it('reports the tab-naming gate on /scope so the bridge can hide the tool', async () => {
    const on = await get('/scope')
    expect(on.json.tabNaming).toEqual({ enabled: true })
    agentTabNamingEnabled = false
    const off = await get('/scope')
    agentTabNamingEnabled = true
    expect(off.json.tabNaming).toEqual({ enabled: false })
  })

  it('returns 400 without the terminal-id header and 404 when it resolves to nothing', async () => {
    const noHeader = await call('POST', '/tab-name', { name: 'X' }, { terminalId: null })
    expect(noHeader.status).toBe(400)
    const unknown = await call(
      'POST',
      '/tab-name',
      { name: 'X' },
      { terminalId: 'unknown-terminal' }
    )
    expect(unknown.status).toBe(404)
  })
})

describe('control-server /aliases endpoint', () => {
  it('POST /aliases with explicit worktreePath dispatches setAlias', async () => {
    setAlias.mockClear()
    const r = await call('POST', '/aliases', {
      worktreePath: EXPLICIT_WORKTREE,
      alias: 'my-label'
    })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({
      worktreePath: EXPLICIT_WORKTREE,
      alias: 'my-label',
      cleared: false,
      clamped: false
    })
    expect(setAlias).toHaveBeenCalledWith(EXPLICIT_WORKTREE, 'my-label')
  })

  it('POST /aliases without worktreePath defaults to the caller scope', async () => {
    setAlias.mockClear()
    const r = await call('POST', '/aliases', { alias: 'self' })
    expect(r.status).toBe(200)
    expect(r.json.worktreePath).toBe(CALLER_WORKTREE)
    expect(setAlias).toHaveBeenCalledWith(CALLER_WORKTREE, 'self')
  })

  it('POST /aliases with untrimmed input reports clamped: true', async () => {
    setAlias.mockClear()
    const r = await call('POST', '/aliases', {
      worktreePath: EXPLICIT_WORKTREE,
      alias: '   spacious   '
    })
    expect(r.json.alias).toBe('spacious')
    expect(r.json.clamped).toBe(true)
  })

  it('POST /aliases with >80-char input clamps and reports clamped: true', async () => {
    setAlias.mockClear()
    const long = 'a'.repeat(120)
    const r = await call('POST', '/aliases', {
      worktreePath: EXPLICIT_WORKTREE,
      alias: long
    })
    expect((r.json.alias as string).length).toBe(80)
    expect(r.json.clamped).toBe(true)
  })

  it('POST /aliases with empty-after-trim reports cleared: true', async () => {
    const r = await call('POST', '/aliases', {
      worktreePath: EXPLICIT_WORKTREE,
      alias: '   '
    })
    expect(r.json.cleared).toBe(true)
    expect(r.json.alias).toBe('')
  })

  it('POST /aliases without worktreePath and without caller scope returns 400', async () => {
    const r = await call(
      'POST',
      '/aliases',
      { alias: 'x' },
      { terminalId: 'unknown-terminal' }
    )
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/worktreePath required/)
  })

  it('DELETE /aliases with explicit worktreePath dispatches clearAlias', async () => {
    clearAlias.mockClear()
    const r = await call('DELETE', '/aliases', { worktreePath: EXPLICIT_WORKTREE })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ worktreePath: EXPLICIT_WORKTREE, cleared: true })
    expect(clearAlias).toHaveBeenCalledWith(EXPLICIT_WORKTREE)
  })

  it('DELETE /aliases without worktreePath defaults to the caller scope', async () => {
    clearAlias.mockClear()
    const r = await call('DELETE', '/aliases', {})
    expect(r.status).toBe(200)
    expect(r.json.worktreePath).toBe(CALLER_WORKTREE)
    expect(clearAlias).toHaveBeenCalledWith(CALLER_WORKTREE)
  })
})

// These all reject before addWorktree runs, so no git work happens. The
// accept path isn't covered here — it would create a real worktree.
describe('control-server POST /worktrees forkConversation', () => {
  it('rejects a caller whose terminal has no forkable transcript', async () => {
    const r = await call(
      'POST',
      '/worktrees',
      { branchName: 'spinoff', forkConversation: true },
      { terminalId: NO_TRANSCRIPT_TERMINAL }
    )
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/only available from a Ness Chat tab/)
  })

  it('rejects a caller with no resolvable scope', async () => {
    const r = await call(
      'POST',
      '/worktrees',
      { branchName: 'spinoff', forkConversation: true },
      { terminalId: 'unknown-terminal' }
    )
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/only available from a Ness Chat tab/)
  })

  it('rejects forkConversation combined with prNumber', async () => {
    const r = await call('POST', '/worktrees', { prNumber: 7, forkConversation: true })
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/cannot be combined with prNumber/)
  })

  it('rejects forkConversation into an agent that cannot be forked into', async () => {
    const r = await call('POST', '/worktrees', {
      branchName: 'spinoff',
      agentKind: 'cursor',
      forkConversation: true
    })
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/not supported for Cursor Agent worktrees/)
  })

  it('rejects forking a conversation into a different agent than owns it', async () => {
    const r = await call('POST', '/worktrees', {
      branchName: 'spinoff',
      agentKind: 'codex',
      forkConversation: true
    })
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/must run Claude Code too/)

    callerForkKind = 'codex'
    try {
      const r2 = await call('POST', '/worktrees', {
        branchName: 'spinoff',
        agentKind: 'claude',
        forkConversation: true
      })
      expect(r2.status).toBe(400)
      expect(r2.json.error).toMatch(/must run Codex too/)
    } finally {
      callerForkKind = 'claude'
    }
  })

  it('rejects forkConversation when the setting is disabled', async () => {
    conversationForkEnabled = false
    try {
      const r = await call('POST', '/worktrees', { branchName: 'spinoff', forkConversation: true })
      expect(r.status).toBe(400)
      expect(r.json.error).toMatch(/disabled in Ness settings/)
    } finally {
      conversationForkEnabled = true
    }
  })
})

describe('control-server POST /worktrees kickoff wrapping', () => {
  beforeAll(() => {
    runPendingPR.mockImplementation(async () => ({
      ok: true,
      path: EXPLICIT_WORKTREE,
      branch: 'pr-7'
    }))
  })

  it('wraps an agent-supplied initialPrompt with the caller as sender', async () => {
    runPendingPR.mockClear()
    const r = await call('POST', '/worktrees', {
      prNumber: 7,
      initialPrompt: 'refactor the auth flow'
    })
    expect(r.status).toBe(200)
    expect(parseAutomatedMessage(runPendingPR.mock.calls[0][0].initialPrompt)).toEqual({
      source: 'worktree-kickoff',
      body: 'refactor the auth flow',
      from: 'Callers Tree'
    })
  })

  it('leaves the configured PR-review default unwrapped', async () => {
    runPendingPR.mockClear()
    prReviewPrompt = 'review this PR'
    try {
      await call('POST', '/worktrees', { prNumber: 7 })
      expect(runPendingPR.mock.calls[0][0].initialPrompt).toBe('review this PR')
    } finally {
      prReviewPrompt = ''
    }
  })

  it('honors an empty-string prompt as opt-out rather than wrapping it', async () => {
    runPendingPR.mockClear()
    await call('POST', '/worktrees', { prNumber: 7, initialPrompt: '' })
    expect(runPendingPR.mock.calls[0][0].initialPrompt).toBeUndefined()
  })
})

describe('control-server /messages endpoint', () => {
  beforeAll(async () => {
    // The server is already listening from the suite above — vitest runs
    // both describes in the same worker, and startControlServer is
    // idempotent from the caller's perspective here.
    const info = getControlServerInfo()
    if (!info) throw new Error('control server failed to start')
    baseUrl = `http://127.0.0.1:${info.port}`
    token = info.token
  })

  it('delivers a wrapped message to the resolved worktree', async () => {
    sendMessage.mockClear()
    const r = await call('POST', '/messages', {
      worktree: 'Other Tree',
      message: 'build is green, you can rebase'
    })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({
      delivered: true,
      worktreePath: EXPLICIT_WORKTREE,
      from: 'Callers Tree',
      woke: false
    })
    const [path, wire] = sendMessage.mock.calls[0]
    expect(path).toBe(EXPLICIT_WORKTREE)
    expect(parseAutomatedMessage(wire)).toEqual({
      source: 'worktree-message',
      body: 'build is green, you can rebase',
      from: 'Callers Tree'
    })
  })

  it('takes the sender from caller scope, not the body', async () => {
    sendMessage.mockClear()
    await call('POST', '/messages', {
      worktree: EXPLICIT_WORKTREE,
      message: 'hi',
      from: 'Some Other Worktree'
    })
    expect(parseAutomatedMessage(sendMessage.mock.calls[0][1])?.from).toBe('Callers Tree')
  })

  it('reports woke: true when delivery had to wake a slept tab', async () => {
    sendMessage.mockReturnValueOnce({ ok: true, sessionId: 'tab-2', woke: true })
    const r = await call('POST', '/messages', {
      worktree: EXPLICIT_WORKTREE,
      message: 'hi'
    })
    expect(r.json.woke).toBe(true)
  })

  it('rejects an unknown worktree', async () => {
    const r = await call('POST', '/messages', { worktree: 'nope', message: 'hi' })
    expect(r.status).toBe(404)
    expect(r.json.error).toMatch(/no worktree matching/)
  })

  it('rejects sending to your own worktree', async () => {
    sendMessage.mockClear()
    const r = await call('POST', '/messages', {
      worktree: 'Callers Tree',
      message: 'hi'
    })
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/your own worktree/)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('requires a non-empty worktree and message', async () => {
    expect((await call('POST', '/messages', { message: 'hi' })).status).toBe(400)
    expect(
      (await call('POST', '/messages', { worktree: EXPLICIT_WORKTREE, message: '  ' }))
        .status
    ).toBe(400)
  })

  it('surfaces an undelivered message rather than silently queueing it', async () => {
    sendMessage.mockReturnValueOnce({ ok: false, reason: 'no-chat-tab' })
    const r = await call('POST', '/messages', {
      worktree: EXPLICIT_WORKTREE,
      message: 'hi'
    })
    expect(r.status).toBe(409)
    expect(r.json.error).toMatch(/no agent chat tab/)
    expect(r.json.error).toMatch(/was not sent/)
  })

  it('refuses delivery when the experimental setting is off', async () => {
    sendMessage.mockClear()
    messagingEnabled = false
    try {
      const r = await call('POST', '/messages', {
        worktree: EXPLICIT_WORKTREE,
        message: 'hi'
      })
      expect(r.status).toBe(403)
      expect(r.json.error).toMatch(/disabled in Ness settings/)
      expect(sendMessage).not.toHaveBeenCalled()
    } finally {
      messagingEnabled = true
    }
  })

  it('rejects a caller with no worktree scope', async () => {
    const r = await call(
      'POST',
      '/messages',
      { worktree: EXPLICIT_WORKTREE, message: 'hi' },
      { terminalId: 'unknown-terminal' }
    )
    expect(r.status).toBe(404)
  })
})

describe('control-server /messages with a tab', () => {
  it('delivers to another tab in your own worktree and names the sending tab', async () => {
    sendToTab.mockClear()
    const r = await call('POST', '/messages', { tab: AUTHOR_TAB, message: 'over to you' })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({
      delivered: true,
      worktreePath: CALLER_WORKTREE,
      tab: AUTHOR_TAB,
      from: 'Callers Tree · Reviewer'
    })
    const [path, tab, wire] = sendToTab.mock.calls[0]
    expect([path, tab]).toEqual([CALLER_WORKTREE, AUTHOR_TAB])
    expect(parseAutomatedMessage(wire)?.from).toBe('Callers Tree · Reviewer')
  })

  it('rejects your own tab and tabs outside the target worktree', async () => {
    sendToTab.mockClear()
    const own = await call('POST', '/messages', { tab: CALLER_TERMINAL, message: 'hi' })
    expect(own.status).toBe(400)
    expect(own.json.error).toMatch(/your own tab/)
    const wrong = await call('POST', '/messages', {
      worktree: EXPLICIT_WORKTREE,
      tab: AUTHOR_TAB,
      message: 'hi'
    })
    expect(wrong.status).toBe(404)
    expect(sendToTab).not.toHaveBeenCalled()
  })

  it('reports why a tab could not receive the message', async () => {
    sendToTab.mockReturnValueOnce({ ok: false, reason: 'terminal-unsupported' })
    const r = await call('POST', '/messages', { tab: AUTHOR_TAB, message: 'hi' })
    expect(r.status).toBe(409)
    expect(r.json.error).toMatch(/terminal tabs cannot receive/)
  })
})

describe('control-server /tabs endpoint', () => {
  it("lists the caller's worktree tabs and flags the caller", async () => {
    const r = await get('/tabs')
    expect(r.status).toBe(200)
    expect(r.json.worktreePath).toBe(CALLER_WORKTREE)
    expect(r.json.tabs).toEqual([
      expect.objectContaining({ id: CALLER_TERMINAL, self: true }),
      expect.not.objectContaining({ self: true })
    ])
  })

  it('lists another worktree by handle', async () => {
    const r = await get('/tabs?worktree=' + encodeURIComponent('Other Tree'))
    expect(r.json).toMatchObject({ worktreePath: EXPLICIT_WORKTREE, tabs: [{ id: 'other-chat' }] })
  })
})

describe('control-server /reviews endpoints', () => {
  it('lists comments flat, marking the caller’s own and naming the human', async () => {
    const r = await get('/reviews/comments?status=open&file=src%2Fa.ts')
    expect(r.status).toBe(200)
    expect(reviews.list).toHaveBeenLastCalledWith(CALLER_WORKTREE, {
      status: 'open',
      file: 'src/a.ts'
    })
    expect(r.json.comments).toEqual([
      {
        id: 'c1',
        file: 'src/a.ts',
        line: 4,
        side: 'new',
        status: 'open',
        author: 'Reviewer',
        authorTab: CALLER_TERMINAL,
        mine: true,
        body: 'nit',
        replies: [{ id: 'r1', author: 'User', body: 'agreed' }]
      }
    ])
    expect((await get('/reviews/comments?status=bogus')).status).toBe(400)
  })

  it('adds a comment authored by the calling tab, ignoring any author in the body', async () => {
    const r = await call('POST', '/reviews/comments', {
      file: './src/a.ts',
      line: 7,
      body: 'why?',
      author: { kind: 'human' }
    })
    expect(r.status).toBe(200)
    expect(reviews.addComment).toHaveBeenLastCalledWith(CALLER_WORKTREE, CALLER_TERMINAL, {
      filePath: 'src/a.ts',
      line: 7,
      side: 'new',
      body: 'why?'
    })
    expect(r.json.comment).toMatchObject({ mine: true, line: 7 })
  })

  it('validates add_review_comment input and passes range errors through', async () => {
    expect((await call('POST', '/reviews/comments', { file: 'a', line: 0, body: 'x' })).status).toBe(400)
    expect(
      (await call('POST', '/reviews/comments', { file: 'a', line: 1, side: 'left', body: 'x' })).status
    ).toBe(400)
    expect((await call('POST', '/reviews/comments', { file: 'a', line: 1, body: ' ' })).status).toBe(400)
    const r = await call('POST', '/reviews/comments', { file: 'a', line: 101, body: 'x' })
    expect(r.status).toBe(422)
    expect(r.json.error).toMatch(/out of range/)
  })

  it('replies and resolves as the calling tab', async () => {
    const reply = await call('POST', '/reviews/replies', { commentId: 'c1', body: 'fixed' })
    expect(reply.status).toBe(200)
    expect(reviews.reply).toHaveBeenLastCalledWith(CALLER_WORKTREE, CALLER_TERMINAL, 'c1', 'fixed')
    expect((await call('POST', '/reviews/replies', { commentId: 'zz', body: 'x' })).status).toBe(404)
    const resolved = await call('POST', '/reviews/resolve', { commentId: 'c1', resolved: true })
    expect(resolved.json.comment).toMatchObject({ status: 'resolved' })
    const reopened = await call('POST', '/reviews/resolve', { commentId: 'c1', resolved: false })
    expect(reopened.json.comment).toMatchObject({ status: 'open' })
  })

  it('requests a review as the calling tab and reports what happens next', async () => {
    const r = await call('POST', '/reviews/request', { context: 'added div, please check' })
    expect(r.status).toBe(200)
    expect(reviews.request).toHaveBeenLastCalledWith(
      CALLER_WORKTREE,
      CALLER_TERMINAL,
      'added div, please check'
    )
    expect(r.json).toEqual({ reviewerTabId: 'reviewer-tab', reused: false })
    expect((await call('POST', '/reviews/request', { context: '  ' })).status).toBe(400)
    const refused = await call('POST', '/reviews/request', { context: 'fail please' })
    expect(refused.status).toBe(409)
    expect(refused.json.error).toMatch(/only a Chat tab/)
  })

  it('submits a review and reports where it is going', async () => {
    const r = await call('POST', '/reviews/submit', {
      verdict: 'changes-requested',
      summary: 'two issues'
    })
    expect(r.status).toBe(200)
    expect(reviews.submit).toHaveBeenLastCalledWith(CALLER_WORKTREE, CALLER_TERMINAL, {
      verdict: 'changes-requested',
      summary: 'two issues',
      targetTabId: undefined
    })
    expect(r.json).toMatchObject({
      id: 'sub-1',
      state: 'draft',
      commentCount: 1,
      targetTabId: AUTHOR_TAB,
      delivery: null
    })
    expect((await call('POST', '/reviews/submit', { verdict: 'lgtm' })).status).toBe(400)
  })

  it('requires a scoped caller', async () => {
    const r = await call(
      'POST',
      '/reviews/submit',
      { verdict: 'approve' },
      { terminalId: 'unknown-terminal' }
    )
    expect(r.status).toBe(404)
  })
})

describe('control-server /scope endpoint', () => {
  // The bridge gates screenshot_tab's "embed this in your reply" guidance
  // on this flag — a terminal tab renders markdown as literal text, so it
  // must not be told the affordance exists.
  it('carries rendersMarkdown through to the caller', async () => {
    const r = await get('/scope')
    expect(r.status).toBe(200)
    expect((r.json.scope as CallerScope).rendersMarkdown).toBe(true)
  })

  it('400s without a terminal id, rather than guessing', async () => {
    const r = await get('/scope', { 'X-Harness-Terminal-Id': '' })
    expect(r.status).toBe(400)
  })
})

describe('control-server /browser/screenshot endpoint', () => {
  beforeAll(() => {
    browserEnabled = true
  })
  afterAll(() => {
    browserEnabled = false
  })

  it('returns the encoded image with its format and mime type', async () => {
    captureResult = { data: 'AAAA', format: 'jpeg' }
    const r = await get(`/browser/screenshot?tabId=${BROWSER_TAB}`)
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ data: 'AAAA', format: 'jpeg', mimeType: 'image/jpeg' })
  })

  it('returns the on-disk path, hash-keyed so a repeat capture reuses the file', async () => {
    captureResult = { data: 'AAAA', format: 'jpeg' }
    const first = await get(`/browser/screenshot?tabId=${BROWSER_TAB}`)
    expect(first.json.path).toMatch(/harness-attachments\/result-[0-9a-f]+\.jpg$/)
    const second = await get(`/browser/screenshot?tabId=${BROWSER_TAB}`)
    expect(second.json.path).toBe(first.json.path)
  })

  it('surfaces the capture failure reason verbatim as a 500', async () => {
    captureResult = { error: 'tab viewport is 0x0 — nothing to capture' }
    const r = await get(`/browser/screenshot?tabId=${BROWSER_TAB}`)
    expect(r.status).toBe(500)
    expect(r.json.error).toBe('tab viewport is 0x0 — nothing to capture')
  })

  it('fails instead of serving an empty image, the old silent HTTP-200 path', async () => {
    captureResult = { data: '', format: 'jpeg' } as CaptureResult
    const r = await get(`/browser/screenshot?tabId=${BROWSER_TAB}`)
    expect(r.status).toBe(500)
    expect(r.json.data).toBeUndefined()
  })

  it('reports a vanished tab rather than an empty body', async () => {
    captureResult = null
    const r = await get(`/browser/screenshot?tabId=${BROWSER_TAB}`)
    expect(r.status).toBe(500)
    expect(r.json.error).toMatch(/no longer available/)
  })
})

describe('control-server /browser/dom endpoint', () => {
  beforeAll(() => {
    browserEnabled = true
  })
  afterAll(() => {
    browserEnabled = false
    domResult = async () => null
  })

  it('returns the markup', async () => {
    domResult = async () => '<html></html>'
    const r = await get(`/browser/dom?tabId=${BROWSER_TAB}`)
    expect(r.status).toBe(200)
    expect(r.json.html).toBe('<html></html>')
  })

  it('tells the caller to reload when the tab renderer crashed', async () => {
    domResult = async () => {
      throw new Error('tab renderer crashed (reason: crashed) — reload the tab')
    }
    const r = await get(`/browser/dom?tabId=${BROWSER_TAB}`)
    expect(r.status).toBe(500)
    expect(r.json.error).toMatch(/renderer crashed .* reload the tab/)
  })

  it('answers instead of hanging when the eval times out', async () => {
    domResult = async () => {
      throw new Error('getDom tab=t1 timed out after 5000ms')
    }
    const r = await get(`/browser/dom?tabId=${BROWSER_TAB}`)
    expect(r.status).toBe(500)
    expect(r.json.error).toMatch(/timed out after 5000ms/)
  })

  it('surfaces the failed-load reason so the caller knows the URL was dead', async () => {
    domResult = async () => {
      throw new Error("tab has no document loaded (last load failed: ERR_FAILED (-2) loading 'http://localhost:8765/')")
    }
    const r = await get(`/browser/dom?tabId=${BROWSER_TAB}`)
    expect(r.status).toBe(500)
    expect(r.json.error).toMatch(/tab has no document loaded/)
  })
})
