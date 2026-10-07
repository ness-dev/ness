import { createServer, IncomingMessage, ServerResponse } from 'http'
import { randomBytes, randomUUID } from 'crypto'
import type { AgentKind } from '../shared/state/terminals'
import { addWorktree, listWorktrees, defaultWorktreeDir, WorktreeInfo } from './worktree'
import { normalizeAlias } from '../shared/state/aliases'
import { isValidBranchName, sanitizeBranchInput } from '../shared/branch-name'
import { agentDisplayName, supportsConversationFork } from '../shared/agent-registry'
import type { GroupKey } from '../shared/worktree-sort'
import type { PRStatus } from '../shared/state/prs'
import type { ChatDeliveryResult } from './chat-delivery'
import type { CaptureResult } from './browser-manager-types'
import { wrapAutomatedMessage } from '../shared/state/json-claude'
import { formatForkResult } from '../shared/fork-chat'
import { log } from './debug'

export interface BrowserTabSummary {
  id: string
  url: string
  title: string
}

export interface BrowserQueries {
  listTabsForWorktree: (worktreePath: string) => BrowserTabSummary[]
  getTabWorktree: (tabId: string) => string | null
  getTabUrl: (tabId: string) => string | null
  getTabConsoleLogs: (
    tabId: string
  ) => Array<{ ts: number; level: string; message: string }>
  screenshotTab: (
    tabId: string,
    opts?: { format?: 'jpeg' | 'png'; quality?: number }
  ) => Promise<CaptureResult | null>
  getTabDom: (tabId: string) => Promise<string | null>
  getTabClickables: (tabId: string) => Promise<unknown | null>
  navigateTab: (tabId: string, url: string) => void
  backTab: (tabId: string) => void
  forwardTab: (tabId: string) => void
  reloadTab: (tabId: string) => void
  createTab: (worktreePath: string, url: string) => { id: string; url: string }
  clickTab: (
    tabId: string,
    x: number,
    y: number,
    options?: { button?: 'left' | 'right' | 'middle'; clickCount?: number }
  ) => void
  typeTab: (tabId: string, text: string, key?: string) => void
  scrollTab: (tabId: string, deltaX: number, deltaY: number) => Promise<void>
  showCursor: (tabId: string, x: number, y: number) => Promise<void>
}

export interface ShellTabSummary {
  id: string
  label: string
  command?: string
  cwd?: string
  alive: boolean
}

export interface ReadShellOutputOptions {
  lines: number
  /** Case-insensitive regex. When set, keep only matching lines (plus any
   * requested context) from the output before applying the `lines` cap. */
  match?: string
  /** Lines of context to include before/after each match. Ignored when `match`
   * is not set. */
  context?: number
}

export interface ShellQueries {
  listShellsForWorktree: (worktreePath: string) => ShellTabSummary[]
  getShellWorktree: (shellId: string) => string | null
  readShellOutput: (
    shellId: string,
    opts: ReadShellOutputOptions
  ) => { output: string; matchCount?: number; error?: string }
  createShell: (
    worktreePath: string,
    opts: { command?: string; cwd?: string; label?: string }
  ) => { id: string; label: string }
  killShell: (shellId: string) => void
}

/** The sidebar's own grouping, exposed to agents. `list_worktrees`
 * otherwise returns raw git facts, which read as "every worktree is equally
 * live" — a merged branch and one whose PR is failing CI look identical. */
export interface WorktreeStatusInfo {
  alias?: string
  status: GroupKey
  statusLabel: string
  pr?: {
    number: number
    state: PRStatus['state']
    title: string
    checks: PRStatus['checksOverall']
    reviewDecision: PRStatus['reviewDecision']
    hasConflict: boolean | null
  }
}

export interface MessagingQueries {
  /** Whether the experimental worktree-messaging setting is on. Re-read per
   * request so a toggle takes effect without restarting the bridge. */
  isEnabled: () => boolean
  /** Resolve a caller-supplied handle — absolute path, branch name, or
   * alias — to a known worktree path. */
  resolveTarget: (query: string) => { path: string } | { error: string }
  /** Human label for a worktree: its alias when set, else its branch. Names
   * the sender in the delivered message. */
  describe: (worktreePath: string) => string
  /** Route a message into a worktree's agent chat, waking a slept tab if
   * that's what delivery takes. */
  send: (worktreePath: string, message: string) => ChatDeliveryResult
}

