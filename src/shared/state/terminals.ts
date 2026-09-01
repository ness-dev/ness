export type PtyStatus = 'idle' | 'processing' | 'waiting' | 'needs-approval'

/** Who was responsible for a burst of activity in a worktree. */
export type ActivityActor = 'human' | 'agent'

export interface PendingTool {
  name: string
  input: Record<string, unknown>
}

export interface ShellActivity {
  active: boolean
  processName?: string
}

/** OSC 9;4 progress state, mirrored from @xterm/addon-progress.
 *  state: 0 = none, 1 = normal, 2 = error, 3 = indeterminate, 4 = paused/warning. */
export interface TerminalProgress {
  state: 0 | 1 | 2 | 3 | 4
  value: number
}

export type AgentKind = 'claude' | 'codex' | 'cursor'

export interface TerminalTab {
  id: string
  type: 'agent' | 'shell' | 'diff' | 'file' | 'browser' | 'json-claude' | 'review'
  label: string
  /** User-defined override for `label`. When set (non-empty after trim),
   *  the tab renders this instead of the auto-derived label. Cleared
   *  with an empty string via terminals/tabRenamed — the reducer drops
   *  the field rather than persisting "". */
  customLabel?: string
  /** Meaningful for json-claude and shell tabs. 'asleep' means no live
   *  subprocess; the tab still exists in the tree and its session
   *  history (in the jsonClaude slice + on-disk jsonl for json-claude,
   *  scrollback file for shell) is intact. Persisted tabs of both types
   *  hydrate as 'asleep' so app launch doesn't construct an xterm or
   *  spawn a subprocess per tab; they wake on first focus. */
  mode?: 'awake' | 'asleep'
  /** For agent tabs: which CLI agent this tab runs. */
  agentKind?: AgentKind
  /** For agent + json-claude tabs: override the model resolved from
   *  settings (claudeModel/codexModel). Set when a worktree was spawned
   *  with a one-shot pick (New Worktree screen "Model" field or the MCP
   *  create_worktree `model` param). Empty/undefined = use settings. */
  model?: string
  /** For diff/file tabs: the file path */
  filePath?: string
  /** For diff tabs: whether the diff is for staged changes */
  staged?: boolean
  /** For diff tabs: show the branch diff (base...HEAD) instead of working-tree diff */
  branchDiff?: boolean
  /** For diff tabs: when set, show this commit's full diff instead of a file diff */
  commitHash?: string
  /** For agent tabs: UUID passed to the agent CLI so the tab resumes its own session. */
  sessionId?: string
  /** For agent tabs: one-shot kickoff prompt. In-memory only — main strips it before persistence. */
  initialPrompt?: string
  /** For agent tabs: one-shot teleport session id. In-memory only — main strips it before persistence. */
  teleportSessionId?: string
  /** For browser tabs: the URL currently loaded (restored on reload). */
  url?: string
  /** For shell tabs: the command the tab was created with (agents set this via
   * the shell MCP). A record of origin, not an instruction — it runs once, in
   * `createShell`'s eager spawn. Remounting the tab (app restart, or after the
   * command's shell exited) gives a plain interactive shell instead. */
  command?: string
  /** For shell tabs: directory to run in. Relative paths resolve against the
   * worktree root; absolute paths are used as-is. */
  cwd?: string
  /** For review tabs: which commits the review is showing. When both
   *  reviewFromCommit and reviewToCommit are undefined, the review shows the
   *  whole branch (uncommitted + all commits ahead of base). When set, they
   *  bound a contiguous range; equal values = a single commit. */
  reviewFromCommit?: string
  reviewToCommit?: string
}

// ---------------------------------------------------------------------------
// Pane tree types — the layout is a binary tree where leaves hold tabs and
// split nodes define a direction + ratio for their two children.
// ---------------------------------------------------------------------------

export type SplitDirection = 'horizontal' | 'vertical'

export interface PaneLeaf {
  type: 'leaf'
  id: string
  tabs: TerminalTab[]
  activeTabId: string
}

