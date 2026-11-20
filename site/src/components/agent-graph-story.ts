import type {
  GraphAgentNode,
  GraphEdge,
  GraphGroup,
  GraphNode,
  GraphPRNode,
  SubscriptionGraph
} from '../../../src/shared/subscription-graph'

// The story the orchestration section tells, as a subscription graph: the
// whole graph (laid out once, so boxes don't move as it's revealed) and the
// beats that reveal it. Pure data, shared by the mock and its layout test.

type Status = GraphAgentNode['status']

const REPO = '/code/ness'
const wt = (name: string): string => `${REPO}-worktrees/${name}`
export const PATHS = {
  main: REPO,
  cookies: wt('session-cookies'),
  webhooks: wt('billing-webhooks'),
  docs: wt('auth-docs')
}

function group(id: keyof typeof PATHS, name: string, branch: string, isMain = false): GraphGroup {
  return {
    id: `wt:${PATHS[id]}`,
    path: PATHS[id],
    name,
    branch,
    isMain,
    external: false,
    status: 'idle',
    merged: false
  }
}

function agent(id: string, g: keyof typeof PATHS, label: string, reviewer = false): GraphAgentNode {
  return {
    kind: 'agent',
    id: `tab:${id}`,
    groupId: `wt:${PATHS[g]}`,
    worktreePath: PATHS[g],
    tabId: id,
    label,
    agentKind: 'claude',
    chat: true,
    status: 'idle',
    asleep: false,
    reviewer
  }
}

function pr(g: keyof typeof PATHS, number: number, title: string): GraphPRNode {
  return {
    kind: 'pr',
    id: `pr:${PATHS[g]}`,
    groupId: `wt:${PATHS[g]}`,
    worktreePath: PATHS[g],
    number,
    title,
    url: '',
    state: 'open',
    checks: 'pending',
    hasConflict: false,
    reviewDecision: 'none'
  }
}

/** The whole story's graph: an orchestrator on main that spun up three
 *  worktrees, one with CI running, one under review, one following a
 *  sibling. Laid out once, so boxes don't move as the story reveals them. */
export const FULL: SubscriptionGraph = {
  groups: [
    group('main', 'ness', 'main', true),
    group('cookies', 'session-cookies', 'session-cookies'),
    group('webhooks', 'billing-webhooks', 'billing-webhooks'),
    group('docs', 'auth-docs', 'auth-docs')
  ],
  nodes: [
    agent('orch', 'main', 'Orchestrator'),
    agent('cookies', 'cookies', 'Signed cookies'),
    agent('webhooks', 'webhooks', 'Webhook retries'),
    agent('review', 'webhooks', 'Review', true),
    agent('docs', 'docs', 'Auth docs'),
    pr('cookies', 412, 'Move sessions to signed cookies'),
    pr('webhooks', 413, 'Retry failed Stripe webhooks')
  ],
  edges: [
    {
      id: 'spawn:cookies',
      kind: 'spawned',
      source: 'tab:orch',
      target: `wt:${PATHS.cookies}`,
      live: true
    },
    {
      id: 'spawn:webhooks',
      kind: 'spawned',
      source: 'tab:orch',
      target: `wt:${PATHS.webhooks}`,
      live: true
    },
    {
      id: 'spawn:docs',
      kind: 'spawned',
      source: 'tab:orch',
      target: `wt:${PATHS.docs}`,
      live: true
    },
    {
      id: 'own:cookies',
      kind: 'own-pr',
      source: 'tab:cookies',
      target: `pr:${PATHS.cookies}`,
      live: true
    },
    {
      id: 'own:webhooks',
      kind: 'own-pr',
      source: 'tab:webhooks',
      target: `pr:${PATHS.webhooks}`,
      live: true
    },
    {
      id: 'review:review',
      kind: 'review',
      source: 'tab:review',
      target: 'tab:webhooks',
      live: true
    },
    {
      id: 'sub:docs>cookies',
      kind: 'subscription',
      source: 'tab:docs',
      target: `wt:${PATHS.cookies}`,
      live: true,
      mode: 'interrupt',
      note: 'the final cookie format, to document it'
    }
  ]
}

