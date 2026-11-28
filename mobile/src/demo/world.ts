// The demo backend: an in-memory stand-in for main. Holds an AppState that
// only ever changes by dispatching real events through the shared
// rootReducer (and emitting them, as main's store does), answers requests
// from a handler table, and plays the scripted chat turns and fake shells.
//
// Loaded lazily by DemoTransport, so none of the fixtures are evaluated
// unless the demo is on.
import { rootReducer, type AppState, type StateEvent } from '../../../src/shared/state'
import { getLeaves, mapLeaves, type PaneNode, type PtyStatus, type TerminalTab } from '../../../src/shared/state/terminals'
import { isJsonClaudePermissionMode, parseUserTurn, type JsonClaudePendingApproval } from '../../../src/shared/state/json-claude'
import type { RepoConfig } from '../../../src/shared/state/repo-configs'
import type { ToolRunResult, ToolSpec } from '../../../src/shared/tools'
import { listChatTabs } from '../../../src/shared/agent-tabs'
import { formatReviewSubmission } from '../../../src/shared/review-format'
import { snippetAt, splitLines } from '../../../src/shared/review-anchor'
import { wrapAutomatedMessage } from '../../../src/shared/state/json-claude'
import type { ReviewComment, ReviewCommentStatus, ReviewSide, ReviewVerdict } from '../../../src/shared/state/reviews'
import { DemoGit } from './git'
import { buildDemoState } from './fixture'
import { TAB, UNITS_REQUEST_ID } from './conversations'
import { approveSteps, darkFinishSteps, denySteps, replySteps, type Step } from './scripts'
import { DemoShell } from './shell'
import { WORKTREES, REPO } from './project'
import { DEMO_CLIENT_ID, DEMO_NOTICE_SIGNAL, DEMO_UNAVAILABLE } from './constants'

export class DemoUnavailableError extends Error {
  constructor(readonly channel: string) {
    super(DEMO_UNAVAILABLE)
  }
}

type Handler = (...args: never[]) => unknown

export interface DemoTheme {
  mode: 'light' | 'dark' | 'system'
  light: string
  dark: string
}

export interface WorldHooks {
  /** Carried over from a previous demo (Reset keeps the user's theme). */
  theme?: DemoTheme
  emitEvent(event: StateEvent, seq: number): void
  emitSignal(name: string, ...args: unknown[]): void
  now?: () => number
  /** Injected for tests; defaults to setTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void
}

const unavailable = { ok: false, error: DEMO_UNAVAILABLE } as const

interface Job {
  make: () => Step[]
  /** Runs even while an approval is pending (the approval's own outcome). */
  force?: boolean
}

export class DemoWorld {
  state: AppState
  seq = 0
  readonly git: DemoGit
  private readonly now: () => number
  private readonly schedule: (fn: () => void, ms: number) => () => void
  private shells = new Map<string, DemoShell>()
  private history = new Map<string, string>()
  private queues = new Map<string, Job[]>()
  /** Cancels the job a session is playing; present while it plays. */
  private playing = new Map<string, () => void>()
  private lastStatus = new Map<string, string>()
  private replies = new Map<string, number>()
  private darkFinished = false
  private closed = false
  readonly handlers: Record<string, Handler>
  readonly signals: Record<string, Handler>