export interface PaneSplit {
  type: 'split'
  id: string
  direction: SplitDirection
  children: [PaneNode, PaneNode]
  ratio: number
}

export type PaneNode = PaneLeaf | PaneSplit

/** Backwards-compat alias — some call sites still reference the old name. */
export type WorkspacePane = PaneLeaf

// ---------------------------------------------------------------------------
// Tree helpers — pure functions used by both the reducer and PanesFSM.
// ---------------------------------------------------------------------------

export function getLeaves(node: PaneNode): PaneLeaf[] {
  if (node.type === 'leaf') return [node]
  return [...getLeaves(node.children[0]), ...getLeaves(node.children[1])]
}

export function findLeaf(node: PaneNode, paneId: string): PaneLeaf | null {
  if (node.type === 'leaf') return node.id === paneId ? node : null
  return findLeaf(node.children[0], paneId) || findLeaf(node.children[1], paneId)
}

export function findLeafByTabId(node: PaneNode, tabId: string): PaneLeaf | null {
  if (node.type === 'leaf') return node.tabs.some((t) => t.id === tabId) ? node : null
  return (
    findLeafByTabId(node.children[0], tabId) || findLeafByTabId(node.children[1], tabId)
  )
}

export function findTabById(
  panes: Record<string, PaneNode>,
  tabId: string
): TerminalTab | null {
  for (const tree of Object.values(panes)) {
    const leaf = findLeafByTabId(tree, tabId)
    if (leaf) return leaf.tabs.find((t) => t.id === tabId) ?? null
  }
  return null
}

/** Whether a tab talks to Claude, and so writes a session jsonl under
 *  ~/.claude/projects. Codex and Cursor agent tabs write their own
 *  formats, so anything reading Claude transcripts must exclude them
 *  rather than assume every agent tab is Claude.
 *
 *  A missing `agentKind` means Claude — tabs created before the field
 *  existed, and the default in PanesFSM.addTab. */
export function isClaudeBackedTab(tab: TerminalTab | null | undefined): boolean {
  if (!tab) return false
  if (tab.type === 'json-claude') return true
  return tab.type === 'agent' && (tab.agentKind ?? 'claude') === 'claude'
}

export function hasAnyTabs(node: PaneNode): boolean {
  if (node.type === 'leaf') return node.tabs.length > 0
  return hasAnyTabs(node.children[0]) || hasAnyTabs(node.children[1])
}

export function mapLeaves(node: PaneNode, fn: (leaf: PaneLeaf) => PaneLeaf): PaneNode {
  if (node.type === 'leaf') return fn(node)
  const left = mapLeaves(node.children[0], fn)
  const right = mapLeaves(node.children[1], fn)
  if (left === node.children[0] && right === node.children[1]) return node
  return { ...node, children: [left, right] }
}

export function replaceNode(
  root: PaneNode,
  nodeId: string,
  replacement: PaneNode
): PaneNode {
  if (root.id === nodeId) return replacement
  if (root.type === 'leaf') return root
  const left = replaceNode(root.children[0], nodeId, replacement)
  const right = replaceNode(root.children[1], nodeId, replacement)
  if (left === root.children[0] && right === root.children[1]) return root
  return { ...root, children: [left, right] }
}

/** Remove a leaf by id. If the leaf is a child of a split, the split
 * collapses to the remaining sibling. Returns null if the root itself
 * is the removed leaf. */
