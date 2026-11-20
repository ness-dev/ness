import { describe, it, expect } from 'vitest'
import { initialState, type AppState } from './state'
import type { PRStatus } from './state/prs'
import type { Worktree } from './state/worktrees'
import type { PaneNode, TerminalTab } from './state/terminals'
import type { ReviewSubmission } from './state/reviews'
import {
  agentId,
  buildSubscriptionGraph,
  filterSubscriptionGraph,
  graphTopologyKey,
  groupId,
  prId,
  type GraphEdge
} from './subscription-graph'

const REPO = '/repo'
const OTHER = '/other'
const A = '/repo-wt/a'
const B = '/repo-wt/b'
const X = '/other-wt/x'

function wt(path: string, branch: string, repoRoot = REPO): Worktree {
  return { path, branch, head: 'h', isBare: false, isMain: false, createdAt: 0, repoRoot }
}

function chat(id: string, over: Partial<TerminalTab> = {}): TerminalTab {
  return { id, type: 'json-claude', label: 'Chat', ...over }
}

function leaf(...tabs: TerminalTab[]): PaneNode {
  return { type: 'leaf', id: `p-${tabs[0]?.id ?? 'x'}`, tabs, activeTabId: tabs[0]?.id ?? '' }
}

function pr(over: Partial<PRStatus> = {}): PRStatus {
  return {
    number: 7,
    title: 'Add a thing',
    state: 'open',
    url: 'https://github.com/o/r/pull/7',
    branch: 'b',
    author: null,
    checks: [],
    checksOverall: 'success',
    hasConflict: false,
    reviews: [],
    reviewDecision: 'none',
    baseBranch: 'main',
    isDefaultBase: true,
    assignees: [],
    linkedIssues: [],
    labels: [],
    ...over
  }
}

function state(over: Partial<AppState> = {}, panes?: Record<string, PaneNode>): AppState {
  return {
    ...initialState,
    worktrees: {
      ...initialState.worktrees,
      list: [wt(A, 'a'), wt(B, 'b'), wt(X, 'x', OTHER)],
      repoRoots: [REPO, OTHER]
    },
    terminals: {
      ...initialState.terminals,
      panes: panes ?? { [A]: leaf(chat('ta')), [B]: leaf(chat('tb')), [X]: leaf(chat('tx')) }
    },
    ...over
  }
}

function edgesOf(s: AppState, kind: GraphEdge['kind']): GraphEdge[] {
  return buildSubscriptionGraph(s, REPO).edges.filter((e) => e.kind === kind)
}

