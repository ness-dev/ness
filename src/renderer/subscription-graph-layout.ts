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
  pr: { width: 220, height: 56 },
  emptyGroup: { width: 220, height: 28 },
  groupHeader: 40,
  groupPad: 12
}

const elk = new ELK()

/** Positions for every group and node. Groups are absolute; their
 *  children are relative to the group, which is what React Flow's
 *  `parentId` expects. Edges are routed by React Flow, so ELK's edge
 *  sections are ignored — ELK only needs them to order the layers. */
export async function layoutSubscriptionGraph(
  g: SubscriptionGraph,
  scale: number
): Promise<Record<string, Box>> {
  const s = (n: number): number => Math.round(n * scale)
  const pad = s(NODE_SIZE.groupPad)
  const children: ElkNode[] = g.groups.map((group) => {
    const members = g.nodes.filter((n) => n.groupId === group.id)
    return {
      id: group.id,
      layoutOptions: {
        'elk.padding': `[top=${s(NODE_SIZE.groupHeader)},left=${pad},bottom=${pad},right=${pad}]`,
        'elk.nodeSize.constraints': 'MINIMUM_SIZE',
        'elk.nodeSize.minimum': `(${s(NODE_SIZE.emptyGroup.width) + 2 * pad}, ${s(NODE_SIZE.groupHeader + NODE_SIZE.emptyGroup.height)})`
      },
      children: members.map((n) => ({
        id: n.id,
        width: s(NODE_SIZE[n.kind].width),
        height: s(NODE_SIZE[n.kind].height)
      }))
    }
  })
  const root: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.layered.spacing.nodeNodeBetweenLayers': String(s(72)),
      'elk.spacing.nodeNode': String(s(20)),
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.separateConnectedComponents': 'true',
      'elk.spacing.componentComponent': String(s(40))
    },
    children,
    edges: g.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] }))
  }
  const out = await elk.layout(root)
  const boxes: Record<string, Box> = {}
  for (const group of out.children ?? []) {
    boxes[group.id] = {
      x: group.x ?? 0,
      y: group.y ?? 0,
      width: group.width ?? 0,
      height: group.height ?? 0
    }
    for (const n of group.children ?? []) {
      boxes[n.id] = { x: n.x ?? 0, y: n.y ?? 0, width: n.width ?? 0, height: n.height ?? 0 }
    }
  }
  return boxes
}
