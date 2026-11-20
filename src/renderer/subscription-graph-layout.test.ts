import { describe, it, expect } from 'vitest'
import { layoutSubscriptionGraph, liftEdges, stackOrder, NODE_SIZE } from './subscription-graph-layout'
import type { GraphEdge, GraphGroup, GraphNode, SubscriptionGraph } from '../shared/subscription-graph'

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

const group = (id: string): GraphGroup => ({
  id,
  path: id,
  name: id,
  branch: id,
  isMain: false,
  external: false,
  status: 'idle',
  merged: false
})

describe('layoutSubscriptionGraph', () => {
  it('stacks members inside their group and lays groups out left to right along edges', async () => {
    const a1 = { ...agent('a1'), groupId: 'A' }
    const a2 = { ...agent('a2'), groupId: 'A' }
    const b1 = { ...agent('b1'), groupId: 'B' }
    const prA = { ...pr, groupId: 'A' }
    const g: SubscriptionGraph = {
      groups: [group('A'), group('B')],
      nodes: [a1, a2, prA, b1],
      edges: [
        // Two edges between the same pair of groups and one inside A: the
        // group-level graph ELK sees must hold a single A→B edge.
        edge('subscription', 'a1', 'B'),
        { ...edge('spawned', 'a2', 'B'), id: 'spawn:a2' },
        edge('own-pr', 'a1', 'pr')
      ]
    }
    expect(liftEdges(g, new Map([['a1', 'A'], ['a2', 'A'], ['pr', 'A'], ['b1', 'B']]))).toEqual([
      { id: 'subscription:a1', sources: ['A'], targets: ['B'] }
    ])
    const boxes = await layoutSubscriptionGraph(g, 1)
    // Children are group-relative: one column at the left padding, in
    // stack order (the PR follower last among agents, the PR at the bottom).
    for (const id of ['a1', 'a2', 'pr', 'b1']) expect(boxes[id].x).toBe(NODE_SIZE.groupPad)
    expect(boxes.a2.y).toBe(NODE_SIZE.groupHeader)
    expect(boxes.a1.y).toBeGreaterThan(boxes.a2.y)
    expect(boxes.pr.y).toBeGreaterThan(boxes.a1.y)
    // The group fits its stack.
    expect(boxes.A.height).toBe(boxes.pr.y + boxes.pr.height + NODE_SIZE.groupPad)
    // B comes after A in the layered direction.
    expect(boxes.B.x).toBeGreaterThan(boxes.A.x + boxes.A.width)
  })
})
