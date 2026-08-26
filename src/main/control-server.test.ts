import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  startControlServer,
  getControlServerInfo,
  type ControlServerDeps,
  type CallerScope
} from './control-server'
import type { ChatDeliveryResult } from './chat-delivery'
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
  isMain: false
}

/** Mutable so a test can flip the setting off without restarting the server —
 * mirrors how the real dep re-reads config per request. */
let conversationForkEnabled = true
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
  hasForkableTranscript: (sessionId) => sessionId === CALLER_TERMINAL,
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
    showCursor: async () => {}
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
    send: (path, message) => sendMessage(path, message)
  },
  renameBranch: (worktreePath, newBranch) => renameBranch(worktreePath, newBranch)
}

let baseUrl: string
let token: string

async function get(
  path: string
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Harness-Terminal-Id': CALLER_TERMINAL
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

  it('rejects forkConversation into an agent that cannot resume a transcript', async () => {
    for (const agentKind of ['codex', 'cursor']) {
      const r = await call('POST', '/worktrees', {
        branchName: 'spinoff',
        agentKind,
        forkConversation: true
      })
      expect(r.status).toBe(400)
      expect(r.json.error).toMatch(/only Claude Code can resume a forked transcript/)
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