/** Scope derived from the caller's terminal id on every request. The
 * source of truth — env vars injected into the MCP bridge can go stale
 * (teleport sessions, deleted worktrees), so each tool call re-resolves. */
export interface CallerScope {
  terminalId: string
  worktreePath: string
  repoRoot: string
  isMain: boolean
}

export interface BrowserPerms {
  enabled: boolean
  mode: 'view' | 'full'
}

export interface ControlServerDeps {
  getRepoRoots: () => string[]
  getWorktreeBase: () => 'remote' | 'local'
  /** Default prompt used when an MCP `create_worktree` call provides
   * `prNumber` but no explicit `initialPrompt`. Resolved per-request so
   * Settings edits take effect mid-session. */
  getPrReviewPrompt: () => string
  broadcast: (channel: string, ...args: unknown[]) => void
  runWorktreeSetup: (ctx: { repoRoot: string; worktreePath: string; branch: string }) => Promise<void>
  /** Drive the full PR-creation FSM (fetch PR metadata, fetch refs/pull/<n>/head,
   * create the worktree, run setup, fire panes init + PR poller refresh) and
   * return the new worktree's path + branch. Host wires this to
   * `worktreesFSM.runPendingPR` plus a renderer focus broadcast. */
  runPendingPRWorktree: (params: {
    id: string
    repoRoot: string
    prNumber: number
    initialPrompt?: string
    agentKind?: AgentKind
    model?: string
  }) => Promise<{ ok: true; path: string; branch: string } | { ok: false; error: string }>
  /** Returns the caller's current scope, or null if the terminal is not
   * associated with any known worktree (e.g. the worktree was deleted). */
  resolveCallerScope: (terminalId: string) => CallerScope | null
  /** Whether the caller has a conversation transcript that can be forked
   * into a new worktree. For Chat tabs the terminal id IS the session id;
   * for terminal tabs it isn't, so this is how `forkConversation` gets
   * rejected before the worktree is created. */
  hasForkableTranscript: (sessionId: string, worktreePath: string) => boolean
  /** Whether conversation forking is enabled in settings. Re-read per request
   * so a toggle takes effect without restarting the bridge. */
  getConversationForkEnabled: () => boolean
  /** Copy the caller's own transcript into a parked fork — a jsonl on disk
   * with no tab and no subprocess. Returns how many more the conversation may
   * park, which the tool result passes back to the model so it can pace
   * itself instead of discovering the cap by being refused. */
  parkChatFork: (
    parentSessionId: string,
    worktreePath: string
  ) =>
    | { ok: true; forkSessionId: string; remaining: number }
    | { ok: false; error: string }
  /** Current browser-tool permissions. Re-read on every request so user
   * toggles take effect mid-session without restarting the bridge. */
  getBrowserPerms: () => BrowserPerms
  /** Alias + PR-derived sidebar grouping for one worktree. */
  getWorktreeStatus: (worktree: WorktreeInfo) => WorktreeStatusInfo
  browser: BrowserQueries
  shell: ShellQueries
  messaging: MessagingQueries
  /** Trim + 80-char clamp + dispatch. Matches the aliases:set IPC handler.
   * Empty-after-trim routes to clearAlias — never stores an empty alias. */
  setAlias: (worktreePath: string, alias: string) => void
  clearAlias: (worktreePath: string) => void
  /** Rename the branch a worktree has checked out, then resync the worktree
   *  list so the sidebar picks the new name up. The directory keeps its
   *  original name — see `renameWorktreeBranch`. */
  renameBranch: (
    worktreePath: string,
    newBranch: string
  ) => Promise<
    | { ok: true; oldBranch: string; branch: string; renamed: boolean }
    | { ok: false; error: string }
  >
}

const FULL_CONTROL_BROWSER_PATHS = new Set([
  '/browser/click',
  '/browser/type',
  '/browser/scroll',
  '/browser/cursor'
])

let serverInfo: { port: number; token: string } | null = null

export function getControlServerInfo(): { port: number; token: string } | null {
  return serverInfo
}

export function startControlServer(deps: ControlServerDeps): Promise<void> {
  return new Promise((resolve, reject) => {
    const token = randomBytes(32).toString('hex')

    const server = createServer((req, res) => {
      handleRequest(req, res, token, deps).catch((err) => {
        log('control', 'handler threw', err instanceof Error ? err.message : String(err))
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
        }
      })
    })

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') {
        serverInfo = { port: addr.port, token }
        log('control', `listening on 127.0.0.1:${addr.port}`)
        resolve()
      } else {
        reject(new Error('failed to bind control server'))
      }
    })
    server.on('error', (err) => {
      log('control', 'server error', err.message)
    })
  })
}