interface Beat {
  ms: number
  caption: string
  /** Node, group and edge ids on screen from this beat on. */
  adds: string[]
  status: Partial<Record<string, Status>>
  prs?: Partial<Record<string, Partial<GraphPRNode>>>
  verdict?: GraphEdge['verdict']
}

export const BEATS: Beat[] = [
  {
    ms: 2200,
    caption: 'You ask the orchestrator on main to ship sessions, billing and docs.',
    adds: [`wt:${PATHS.main}`, 'tab:orch'],
    status: { orch: 'processing' }
  },
  {
    ms: 1500,
    caption: 'It calls create_worktree with a briefing. A new agent starts on its own branch.',
    adds: [`wt:${PATHS.webhooks}`, 'tab:webhooks', 'spawn:webhooks'],
    status: { orch: 'processing', webhooks: 'processing' }
  },
  {
    ms: 1500,
    caption: 'Then another…',
    adds: [`wt:${PATHS.docs}`, 'tab:docs', 'spawn:docs'],
    status: { orch: 'processing', webhooks: 'processing', docs: 'processing' }
  },
  {
    ms: 2400,
    caption: '…and another. The orchestrator follows every worktree it created.',
    adds: [`wt:${PATHS.cookies}`, 'tab:cookies', 'spawn:cookies'],
    status: { orch: 'idle', webhooks: 'processing', docs: 'processing', cookies: 'processing' }
  },
  {
    ms: 2800,
    caption: 'A PR goes up. Its own agent hears about CI, and so does the orchestrator.',
    adds: [`pr:${PATHS.cookies}`, 'own:cookies'],
    status: { cookies: 'idle', webhooks: 'processing', docs: 'processing' }
  },
  {
    ms: 3000,
    caption: 'Billing calls request_review. A reviewer agent opens next to it and reads the diff.',
    adds: ['tab:review', 'review:review', `pr:${PATHS.webhooks}`, 'own:webhooks'],
    status: { webhooks: 'idle', review: 'processing', docs: 'processing' }
  },
  {
    ms: 3000,
    caption: 'The docs agent calls subscribe_to_worktree on cookies, so it knows when the format lands.',
    adds: ['sub:docs>cookies'],
    status: { review: 'processing', docs: 'waiting' }
  },
  {
    ms: 4200,
    caption: 'CI goes green. The reviewer’s verdict goes back to the author, who gets to work.',
    adds: [],
    status: { webhooks: 'processing', review: 'idle', docs: 'processing' },
    prs: { cookies: { checks: 'success' }, webhooks: { checks: 'success' } },
    verdict: 'changes-requested'
  }
]

const RANK: Record<Status, number> = {
  idle: 0,
  processing: 1,
  waiting: 2,
  'needs-approval': 3
}

/** The graph as of `beat`, plus which ids are still to come. Statuses and
 *  PR fields accumulate across beats, like the real thing. */
export function graphAt(beat: number): {
  graph: SubscriptionGraph
  shown: Set<string>
} {
  const shown = new Set<string>()
  const status: Record<string, Status> = {}
  const prs: Record<string, Partial<GraphPRNode>> = {}
  let verdict: GraphEdge['verdict']
  for (const b of BEATS.slice(0, beat + 1)) {
    b.adds.forEach((id) => shown.add(id))
    Object.assign(status, b.status)
    for (const [k, v] of Object.entries(b.prs ?? {})) prs[k] = { ...prs[k], ...v }
    verdict = b.verdict ?? verdict
  }
  const nodes: GraphNode[] = FULL.nodes.map((n) => {
    if (n.kind === 'agent') return { ...n, status: status[n.tabId] ?? 'idle' }
    const key = (Object.keys(PATHS) as (keyof typeof PATHS)[]).find((k) => PATHS[k] === n.worktreePath)
    return { ...n, ...(key ? prs[key] : {}) }
  })
  const groups = FULL.groups.map((g) => {
    let s: Status = 'idle'
    for (const n of nodes) {
      if (n.kind === 'agent' && n.groupId === g.id && shown.has(n.id) && RANK[n.status] > RANK[s])
        s = n.status
    }
    return { ...g, status: s }
  })
  const edges = FULL.edges.map((e) => (e.kind === 'review' && verdict ? { ...e, verdict } : e))
  return { graph: { groups, nodes, edges }, shown }
}
