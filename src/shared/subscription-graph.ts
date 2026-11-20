import type { AppState } from './state'
import type { PRStatus } from './state/prs'
import type { NotifyMode } from './state/subscriptions'
import type { ReviewVerdict } from './state/reviews'
import { getLeaves, type AgentKind, type PtyStatus, type TerminalTab } from './state/terminals'
import { findTabInWorktree, tabLabel } from './agent-tabs'
import { followedTargets, subscribersOf } from './subscribers'

// The subscription graph for one project: every agent, grouped by
// worktree, with an edge to everything it follows or is connected to.
// A pure derivation over existing slices — nothing here is stored.
//
// Subscriptions are read through shared/subscribers.ts so implicit ones
// (created-worktree, own-worktree) show up exactly as delivery sees them.

/** A worktree, drawn as a group box around its agents and PR. External
 *  groups are worktrees in other repos that something in this project
 *  is connected to; they carry only the nodes that the edge needs. */
export interface GraphGroup {
  id: string
  path: string
  name: string
  branch: string
  isMain: boolean
  external: boolean
  /** Worst status across the worktree's agent tabs. */
  status: PtyStatus
  merged: boolean
}

export interface GraphAgentNode {
  kind: 'agent'
  id: string
  groupId: string
  worktreePath: string
  tabId: string
  label: string
  agentKind: AgentKind
  /** Chat tab (json-mode) rather than a terminal agent. Only Chat tabs
   *  can subscribe or be delivered to. */
  chat: boolean
  status: PtyStatus
  asleep: boolean
  reviewer: boolean
}

export interface GraphPRNode {
  kind: 'pr'
  id: string
  groupId: string
  worktreePath: string
  number: number
  title: string
  url: string
  state: PRStatus['state']
  checks: PRStatus['checksOverall']
  hasConflict: boolean | null
  reviewDecision: PRStatus['reviewDecision']
}

export type GraphNode = GraphAgentNode | GraphPRNode

/** - subscription: an explicit subscribe_to_worktree, agent → worktree
 *  - spawned: the agent (or, once that tab is gone, its worktree) created
 *    the target worktree; `live` while that still makes it a follower
 *  - own-pr: a worktree's author tab follows its PR (CI notify on)
 *  - review: a reviewer tab → the tab whose work it reviews */
export type GraphEdgeKind = 'subscription' | 'spawned' | 'own-pr' | 'review'

export interface GraphEdge {
  id: string
  kind: GraphEdgeKind
  source: string
  target: string
  live: boolean
  mode?: NotifyMode
  note?: string
  /** Spawned edges that aren't `live`: why. A closed creator tab falls
   *  back to its worktree; a terminal-agent creator is still open but
   *  can't receive updates. */
  notLiveReason?: 'creator-closed' | 'terminal-creator'
  /** Review edges: the reviewer's latest submitted verdict. */
  verdict?: ReviewVerdict
}

