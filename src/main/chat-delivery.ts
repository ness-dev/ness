import type { AppState } from '../shared/state'
import { getLeaves } from '../shared/state/terminals'
import { worktreeHandle } from '../shared/state/worktrees'
import { findTabInWorktree, listChatTabs } from '../shared/agent-tabs'
import { parseChatMention, slugifyTabLabel } from '../shared/chat-mention'

export interface ChatDeliveryDeps {
  /** Injects a user turn into a json-mode chat session. A session that is
   *  still starting gets it once the start completes. */
  send: (sessionId: string, text: string) => void
  /** True when the session has a live subprocess to receive the message. */
  hasSession: (sessionId: string) => boolean
  /** True while the session's start is in flight — waiting on the
   *  worktree's shell-env probe before it spawns. */
  isStarting: (sessionId: string) => boolean
  /** Re-spawns a slept json-claude tab's subprocess. Asynchronous: the
   *  start usually waits on the shell-env probe, so the session is
   *  typically still starting when this returns. */
  wake: (worktreePath: string, tabId: string) => void
  /** Starts the subprocess of an awake json-claude tab whose process is
   *  gone (crashed, or not yet respawned by a client). Idempotent with the
   *  renderer's own respawn: JsonClaudeManager.create no-ops when the
   *  session is already running, so whichever side goes second is a no-op. */
  respawn: (worktreePath: string, tabId: string) => void
}

export type ChatDeliveryResult =
  | { ok: true; sessionId: string; woke: boolean }
  | { ok: false; reason: 'no-chat-tab' | 'wake-failed' }

/** Most recently active session for this worktree that still has a live
 *  subprocess. */
function pickLiveSession(
  state: AppState,
  deps: ChatDeliveryDeps,
  worktreePath: string
): string | null {
  let best: string | null = null
  let bestTs = -1
  for (const [sessionId, session] of Object.entries(state.jsonClaude.sessions)) {
    if (session.worktreePath !== worktreePath) continue
    if (!deps.hasSession(sessionId)) continue
    const last = session.entries[session.entries.length - 1]
    const ts = last?.timestamp ?? 0
    if (ts > bestTs || (ts === bestTs && (best === null || sessionId < best))) {
      best = sessionId
      bestTs = ts
    }
  }
  return best
}

/** A json-claude tab whose start is in flight. A woken tab is already
 *  'awake' but has no live session until its shell-env probe finishes, so
 *  without this tier a second notification in that window would miss it —
 *  and either fail or wake a different slept tab. */
function pickStartingTab(state: AppState, deps: ChatDeliveryDeps, worktreePath: string): string | null {
  const tree = state.terminals.panes[worktreePath]
  if (!tree) return null
  for (const leaf of getLeaves(tree)) {
    for (const tab of leaf.tabs) {
      if (tab.type === 'json-claude' && deps.isStarting(tab.id)) return tab.id
    }
  }
  return null
}

/** A slept json-claude tab to wake, preferring whichever tab its pane
 *  had focused. */
function pickSleptTab(state: AppState, worktreePath: string): string | null {
  const tree = state.terminals.panes[worktreePath]
  if (!tree) return null
  let fallback: string | null = null
  for (const leaf of getLeaves(tree)) {
    for (const tab of leaf.tabs) {
      if (tab.type !== 'json-claude') continue
      if ((tab.mode ?? 'awake') !== 'asleep') continue
      if (tab.id === leaf.activeTabId) return tab.id
      fallback ??= tab.id
    }
  }
  return fallback
}

const WORKTREE_HANDLE_PREFIX = 'worktree:'

/** Every live worktree a handle could mean: the exact path alone, else
 *  each whose `<repo>/<branch>` handle, alias, or bare branch matches
 *  case-insensitively. Also strips the composer's `worktree:` prefix. */