describe('buildSubscriptionGraph', () => {
  it('groups agents by worktree and filters to one project', () => {
    const g = buildSubscriptionGraph(state(), REPO)
    expect(g.groups.map((x) => x.path)).toEqual([A, B])
    expect(g.nodes.map((n) => [n.id, n.groupId])).toEqual([
      [agentId('ta'), groupId(A)],
      [agentId('tb'), groupId(B)]
    ])
    expect(g.edges).toEqual([])
  })

  it('includes terminal agents but not shells', () => {
    const s = state({}, {
      [A]: leaf(chat('ta'), { id: 'term', type: 'agent', label: 'Claude' }, { id: 'sh', type: 'shell', label: 'Shell' })
    })
    const nodes = buildSubscriptionGraph(s, REPO).nodes
    expect(nodes.map((n) => n.id)).toEqual([agentId('ta'), agentId('term')])
    expect(nodes[1]).toMatchObject({ kind: 'agent', chat: false })
  })

  it('draws an explicit subscription edge with its mode and note', () => {
    const s = state({
      subscriptions: {
        list: [{ id: 's1', subscriberPath: A, subscriberTabId: 'ta', targetPath: B, note: 'API shape', mode: 'silent', createdAt: 1 }]
      }
    })
    expect(edgesOf(s, 'subscription')).toEqual([
      { id: 'sub:s1', kind: 'subscription', source: agentId('ta'), target: groupId(B), live: true, mode: 'silent', note: 'API shape' }
    ])
  })

  it('drops subscriptions from tabs that no longer exist', () => {
    const s = state({
      subscriptions: {
        list: [{ id: 's1', subscriberPath: A, subscriberTabId: 'gone', targetPath: B, createdAt: 1 }]
      }
    })
    const g = buildSubscriptionGraph(s, REPO)
    expect(g.edges).toEqual([])
    expect(g.nodes.some((n) => n.id === agentId('gone'))).toBe(false)
  })

  it('draws a spawned edge from the creating agent, falling back to its worktree once the tab closes', () => {
    const origins = { byPath: { [B]: { creatorPath: A, creatorTabId: 'ta', createdAt: 1 } } }
    expect(edgesOf(state({ origins }), 'spawned')).toEqual([
      { id: `spawn:${B}`, kind: 'spawned', source: agentId('ta'), target: groupId(B), live: true }
    ])
    const closed = state({ origins }, { [A]: leaf(chat('other')), [B]: leaf(chat('tb')) })
    expect(edgesOf(closed, 'spawned')).toEqual([
      {
        id: `spawn:${B}`,
        kind: 'spawned',
        source: groupId(A),
        target: groupId(B),
        live: false,
        notLiveReason: 'creator-closed'
      }
    ])
    // The created-worktree follow is the spawn edge, not a second edge.
    expect(edgesOf(state({ origins }), 'subscription')).toEqual([])
  })

  it('marks a spawn from a terminal agent as not live, but still draws it from that tab', () => {
    const origins = { byPath: { [B]: { creatorPath: A, creatorTabId: 'term', createdAt: 1 } } }
    const s = state({ origins }, {
      [A]: leaf({ id: 'term', type: 'agent', label: 'Claude' }),
      [B]: leaf(chat('tb'))
    })
    expect(edgesOf(s, 'spawned')).toEqual([
      {
        id: `spawn:${B}`,
        kind: 'spawned',
        source: agentId('term'),
        target: groupId(B),
        live: false,
        notLiveReason: 'terminal-creator'
      }
    ])
  })

  it('links an agent to its own PR only while it follows it', () => {
    const prs = { ...initialState.prs, byPath: { [A]: pr() } }
    const off = buildSubscriptionGraph(state({ prs }), REPO)
    expect(off.nodes.find((n) => n.id === prId(A))).toMatchObject({ kind: 'pr', number: 7, groupId: groupId(A) })
    expect(off.edges).toEqual([])
    const on = state({ prs, settings: { ...initialState.settings, notifyChatOnCiFailure: true } })
    expect(edgesOf(on, 'own-pr')).toEqual([
      { id: 'own:ta', kind: 'own-pr', source: agentId('ta'), target: prId(A), live: true, mode: 'silent' }
    ])
  })

  it('links a reviewer tab to the tab it reviews, with its latest sent verdict', () => {
    const sub = (verdict: ReviewSubmission['verdict'], st: ReviewSubmission['state']): ReviewSubmission => ({
      id: verdict,
      author: { kind: 'agent', tabId: 'rev' },
      verdict,
      summary: '',
      commentIds: [],
      createdAt: 1,
      state: st
    })
    const s = state(
      {
        reviews: {
          byPath: {
            [A]: { comments: [], submissions: [sub('changes-requested', 'sent'), sub('approve', 'draft')] }
          }
        }
      },
      { [A]: leaf(chat('ta'), chat('rev', { reviewOf: 'ta' })), [B]: leaf(chat('tb')) }
    )
    expect(edgesOf(s, 'review')).toEqual([
      { id: 'review:rev', kind: 'review', source: agentId('rev'), target: agentId('ta'), live: true, verdict: 'changes-requested' }
    ])
  })

  it('pulls in a worktree from another project as an external group', () => {
    const s = state({
      subscriptions: {
        list: [{ id: 's1', subscriberPath: X, subscriberTabId: 'tx', targetPath: A, createdAt: 1 }]
      }
    })
    const g = buildSubscriptionGraph(s, REPO)
    expect(g.groups.find((x) => x.path === X)).toMatchObject({ external: true })
    expect(g.edges[0]).toMatchObject({ source: agentId('tx'), target: groupId(A) })
    // Unrelated other-project subscriptions don't leak in.
    const unrelated = state({
      subscriptions: {
        list: [{ id: 's2', subscriberPath: X, subscriberTabId: 'tx', targetPath: X + '2', createdAt: 1 }]
      }
    })
    expect(buildSubscriptionGraph(unrelated, REPO).groups.map((x) => x.path)).toEqual([A, B])
  })

  it('rolls the worst agent status up to the worktree', () => {
    const s = state({
      terminals: {
        ...initialState.terminals,
        panes: { [A]: leaf(chat('t1'), chat('t2')) },
        statuses: { t1: 'processing', t2: 'needs-approval' }
      }
    })
    expect(buildSubscriptionGraph(s, REPO).groups[0].status).toBe('needs-approval')
  })

  it('keeps the topology key stable across status changes', () => {
    const a = buildSubscriptionGraph(state(), REPO)
    const b = buildSubscriptionGraph(
      state({ terminals: { ...state().terminals, statuses: { ta: 'processing' } } }),
      REPO
    )
    expect(graphTopologyKey(a)).toBe(graphTopologyKey(b))
  })
})

