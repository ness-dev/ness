import { describe, it, expect } from 'vitest'
import { stackOrder } from './subscription-graph-layout'
import type { GraphEdge, GraphNode, SubscriptionGraph } from '../shared/subscription-graph'

const agent = (id: string): GraphNode => ({
  kind: 'agent',
  id,
  groupId: 'g',
  worktreePath: '/w',
  tabId: id,
  label: id,
  agentKind: 'claude',
  chat: true,
  status: 'idle',
  asleep: false,
  reviewer: false
})

const pr: GraphNode = {
  kind: 'pr',
  id: 'pr',
  groupId: 'g',
  worktreePath: '/w',
  number: 1,
  title: 't',
  url: 'u',
  state: 'open',
  checks: 'none',
  hasConflict: false,
  reviewDecision: 'none'
}

const edge = (kind: GraphEdge['kind'], source: string, target: string): GraphEdge => ({
  id: `${kind}:${source}`,
  kind,
  source,
  target,
  live: true
})

function order(nodes: GraphNode[], edges: GraphEdge[]): string[] {
  const g: SubscriptionGraph = { groups: [], nodes, edges }
  return stackOrder(g, 'g').map((n) => n.id)
}

describe('stackOrder', () => {
  it('puts the reviewer above its author and the author above the PR', () => {
    // Pane order is author, reviewer — which put the reviewer between the
    // author and its PR, so both arrows ran through the same card.
    expect(
      order([agent('author'), agent('rev'), pr], [edge('own-pr', 'author', 'pr'), edge('review', 'rev', 'author')])
    ).toEqual(['rev', 'author', 'pr'])
  })

  it('keeps pane order when there are no internal edges', () => {
    expect(order([agent('a'), agent('b'), pr], [])).toEqual(['a', 'b', 'pr'])
  })

  it('moves the PR follower to sit directly above the PR', () => {
    expect(order([agent('a'), agent('b'), pr], [edge('own-pr', 'a', 'pr')])).toEqual(['b', 'a', 'pr'])
  })
})
