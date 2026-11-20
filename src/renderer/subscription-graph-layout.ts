import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js'
import type { SubscriptionGraph } from '../shared/subscription-graph'

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** Node sizes in CSS px at the default 16px root. Multiplied by the live
 *  root font-size ratio so rem-sized text inside still fits at every
 *  uiScale rung. */
export const NODE_SIZE = {
  agent: { width: 220, height: 44 },
  pr: { width: 220, height: 52 },
  groupHeader: 40,
  groupPad: 12,
  gap: 16
}

const elk = new ELK()

/** Positions for every group and node. Groups are absolute; their
 *  children are relative to the group, which is what React Flow's
 *  `parentId` expects.
 *
 *  Two passes: each worktree stacks its agents and PR in a column, then
 *  ELK places the worktree boxes with edges lifted to worktree level.
 *  Laying the members out inside ELK too put each PR in a layer of its
 *  own, which doubled the width of every worktree and of the graph. */
export async function layoutSubscriptionGraph(
  g: SubscriptionGraph,
  scale: number
): Promise<Record<string, Box>> {
  const s = (n: number): number => Math.round(n * scale)
  const pad = s(NODE_SIZE.groupPad)
  const gap = s(NODE_SIZE.gap)
  const boxes: Record<string, Box> = {}
  const groupOf = new Map<string, string>()

  const children: ElkNode[] = g.groups.map((group) => {
    let y = s(NODE_SIZE.groupHeader)
    const width = s(NODE_SIZE.agent.width) + 2 * pad
    for (const n of g.nodes) {
      if (n.groupId !== group.id) continue
      groupOf.set(n.id, group.id)
      const size = NODE_SIZE[n.kind]
      boxes[n.id] = { x: pad, y, width: s(size.width), height: s(size.height) }
      y += s(size.height) + gap
    }
    const height = y === s(NODE_SIZE.groupHeader) ? y : y - gap + pad
    return { id: group.id, width, height }
  })

  const seen = new Set<string>()
  const edges: { id: string; sources: string[]; targets: string[] }[] = []
  for (const e of g.edges) {
    const a = groupOf.get(e.source) ?? e.source
    const b = groupOf.get(e.target) ?? e.target
    if (a === b || seen.has(`${a}>${b}`)) continue
    seen.add(`${a}>${b}`)
    edges.push({ id: e.id, sources: [a], targets: [b] })
  }

  const out = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': String(s(64)),
      'elk.spacing.nodeNode': String(s(20)),
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.separateConnectedComponents': 'true',
      'elk.spacing.componentComponent': String(s(32))
    },
    children,
    edges
  })
  for (const group of out.children ?? []) {
    boxes[group.id] = {
      x: group.x ?? 0,
      y: group.y ?? 0,
      width: group.width ?? 0,
      height: group.height ?? 0
    }
  }
  return boxes
}