export interface SubscriptionGraph {
  groups: GraphGroup[]
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export const groupId = (path: string): string => `wt:${path}`
export const agentId = (tabId: string): string => `tab:${tabId}`
export const prId = (path: string): string => `pr:${path}`

const STATUS_RANK: Record<PtyStatus, number> = {
  idle: 0,
  processing: 1,
  waiting: 2,
  'needs-approval': 3
}

function isAgentTab(tab: TerminalTab): boolean {
  return tab.type === 'json-claude' || tab.type === 'agent'
}

function agentTabs(state: AppState, path: string): TerminalTab[] {
  const tree = state.terminals.panes[path]
  if (!tree) return []
  return getLeaves(tree).flatMap((l) => l.tabs.filter(isAgentTab))
}

function worktreeName(state: AppState, path: string, branch: string | undefined): string {
  return state.aliases.byPath[path] || branch || path.split('/').pop() || path
}

export function buildSubscriptionGraph(state: AppState, repoPath: string): SubscriptionGraph {
  const groups = new Map<string, GraphGroup>()
  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []
  const worktreeByPath = new Map(state.worktrees.list.map((w) => [w.path, w]))
  const inProject = (path: string): boolean => worktreeByPath.get(path)?.repoRoot === repoPath

  const ensureGroup = (path: string): GraphGroup | null => {
    const id = groupId(path)
    const existing = groups.get(id)
    if (existing) return existing
    const wt = worktreeByPath.get(path)
    if (!wt) return null
    const g: GraphGroup = {
      id,
      path,
      name: worktreeName(state, path, wt.branch),
      branch: wt.branch,
      isMain: wt.isMain,
      external: wt.repoRoot !== repoPath,
      status: 'idle',
      merged: !!state.prs.mergedByPath[path] || state.prs.byPath[path]?.state === 'merged'
    }
    groups.set(id, g)
    return g
  }

  const addAgent = (path: string, tab: TerminalTab): string | null => {
    const g = ensureGroup(path)
    if (!g) return null
    const id = agentId(tab.id)
    if (!nodes.has(id)) {
      const status = state.terminals.statuses[tab.id] ?? 'idle'
      nodes.set(id, {
        kind: 'agent',
        id,
        groupId: g.id,
        worktreePath: path,
        tabId: tab.id,
        label: tabLabel(tab),
        agentKind: tab.agentKind ?? 'claude',
        chat: tab.type === 'json-claude',
        status,
        asleep: tab.mode === 'asleep',
        reviewer: !!tab.reviewOf
      })
      if (STATUS_RANK[status] > STATUS_RANK[g.status]) g.status = status
    }
    return id
  }

  /** The node for a live tab, or null when the tab is gone. */
  const agentFor = (path: string, tabId: string): string | null => {
    const tab = findTabInWorktree(state, path, tabId)
    return tab && isAgentTab(tab) ? addAgent(path, tab) : null
  }

  const addPR = (path: string): string | null => {
    const pr = state.prs.byPath[path]
    const g = ensureGroup(path)
    if (!pr || !g) return null
    const id = prId(path)
    if (!nodes.has(id)) {
      nodes.set(id, {
        kind: 'pr',
        id,
        groupId: g.id,
        worktreePath: path,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        state: pr.state,
        checks: pr.checksOverall,
        hasConflict: pr.hasConflict,
        reviewDecision: pr.reviewDecision
      })
    }
    return id
  }

  // Every project worktree, its agents and its PR, in sidebar list order.
  for (const wt of state.worktrees.list) {
    if (wt.repoRoot !== repoPath || wt.prunable) continue
    ensureGroup(wt.path)
    for (const tab of agentTabs(state, wt.path)) addAgent(wt.path, tab)
    addPR(wt.path)
  }

  // Subscriptions, explicit and own-worktree. Created-worktree followers
  // are drawn from origins below, as the spawn edge they come from.
  for (const target of followedTargets(state)) {
    for (const s of subscribersOf(state, target)) {
      if (s.reason === 'created-worktree') continue
      if (!inProject(s.subscriberPath) && !inProject(s.targetPath)) continue
      const source = agentFor(s.subscriberPath, s.subscriberTabId)
      if (!source) continue
      if (s.reason === 'own-worktree') {
        const pr = addPR(s.targetPath)
        if (pr) {
          edges.push({ id: `own:${s.subscriberTabId}`, kind: 'own-pr', source, target: pr, live: true, mode: s.mode })
        }
        continue
      }
      const g = ensureGroup(s.targetPath)
      if (!g) continue
      edges.push({
        id: `sub:${s.explicitId ?? `${s.subscriberTabId}>${s.targetPath}`}`,
        kind: 'subscription',
        source,
        target: g.id,
        live: true,
        mode: s.mode,
        ...(s.note ? { note: s.note } : {})
      })
    }
  }

  for (const [path, o] of Object.entries(state.origins.byPath)) {
    if (!inProject(path) && !inProject(o.creatorPath)) continue
    const target = ensureGroup(path)
    if (!target) continue
    const tab = findTabInWorktree(state, o.creatorPath, o.creatorTabId)
    const live = tab?.type === 'json-claude'
    // Once the creator tab is closed the worktree still came from there,
    // so the edge falls back to the creator's worktree.
    const source = tab && isAgentTab(tab) ? addAgent(o.creatorPath, tab) : ensureGroup(o.creatorPath)?.id
    if (!source) continue
    edges.push({
      id: `spawn:${path}`,
      kind: 'spawned',
      source,
      target: target.id,
      live,
      ...(live ? {} : { notLiveReason: tab && isAgentTab(tab) ? 'terminal-creator' : 'creator-closed' })
    })
  }

  for (const g of [...groups.values()]) {
    if (g.external) continue
    const submissions = state.reviews.byPath[g.path]?.submissions ?? []
    for (const tab of agentTabs(state, g.path)) {
      if (tab.type !== 'json-claude' || !tab.reviewOf) continue
      const requester = agentFor(g.path, tab.reviewOf)
      const reviewer = agentFor(g.path, tab.id)
      if (!requester || !reviewer) continue
      let verdict: ReviewVerdict | undefined
      for (const sub of submissions) {
        if (sub.author.kind === 'agent' && sub.author.tabId === tab.id && sub.state === 'sent') {
          verdict = sub.verdict
        }
      }
      edges.push({
        id: `review:${tab.id}`,
        kind: 'review',
        source: reviewer,
        target: requester,
        live: true,
        ...(verdict ? { verdict } : {})
      })
    }
  }

  return { groups: [...groups.values()], nodes: [...nodes.values()], edges }
}

/** A key that changes only when the graph's shape does — the node and
 *  edge sets, not their labels or statuses. The view re-runs layout on
 *  this, so a status flip repaints without the boxes jumping around. */
export function graphTopologyKey(g: SubscriptionGraph): string {
  return [
    g.groups.map((x) => x.id).join(','),
    g.nodes.map((n) => `${n.groupId}/${n.id}`).join(','),
    g.edges.map((e) => `${e.source}>${e.target}`).join(',')
  ].join('|')
}

export interface GraphFilter {
  showMerged: boolean
  showUnlinked: boolean
}

export interface FilteredGraph {
  graph: SubscriptionGraph
  /** Worktrees each filter is hiding right now, for the toggles' counts. */
  hidden: { merged: number; unlinked: number }
}

/** Trims the graph for a project with many worktrees, where it's the links
 *  that matter. Applied in order:
 *    1. merged worktrees go, unless an unmerged one links to them; a live
 *       link into a merged worktree is still state worth seeing
 *    2. worktrees with no link to another worktree go; a worktree's own
 *       PR and reviewer edges don't count, they're inside the box
 *  Edges touching a hidden worktree go with it. */
export function filterSubscriptionGraph(g: SubscriptionGraph, f: GraphFilter): FilteredGraph {
  const groupOf = new Map<string, string>(g.groups.map((x) => [x.id, x.id]))
  for (const n of g.nodes) groupOf.set(n.id, n.groupId)
  const crossLinks = (edges: GraphEdge[]): Array<[string, string]> =>
    edges
      .map((e) => [groupOf.get(e.source), groupOf.get(e.target)] as const)
      .filter((p): p is readonly [string, string] => !!p[0] && !!p[1] && p[0] !== p[1])
      .map(([a, b]) => [a, b])

  const byId = new Map(g.groups.map((x) => [x.id, x]))
  const keep = new Set(g.groups.map((x) => x.id))
  let merged = 0
  if (!f.showMerged) {
    const linkedToUnmerged = new Set<string>()
    for (const [a, b] of crossLinks(g.edges)) {
      if (!byId.get(a)?.merged) linkedToUnmerged.add(b)
      if (!byId.get(b)?.merged) linkedToUnmerged.add(a)
    }
    for (const x of g.groups) {
      if (x.merged && !linkedToUnmerged.has(x.id)) {
        keep.delete(x.id)
        merged++
      }
    }
  }
  const live = (e: GraphEdge): boolean => {
    const a = groupOf.get(e.source)
    const b = groupOf.get(e.target)
    return !!a && !!b && keep.has(a) && keep.has(b)
  }
  let unlinked = 0
  if (!f.showUnlinked) {
    const linked = new Set(crossLinks(g.edges.filter(live)).flat())
    for (const id of [...keep]) {
      if (!linked.has(id)) {
        keep.delete(id)
        unlinked++
      }
    }
  }
  return {
    graph: {
      groups: g.groups.filter((x) => keep.has(x.id)),
      nodes: g.nodes.filter((n) => keep.has(n.groupId)),
      edges: g.edges.filter(live)
    },
    hidden: { merged, unlinked }
  }
}