function resolveScope(
  req: IncomingMessage,
  deps: ControlServerDeps
): { scope: CallerScope | null; terminalId: string } {
  const terminalId = String(req.headers['x-harness-terminal-id'] || '')
  if (!terminalId) return { scope: null, terminalId: '' }
  return { scope: deps.resolveCallerScope(terminalId), terminalId }
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  deps: ControlServerDeps
): Promise<void> {
  const auth = req.headers.authorization
  if (auth !== 'Bearer ' + token) {
    res.writeHead(401)
    res.end('unauthorized')
    return
  }

  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const path = url.pathname

  if (req.method === 'GET' && path === '/health') {
    return sendJson(res, 200, { ok: true })
  }

  // list_repos is workspace-wide for every caller — read-only metadata that
  // helps agents understand the overall harness state.
  if (req.method === 'GET' && path === '/repos') {
    return sendJson(res, 200, { repoRoots: deps.getRepoRoots() })
  }

  // Worktree management tools are workspace-wide for every caller — a
  // feature-worktree session might spin off a new worktree for a related
  // idea, and listing siblings across repos is useful context. Runtime
  // tools (browser, future dev-servers) are the ones that need per-worktree
  // scoping, since those resources physically live inside a single worktree.
  if (req.method === 'GET' && path === '/worktrees') {
    const repoRoot = url.searchParams.get('repoRoot')
    const roots = repoRoot ? [repoRoot] : deps.getRepoRoots()
    const all: Array<WorktreeInfo & WorktreeStatusInfo> = []
    for (const r of roots) {
      try {
        for (const wt of await listWorktrees(r)) {
          all.push({ ...wt, ...deps.getWorktreeStatus(wt) })
        }
      } catch (e) {
        log('control', `list worktrees failed for ${r}`, e instanceof Error ? e.message : e)
      }
    }
    return sendJson(res, 200, all)
  }

  if (req.method === 'POST' && path === '/worktrees') {
    const body = await readJson(req)
    let repoRoot = typeof body.repoRoot === 'string' ? body.repoRoot : undefined
    if (!repoRoot) {
      // Prefer the caller's repo when we can infer it — a feature-worktree
      // agent "make a sibling worktree for idea X" reads most naturally
      // without having to pass repoRoot.
      const { scope } = resolveScope(req, deps)
      if (scope) {
        repoRoot = scope.repoRoot
      } else {
        const roots = deps.getRepoRoots()
        if (roots.length === 1) {
          repoRoot = roots[0]
        } else if (roots.length === 0) {
          return sendJson(res, 400, { error: 'no repos open in Ness' })
        } else {
          return sendJson(res, 400, {
            error: 'repoRoot required when multiple repos are open',
            repoRoots: roots
          })
        }
      }
    }

    const rawPrNumber = body.prNumber
    let prNumber: number | undefined
    if (rawPrNumber !== undefined && rawPrNumber !== null && rawPrNumber !== '') {
      const n = typeof rawPrNumber === 'number' ? rawPrNumber : Number(rawPrNumber)
      if (!Number.isInteger(n) || n <= 0) {
        return sendJson(res, 400, { error: 'prNumber must be a positive integer' })
      }
      prNumber = n
    }

    const branchName = String(body.branchName || '').trim()
    const rawInitialPrompt =
      typeof body.initialPrompt === 'string' ? body.initialPrompt : undefined
    const aliasInput = typeof body.alias === 'string' ? body.alias : undefined

    // Every prompt arriving here was written by an agent, so it gets the same
    // sentinel a worktree-to-worktree message does. Creation from the Ness
    // UI goes through IPC, not this route, and stays unwrapped — that one
    // really was typed by the human.
    const kickoffSender = resolveScope(req, deps).scope
    const initialPrompt = rawInitialPrompt
      ? wrapAutomatedMessage('worktree-kickoff', rawInitialPrompt, {
          from: kickoffSender
            ? deps.messaging.describe(kickoffSender.worktreePath)
            : undefined
        })
      : rawInitialPrompt

    const rawAgent = typeof body.agentKind === 'string' ? body.agentKind.trim().toLowerCase() : ''
    let agentKind: AgentKind | undefined
    if (rawAgent) {
      if (rawAgent !== 'claude' && rawAgent !== 'codex' && rawAgent !== 'cursor') {
        return sendJson(res, 400, { error: 'agentKind must be "claude", "codex", or "cursor"' })
      }
      agentKind = rawAgent
    }
    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined
    const baseBranch = typeof body.baseBranch === 'string' ? body.baseBranch : undefined

    // Forking is always self-scoped: the caller's own conversation, resolved
    // from its terminal id. Asking an agent to name a session id doesn't work
    // — it can't reliably observe its own, and a cross-worktree lookup would
    // need a session→worktree index for a use case nobody has asked for.
    let forkSource: { sessionId: string; worktreePath: string } | undefined
    if (body.forkConversation === true) {
      if (!deps.getConversationForkEnabled()) {
        return sendJson(res, 400, {
          error:
            'conversation forking is disabled in Ness settings. Retry without forkConversation and describe the task in initialPrompt instead.'
        })
      }
      if (agentKind !== undefined && !supportsConversationFork(agentKind)) {
        return sendJson(res, 400, {
          error: `forkConversation is not supported for ${agentDisplayName(agentKind)} worktrees — only Claude Code can resume a forked transcript. Retry without forkConversation and describe the task in initialPrompt instead.`
        })
      }
      if (prNumber !== undefined) {
        return sendJson(res, 400, {
          error:
            'forkConversation cannot be combined with prNumber — a PR review worktree starts from the PR author\'s work, not from your conversation'
        })
      }
      const { scope, terminalId } = resolveScope(req, deps)
      if (!scope || !deps.hasForkableTranscript(terminalId, scope.worktreePath)) {
        return sendJson(res, 400, {
          error:
            'forkConversation is only available from a Ness Chat tab that already has conversation history. Retry without forkConversation and describe the task in initialPrompt instead.'
        })
      }
      forkSource = { sessionId: terminalId, worktreePath: scope.worktreePath }
      // Pin rather than leave undefined: an omitted agentKind falls back to
      // the user's default agent, and a non-Claude default would drop the
      // forked session id on the floor at spawn time.
      agentKind = 'claude'
    }

    if (prNumber !== undefined) {
      if (branchName) {
        log('control', `prNumber=${prNumber} provided — ignoring branchName=${branchName}`)
      }
      // No explicit prompt → fall back to the configured review-prompt default,
      // which the human wrote in Settings and so stays unwrapped. Empty-string
      // prompts ('') are honored as "no prompt" so callers can opt out
      // explicitly.
      const promptForPR =
        rawInitialPrompt === undefined ? deps.getPrReviewPrompt() : initialPrompt
      const result = await deps.runPendingPRWorktree({
        id: randomUUID(),
        repoRoot,
        prNumber,
        initialPrompt: promptForPR || undefined,
        agentKind,
        model
      })
      if (!result.ok) {
        const status = /couldn't fetch pr|not found|404/i.test(result.error) ? 422 : 502
        return sendJson(res, status, { error: result.error })
      }
      if (aliasInput !== undefined) {
        deps.setAlias(result.path, aliasInput)
      }
      return sendJson(res, 200, { path: result.path, branch: result.branch })
    }

    if (!branchName) {
      return sendJson(res, 400, { error: 'branchName or prNumber required' })
    }
    const wtDir = defaultWorktreeDir(repoRoot)
    const mode = deps.getWorktreeBase()
    const created = await addWorktree(repoRoot, wtDir, branchName, {
      baseBranch,
      fetchRemote: !baseBranch && mode === 'remote'
    })
    // runWorktreeSetup runs its synchronous symlink step before the first
    // await, so the broadcast below can fire immediately and the Claude tab
    // spawned by ensureInitialized still sees shared settings.
    deps.runWorktreeSetup({ repoRoot, worktreePath: created.path, branch: created.branch })
      .catch((err) => log('control', `setup script failed: ${err instanceof Error ? err.message : String(err)}`))
    if (aliasInput !== undefined) {
      deps.setAlias(created.path, aliasInput)
    }
    deps.broadcast('worktrees:externalCreate', {
      repoRoot,
      worktree: created,
      initialPrompt,
      agentKind,
      model,
      forkSource,
      baseRef: baseBranch
    })
    return sendJson(res, 200, created)
  }

  // fork_chat — the caller forking ITSELF, mid-answer, over a tangent it
  // found rather than one the user asked about. Same self-scoping rule as
  // forkConversation: the session comes from the terminal id, never from an
  // argument. Unlike create_worktree this stays in the caller's worktree, so
  // there is no branch, no relocation preamble, and nothing running until the
  // user opens it.
  if (req.method === 'POST' && path === '/forks') {
    const body = await readJson(req)
    const topic = String(body.topic || '').trim()
    const prompt = String(body.prompt || '').trim()
    if (!topic) return sendJson(res, 400, { error: 'topic is required' })
    if (!prompt) return sendJson(res, 400, { error: 'prompt is required' })
    if (!deps.getConversationForkEnabled()) {
      return sendJson(res, 400, {
        error:
          'conversation forking is disabled in Ness settings. Mention what you noticed in your answer instead.'
      })
    }
    const { scope, terminalId } = resolveScope(req, deps)
    if (!scope || !deps.hasForkableTranscript(terminalId, scope.worktreePath)) {
      return sendJson(res, 400, {
        error:
          'fork_chat is only available from a Ness Chat tab that already has conversation history. Mention what you noticed in your answer instead.'
      })
    }
    const parked = deps.parkChatFork(terminalId, scope.worktreePath)
    if (!parked.ok) return sendJson(res, 409, { error: parked.error })
    log('control', `fork_chat parked ${parked.forkSessionId} topic="${topic}"`)
    return sendJson(res, 200, {
      forkSessionId: parked.forkSessionId,
      message: formatForkResult({
        forkSessionId: parked.forkSessionId,
        topic,
        remaining: parked.remaining
      })
    })
  }

  // rename_worktree — the git-level counterpart to /aliases. Renames the
  // branch and/or sets the display alias in one call, because the auto-naming
  // flow (a worktree created from just a kickoff prompt) always wants both.
  if (req.method === 'POST' && path === '/worktrees/rename') {
    const body = await readJson(req)
    let worktreePath =
      typeof body.worktreePath === 'string' ? body.worktreePath.trim() : ''
    if (!worktreePath) {
      const { scope } = resolveScope(req, deps)
      if (scope) worktreePath = scope.worktreePath
    }
    if (!worktreePath) {
      return sendJson(res, 400, {
        error: 'worktreePath required when caller is not scoped to a worktree'
      })
    }

    const requestedBranch =
      typeof body.branchName === 'string' ? body.branchName.trim() : ''
    const aliasInput = typeof body.alias === 'string' ? body.alias : undefined
    if (!requestedBranch && aliasInput === undefined) {
      return sendJson(res, 400, { error: 'branchName or alias required' })
    }

    let branch: string | undefined
    let oldBranch: string | undefined
    let renamed = false
    if (requestedBranch) {
      // Reject rather than silently sanitize: an agent that asked for
      // `fix/the thing` should learn what it actually gets, not discover a
      // differently-named branch three commits later.
      if (
        sanitizeBranchInput(requestedBranch) !== requestedBranch ||
        !isValidBranchName(requestedBranch)
      ) {
        return sendJson(res, 400, {
          error: `"${requestedBranch}" is not a valid git branch name — use kebab-case with no spaces (slashes are fine)`
        })
      }
      const result = await deps.renameBranch(worktreePath, requestedBranch)
      if (!result.ok) return sendJson(res, 409, { error: result.error })
      branch = result.branch
      oldBranch = result.oldBranch
      renamed = result.renamed
    }

    let alias: string | undefined
    if (aliasInput !== undefined) {
      deps.setAlias(worktreePath, aliasInput)
      alias = normalizeAlias(aliasInput) ?? ''
    }
    return sendJson(res, 200, { worktreePath, branch, oldBranch, renamed, alias })
  }

  if ((req.method === 'POST' || req.method === 'DELETE') && path === '/aliases') {
    const body = await readJson(req)
    let worktreePath =
      typeof body.worktreePath === 'string' ? body.worktreePath : undefined
    if (!worktreePath) {
      // Default to caller's current worktree — matches how create_worktree
      // resolves repoRoot from scope, so an agent inside a worktree can
      // alias itself without knowing its own absolute path.
      const { scope } = resolveScope(req, deps)
      if (scope) worktreePath = scope.worktreePath
    }
    if (!worktreePath) {
      return sendJson(res, 400, {
        error: 'worktreePath required when caller is not scoped to a worktree'
      })
    }
    if (req.method === 'DELETE') {
      deps.clearAlias(worktreePath)
      return sendJson(res, 200, { worktreePath, cleared: true })
    }
    const submitted = typeof body.alias === 'string' ? body.alias : ''
    const stored = normalizeAlias(submitted)
    deps.setAlias(worktreePath, submitted)
    // Surface silent clamping so the agent can decide whether to re-prompt
    // the user. `clamped: true` when the caller's input differed from what
    // actually got stored (whitespace normalization or length cap).
    const clamped = submitted !== (stored ?? '')
    return sendJson(res, 200, {
      worktreePath,
      alias: stored ?? '',
      cleared: stored === null,
      clamped
    })
  }

  // Browser MCP endpoints. Every call is scoped to the caller's worktree
  // regardless of whether the caller is main or a feature worktree —
  // runtime things (tabs, dev servers) live physically inside one worktree
  // and shouldn't be reachable across boundaries.
  if (path.startsWith('/browser/')) {
    const { scope, terminalId } = resolveScope(req, deps)
    if (!terminalId) {
      return sendJson(res, 400, { error: 'X-Harness-Terminal-Id header required' })
    }
    if (!scope) {
      return sendJson(res, 404, {
        error: 'caller terminal is not associated with a worktree'
      })
    }
    const perms = deps.getBrowserPerms()
    if (!perms.enabled) {
      return sendJson(res, 403, {
        error: 'browser tools are disabled in Ness settings'
      })
    }
    if (perms.mode === 'view' && FULL_CONTROL_BROWSER_PATHS.has(path)) {
      return sendJson(res, 403, {
        error:
          'browser tools are set to View Only in Ness settings — click/type/scroll/cursor are unavailable'
      })
    }
    const callerWorktree = scope.worktreePath

    const assertSameWorktree = (tabId: string): string | null => {
      const wt = deps.browser.getTabWorktree(tabId)
      if (!wt) return 'tab not found'
      if (wt !== callerWorktree) {
        return (
          `cross-worktree access denied: this session is scoped to worktree ${callerWorktree}. ` +
          `Use list_browser_tabs() to see accessible tabs.`
        )
      }
      return null
    }

    if (req.method === 'GET' && path === '/browser/tabs') {
      return sendJson(res, 200, {
        tabs: deps.browser.listTabsForWorktree(callerWorktree)
      })
    }
    if (req.method === 'POST' && path === '/browser/tabs') {
      const body = await readJson(req)
      const url = typeof body.url === 'string' ? body.url : ''
      const created = deps.browser.createTab(callerWorktree, url)
      return sendJson(res, 200, created)
    }

    // Write endpoints read tabId from the JSON body; read endpoints take it
    // as a query param so they can stay GET.
    const body = req.method === 'POST' ? await readJson(req) : {}
    const tabId = String(
      (body.tabId as string | undefined) ?? url.searchParams.get('tabId') ?? ''
    )
    if (!tabId) {
      return sendJson(res, 400, { error: 'tabId required' })
    }
    const bad = assertSameWorktree(tabId)
    if (bad) return sendJson(res, 403, { error: bad })

    if (req.method === 'GET' && path === '/browser/url') {
      return sendJson(res, 200, { url: deps.browser.getTabUrl(tabId) })
    }
    if (req.method === 'GET' && path === '/browser/console') {
      return sendJson(res, 200, { logs: deps.browser.getTabConsoleLogs(tabId) })
    }
    if (req.method === 'GET' && path === '/browser/screenshot') {
      const fmtParam = url.searchParams.get('format')
      const format: 'jpeg' | 'png' = fmtParam === 'png' ? 'png' : 'jpeg'
      const qParam = url.searchParams.get('quality')
      const quality = qParam ? parseInt(qParam, 10) : undefined
      const result = await deps.browser.screenshotTab(tabId, { format, quality })
      // An empty image used to come back as HTTP 200 with `data: ''`, which
      // the bridge reported as a bare "screenshot failed" and nothing logged.
      if (!result?.data) {
        return sendJson(res, 500, {
          error: result?.error ?? 'capture failed: tab is no longer available'
        })
      }
      return sendJson(res, 200, {
        data: result.data,
        format: result.format,
        mimeType: result.format === 'png' ? 'image/png' : 'image/jpeg',
        // Kept for older MCP bridge versions. New bridges read `data`+`format`.
        pngBase64: result.format === 'png' ? result.data : undefined
      })
    }
    if (req.method === 'GET' && path === '/browser/dom') {
      const dom = await deps.browser.getTabDom(tabId)
      return sendJson(res, dom != null ? 200 : 500, {
        html: dom,
        error: dom != null ? undefined : 'dom read failed'
      })
    }
    if (req.method === 'GET' && path === '/browser/clickables') {
      const data = await deps.browser.getTabClickables(tabId)
      return sendJson(res, data != null ? 200 : 500, {
        snapshot: data,
        error: data != null ? undefined : 'clickables read failed'
      })
    }
    if (req.method === 'POST' && path === '/browser/navigate') {
      const nextUrl = String(body.url || '').trim()
      if (!nextUrl) return sendJson(res, 400, { error: 'url required' })
      deps.browser.navigateTab(tabId, nextUrl)
      return sendJson(res, 200, { ok: true })
    }
    if (req.method === 'POST' && path === '/browser/back') {
      deps.browser.backTab(tabId)
      return sendJson(res, 200, { ok: true })
    }
    if (req.method === 'POST' && path === '/browser/forward') {
      deps.browser.forwardTab(tabId)
      return sendJson(res, 200, { ok: true })
    }
    if (req.method === 'POST' && path === '/browser/reload') {
      deps.browser.reloadTab(tabId)
      return sendJson(res, 200, { ok: true })
    }
    if (req.method === 'POST' && path === '/browser/click') {
      const x = Number(body.x)
      const y = Number(body.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return sendJson(res, 400, { error: 'x and y (numbers) required' })
      }
      const button = body.button === 'right' || body.button === 'middle' ? body.button : 'left'
      const rawCount = Number(body.clickCount)
      const clickCount = Number.isFinite(rawCount)
        ? Math.max(1, Math.min(3, Math.floor(rawCount)))
        : 1
      deps.browser.clickTab(tabId, x, y, { button, clickCount })
      return sendJson(res, 200, { ok: true })
    }
    if (req.method === 'POST' && path === '/browser/type') {
      const text = typeof body.text === 'string' ? body.text : ''
      const key = typeof body.key === 'string' ? body.key : undefined
      if (!text && !key) {
        return sendJson(res, 400, { error: 'text or key required' })
      }
      deps.browser.typeTab(tabId, text, key)
      return sendJson(res, 200, { ok: true })
    }
    if (req.method === 'POST' && path === '/browser/scroll') {
      const dx = Number(body.deltaX) || 0
      const dy = Number(body.deltaY) || 0
      await deps.browser.scrollTab(tabId, dx, dy)
      return sendJson(res, 200, { ok: true })
    }
    if (req.method === 'POST' && path === '/browser/cursor') {
      const x = Number(body.x)
      const y = Number(body.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return sendJson(res, 400, { error: 'x and y (numbers) required' })
      }
      await deps.browser.showCursor(tabId, x, y)
      return sendJson(res, 200, { ok: true })
    }

    res.writeHead(404)
    res.end('browser endpoint not found')
    return
  }

  // Shell MCP endpoints. Same worktree-scoping model as /browser/*: agents
  // can spawn shells, read their output, and kill them, but only within
  // their own worktree. Reading another worktree's logs is explicitly
  // denied.
  if (path.startsWith('/shells')) {
    const { scope, terminalId } = resolveScope(req, deps)
    if (!terminalId) {
      return sendJson(res, 400, { error: 'X-Harness-Terminal-Id header required' })
    }
    if (!scope) {
      return sendJson(res, 404, {
        error: 'caller terminal is not associated with a worktree'
      })
    }
    const callerWorktree = scope.worktreePath

    const assertSameWorktree = (shellId: string): string | null => {
      const wt = deps.shell.getShellWorktree(shellId)
      if (!wt) return 'shell not found'
      if (wt !== callerWorktree) {
        return (
          `cross-worktree access denied: this session is scoped to worktree ${callerWorktree}. ` +
          `Use list_shells() to see accessible shells.`
        )
      }
      return null
    }

    if (req.method === 'GET' && path === '/shells') {
      return sendJson(res, 200, {
        shells: deps.shell.listShellsForWorktree(callerWorktree)
      })
    }
    if (req.method === 'POST' && path === '/shells') {
      const body = await readJson(req)
      const command = typeof body.command === 'string' ? body.command.trim() : ''
      const cwd = typeof body.cwd === 'string' ? body.cwd.trim() : ''
      const label = typeof body.label === 'string' ? body.label.trim() : ''
      const created = deps.shell.createShell(callerWorktree, {
        command: command || undefined,
        cwd: cwd || undefined,
        label: label || undefined
      })
      return sendJson(res, 200, created)
    }

    // Remaining routes take a shell_id from body (POST) or query (GET).
    const body = req.method === 'POST' ? await readJson(req) : {}
    const shellId = String(
      (body.shellId as string | undefined) ?? url.searchParams.get('shellId') ?? ''
    )
    if (!shellId) {
      return sendJson(res, 400, { error: 'shellId required' })
    }
    const bad = assertSameWorktree(shellId)
    if (bad) return sendJson(res, 403, { error: bad })

    if (req.method === 'GET' && path === '/shells/output') {
      const linesParam = url.searchParams.get('lines')
      const lines = linesParam
        ? Math.max(1, Math.min(5000, parseInt(linesParam, 10) || 200))
        : 200
      const match = url.searchParams.get('match') || undefined
      const contextParam = url.searchParams.get('context')
      const context = contextParam
        ? Math.max(0, Math.min(20, parseInt(contextParam, 10) || 0))
        : 0
      const result = deps.shell.readShellOutput(shellId, { lines, match, context })
      if (result.error) return sendJson(res, 400, { error: result.error })
      return sendJson(res, 200, result)
    }
    if (req.method === 'POST' && path === '/shells/kill') {
      deps.shell.killShell(shellId)
      return sendJson(res, 200, { ok: true })
    }

    res.writeHead(404)
    res.end('shell endpoint not found')
    return
  }

  // send_message — deliver a message into another worktree's agent chat.
  // Unlike the browser/shell tools this deliberately crosses the worktree
  // boundary; that's the entire feature. What does NOT cross is sender
  // identity: `from` comes from the caller's resolved scope, never from the
  // body, so an agent can't claim to be someone else.
  if (req.method === 'POST' && path === '/messages') {
    if (!deps.messaging.isEnabled()) {
      return sendJson(res, 403, {
        error:
          'worktree messaging is disabled in Ness settings (Settings → Experimental → Worktree messaging)'
      })
    }
    const { scope, terminalId } = resolveScope(req, deps)
    if (!terminalId) {
      return sendJson(res, 400, { error: 'X-Harness-Terminal-Id header required' })
    }
    if (!scope) {
      return sendJson(res, 404, {
        error: 'caller terminal is not associated with a worktree'
      })
    }
    const body = await readJson(req)
    const target = typeof body.worktree === 'string' ? body.worktree.trim() : ''
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    if (!target) return sendJson(res, 400, { error: 'worktree required' })
    if (!message) return sendJson(res, 400, { error: 'message required' })

    const resolved = deps.messaging.resolveTarget(target)
    if ('error' in resolved) return sendJson(res, 404, { error: resolved.error })
    if (resolved.path === scope.worktreePath) {
      return sendJson(res, 400, {
        error: 'cannot send a message to your own worktree'
      })
    }

    const from = deps.messaging.describe(scope.worktreePath)
    const result = deps.messaging.send(
      resolved.path,
      wrapAutomatedMessage('worktree-message', message, { from })
    )
    if (!result.ok) {
      // Nothing is queued for later — say so plainly so the caller can decide
      // whether to retry, open a chat tab, or just tell the user.
      const error =
        result.reason === 'no-chat-tab'
          ? `worktree ${resolved.path} has no agent chat tab to deliver to — the message was not sent`
          : `failed to wake the agent chat in ${resolved.path} — the message was not sent`
      return sendJson(res, 409, { error })
    }
    log('control', `message ${scope.worktreePath} -> ${resolved.path} (woke=${result.woke})`)
    return sendJson(res, 200, {
      delivered: true,
      worktreePath: resolved.path,
      from,
      woke: result.woke
    })
  }

  // /scope — returns the caller's current scope. The MCP bridge calls this
  // once at startup so it can adapt tool descriptions (e.g. signalling
  // "create_worktree defaults to this repo" for feature callers) and filter
  // out browser tools when the user has them disabled or restricted.
  if (req.method === 'GET' && path === '/scope') {
    const { scope, terminalId } = resolveScope(req, deps)
    if (!terminalId) {
      return sendJson(res, 400, { error: 'X-Harness-Terminal-Id header required' })
    }
    return sendJson(res, 200, {
      scope,
      browser: deps.getBrowserPerms(),
      conversationFork: { enabled: deps.getConversationForkEnabled() },
      messaging: { enabled: deps.messaging.isEnabled() }
    })
  }

  res.writeHead(404)
  res.end('not found')
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}