function worktreeCandidates(state: AppState, query: string): { q: string; paths: string[] } {
  // The chat composer's @-mention inserts `@worktree:<repo>/<branch>`, and
  // agents routinely pass that token through verbatim. Strip the prefix so
  // it resolves instead of 404ing on a handle we handed them ourselves.
  let q = query.trim()
  if (q.toLowerCase().startsWith(WORKTREE_HANDLE_PREFIX)) {
    q = q.slice(WORKTREE_HANDLE_PREFIX.length).trim()
  }
  if (!q) return { q, paths: [] }
  // A prunable worktree's directory is already gone, so nothing can be
  // running in it to receive the message.
  const list = state.worktrees.list.filter((w) => !w.prunable)
  if (list.some((w) => w.path === q)) return { q, paths: [q] }
  const lower = q.toLowerCase()
  const paths = list
    .filter((w) => {
      const alias = state.aliases.byPath[w.path]
      return (
        alias?.toLowerCase() === lower ||
        w.branch.toLowerCase() === lower ||
        worktreeHandle(w.repoRoot, w.branch).toLowerCase() === lower
      )
    })
    .map((w) => w.path)
  return { q, paths: [...new Set(paths)] }
}

/** Resolve a caller-supplied worktree handle. Absolute path wins outright;
 *  otherwise a `<repo>/<branch>` handle, alias, and bare branch are matched
 *  case-insensitively. An ambiguous handle is an error rather than a guess —
 *  silently picking one of two worktrees would deliver a message somewhere
 *  the sender didn't intend. */
export function resolveWorktreeQuery(
  state: AppState,
  query: string
): { path: string } | { error: string } {
  const { q, paths } = worktreeCandidates(state, query)
  if (!q) return { error: 'worktree required' }
  if (paths.length === 1) return { path: paths[0] }
  if (paths.length > 1) {
    return {
      error: `"${q}" matches ${paths.length} worktrees — pass the absolute path instead`
    }
  }
  return { error: `no worktree matching "${q}"` }
}

/** Resolve an `@chat:<repo>/<branch>#<tab>` mention to one Chat tab. The
 *  tab half matches a tab id exactly, else the slug of a Chat tab's name.
 *
 *  The worktree half can be ambiguous through no fault of the token's —
 *  `<repo>` is a basename, so two clones of `app` on `main` share a handle,
 *  and a handle can also equal another worktree's alias or branch. The
 *  sender holds only the token, so "pass the absolute path" isn't advice it
 *  can follow. Instead the tab ref narrows the candidates: a resolve
 *  succeeds when exactly one candidate worktree holds exactly one match.
 *  Anything else is still an error, never a guess. */
export function resolveChatQuery(
  state: AppState,
  query: string
): { path: string; tabId: string } | { error: string } {
  const parsed = parseChatMention(query)
  if (!parsed) return { error: `"${query}" is not a chat mention — expected chat:<repo>/<branch>#<tab>` }
  const { paths } = worktreeCandidates(state, parsed.worktree)
  if (paths.length === 0) return { error: `no worktree matching "${parsed.worktree}"` }
  const want = parsed.tab.toLowerCase()
  const hits: Array<{ path: string; tabId: string }> = []
  let slugCollisions = 0
  for (const path of paths) {
    const tabs = listChatTabs(state, path)
    const byId = tabs.find((t) => t.id === parsed.tab)
    if (byId) {
      hits.push({ path, tabId: byId.id })
      continue
    }
    const bySlug = tabs.filter((t) => slugifyTabLabel(t.label) === want)
    if (bySlug.length === 1) hits.push({ path, tabId: bySlug[0].id })
    else if (bySlug.length > 1) slugCollisions += bySlug.length
  }
  if (hits.length === 1 && slugCollisions === 0) return hits[0]
  if (hits.length + slugCollisions > 1) {
    return {
      error: `"${parsed.tab}" matches ${hits.length + slugCollisions} Chat tabs for ${parsed.worktree} — call list_tabs and pass the tab id instead`
    }
  }
  return {
    error: `no Chat tab "${parsed.tab}" in ${parsed.worktree} — it may have been closed or renamed; call list_tabs to see them`
  }
}