export function removeLeaf(root: PaneNode, leafId: string): PaneNode | null {
  if (root.type === 'leaf') return root.id === leafId ? null : root
  const [left, right] = root.children
  if (left.type === 'leaf' && left.id === leafId) return right
  if (right.type === 'leaf' && right.id === leafId) return left
  const newLeft = removeLeaf(left, leafId)
  if (newLeft !== left) {
    return newLeft === null ? right : { ...root, children: [newLeft, right] }
  }
  const newRight = removeLeaf(right, leafId)
  if (newRight !== right) {
    return newRight === null ? left : { ...root, children: [left, newRight] }
  }
  return root
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Tmux-style session state for a single xterm-backed terminal: exactly
 *  one client (if any) holds control — their viewport sizes the PTY and
 *  their keystrokes are forwarded — while everyone else watches the same
 *  rendered byte stream as spectators. JSON-mode agent tabs re-render
 *  per client and don't need this; they're intentionally not tracked. */
export interface TerminalSession {
  /** Server-assigned clientId of the current controller, or null if the
   *  controller disconnected and nobody has clicked "take control" yet. */
  controllerClientId: string | null
  /** ClientIds currently watching this terminal read-only. Order is the
   *  order they joined; the UI uses it as a stable sort for the chip. */
  spectatorClientIds: string[]
  /** Last-applied grid dimensions, set whenever the current controller
   *  issues a resize (either via pty:resize or terminal:takeControl).
   *  Null until the first resize — new joiners see the PTY's spawn-time
   *  dimensions until somebody takes control and sets real dims. */
  size: { cols: number; rows: number } | null
}

export interface TerminalsState {
  /** PTY status per terminal id. */
  statuses: Record<string, PtyStatus>
  /** Only meaningful when status is 'needs-approval'; null otherwise. */
  pendingTools: Record<string, PendingTool | null>
  /** Per-terminal foreground-process indicator for shell tabs. */
  shellActivity: Record<string, ShellActivity>
  /** Per-terminal OSC 9;4 progress, dispatched from the controller's
   *  ProgressAddon. Absent entries mean no active progress. */
  progress: Record<string, TerminalProgress>
  /** Pane layout tree per worktree path. Authored entirely in main via the
   * panes-fsm methods. */
  panes: Record<string, PaneNode>
  /** Per-worktree most-recent-activity timestamp (ms since epoch). Used by
   * the sidebar for recency sort. Updated by the activity-deriver in main
   * whenever a contained terminal changes status. */
  lastActive: Record<string, number>
  /** Per-worktree recency split by who acted. `human` advances when the user
   * submits a prompt or types into the composer; `agent` advances when the
   * agent finishes a turn or blocks on approval. Both are derived from the
   * same status transitions `lastActive` is, so they carry its ±30s debounce
   * — fine for sorting, not for anything needing exact times. */
  lastHumanActive: Record<string, number>
  lastAgentActive: Record<string, number>
  /** Controller + spectator roster per xterm-backed terminal id. Entries
   *  are created lazily on the first join (or on pty:create) and deleted
   *  when the last client leaves. See the `controlTaken` reducer cases
   *  for the exact transitions. */
  sessions: Record<string, TerminalSession>
}

export type TerminalsEvent =
  | {
      type: 'terminals/statusChanged'
      payload: { id: string; status: PtyStatus; pendingTool: PendingTool | null }
    }
  | {
      type: 'terminals/shellActivityChanged'
      payload: { id: string; active: boolean; processName?: string }
    }
  | {
      type: 'terminals/progressChanged'
      payload: { id: string; state: 0 | 1 | 2 | 3 | 4; value: number }
    }
  | { type: 'terminals/removed'; payload: string }
  | {
      type: 'terminals/panesReplaced'
      payload: Record<string, PaneNode>
    }
  | {
      type: 'terminals/panesForWorktreeChanged'
      payload: { worktreePath: string; panes: PaneNode }
    }
  | {
      type: 'terminals/panesForWorktreeCleared'
      payload: string
    }
  | {
      type: 'terminals/lastActiveChanged'
      payload: { worktreePath: string; ts: number; actors?: ActivityActor[] }
    }
  | {
      type: 'terminals/actorActivitySeeded'
      payload: { human: Record<string, number>; agent: Record<string, number> }
    }
  | {
      type: 'terminals/paneRatioChanged'
      payload: { worktreePath: string; splitId: string; ratio: number }
    }
  | {
      type: 'terminals/sessionIdDiscovered'
      payload: { terminalId: string; sessionId: string }
    }
  | {
      type: 'terminals/controlTaken'
      payload: { terminalId: string; clientId: string; cols: number; rows: number }
    }
  | {
      type: 'terminals/controlReleased'
      payload: { terminalId: string; clientId: string }
    }
  | {
      type: 'terminals/clientJoined'
      payload: { terminalId: string; clientId: string }
    }
  | {
      type: 'terminals/clientDisconnected'
      payload: { clientId: string }
    }
  | {
      type: 'terminals/sizeChanged'
      payload: { terminalId: string; cols: number; rows: number }
    }
  | {
      type: 'terminals/tabTypeChanged'
      payload: {
        worktreePath: string
        tabId: string
        newId: string
        newType: 'agent' | 'json-claude'
        newLabel: string
      }
    }
  | {
      type: 'terminals/tabSlept'
      payload: { worktreePath: string; tabId: string }
    }
  | {
      type: 'terminals/tabWoken'
      payload: { worktreePath: string; tabId: string }
    }
  | {
      type: 'terminals/tabRenamed'
      payload: { worktreePath: string; tabId: string; label: string }
    }
  | {
      type: 'terminals/tabModelChanged'
      payload: {
        worktreePath: string
        tabId: string
        /** Empty string clears the override so the tab falls back to
         *  settings.claudeModel (or the CLI's own default when no
         *  setting is set). */
        model: string
      }
    }
  | {
      type: 'terminals/reviewSelectionChanged'
      payload: {
        worktreePath: string
        tabId: string
        fromCommit?: string
        toCommit?: string
      }
    }

export const initialTerminals: TerminalsState = {
  statuses: {},
  pendingTools: {},
  shellActivity: {},
  progress: {},
  panes: {},
  lastActive: {},
  lastHumanActive: {},
  lastAgentActive: {},
  sessions: {}
}

export function terminalsReducer(
  state: TerminalsState,
  event: TerminalsEvent
): TerminalsState {
  switch (event.type) {
    case 'terminals/statusChanged': {
      const { id, status, pendingTool } = event.payload
      // pendingTool only matters when the status is needs-approval; null it
      // otherwise so the renderer doesn't flash stale approval UI.
      const nextPending = status === 'needs-approval' ? pendingTool : null
      return {
        ...state,
        statuses: { ...state.statuses, [id]: status },
        pendingTools: { ...state.pendingTools, [id]: nextPending }
      }
    }
    case 'terminals/shellActivityChanged': {
      const { id, active, processName } = event.payload
      return {
        ...state,
        shellActivity: {
          ...state.shellActivity,
          [id]: { active, processName }
        }
      }
    }
    case 'terminals/progressChanged': {
      const { id, state: pstate, value } = event.payload
      const prev = state.progress[id]
      // state 0 = no progress: drop the entry to reset cleanly.
      if (pstate === 0) {
        if (!prev) return state
        const { [id]: _dropped, ...rest } = state.progress
        void _dropped
        return { ...state, progress: rest }
      }
      // Dedup identical updates so high-frequency OSC streams don't fan out.
      if (prev && prev.state === pstate && prev.value === value) return state
      return {
        ...state,
        progress: { ...state.progress, [id]: { state: pstate, value } }
      }
    }
    case 'terminals/removed': {
      const id = event.payload
      if (
        !(id in state.statuses) &&
        !(id in state.pendingTools) &&
        !(id in state.shellActivity) &&
        !(id in state.progress) &&
        !(id in state.sessions)
      ) {
        return state
      }
      const { [id]: _s, ...restStatuses } = state.statuses
      const { [id]: _p, ...restPending } = state.pendingTools
      const { [id]: _a, ...restActivity } = state.shellActivity
      const { [id]: _pg, ...restProgress } = state.progress
      const { [id]: _session, ...restSessions } = state.sessions
      void _s
      void _p
      void _a
      void _pg
      void _session
      return {
        ...state,
        statuses: restStatuses,
        pendingTools: restPending,
        shellActivity: restActivity,
        progress: restProgress,
        sessions: restSessions
      }
    }
    case 'terminals/panesReplaced': {
      return { ...state, panes: event.payload }
    }
    case 'terminals/panesForWorktreeChanged': {
      const { worktreePath, panes } = event.payload
      return {
        ...state,
        panes: { ...state.panes, [worktreePath]: panes }
      }
    }
    case 'terminals/panesForWorktreeCleared': {
      const worktreePath = event.payload
      if (!(worktreePath in state.panes)) return state
      const { [worktreePath]: _dropped, ...rest } = state.panes
      void _dropped
      return { ...state, panes: rest }
    }
    case 'terminals/lastActiveChanged': {
      const { worktreePath, ts, actors } = event.payload
      const next: TerminalsState = {
        ...state,
        lastActive: { ...state.lastActive, [worktreePath]: ts }
      }
      if (actors?.includes('human')) {
        next.lastHumanActive = { ...state.lastHumanActive, [worktreePath]: ts }
      }
      if (actors?.includes('agent')) {
        next.lastAgentActive = { ...state.lastAgentActive, [worktreePath]: ts }
      }
      return next
    }
    case 'terminals/actorActivitySeeded': {
      // Boot-time hydration from the on-disk activity log. Existing entries
      // win — a live transition that landed before the seed dispatch is
      // newer than anything the log can offer.
      return {
        ...state,
        lastHumanActive: { ...event.payload.human, ...state.lastHumanActive },
        lastAgentActive: { ...event.payload.agent, ...state.lastAgentActive }
      }
    }
    case 'terminals/paneRatioChanged': {
      const { worktreePath, splitId, ratio } = event.payload
      const tree = state.panes[worktreePath]
      if (!tree) return state
      const updated = replaceNode(tree, splitId, {
        ...findSplit(tree, splitId)!,
        ratio
      })
      if (updated === tree) return state
      return { ...state, panes: { ...state.panes, [worktreePath]: updated } }
    }
    case 'terminals/sessionIdDiscovered': {
      const { terminalId, sessionId } = event.payload
      const nextPanes: Record<string, PaneNode> = {}
      let changed = false
      for (const [path, tree] of Object.entries(state.panes)) {
        nextPanes[path] = mapLeaves(tree, (leaf) => {
          const newTabs = leaf.tabs.map((tab) => {
            if (tab.id !== terminalId || tab.sessionId === sessionId) return tab
            changed = true
            return { ...tab, sessionId }
          })
          return newTabs === leaf.tabs ? leaf : { ...leaf, tabs: newTabs }
        })
      }
      return changed ? { ...state, panes: nextPanes } : state
    }
    case 'terminals/controlTaken': {
      const { terminalId, clientId, cols, rows } = event.payload
      const existing = state.sessions[terminalId]
      // When a new client takes control the previous controller (if any)
      // demotes to spectator. If they were already in the spectator list
      // we keep their position; otherwise append.
      const prevController = existing?.controllerClientId
      const prevSpectators = existing?.spectatorClientIds ?? []
      const nextSpectators = prevSpectators.filter((id) => id !== clientId)
      if (prevController && prevController !== clientId && !nextSpectators.includes(prevController)) {
        nextSpectators.push(prevController)
      }
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [terminalId]: {
            controllerClientId: clientId,
            spectatorClientIds: nextSpectators,
            size: { cols, rows }
          }
        }
      }
    }
    case 'terminals/controlReleased': {
      const { terminalId, clientId } = event.payload
      const existing = state.sessions[terminalId]
      if (!existing) return state
      if (existing.controllerClientId === clientId) {
        return {
          ...state,
          sessions: {
            ...state.sessions,
            [terminalId]: { ...existing, controllerClientId: null }
          }
        }
      }
      if (!existing.spectatorClientIds.includes(clientId)) return state
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [terminalId]: {
            ...existing,
            spectatorClientIds: existing.spectatorClientIds.filter((id) => id !== clientId)
          }
        }
      }
    }
    case 'terminals/clientJoined': {
      const { terminalId, clientId } = event.payload
      const existing = state.sessions[terminalId]
      if (!existing) {
        // First-ever join for this terminal: the joiner becomes controller
        // so a lone client can type immediately without a click. Size stays
        // null until pty:resize or takeControl lands a real dimension.
        return {
          ...state,
          sessions: {
            ...state.sessions,
            [terminalId]: {
              controllerClientId: clientId,
              spectatorClientIds: [],
              size: null
            }
          }
        }
      }
      if (
        existing.controllerClientId === clientId ||
        existing.spectatorClientIds.includes(clientId)
      ) {
        return state
      }
      // Someone already has control — this client joins as a spectator. If
      // there's no controller, they're still a spectator; taking control
      // is an explicit click, not an implicit promotion, so Electron doesn't
      // steal control from a web client whose tab just focused elsewhere.
      if (existing.controllerClientId === null) {
        return {
          ...state,
          sessions: {
            ...state.sessions,
            [terminalId]: {
              ...existing,
              controllerClientId: clientId
            }
          }
        }
      }
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [terminalId]: {
            ...existing,
            spectatorClientIds: [...existing.spectatorClientIds, clientId]
          }
        }
      }
    }
    case 'terminals/clientDisconnected': {
      const { clientId } = event.payload
      let changed = false
      const nextSessions: Record<string, TerminalSession> = {}
      for (const [id, session] of Object.entries(state.sessions)) {
        let next = session
        if (session.controllerClientId === clientId) {
          next = { ...next, controllerClientId: null }
          changed = true
        }
        if (next.spectatorClientIds.includes(clientId)) {
          next = {
            ...next,
            spectatorClientIds: next.spectatorClientIds.filter((s) => s !== clientId)
          }
          changed = true
        }
        nextSessions[id] = next
      }
      return changed ? { ...state, sessions: nextSessions } : state
    }
    case 'terminals/tabTypeChanged': {
      const { worktreePath, tabId, newId, newType, newLabel } = event.payload
      const tree = state.panes[worktreePath]
      if (!tree) return state
      let changed = false
      const updated = mapLeaves(tree, (leaf) => {
        if (!leaf.tabs.some((t) => t.id === tabId)) return leaf
        const tabs = leaf.tabs.map((t) => {
          if (t.id !== tabId) return t
          // For json-claude, the convention is tab.id == tab.sessionId.
          // For agent, sessionId stays bound to the on-disk jsonl so
          // --resume picks it up after the swap. Carry it across either
          // way, generating one if the source tab somehow lacked it.
          const sessionId = t.sessionId ?? newId
          changed = true
          if (newType === 'json-claude') {
            return {
              id: newId,
              type: 'json-claude' as const,
              label: newLabel,
              sessionId,
              mode: 'awake' as const
            }
          }
          return {
            id: newId,
            type: 'agent' as const,
            agentKind: 'claude' as const,
            label: newLabel,
            sessionId
          }
        })
        const activeTabId = leaf.activeTabId === tabId ? newId : leaf.activeTabId
        return { ...leaf, tabs, activeTabId }
      })
      if (!changed) return state
      return { ...state, panes: { ...state.panes, [worktreePath]: updated } }
    }
    case 'terminals/tabSlept':
    case 'terminals/tabWoken': {
      const { worktreePath, tabId } = event.payload
      const target: 'awake' | 'asleep' =
        event.type === 'terminals/tabSlept' ? 'asleep' : 'awake'
      const tree = state.panes[worktreePath]
      if (!tree) return state
      let mutated = false
      const updated = mapLeaves(tree, (leaf) => {
        const i = leaf.tabs.findIndex((t) => t.id === tabId)
        if (i === -1) return leaf
        const tab = leaf.tabs[i]
        if (tab.type !== 'json-claude' && tab.type !== 'shell') return leaf
        if ((tab.mode ?? 'awake') === target) return leaf
        const patched: TerminalTab = { ...tab, mode: target }
        const nextTabs = [
          ...leaf.tabs.slice(0, i),
          patched,
          ...leaf.tabs.slice(i + 1)
        ]
        mutated = true
        return { ...leaf, tabs: nextTabs }
      })
      if (!mutated) return state
      return { ...state, panes: { ...state.panes, [worktreePath]: updated } }
    }
    case 'terminals/tabRenamed': {
      const { worktreePath, tabId, label } = event.payload
      const tree = state.panes[worktreePath]
      if (!tree) return state
      const trimmed = label.trim()
      let mutated = false
      const updated = mapLeaves(tree, (leaf) => {
        const i = leaf.tabs.findIndex((t) => t.id === tabId)
        if (i === -1) return leaf
        const tab = leaf.tabs[i]
        const current = tab.customLabel
        if (trimmed === '') {
          if (current === undefined) return leaf
          const { customLabel: _dropped, ...rest } = tab
          void _dropped
          mutated = true
          return {
            ...leaf,
            tabs: [...leaf.tabs.slice(0, i), rest as TerminalTab, ...leaf.tabs.slice(i + 1)]
          }
        }
        if (current === trimmed) return leaf
        mutated = true
        return {
          ...leaf,
          tabs: [
            ...leaf.tabs.slice(0, i),
            { ...tab, customLabel: trimmed },
            ...leaf.tabs.slice(i + 1)
          ]
        }
      })
      if (!mutated) return state
      return { ...state, panes: { ...state.panes, [worktreePath]: updated } }
    }
    case 'terminals/tabModelChanged': {
      const { worktreePath, tabId, model } = event.payload
      const tree = state.panes[worktreePath]
      if (!tree) return state
      const trimmed = model.trim()
      let mutated = false
      const updated = mapLeaves(tree, (leaf) => {
        const i = leaf.tabs.findIndex((t) => t.id === tabId)
        if (i === -1) return leaf
        const tab = leaf.tabs[i]
        if (tab.type !== 'json-claude' && tab.type !== 'agent') return leaf
        const current = tab.model
        if (trimmed === '') {
          if (current === undefined) return leaf
          const { model: _dropped, ...rest } = tab
          void _dropped
          mutated = true
          return {
            ...leaf,
            tabs: [...leaf.tabs.slice(0, i), rest as TerminalTab, ...leaf.tabs.slice(i + 1)]
          }
        }
        if (current === trimmed) return leaf
        mutated = true
        return {
          ...leaf,
          tabs: [
            ...leaf.tabs.slice(0, i),
            { ...tab, model: trimmed },
            ...leaf.tabs.slice(i + 1)
          ]
        }
      })
      if (!mutated) return state
      return { ...state, panes: { ...state.panes, [worktreePath]: updated } }
    }
    case 'terminals/reviewSelectionChanged': {
      const { worktreePath, tabId, fromCommit, toCommit } = event.payload
      const tree = state.panes[worktreePath]
      if (!tree) return state
      let mutated = false
      const updated = mapLeaves(tree, (leaf) => {
        const i = leaf.tabs.findIndex((t) => t.id === tabId)
        if (i === -1) return leaf
        const tab = leaf.tabs[i]
        if (tab.type !== 'review') return leaf
        if (tab.reviewFromCommit === fromCommit && tab.reviewToCommit === toCommit) return leaf
        mutated = true
        const next: TerminalTab = { ...tab }
        if (fromCommit === undefined) delete next.reviewFromCommit
        else next.reviewFromCommit = fromCommit
        if (toCommit === undefined) delete next.reviewToCommit
        else next.reviewToCommit = toCommit
        return {
          ...leaf,
          tabs: [...leaf.tabs.slice(0, i), next, ...leaf.tabs.slice(i + 1)]
        }
      })
      if (!mutated) return state
      return { ...state, panes: { ...state.panes, [worktreePath]: updated } }
    }
    case 'terminals/sizeChanged': {
      const { terminalId, cols, rows } = event.payload
      const existing = state.sessions[terminalId]
      if (!existing) {
        return {
          ...state,
          sessions: {
            ...state.sessions,
            [terminalId]: {
              controllerClientId: null,
              spectatorClientIds: [],
              size: { cols, rows }
            }
          }
        }
      }
      if (existing.size && existing.size.cols === cols && existing.size.rows === rows) {
        return state
      }
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [terminalId]: { ...existing, size: { cols, rows } }
        }
      }
    }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}

function findSplit(node: PaneNode, splitId: string): PaneSplit | null {
  if (node.type === 'leaf') return null
  if (node.id === splitId) return node
  return findSplit(node.children[0], splitId) || findSplit(node.children[1], splitId)
}