describe('filterSubscriptionGraph', () => {
  const C = '/repo-wt/c'
  const D = '/repo-wt/d'
  function big(): AppState {
    return {
      ...initialState,
      worktrees: {
        ...initialState.worktrees,
        list: [wt(A, 'a'), wt(B, 'b'), wt(C, 'c'), wt(D, 'd')],
        repoRoots: [REPO]
      },
      terminals: {
        ...initialState.terminals,
        panes: { [A]: leaf(chat('ta')), [B]: leaf(chat('tb')), [C]: leaf(chat('tc')), [D]: leaf(chat('td')) }
      },
      // A created B; C is merged and on its own; D is on its own.
      origins: { byPath: { [B]: { creatorPath: A, creatorTabId: 'ta', createdAt: 1 } } },
      prs: { ...initialState.prs, mergedByPath: { [C]: true } }
    }
  }
  const paths = (g: { groups: { path: string }[] }): string[] => g.groups.map((x) => x.path)

  it('hides merged and unlinked worktrees by default, and counts them', () => {
    const r = filterSubscriptionGraph(buildSubscriptionGraph(big(), REPO), {
      showMerged: false,
      showUnlinked: false
    })
    expect(paths(r.graph)).toEqual([A, B])
    expect(r.hidden).toEqual({ merged: 1, unlinked: 1 })
  })

  it('shows everything with both toggles on', () => {
    const g = buildSubscriptionGraph(big(), REPO)
    const r = filterSubscriptionGraph(g, { showMerged: true, showUnlinked: true })
    expect(r.graph).toEqual(g)
    expect(r.hidden).toEqual({ merged: 0, unlinked: 0 })
  })

  it('hides a merged worktree even though an unmerged one spawned it', () => {
    const s = big()
    s.prs = { ...s.prs, mergedByPath: { [B]: true, [C]: true } }
    const g = buildSubscriptionGraph(s, REPO)
    // A's creator tab is a live Chat tab, so this is the implicit follow.
    expect(g.edges.find((e) => e.kind === 'spawned')).toMatchObject({ source: agentId('ta'), live: true })
    const r = filterSubscriptionGraph(g, { showMerged: false, showUnlinked: true })
    expect(paths(r.graph)).toEqual([A, D])
    expect(r.hidden.merged).toBe(2)
    // With its spawned child gone, A has nothing left to link to.
    const both = filterSubscriptionGraph(g, { showMerged: false, showUnlinked: false })
    expect(paths(both.graph)).toEqual([])
    expect(both.hidden).toEqual({ merged: 2, unlinked: 2 })
  })

  it('keeps a merged worktree an unmerged agent still subscribes to', () => {
    const s = big()
    s.prs = { ...s.prs, mergedByPath: { [B]: true, [C]: true } }
    s.subscriptions = {
      list: [{ id: 's1', subscriberPath: D, subscriberTabId: 'td', targetPath: C, createdAt: 1 }]
    }
    const r = filterSubscriptionGraph(buildSubscriptionGraph(s, REPO), {
      showMerged: false,
      showUnlinked: false
    })
    expect(paths(r.graph)).toEqual([C, D])
    expect(r.hidden).toEqual({ merged: 1, unlinked: 1 })
  })

  it('treats a closed, unmerged PR as merged, like the sidebar', () => {
    const s = big()
    s.prs = { ...s.prs, byPath: { [D]: pr({ state: 'closed' }) } }
    const g = buildSubscriptionGraph(s, REPO)
    // D is labelled closed; C, merged locally, is labelled merged.
    expect(g.groups.find((x) => x.path === D)).toMatchObject({ merged: true, closed: true })
    expect(g.groups.find((x) => x.path === C)).toMatchObject({ merged: true, closed: false })
    const r = filterSubscriptionGraph(g, { showMerged: false, showUnlinked: true })
    expect(paths(r.graph)).toEqual([A, B])
    expect(r.hidden.merged).toBe(2)
  })

  it("doesn't count a worktree's own PR edge as a link", () => {
    const s = { ...big(), origins: { byPath: {} } }
    s.prs = { ...s.prs, byPath: { [A]: pr() } }
    s.settings = { ...s.settings, notifyChatOnCiFailure: true }
    const r = filterSubscriptionGraph(buildSubscriptionGraph(s, REPO), {
      showMerged: true,
      showUnlinked: false
    })
    expect(r.graph.groups).toEqual([])
    expect(r.hidden.unlinked).toBe(4)
  })
})