/** Human label for a worktree: alias when the user set one, else its branch. */
export function describeWorktree(state: AppState, worktreePath: string): string {
  const alias = state.aliases.byPath[worktreePath]
  if (alias) return alias
  const wt = state.worktrees.list.find((w) => w.path === worktreePath)
  return wt?.branch || worktreePath
}

export type TabDeliveryFailure =
  | 'no-tab'
  | 'not-agent-tab'
  | 'terminal-unsupported'
  | 'wake-failed'

export type TabDeliveryResult =
  | { ok: true; tabId: string; woke: boolean }
  | { ok: false; reason: TabDeliveryFailure }


/** Deliver a message into one specific Chat tab, waking or restarting
 *  it as needed. A json-claude tab's id is its session id. Terminal agent
 *  tabs are refused: typing into a running TUI unattended is too
 *  unreliable (it can land in a permission prompt or a half-typed draft).
 *
 *  Same cost caveat as deliverToWorktreeChat: waking spawns a subprocess,
 *  so never call this from inside a store listener. */
export function deliverToTab(
  state: AppState,
  deps: ChatDeliveryDeps,
  worktreePath: string,
  tabId: string,
  message: string
): TabDeliveryResult {
  if (deps.hasSession(tabId) && state.jsonClaude.sessions[tabId]?.worktreePath === worktreePath) {
    deps.send(tabId, message)
    return { ok: true, tabId, woke: false }
  }
  const tab = findTabInWorktree(state, worktreePath, tabId)
  if (!tab) return { ok: false, reason: 'no-tab' }
  if (tab.type === 'agent') return { ok: false, reason: 'terminal-unsupported' }
  if (tab.type !== 'json-claude') return { ok: false, reason: 'not-agent-tab' }
  if ((tab.mode ?? 'awake') === 'asleep') deps.wake(worktreePath, tabId)
  else deps.respawn(worktreePath, tabId)
  // Only a start that never began (or already failed) is a failure; one
  // still in flight receives the message through `send` once it's up.
  // That makes `ok` optimistic: if the start later fails, the gate drops
  // the held send and logs it under [json-claude], after the caller has
  // already been told it was delivered.
  if (!deps.hasSession(tabId) && !deps.isStarting(tabId)) return { ok: false, reason: 'wake-failed' }
  deps.send(tabId, message)
  return { ok: true, tabId, woke: true }
}

/** Human-readable reason, phrased for an agent or a toast. */
export function describeTabDeliveryFailure(reason: TabDeliveryFailure): string {
  switch (reason) {
    case 'no-tab':
      return 'that tab no longer exists in this worktree'
    case 'not-agent-tab':
      return 'that tab is not an agent tab'
    case 'terminal-unsupported':
      return 'terminal tabs cannot receive reviews or messages — only Chat tabs can'
    case 'wake-failed':
      return "failed to start that Chat tab's agent"
  }
}

/** Route a message to a worktree's agent chat, waking a slept tab if that's
 *  what it takes. Every persisted json-claude tab hydrates as 'asleep' at
 *  app launch and the auto-sleep monitor puts idle ones back to sleep, so
 *  "no live session" is the *normal* state for the worktrees these callers
 *  care about — refusing to wake would make them fire almost never.
 *
 *  Waking spawns a subprocess and replays a transcript from disk, so this
 *  is far too much work to run inside a store listener. Callers reached
 *  from a store subscription must hop off the fan-out first. */
export function deliverToWorktreeChat(
  state: AppState,
  deps: ChatDeliveryDeps,
  worktreePath: string,
  message: string
): ChatDeliveryResult {
  const tabId =
    pickLiveSession(state, deps, worktreePath) ??
    pickStartingTab(state, deps, worktreePath) ??
    pickSleptTab(state, worktreePath)
  // No chat tab at all — a terminal-only worktree.
  if (!tabId) return { ok: false, reason: 'no-chat-tab' }
  const result = deliverToTab(state, deps, worktreePath, tabId, message)
  if (!result.ok) return { ok: false, reason: 'wake-failed' }
  return { ok: true, sessionId: tabId, woke: result.woke }
}
