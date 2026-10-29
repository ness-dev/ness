import type { Store } from './store'
import type {
  AgentKind,
  TerminalTab,
  PaneNode,
  PaneLeaf,
  SplitDirection
} from '../shared/state/terminals'
import {
  getLeaves,
  findLeaf,
  findLeafByTabId,
  hasAnyTabs,
  mapLeaves,
  replaceNode,
  removeLeaf
} from '../shared/state/terminals'
import type { PersistedPaneNode } from './persistence'
import { agentDisplayName, getAgentInfo, supportsChat, supportsConversationFork } from '../shared/agent-registry'
import { log } from './debug'

interface PanesFSMOptions {
  persist: (panes: Record<string, PaneNode>) => void
  getRepoRootForWorktree: (worktreePath: string) => string | undefined
  getLatestClaudeSessionId: (worktreePath: string) => Promise<string | null>
  getDefaultAgentKind?: () => AgentKind
  /** Read the default Claude interface setting. When this returns 'json',
   *  a default Claude agent tab spawns as a json-claude tab instead of
   *  an xterm-hosted one. */
  getDefaultClaudeTabType?: () => 'xterm' | 'json'
  /** Tear down the PTY backing a closed tab. Called for agent + shell
   *  tabs when they're removed from the tree (closeTab, restartAgentTab,
   *  clearForWorktree). Authoritative on the main side so PTY lifetime
   *  no longer depends on a renderer being mounted to issue the kill —
   *  important for the web client, where any client (or none) might be
   *  the one driving the close. */
  killTabPty?: (tabId: string) => void
  /** Tear down a json-claude subprocess on tab close. Same authoritative-
   *  on-main contract as killTabPty, but routes to JsonClaudeManager
   *  instead of PtyManager. */
  killJsonClaude?: (sessionId: string) => void
  /** Drop the slice entry for a json-claude session. Used by
   *  convertTabType when swapping AWAY from json — without this, the
   *  stale 'exited' session entry survives and JsonModeChat's mount
   *  useEffect short-circuits if the user later swaps back to the same
   *  sessionId. The on-disk jsonl is untouched, so a re-mount replays
   *  history via seedFromTranscript. */
  clearJsonClaudeSession?: (sessionId: string) => void
  /** Spawn a json-claude session and (optionally) send a one-shot
   *  initial prompt as the first user message. Called from
   *  ensureInitialized when a default json-claude tab is created so
   *  the subprocess + initial prompt land on the same path the xterm
   *  side gets via --prompt. The renderer's JsonModeChat useEffect
   *  notices the session already exists and skips its own start. */
  startJsonClaudeWithPrompt?: (
    sessionId: string,
    worktreePath: string,
    initialPrompt?: string
  ) => void
  /** Spawn (or resume) a json-claude session without an initial
   *  prompt. Used by wakeJsonClaudeTab to re-attach a slept tab to a
   *  fresh subprocess. Idempotent: a no-op if the session is already
   *  running. */
  startJsonClaude?: (sessionId: string, worktreePath: string) => void
}