  constructor(private readonly hooks: WorldHooks) {
    this.now = hooks.now ?? Date.now
    this.schedule =
      hooks.schedule ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms)
        return () => clearTimeout(t)
      })
    const start = this.now()
    this.git = new DemoGit(start)
    this.state = buildDemoState(start, this.git)
    const theme = hooks.theme
    if (theme) {
      const events: StateEvent[] = [
        { type: 'settings/themeModeChanged', payload: theme.mode },
        { type: 'settings/themeLightChanged', payload: theme.light },
        { type: 'settings/themeDarkChanged', payload: theme.dark }
      ]
      this.state = events.reduce(rootReducer, this.state)
    }
    // The dark-mode turn is already running when the demo opens.
    this.playing.set(TAB.darkChat, () => {})
    for (const id of Object.keys(this.state.jsonClaude.sessions)) {
      const d = this.derive(id)
      if (d) this.lastStatus.set(id, d.key)
    }
    this.handlers = this.buildHandlers()
    this.signals = this.buildSignals()
  }

  close(): void {
    this.closed = true
    for (const cancel of this.playing.values()) cancel()
    this.playing.clear()
  }

  dispatch(event: StateEvent): void {
    if (this.closed) return
    this.state = rootReducer(this.state, event)
    this.seq++
    this.hooks.emitEvent(event, this.seq)
    if (event.type.startsWith('jsonClaude/')) this.deriveStatuses(event)
  }

  private notice(): void {
    this.hooks.emitSignal(DEMO_NOTICE_SIGNAL, DEMO_UNAVAILABLE)
  }

  // ── status: same mapping as main's JsonClaudeStatusDeriver ───────────

  private deriveStatuses(event: StateEvent): void {
    const p = (event as { payload?: { sessionId?: unknown } }).payload
    const ids = typeof p?.sessionId === 'string' ? [p.sessionId] : Object.keys(this.state.jsonClaude.sessions)
    for (const id of ids) {
      const derived = this.derive(id)
      if (!derived || this.lastStatus.get(id) === derived.key) continue
      this.lastStatus.set(id, derived.key)
      this.dispatch({ type: 'terminals/statusChanged', payload: { id, status: derived.status, pendingTool: derived.pendingTool } })
    }
  }

  private derive(id: string) {
    const session = this.state.jsonClaude.sessions[id]
    if (!session) return null
    const approval = this.pendingFor(id)
    const status: PtyStatus = approval ? 'needs-approval' : session.busy ? 'processing' : 'waiting'
    return {
      status,
      key: `${status}:${approval?.requestId ?? ''}`,
      pendingTool: approval ? { name: approval.toolName, input: approval.input } : null
    }
  }

  // ── scripted turns ───────────────────────────────────────────────────

  private pendingFor(sessionId: string): JsonClaudePendingApproval | undefined {
    return Object.values(this.state.jsonClaude.pendingApprovals).find((a) => a.sessionId === sessionId)
  }

  private enqueue(sessionId: string, job: Job): void {
    const q = this.queues.get(sessionId) ?? []
    if (job.force) q.unshift(job)
    else q.push(job)
    this.queues.set(sessionId, q)
    this.pump(sessionId)
  }

  private pump(sessionId: string): void {
    if (this.closed || this.playing.has(sessionId)) return
    const q = this.queues.get(sessionId) ?? []
    const job = q[0]
    if (!job || (!job.force && this.pendingFor(sessionId))) return
    q.shift()
    this.play(sessionId, job.make())
  }

  private play(sessionId: string, steps: Step[]): void {
    let i = 0
    let cancel: () => void = () => {}
    const finish = () => {
      this.playing.delete(sessionId)
      this.pump(sessionId)
    }
    const run = () => {
      if (this.closed) return
      // Steps with no delay land together, like a coalesced frame.
      do {
        const step = steps[i++]
        if (step.write) this.applyWrite(step.write)
        for (const e of step.events) this.dispatch(e)
      } while (i < steps.length && steps[i].delay === 0)
      if (i >= steps.length) finish()
      else cancel = this.schedule(run, steps[i].delay)
    }
    this.playing.set(sessionId, () => cancel())
    if (steps.length === 0) finish()
    else cancel = this.schedule(run, steps[0].delay)
  }

  private applyWrite(w: NonNullable<Step['write']>): void {
    this.git.writeWork(w.worktreePath, w.file, w.contents)
    this.hooks.emitSignal('worktree:changedFilesInvalidated', w.worktreePath)
    this.hooks.emitSignal('file:contentChanged', w.worktreePath, w.file)
  }

  /** Stop the session's turn: finalize a half-streamed message, clear busy. */
  private interrupt(sessionId: string): void {
    const cancel = this.playing.get(sessionId)
    if (!cancel) return
    cancel()
    this.playing.delete(sessionId)
    if (sessionId === TAB.darkChat) this.darkFinished = true
    const session = this.state.jsonClaude.sessions[sessionId]
    const partial = session?.entries.findLast((e) => e.isPartial)
    if (partial) {
      this.dispatch({ type: 'jsonClaude/assistantEntryFinalized', payload: { sessionId, entryId: partial.entryId, blocks: partial.blocks ?? [] } })
    }
    if (session?.busy) this.dispatch({ type: 'jsonClaude/busyChanged', payload: { sessionId, busy: false } })
    this.pump(sessionId)
  }

  private send(sessionId: string, text: string): void {
    const session = this.state.jsonClaude.sessions[sessionId]
    if (!session || !text.trim()) return
    const turn = this.replies.get(sessionId) ?? 0
    this.replies.set(sessionId, turn + 1)
    const waits = this.playing.has(sessionId) || !!this.pendingFor(sessionId)
    if (!waits) {
      this.enqueue(sessionId, { make: () => replySteps(sessionId, text, turn, this.now) })
      return
    }
    // Typed mid-turn: shown queued now, delivered when the turn ends.
    const entryId = `${sessionId}-q${this.now().toString(36)}${turn}`
    this.dispatch({ type: 'jsonClaude/entryAppended', payload: { sessionId, entry: { entryId, kind: 'user', ...parseUserTurn(text), timestamp: this.now(), isQueued: true } } })
    this.enqueue(sessionId, {
      make: () => {
        const steps = replySteps(sessionId, text, turn, this.now)
        // The entry is already there; unqueue it instead of adding another.
        steps[0] = { ...steps[0], events: [{ type: 'jsonClaude/userEntriesUnqueued', payload: { sessionId } }, ...steps[0].events.slice(1)] }
        return steps
      }
    })
  }

  // ── panes ────────────────────────────────────────────────────────────

  private setPanes(wt: string, fn: (tree: PaneNode) => PaneNode): boolean {
    const tree = this.state.terminals.panes[wt]
    if (!tree) return false
    const next = fn(tree)
    if (next !== tree) this.dispatch({ type: 'terminals/panesForWorktreeChanged', payload: { worktreePath: wt, panes: next } })
    return true
  }

  private addTab(wt: string, tab: TerminalTab, paneId?: string): boolean {
    const tree = this.state.terminals.panes[wt]
    if (!tree) return false
    const target = (paneId && getLeaves(tree).find((l) => l.id === paneId)) || getLeaves(tree)[0]
    return this.setPanes(wt, (t) =>
      mapLeaves(t, (l) => {
        if (l.id !== target.id) return l
        const exists = l.tabs.some((x) => x.id === tab.id)
        return { ...l, tabs: exists ? l.tabs : [...l.tabs, tab], activeTabId: tab.id }
      })
    )
  }

  private closeTab(wt: string, tabId: string): boolean {
    return this.setPanes(wt, (t) =>
      mapLeaves(t, (l) => {
        const i = l.tabs.findIndex((x) => x.id === tabId)
        if (i === -1) return l
        const tabs = [...l.tabs.slice(0, i), ...l.tabs.slice(i + 1)]
        const activeTabId = l.activeTabId === tabId ? (tabs[Math.max(0, i - 1)]?.id ?? '') : l.activeTabId
        return { ...l, tabs, activeTabId }
      })
    )
  }

  private startChat(sessionId: string, worktreePath: string): boolean {
    if (this.state.jsonClaude.sessions[sessionId]) return true
    this.dispatch({ type: 'jsonClaude/sessionStarted', payload: { sessionId, worktreePath } })
    this.dispatch({ type: 'jsonClaude/sessionStateChanged', payload: { sessionId, state: 'running' } })
    this.dispatch({ type: 'jsonClaude/currentModelChanged', payload: { sessionId, model: this.state.settings.claudeModel ?? 'claude-opus-5-5' } })
    this.dispatch({ type: 'jsonClaude/entriesSeeded', payload: { sessionId, entries: [] } })
    return true
  }

  // ── terminals ────────────────────────────────────────────────────────

  private worktreeOf(terminalId: string, cwd?: string): (typeof WORKTREES)[number] {
    const byTab = Object.entries(this.state.terminals.panes).find(([, tree]) => getLeaves(tree).some((l) => l.tabs.some((t) => t.id === terminalId)))
    const path = byTab?.[0] ?? cwd
    return WORKTREES.find((w) => w.path === path) ?? WORKTREES[0]
  }

  private out(id: string, data: string): void {
    if (!data) return
    const prev = this.history.get(id) ?? ''
    // Same idea as main's scrollback cap, much smaller.
    this.history.set(id, (prev + data).slice(-64_000))
    this.hooks.emitSignal('terminal:data', id, data)
  }

  private createPty(id: string, cwd: string, agentKind?: string, cols?: number): void {
    const existing = this.shells.get(id)
    if (existing) {
      if (cols) existing.resize(cols)
      return
    }
    const wt = this.worktreeOf(id, cwd)
    const shell = new DemoShell({ cwd: wt.path, branch: wt.branch, git: this.git, cols })
    this.shells.set(id, shell)
    const note = agentKind ? `\x1b[33mClaude Code in a terminal isn't part of the demo; the Chat tabs show what it does.\x1b[0m\r\n` : ''
    this.out(id, note + shell.start())
  }

  // ── reviews: review-comments.ts and review-service.ts, in memory ─────

  private reviewId = 0

  private addReviewComment(
    wt: string,
    input: { filePath: string; line: number; side: ReviewSide; body: string; view?: { fromCommit?: string; toCommit?: string } }
  ): ReviewComment | { error: string } {
    const body = typeof input?.body === 'string' ? input.body.trim() : ''
    if (!body) return { error: 'Comment body is empty' }
    if (input.side !== 'new') return { error: DEMO_UNAVAILABLE }
    const sha = input.view?.toCommit ?? this.git.headSha(wt)
    const content = this.git.fileAt(wt, sha, input.filePath)
    if (content === undefined) return { error: `${input.filePath} does not exist at ${sha.slice(0, 7)} (new side)` }
    const snippet = snippetAt(splitLines(content), input.line)
    if (snippet === null) return { error: `line ${input.line} is out of range` }
    const comment: ReviewComment = {
      id: `demo-rc-${this.now().toString(36)}-${this.reviewId++}`,
      filePath: input.filePath,
      side: 'new',
      line: input.line,
      anchoredSha: sha,
      anchor: { commitSha: sha, line: input.line, snippet },
      author: { kind: 'human' },
      status: 'open',
      body,
      createdAt: this.now()
    }
    this.dispatch({ type: 'reviews/commentAdded', payload: { worktreePath: wt, comment } })
    return comment
  }

  /** sendReviewSubmission: delivered to the author's chat, which answers
   *  with one of its scripted replies. */
  private sendReview(wt: string, id: string, targetTabId?: string): { ok: true; tabId: string; woke: boolean } | { ok: false; error: string } {
    const review = this.state.reviews.byPath[wt]
    const submission = review?.submissions?.find((x) => x.id === id)
    if (!submission) return { ok: false, error: 'Review not found' }
    const reviewer = submission.author.kind === 'agent' ? submission.author.tabId : null
    const target = targetTabId || submission.targetTabId || listChatTabs(this.state, wt).find((t) => t.id !== reviewer && !t.reviewOf)?.id
    const record = (ok: boolean, error?: string) =>
      this.dispatch({ type: 'reviews/submissionDelivered', payload: { worktreePath: wt, id, state: ok ? 'sent' : 'failed', targetTabId: target ?? null, at: this.now(), error } })
    if (!target || !this.state.jsonClaude.sessions[target]) {
      record(false, 'No other Chat tab in this worktree to send it to')
      return { ok: false, error: 'No other Chat tab in this worktree to send it to' }
    }
    if (target === reviewer) {
      record(false, "A review can't be sent to the tab that wrote it")
      return { ok: false, error: "A review can't be sent to the tab that wrote it" }
    }
    const message = wrapAutomatedMessage('review', formatReviewSubmission(submission, review?.comments ?? []), {
      from: submission.author.kind === 'agent' ? submission.author.label : undefined
    })
    this.send(target, message)
    record(true)
    return { ok: true, tabId: target, woke: false }
  }

  private openReviewTab(wt: string): boolean {
    const tree = this.state.terminals.panes[wt]
    if (!tree) return false
    for (const l of getLeaves(tree)) {
      const existing = l.tabs.find((t) => t.type === 'review')
      if (existing) return this.setPanes(wt, (t) => mapLeaves(t, (x) => (x.id === l.id && x.activeTabId !== existing.id ? { ...x, activeTabId: existing.id } : x)))
    }
    return this.addTab(wt, { id: `review-${wt.replace(/[^a-zA-Z0-9]/g, '-')}-${this.now()}`, type: 'review', label: 'Review' })
  }

  // ── tables ───────────────────────────────────────────────────────────

  private buildHandlers(): Record<string, Handler> {
    const ok = () => true
    const git = this.git
    const tools: ToolSpec[] = [{ id: 'lighthouse', title: 'Lighthouse', script: 'run.sh', dir: `${REPO}/.ness/tools/lighthouse`, refresh: 'manual' }]
    const refreshPrs = () => {
      this.dispatch({ type: 'prs/loadingChanged', payload: true })
      this.schedule(() => this.dispatch({ type: 'prs/loadingChanged', payload: false }), 700)
      return true
    }
    const h: Record<string, Handler> = {
      'transport:getClientId': () => DEMO_CLIENT_ID,

      'worktrees:refreshList': ok,
      'worktrees:dismissPending': ok,
      'prs:refreshAll': refreshPrs,
      'prs:refreshAllIfStale': ok,
      'prs:refreshOne': ok,
      'prs:refreshOneIfStale': ok,
      'settings:hasGithubToken': ok,

      'worktree:changedFiles': (wt: string, mode?: 'working' | 'branch') => git.changedFiles(wt, mode),
      'worktree:fileDiffSides': (wt: string, file: string, staged: boolean, mode?: 'working' | 'branch') => git.diffSides(wt, file, staged, mode),
      'worktree:branchCommits': (wt: string) => git.branchCommits(wt),
      'worktree:recentCommitShas': (wt: string) => git.branchCommits(wt).map((c) => c.hash),
      'worktree:commitMeta': (wt: string, hash: string) => git.commitMeta(wt, hash),
      'worktree:commitDiff': (wt: string, hash: string) => git.commitDiff(wt, hash),
      'worktree:commitChangedFiles': (wt: string, hash: string) => git.commitChangedFiles(wt, hash),
      'worktree:commitFileDiffSides': (wt: string, hash: string, file: string) => git.commitFileSides(wt, hash, file),
      'worktree:commitRangeChangedFiles': (wt: string, from: string, to: string) => git.commitRangeChangedFiles(wt, from, to),
      'worktree:commitRangeFileDiffSides': (wt: string, from: string, to: string, file: string) => git.commitRangeFileSides(wt, from, to, file),
      'worktree:listFiles': (wt: string) => git.listFiles(wt),
      'worktree:readFile': (wt: string, file: string) => {
        const content = git.readFile(wt, file)
        return content === undefined
          ? { content: null, size: 0, binary: false, truncated: false, error: 'File not found' }
          : { content, size: content.length, binary: false, truncated: false }
      },
      'worktree:readFileBinary': () => unavailable,

      'tools:list': () => tools,
      'tools:run': (): ToolRunResult => ({
        ok: true,
        markdown:
          '**Preview build** · mobile\n\n| Category | Score |\n|---|---|\n| Performance | 🟢 97 |\n| Accessibility | 🟢 100 |\n| Best practices | 🟢 96 |\n| SEO | 🟡 89 |\n\n_A custom tool: any script in `.ness/tools/` shows up as a panel._'
      }),

      'panes:ensureInitialized': ok,
      'panes:addTab': (wt: string, tab: TerminalTab, paneId?: string) => this.addTab(wt, tab, paneId),
      'panes:closeTab': (wt: string, tabId: string) => this.closeTab(wt, tabId),
      'panes:selectTab': (wt: string, paneId: string, tabId: string) =>
        this.setPanes(wt, (t) => mapLeaves(t, (l) => (l.id === paneId && l.activeTabId !== tabId ? { ...l, activeTabId: tabId } : l))),
      'panes:wakeTab': (wt: string, tabId: string) => {
        this.dispatch({ type: 'terminals/tabWoken', payload: { worktreePath: wt, tabId } })
        return true
      },
      'panes:sleepTab': (wt: string, tabId: string) => {
        this.dispatch({ type: 'terminals/tabSlept', payload: { worktreePath: wt, tabId } })
        return true
      },
      'panes:renameTab': (wt: string, tabId: string, label: string) => {
        this.dispatch({ type: 'terminals/tabRenamed', payload: { worktreePath: wt, tabId, label, source: 'user' } })
        return true
      },
      'panes:reorderTabs': ok,
      'panes:openReview': (wt: string) => this.openReviewTab(wt),
      'panes:setReviewSelection': (wt: string, tabId: string, fromCommit?: string, toCommit?: string) => {
        this.dispatch({ type: 'terminals/reviewSelectionChanged', payload: { worktreePath: wt, tabId, fromCommit, toCommit } })
        return true
      },
      'panes:convertTabType': () => {
        this.notice()
        return false
      },
      'panes:restartAgentTab': () => {
        this.notice()
        return false
      },
      'terminals:touchLastActive': (wt: string) => {
        this.dispatch({ type: 'terminals/lastActiveChanged', payload: { worktreePath: wt, ts: this.now() } })
        return true
      },

      'terminal:getHistory': (id: string) => this.history.get(id) ?? '',
      'terminal:forgetHistory': (id: string) => {
        this.history.delete(id)
        this.shells.delete(id)
        return true
      },
      'agent:buildSpawnArgs': () => 'claude',

      'jsonClaude:start': (id: string, cwd: string) => this.startChat(id, cwd),
      'jsonClaude:getEntries': (id: string) => {
        const session = this.state.jsonClaude.sessions[id]
        if (!session) return []
        this.dispatch({ type: 'jsonClaude/entriesSeeded', payload: { sessionId: id, entries: session.entries } })
        return session.entries
      },
      'jsonClaude:setComposerVisible': (id: string, visible: boolean) => {
        if (id === TAB.darkChat && visible && !this.darkFinished) {
          this.darkFinished = true
          this.playing.delete(id)
          this.enqueue(id, { make: () => darkFinishSteps(this.now), force: true })
        }
        return true
      },
      'jsonClaude:resolveApproval': (requestId: string, result: { behavior: 'allow' | 'deny'; message?: string }) => {
        const approval = this.state.jsonClaude.pendingApprovals[requestId]
        if (!approval) return false
        if (requestId === UNITS_REQUEST_ID) {
          const steps = result?.behavior === 'allow' ? approveSteps(this.now) : denySteps(this.now, result?.message)
          this.enqueue(approval.sessionId, { make: () => steps, force: true })
        } else {
          this.dispatch({ type: 'jsonClaude/approvalResolved', payload: { requestId } })
        }
        return true
      },
      'jsonClaude:rerunAutoApprovalReview': () => {
        this.notice()
        return false
      },
      'jsonClaude:interrupt': (id: string) => {
        this.interrupt(id)
        return true
      },
      'jsonClaude:interruptAndSend': (id: string, text: string) => {
        this.interrupt(id)
        this.send(id, text)
        return { ok: true }
      },
      'jsonClaude:kill': ok,
      'jsonClaude:setPermissionMode': (id: string, mode: unknown) => {
        if (!isJsonClaudePermissionMode(mode) || !this.state.jsonClaude.sessions[id]) return false
        this.dispatch({ type: 'jsonClaude/permissionModeChanged', payload: { sessionId: id, mode } })
        return true
      },
      'jsonClaude:setTabModel': (id: string, model: string) => {
        if (!this.state.jsonClaude.sessions[id]) return false
        this.dispatch({ type: 'jsonClaude/currentModelChanged', payload: { sessionId: id, model } })
        return true
      },
      'jsonClaude:grantSessionToolApprovals': (id: string, toolNames: string[]) => {
        this.dispatch({ type: 'jsonClaude/sessionToolApprovalsGranted', payload: { sessionId: id, toolNames } })
        return true
      },
      'jsonClaude:clearSessionToolApprovals': (id: string, toolNames?: string[]) => {
        this.dispatch({ type: 'jsonClaude/sessionToolApprovalsCleared', payload: { sessionId: id, toolNames } })
        return true
      },
      'jsonClaude:readAttachmentImage': () => null,
      'jsonClaude:openAuthLoginTab': () => unavailable,
      'permissions:grant': ok,

      'pr:merge': () => unavailable,
      'pr:approve': () => unavailable,
      'reviews:requestForWorktree': () => unavailable,
      'reviews:addComment': (wt: string, input: Parameters<DemoWorld['addReviewComment']>[1]) => this.addReviewComment(wt, input),
      'reviews:deleteComment': (wt: string, id: string) => {
        this.dispatch({ type: 'reviews/commentDeleted', payload: { worktreePath: wt, id } })
        return true
      },
      'reviews:setCommentStatus': (wt: string, id: string, status: ReviewCommentStatus) => {
        if (status !== 'open' && status !== 'resolved' && status !== 'outdated') return false
        this.dispatch({ type: 'reviews/commentStatusChanged', payload: { worktreePath: wt, id, status, by: { kind: 'human' }, at: this.now() } })
        return true
      },
      'reviews:addReply': (wt: string, commentId: string, body: string) => {
        const text = typeof body === 'string' ? body.trim() : ''
        if (!text || !this.state.reviews.byPath[wt]?.comments.some((x) => x.id === commentId)) return false
        const reply = { id: `demo-rr-${this.now().toString(36)}-${this.reviewId++}`, author: { kind: 'human' as const }, body: text, createdAt: this.now() }
        this.dispatch({ type: 'reviews/replyAdded', payload: { worktreePath: wt, commentId, reply } })
        return true
      },
      'reviews:editComment': (wt: string, id: string, body: string) => {
        if (typeof body !== 'string' || !body.trim()) return false
        this.dispatch({ type: 'reviews/commentEdited', payload: { worktreePath: wt, id, body: body.trim() } })
        return true
      },
      // Demo comments are anchored at HEAD, and the demo's HEAD never moves.
      'reviews:refreshAnchors': ok,
      'reviews:listChatTabs': (wt: string) => listChatTabs(this.state, wt),
      'reviews:editSubmission': (wt: string, id: string, summary: string, verdict: ReviewVerdict) => {
        if (typeof summary !== 'string' || !['approve', 'changes-requested', 'comment'].includes(verdict)) return false
        this.dispatch({ type: 'reviews/submissionEdited', payload: { worktreePath: wt, id, summary: summary.trim(), verdict } })
        return true
      },
      'reviews:deleteSubmission': (wt: string, id: string) => {
        this.dispatch({ type: 'reviews/submissionDeleted', payload: { worktreePath: wt, id } })
        return true
      },
      'reviews:sendSubmission': (wt: string, id: string, targetTabId?: string) => this.sendReview(wt, id, targetTabId),
      'prs:requestConflictFix': () => unavailable,
      'ciNotify:setOverride': (path: string, enabled: boolean | null) => {
        this.dispatch(enabled === null ? { type: 'ciNotify/clear', payload: path } : { type: 'ciNotify/set', payload: { path, enabled } })
        return true
      },

      'scratchpad:setText': (wt: string, text: string) => {
        this.dispatch({ type: 'scratchpad/textChanged', payload: { worktreePath: wt, text } })
        return true
      },
      'aliases:set': (path: string, alias: string) => {
        const a = alias.trim()
        this.dispatch(a ? { type: 'aliases/set', payload: { path, alias: a } } : { type: 'aliases/cleared', payload: { path } })
        return true
      },
      'aliases:clear': (path: string) => {
        this.dispatch({ type: 'aliases/cleared', payload: { path } })
        return true
      },
      'pinned:pin': (path: string) => {
        this.dispatch({ type: 'pinned/set', payload: path })
        return true
      },
      'pinned:unpin': (path: string) => {
        this.dispatch({ type: 'pinned/clear', payload: path })
        return true
      },
      'snooze:snooze': (path: string, wakeAt: number) => {
        this.dispatch({ type: 'snooze/set', payload: { path, snoozedAt: this.now(), wakeAt } })
        return true
      },
      'snooze:unsnooze': (path: string) => {
        this.dispatch({ type: 'snooze/clear', payload: path })
        return true
      },
      'repoConfig:set': (repoRoot: string, next: Record<string, unknown>) => {
        const merged: Record<string, unknown> = { ...this.state.repoConfigs.byRepo[repoRoot] }
        for (const [k, v] of Object.entries(next ?? {})) {
          if (v === null || v === undefined) delete merged[k]
          else merged[k] = v
        }
        const config = merged as RepoConfig
        this.dispatch({ type: 'repoConfigs/changed', payload: { repoRoot, config, filename: '.ness.json' } })
        return config
      },

      'subscriptions:setMode': ok,
      'subscriptions:unsubscribe': ok,
      'notifications:deliverHeld': ok,
      'notifications:discardHeld': ok,
      'costs:setInterest': ok,
      'contextWindow:setInterest': ok,
      'config:setAutoApproveSteerInstructions': ok,

      'config:setThemeMode': (mode: 'light' | 'dark' | 'system') => {
        this.dispatch({ type: 'settings/themeModeChanged', payload: mode })
        return true
      },
      'config:setThemeLight': (id: string) => {
        this.dispatch({ type: 'settings/themeLightChanged', payload: id })
        return true
      },
      'config:setThemeDark': (id: string) => {
        this.dispatch({ type: 'settings/themeDarkChanged', payload: id })
        return true
      }
    }
    return h
  }

  private buildSignals(): Record<string, Handler> {
    const noop = () => {}
    return {
      'pty:create': (id: string, cwd: string, _cmd: string, _args: string[], agentKind?: string, cols?: number) =>
        this.createPty(id, cwd, agentKind, cols),
      'pty:write': (id: string, data: string) => {
        const shell = this.shells.get(id)
        if (shell) this.out(id, shell.input(data))
      },
      'pty:resize': (id: string, cols: number) => this.shells.get(id)?.resize(cols),
      'pty:kill': (id: string) => {
        this.shells.delete(id)
      },
      'terminal:join': noop,
      'terminal:leave': noop,
      'terminal:takeControl': noop,
      'terminal:setProgress': noop,
      'jsonClaude:send': (id: string, text: string) => this.send(id, text),
      'jsonClaude:cancelQueued': (id: string, messageId: string) => {
        this.dispatch({ type: 'jsonClaude/entryRemoved', payload: { sessionId: id, entryId: messageId } })
        const q = this.queues.get(id)
        if (q?.length) q.pop()
      },
      'worktree:watchChangedFiles': noop,
      'worktree:unwatchChangedFiles': noop,
      'file:watchSubscribe': noop,
      'file:watchUnsubscribe': noop,
      'config:setLastEffectiveAppBg': noop,
      'perf:reportRendererSample': noop
    }
  }

  request(name: string, args: unknown[]): unknown {
    const h = this.handlers[name] as ((...a: unknown[]) => unknown) | undefined
    if (!h) {
      this.notice()
      throw new DemoUnavailableError(name)
    }
    return h(...args)
  }

  signal(name: string, args: unknown[]): void {
    const h = this.signals[name] as ((...a: unknown[]) => void) | undefined
    h?.(...args)
  }
}