function newPaneId(): string {
  return `pane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function newSplitId(): string {
  return `split-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function stripTransientTabFields(tab: TerminalTab): TerminalTab {
  if (!tab.initialPrompt && !tab.teleportSessionId) return tab
  const { initialPrompt: _ip, teleportSessionId: _ts, ...rest } = tab
  void _ip
  void _ts
  return rest
}

export class PanesFSM {
  private store: Store
  private opts: PanesFSMOptions
  private sleepingPanes = new Map<string, PaneNode>()

  constructor(store: Store, opts: PanesFSMOptions) {
    this.store = store
    this.opts = opts
  }

  hasSleepingPanes(wtPath: string): boolean {
    return this.sleepingPanes.has(wtPath)
  }

  private getTree(wtPath: string): PaneNode | null {
    return this.store.getSnapshot().state.terminals.panes[wtPath] || null
  }

  /** Type of the tab at (wtPath, tabId), or null if not found. Lets the
   *  panes:wakeTab IPC handler pick exactly one wake method instead of
   *  fanning out to both and trusting each method's internal type guard
   *  (which is brittle — any future unconditional side-effect added to
   *  the wrong path silently fires on the wrong tab type). */
  getTabType(wtPath: string, tabId: string): TerminalTab['type'] | null {
    const tree = this.getTree(wtPath)
    return (
      (tree && findLeafByTabId(tree, tabId)?.tabs.find((t) => t.id === tabId)?.type) ??
      null
    )
  }

  private getAllPanes(): Record<string, PaneNode> {
    return this.store.getSnapshot().state.terminals.panes
  }

  private buildPersistPayload(): Record<string, PaneNode> {
    const out: Record<string, PaneNode> = {}
    for (const [path, tree] of this.sleepingPanes) out[path] = tree
    for (const [path, tree] of Object.entries(this.getAllPanes())) out[path] = tree
    return out
  }

  private commit(wtPath: string, next: PaneNode): void {
    this.store.dispatch({
      type: 'terminals/panesForWorktreeChanged',
      payload: { worktreePath: wtPath, panes: next }
    })
    this.opts.persist(this.buildPersistPayload())
  }

  async restoreFromConfig(
    persistedNested:
      | Record<string, Record<string, PersistedPaneNode>>
      | undefined
  ): Promise<void> {
    if (!persistedNested) return
    this.sleepingPanes.clear()
    for (const byWt of Object.values(persistedNested)) {
      for (const [wtPath, paneTree] of Object.entries(byWt)) {
        const tree = await this.hydratePersistedTree(paneTree, wtPath)
        this.sleepingPanes.set(wtPath, tree)
      }
    }
  }

  private async hydratePersistedTree(
    node: PersistedPaneNode,
    wtPath: string
  ): Promise<PaneNode> {
    if (node.type === 'split') {
      const [left, right] = await Promise.all([
        this.hydratePersistedTree(node.children[0], wtPath),
        this.hydratePersistedTree(node.children[1], wtPath)
      ])
      return {
        type: 'split',
        id: node.id,
        direction: node.direction,
        ratio: node.ratio,
        children: [left, right]
      }
    }
    const allTabs = node.tabs
    const needsBackfill = allTabs.some((t) => t.type === 'agent' && !t.sessionId)
    const latest = needsBackfill
      ? await this.opts.getLatestClaudeSessionId(wtPath).catch(() => null)
      : null
    let claimedLatest = false
    const tabs: TerminalTab[] = allTabs.map((t): TerminalTab => {
      const base: TerminalTab = {
        id: t.id,
        type: t.type,
        label: t.label,
        agentKind: t.agentKind,
        sessionId: t.sessionId,
        ...(t.providerSessionId ? { providerSessionId: t.providerSessionId } : {}),
        url: t.url,
        command: t.command,
        cwd: t.cwd,
        model: t.model,
        ...(t.customLabel ? { customLabel: t.customLabel } : {})
      }
      // Persisted json-claude and shell tabs hydrate as 'asleep' so app
      // launch doesn't construct an xterm + spawn a subprocess per tab
      // across every restored worktree. The renderer wakes them on
      // first focus via panes:wakeTab. (Agent tabs stay eager so
      // background processing they're in the middle of resumes promptly.)
      if (base.type === 'json-claude' || base.type === 'shell') {
        return { ...base, mode: 'asleep' }
      }
      if (base.type !== 'agent' || base.sessionId) return base
      if (latest && !claimedLatest) {
        claimedLatest = true
        return { ...base, sessionId: latest }
      }
      return { ...base, sessionId: crypto.randomUUID() }
    })
    return {
      type: 'leaf',
      id: node.id,
      tabs,
      activeTabId: node.activeTabId
    }
  }

  ensureInitialized(
    wtPath: string,
    opts?: {
      initialPrompt?: string
      teleportSessionId?: string
      agentKind?: AgentKind
      model?: string
      /** A transcript has already been written to this worktree's project
       *  dir under this id. Presetting it on the tab is all that's needed —
       *  both spawn paths independently pick `--resume` over `--session-id`
       *  when the session file exists. */
      forkedSessionId?: string
    }
  ): PaneNode {
    const existing = this.getTree(wtPath)
    if (existing && hasAnyTabs(existing)) {
      this.deliverLateKickoff(wtPath, existing, opts?.initialPrompt)
      return existing
    }

    // Belt-and-suspenders for issue #185: a prunable worktree points at a
    // directory that no longer exists on disk. Spawning a default agent
    // tab against it would fire an ENOENT from child_process.spawn. Fix 1
    // catches the crash in the manager, but we shouldn't get that far in
    // the first place — the sidebar surfaces the stale entry with a
    // prune action so the user can clean it up.
    const wt = this.store.getSnapshot().state.worktrees.list.find((w) => w.path === wtPath)
    if (wt?.prunable) {
      log('panes-fsm', `ensureInitialized skipped — prunable worktree wtPath=${wtPath}`)
      // Callers don't use the returned node for prunable worktrees (the
      // sidebar tab won't be clicked), so an empty leaf is fine. Don't
      // commit — leaving the state clean means a later prune + refresh
      // will lazy-init on click without a stale entry lingering.
      return existing ?? { type: 'leaf', id: newPaneId(), tabs: [], activeTabId: '' }
    }

    const sleeping = this.sleepingPanes.get(wtPath)
    if (sleeping && hasAnyTabs(sleeping)) {
      this.sleepingPanes.delete(wtPath)
      this.commit(wtPath, sleeping)
      this.deliverLateKickoff(wtPath, sleeping, opts?.initialPrompt)
      return sleeping
    }

    let agentKind = opts?.agentKind ?? this.opts.getDefaultAgentKind?.() ?? 'claude'
    if (opts?.forkedSessionId && !supportsConversationFork(agentKind)) {
      // The transcript is already written to disk keyed by this id; handing it
      // to an agent that assigns its own session id would strand it forever.
      // Callers are supposed to pin Claude themselves — log loudly if one didn't.
      log(
        'panes-fsm',
        `forkedSessionId supplied for ${agentKind}, which can't resume a fork — forcing claude wtPath=${wtPath}`
      )
      agentKind = 'claude'
    }
    const agentInfo = getAgentInfo(agentKind)
    const model = opts?.model && opts.model.trim() ? opts.model.trim() : undefined
    const shellTabId = `shell-${wtPath.replace(/[^a-zA-Z0-9]/g, '-')}-${Date.now()}`
    // Branch to a json-claude default tab when the user has opted in
    // and the agent has a chat provider. teleport sessions stay on xterm (json-
    // claude has no `--resume <id>` analog for an arbitrary external
    // session today). initialPrompt is honored for both — for the
    // json-claude side we pre-spawn the subprocess and send it as the
    // first message via startJsonClaudeWithPrompt below.
    // An agent that assigns its own session ids can't be handed the forked
    // conversation's id on a terminal command line — the fork only becomes
    // a real conversation inside its chat provider (Codex forks the thread
    // when the chat tab boots). So such a fork can only open in Chat.
    const forkNeedsChat = !!opts?.forkedSessionId && !agentInfo.assignsSessionId
    const wantsJson =
      supportsChat(agentKind) &&
      (this.opts.getDefaultClaudeTabType?.() === 'json' || forkNeedsChat) &&
      !opts?.teleportSessionId
    let agentTab: TerminalTab
    let jsonClaudeKickoff: { sessionId: string; initialPrompt?: string; model?: string } | null = null
    if (wantsJson) {
      const sessionId = opts?.forkedSessionId ?? crypto.randomUUID()
      agentTab = {
        id: sessionId,
        type: 'json-claude',
        label: 'Chat',
        sessionId,
        mode: 'awake',
        ...(agentKind !== 'claude' ? { agentKind } : {}),
        model
      }
      jsonClaudeKickoff = { sessionId, initialPrompt: opts?.initialPrompt, model }
    } else {
      const agentTabId = `agent-${wtPath.replace(/[^a-zA-Z0-9]/g, '-')}-${Date.now()}`
      agentTab = {
        id: agentTabId,
        type: 'agent',
        agentKind,
        label: agentInfo.displayName,
        sessionId: agentInfo.assignsSessionId
          ? (opts?.forkedSessionId ?? crypto.randomUUID())
          : undefined,
        initialPrompt: opts?.teleportSessionId ? undefined : opts?.initialPrompt,
        teleportSessionId: opts?.teleportSessionId,
        model
      }
    }
    const tabs: TerminalTab[] = [agentTab, { id: shellTabId, type: 'shell', label: 'Shell' }]
    const pane: PaneLeaf = {
      type: 'leaf',
      id: newPaneId(),
      tabs,
      activeTabId: agentTab.id
    }
    this.commit(wtPath, pane)
    // Only kick off main-side spawn when an initialPrompt needs to land
    // as the first message. For prompt-less json-claude tabs, the
    // renderer's JsonModeChat useEffect handles the start — and for
    // sleeping panes / tab-type swaps we never reach this branch at
    // all, so resume flows are unaffected.
    if (jsonClaudeKickoff?.initialPrompt) {
      this.opts.startJsonClaudeWithPrompt?.(
        jsonClaudeKickoff.sessionId,
        wtPath,
        jsonClaudeKickoff.initialPrompt
      )
    }
    return pane
  }

  /** A prompt-less ensureInitialized can beat the one carrying a new
   *  worktree's kickoff prompt — main's `worktrees/listChanged`
   *  subscriber inits every path it sees, and a concurrent creation's
   *  refreshList can surface this worktree while its setup script is
   *  still running. Rather than dropping the prompt on the floor, hand
   *  it to the chat tab that already exists. `startJsonClaudeWithPrompt`
   *  is idempotent on the spawn and sends the prompt either way. */
  private deliverLateKickoff(wtPath: string, tree: PaneNode, initialPrompt?: string): void {
    if (!initialPrompt) return
    const chatTab = getLeaves(tree)
      .flatMap((leaf) => leaf.tabs)
      .find((t) => t.type === 'json-claude')
    if (!chatTab) {
      log('panes-fsm', `late kickoff dropped — no chat tab wtPath=${wtPath}`)
      return
    }
    log('panes-fsm', `late kickoff → sessionId=${chatTab.sessionId ?? chatTab.id} wtPath=${wtPath}`)
    this.opts.startJsonClaudeWithPrompt?.(
      chatTab.sessionId ?? chatTab.id,
      wtPath,
      initialPrompt
    )
  }

  addTab(wtPath: string, tab: TerminalTab, paneId?: string): void {
    // Brand-new json-claude tabs default to 'awake' — the user just
    // clicked to create one, so the renderer's auto-spawn path should
    // proceed. Slept-by-default only applies to tabs hydrated from
    // disk in restoreFromConfig.
    const normalizedTab: TerminalTab =
      tab.type === 'json-claude' && tab.mode === undefined
        ? { ...tab, mode: 'awake' }
        : tab
    const tree = this.getTree(wtPath)
    if (!tree) {
      const pane: PaneLeaf = {
        type: 'leaf',
        id: newPaneId(),
        tabs: [normalizedTab],
        activeTabId: normalizedTab.id
      }
      this.commit(wtPath, pane)
      return
    }
    const leaves = getLeaves(tree)
    const targetId = paneId || leaves[0].id
    const updated = mapLeaves(tree, (leaf) => {
      if (leaf.id !== targetId) return leaf
      return {
        ...leaf,
        tabs: [...leaf.tabs, normalizedTab],
        activeTabId: normalizedTab.id
      }
    })
    this.commit(wtPath, updated)
  }

  /** Tear down a json-claude tab's subprocess while leaving its tab
   *  record (and the on-disk session jsonl) intact. The tab stays in
   *  the tree with mode='asleep' so the user can wake it later. No-op
   *  for non-json-claude tabs or tabs already asleep. */
  sleepJsonClaudeTab(wtPath: string, tabId: string): void {
    const tree = this.getTree(wtPath)
    if (!tree) return
    const leaf = findLeafByTabId(tree, tabId)
    if (!leaf) return
    const tab = leaf.tabs.find((t) => t.id === tabId)
    if (!tab || tab.type !== 'json-claude') return
    if ((tab.mode ?? 'awake') === 'asleep') return
    this.opts.killJsonClaude?.(tabId)
    this.store.dispatch({
      type: 'terminals/tabSlept',
      payload: { worktreePath: wtPath, tabId }
    })
    this.opts.persist(this.buildPersistPayload())
  }

  /** Re-spawn a slept json-claude tab. Marks the tab awake and kicks
   *  off the same start path as a fresh tab. No-op for non-json-claude
   *  tabs or tabs already awake. */
  wakeJsonClaudeTab(wtPath: string, tabId: string): void {
    const tree = this.getTree(wtPath)
    if (!tree) return
    const leaf = findLeafByTabId(tree, tabId)
    if (!leaf) return
    const tab = leaf.tabs.find((t) => t.id === tabId)
    if (!tab || tab.type !== 'json-claude') return
    if ((tab.mode ?? 'awake') === 'awake') return
    this.store.dispatch({
      type: 'terminals/tabWoken',
      payload: { worktreePath: wtPath, tabId }
    })
    this.opts.startJsonClaude?.(tabId, wtPath)
    this.opts.persist(this.buildPersistPayload())
  }

  /** Flip a slept shell tab to awake. No subprocess spawn here — the
   *  renderer's XTerminal mount path owns PTY creation; flipping mode
   *  is what makes WorkspaceView render it in the first place. */
  wakeShellTab(wtPath: string, tabId: string): void {
    const tree = this.getTree(wtPath)
    if (!tree) return
    const leaf = findLeafByTabId(tree, tabId)
    if (!leaf) return
    const tab = leaf.tabs.find((t) => t.id === tabId)
    if (!tab || tab.type !== 'shell') return
    if ((tab.mode ?? 'awake') === 'awake') return
    this.store.dispatch({
      type: 'terminals/tabWoken',
      payload: { worktreePath: wtPath, tabId }
    })
    this.opts.persist(this.buildPersistPayload())
  }

  closeTab(wtPath: string, tabId: string): void {
    const tree = this.getTree(wtPath)
    if (!tree) return
    const leaf = findLeafByTabId(tree, tabId)
    if (!leaf) return
    const closing = leaf.tabs.find((t) => t.id === tabId)
    if (closing && (closing.type === 'agent' || closing.type === 'shell')) {
      this.opts.killTabPty?.(tabId)
    } else if (closing && closing.type === 'json-claude') {
      this.opts.killJsonClaude?.(tabId)
    }
    const remaining = leaf.tabs.filter((t) => t.id !== tabId)
    if (remaining.length === 0) {
      const collapsed = removeLeaf(tree, leaf.id)
      if (collapsed === null) {
        this.commit(wtPath, { ...leaf, tabs: [], activeTabId: '' })
      } else {
        this.commit(wtPath, collapsed)
      }
      return
    }
    let newActive = leaf.activeTabId
    if (leaf.activeTabId === tabId) {
      const closedIdx = leaf.tabs.findIndex((t) => t.id === tabId)
      const targetIdx = Math.max(0, Math.min(closedIdx - 1, remaining.length - 1))
      newActive = remaining[targetIdx].id
    }
    const updated = replaceNode(tree, leaf.id, {
      ...leaf,
      tabs: remaining,
      activeTabId: newActive
    })
    this.commit(wtPath, updated)
  }

  /** Swap an agent tab to a json-claude tab (or vice versa) without
   *  losing the on-disk session. The sessionId on the source tab maps
   *  to the same `~/.claude/projects/.../`<sessionId>`.jsonl` regardless
   *  of which renderer is driving it, so killing the current backend
   *  and dispatching the type flip is enough — the destination
   *  component (XTerminal or JsonModeChat) self-spawns the matching
   *  process on mount via --resume. */
  convertTabType(
    wtPath: string,
    tabId: string,
    newType: 'agent' | 'json-claude'
  ): void {
    const tree = this.getTree(wtPath)
    if (!tree) return
    const leaf = findLeafByTabId(tree, tabId)
    if (!leaf) return
    const tab = leaf.tabs.find((t) => t.id === tabId)
    if (!tab) return
    if (tab.type === newType) return
    if (tab.type !== 'agent' && tab.type !== 'json-claude') return
    if (!supportsChat(tab.agentKind)) {
      // Only agents with a chat provider have a json-claude counterpart.
      log('panes-fsm', `convertTabType refused for agent without chat kind=${tab.agentKind}`)
      return
    }
    const sessionId = tab.sessionId ?? crypto.randomUUID()
    if (tab.type === 'agent') {
      this.opts.killTabPty?.(tabId)
    } else {
      this.opts.killJsonClaude?.(tabId)
      // Drop the slice entry too, otherwise a subsequent swap back to
      // json-claude with the same sessionId would find a stale 'exited'
      // entry and JsonModeChat's mount useEffect would skip the start.
      this.opts.clearJsonClaudeSession?.(tabId)
    }
    const newId =
      newType === 'json-claude'
        ? sessionId
        : `agent-${wtPath.replace(/[^a-zA-Z0-9]/g, '-')}-${Date.now()}`
    const newLabel = newType === 'json-claude' ? 'Chat' : agentDisplayName(tab.agentKind)
    this.store.dispatch({
      type: 'terminals/tabTypeChanged',
      payload: { worktreePath: wtPath, tabId, newId, newType, newLabel }
    })
    this.opts.persist(this.buildPersistPayload())
  }

  /** Record the agent's own id for a chat tab's conversation (a Codex
   *  thread id) so a restart resumes it. No-op if the tab is gone. */
  setTabProviderSessionId(tabId: string, providerSessionId: string): void {
    const panes = this.store.getSnapshot().state.terminals.panes
    const wtPath = Object.keys(panes).find((p) => findLeafByTabId(panes[p], tabId))
    if (!wtPath) return
    this.store.dispatch({
      type: 'terminals/tabProviderSessionIdChanged',
      payload: { worktreePath: wtPath, tabId, providerSessionId }
    })
    this.opts.persist(this.buildPersistPayload())
  }

  restartAgentTab(wtPath: string, tabId: string, newId: string): void {
    const tree = this.getTree(wtPath)
    if (!tree) return
    // Tear down the old PTY before swapping the id — once we commit the
    // new id, no client has a way to refer to the old PTY anymore.
    this.opts.killTabPty?.(tabId)
    const updated = mapLeaves(tree, (leaf) => {
      if (!leaf.tabs.some((t) => t.id === tabId)) return leaf
      const tabs = leaf.tabs.map((t) =>
        t.id === tabId && t.type === 'agent' ? { ...t, id: newId } : t
      )
      const activeTabId = leaf.activeTabId === tabId ? newId : leaf.activeTabId
      return { ...leaf, tabs, activeTabId }
    })
    this.commit(wtPath, updated)
  }

  selectTab(wtPath: string, paneId: string, tabId: string): void {
    const tree = this.getTree(wtPath)
    if (!tree || !findLeaf(tree, paneId)) return
    const updated = mapLeaves(tree, (leaf) =>
      leaf.id === paneId ? { ...leaf, activeTabId: tabId } : leaf
    )
    this.commit(wtPath, updated)
  }

  renameTab(wtPath: string, tabId: string, label: string): void {
    const tree = this.getTree(wtPath)
    if (!tree) return
    const leaf = findLeafByTabId(tree, tabId)
    if (!leaf) return
    this.store.dispatch({
      type: 'terminals/tabRenamed',
      payload: { worktreePath: wtPath, tabId, label }
    })
    this.opts.persist(this.buildPersistPayload())
  }

  /** Activate the existing review tab for this worktree, or create one if
   *  none exists. Only one review tab can live per worktree at a time —
   *  every entry point in the renderer funnels through here. */
  openReviewTab(wtPath: string): void {
    const tree = this.getTree(wtPath)
    if (tree) {
      let existing: { paneId: string; tabId: string } | null = null
      for (const leaf of getLeaves(tree)) {
        for (const tab of leaf.tabs) {
          if (tab.type === 'review') {
            existing = { paneId: leaf.id, tabId: tab.id }
            break
          }
        }
        if (existing) break
      }
      if (existing) {
        const updated = mapLeaves(tree, (leaf) =>
          leaf.id === existing!.paneId ? { ...leaf, activeTabId: existing!.tabId } : leaf
        )
        this.commit(wtPath, updated)
        return
      }
    }
    const tab: TerminalTab = {
      id: `review-${wtPath.replace(/[^a-zA-Z0-9]/g, '-')}-${Date.now()}`,
      type: 'review',
      label: 'Review'
    }
    this.addTab(wtPath, tab)
  }

  /** Open (or focus) a file viewer tab for `filePath` (worktree-relative).
   *  Dedupes on filePath so opening the same file from the changed-files
   *  panel or a clicked terminal file-link converges on one shared tab.
   *  Uses the same `file-<path>` id scheme as the renderer's handleOpenFile.
   *  When `nearTabId` is given (the terminal a file-link was clicked in), the
   *  new tab opens in that terminal's pane so a split layout opens the file
   *  where the click happened rather than always in the first pane. */
  openFileTab(wtPath: string, filePath: string, nearTabId?: string): void {
    const tree = this.getTree(wtPath)
    if (tree) {
      let existing: { paneId: string; tabId: string } | null = null
      for (const leaf of getLeaves(tree)) {
        for (const tab of leaf.tabs) {
          if (tab.type === 'file' && tab.filePath === filePath) {
            existing = { paneId: leaf.id, tabId: tab.id }
            break
          }
        }
        if (existing) break
      }
      if (existing) {
        const updated = mapLeaves(tree, (leaf) =>
          leaf.id === existing!.paneId ? { ...leaf, activeTabId: existing!.tabId } : leaf
        )
        this.commit(wtPath, updated)
        return
      }
    }
    const targetPaneId =
      tree && nearTabId ? findLeafByTabId(tree, nearTabId)?.id : undefined
    const tab: TerminalTab = {
      id: `file-${filePath}`,
      type: 'file',
      label: filePath.split('/').pop() || filePath,
      filePath
    }
    this.addTab(wtPath, tab, targetPaneId)
  }

  /** Update the commit range a review tab is showing. Called by the
   *  in-view commit picker. Persists nothing (review tabs are ephemeral). */
  setReviewSelection(
    wtPath: string,
    tabId: string,
    fromCommit?: string,
    toCommit?: string
  ): void {
    this.store.dispatch({
      type: 'terminals/reviewSelectionChanged',
      payload: { worktreePath: wtPath, tabId, fromCommit, toCommit }
    })
  }

  reorderTabs(
    wtPath: string,
    paneId: string,
    fromId: string,
    toId: string
  ): void {
    if (fromId === toId) return
    const tree = this.getTree(wtPath)
    if (!tree) return
    const updated = mapLeaves(tree, (leaf) => {
      if (leaf.id !== paneId) return leaf
      const fromIdx = leaf.tabs.findIndex((t) => t.id === fromId)
      const toIdx = leaf.tabs.findIndex((t) => t.id === toId)
      if (fromIdx === -1 || toIdx === -1) return leaf
      const tabs = leaf.tabs.slice()
      const [moved] = tabs.splice(fromIdx, 1)
      tabs.splice(toIdx, 0, moved)
      return { ...leaf, tabs }
    })
    this.commit(wtPath, updated)
  }

  moveTabToPane(
    wtPath: string,
    tabId: string,
    toPaneId: string,
    toIndex?: number
  ): void {
    const tree = this.getTree(wtPath)
    if (!tree) return
    const sourceLeaf = findLeafByTabId(tree, tabId)
    if (!sourceLeaf) return
    const moved = sourceLeaf.tabs.find((t) => t.id === tabId)!
    const sourceTabs = sourceLeaf.tabs.filter((t) => t.id !== tabId)
    const sourceActive =
      sourceLeaf.activeTabId === tabId
        ? sourceTabs[0]?.id || ''
        : sourceLeaf.activeTabId

    let updated: PaneNode
    if (sourceTabs.length === 0 && sourceLeaf.id !== toPaneId) {
      const collapsed = removeLeaf(tree, sourceLeaf.id)
      if (!collapsed) {
        updated = mapLeaves(tree, (leaf) => {
          if (leaf.id !== toPaneId) return leaf
          const tabs = leaf.tabs.slice()
          tabs.splice(toIndex ?? tabs.length, 0, moved)
          return { ...leaf, tabs, activeTabId: moved.id }
        })
      } else {
        updated = mapLeaves(collapsed, (leaf) => {
          if (leaf.id !== toPaneId) return leaf
          const tabs = leaf.tabs.slice()
          tabs.splice(toIndex ?? tabs.length, 0, moved)
          return { ...leaf, tabs, activeTabId: moved.id }
        })
      }
    } else {
      updated = mapLeaves(tree, (leaf) => {
        if (leaf.id === sourceLeaf.id && leaf.id !== toPaneId) {
          return { ...leaf, tabs: sourceTabs, activeTabId: sourceActive }
        }
        if (leaf.id === toPaneId) {
          const baseTabs =
            leaf.id === sourceLeaf.id ? sourceTabs : leaf.tabs.slice()
          baseTabs.splice(toIndex ?? baseTabs.length, 0, moved)
          return { ...leaf, tabs: baseTabs, activeTabId: moved.id }
        }
        return leaf
      })
    }
    this.commit(wtPath, updated)
  }

  splitPane(
    wtPath: string,
    fromPaneId: string,
    direction: SplitDirection = 'horizontal'
  ): PaneLeaf | null {
    const tree = this.getTree(wtPath)
    if (!tree) return null
    const source = findLeaf(tree, fromPaneId)
    if (!source) return null
    const sourceActive = source.tabs.find((t) => t.id === source.activeTabId)
    const sourceType = sourceActive?.type
    const shouldShell =
      !sourceType ||
      sourceType === 'agent' ||
      sourceType === 'shell' ||
      sourceType === 'browser'

    let tab: TerminalTab
    if (shouldShell) {
      tab = { id: `shell-${Date.now()}`, type: 'shell', label: 'Shell' }
    } else if (sourceActive!.type === 'json-claude') {
      // The Claude CLI requires --session-id to be a UUID, and for json-
      // claude the tab id doubles as the session id (see main/index.ts's
      // jsonClaude:start handler). Mint a fresh UUID so the split spawns
      // a brand-new session with no existing jsonl on disk — that drives
      // startJsonClaudeSession to use --session-id (new) rather than
      // --resume. Carry over only fields that make sense for a fresh
      // chat (label, agent, model) — never copy initialPrompt/teleportSessionId.
      const sessionId = crypto.randomUUID()
      tab = {
        id: sessionId,
        type: 'json-claude',
        label: sourceActive!.label,
        sessionId,
        mode: 'awake',
        ...(sourceActive!.agentKind ? { agentKind: sourceActive!.agentKind } : {}),
        model: sourceActive!.model
      }
    } else {
      tab = {
        ...sourceActive!,
        id: `${sourceActive!.type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      }
    }

    const newLeaf: PaneLeaf = {
      type: 'leaf',
      id: newPaneId(),
      tabs: [tab],
      activeTabId: tab.id
    }

    const splitNode: PaneNode = {
      type: 'split',
      id: newSplitId(),
      direction,
      children: [source, newLeaf],
      ratio: 0.5
    }

    const updated = replaceNode(tree, fromPaneId, splitNode)
    this.commit(wtPath, updated)
    return newLeaf
  }

  setRatio(wtPath: string, splitId: string, ratio: number): void {
    this.store.dispatch({
      type: 'terminals/paneRatioChanged',
      payload: { worktreePath: wtPath, splitId, ratio }
    })
    this.opts.persist(this.buildPersistPayload())
  }

  clearForWorktree(wtPath: string): void {
    const inLive = wtPath in this.getAllPanes()
    const inSleeping = this.sleepingPanes.delete(wtPath)
    if (!inLive && !inSleeping) return
    if (inLive) {
      // Kill PTYs for every agent + shell tab under this worktree
      // before dispatching the clear, so any clients listening for
      // terminal:exit get the signal in the same window as the tree
      // update instead of leaking PTYs.
      const tree = this.getTree(wtPath)
      if (tree) {
        for (const leaf of getLeaves(tree)) {
          for (const tab of leaf.tabs) {
            if (tab.type === 'agent' || tab.type === 'shell') {
              this.opts.killTabPty?.(tab.id)
            } else if (tab.type === 'json-claude') {
              this.opts.killJsonClaude?.(tab.id)
            }
          }
        }
      }
      this.store.dispatch({
        type: 'terminals/panesForWorktreeCleared',
        payload: wtPath
      })
    }
    this.opts.persist(this.buildPersistPayload())
  }
}

export { stripTransientTabFields }
