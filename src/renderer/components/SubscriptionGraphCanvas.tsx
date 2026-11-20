import { createContext, memo, useContext } from 'react'
import {
  Handle,
  Position,
  BaseEdge,
  getBezierPath,
  MarkerType,
  type Node,
  type Edge,
  type NodeProps,
  type EdgeProps
} from '@xyflow/react'
import '@xyflow/react/dist/base.css'
import './subscription-graph.css'
import { GitPullRequest, Loader2, Moon, SquareTerminal } from 'lucide-react'
import { AgentIcon } from './AgentIcon'
import { STATUS_COLORS, STATUS_LABELS, prIconStyle } from '../worktree-row-style'
import type { PRStatus } from '../types'
import type {
  GraphAgentNode,
  GraphEdge,
  GraphEdgeKind,
  GraphGroup,
  GraphPRNode,
  SubscriptionGraph
} from '../../shared/subscription-graph'
import type { Box } from '../subscription-graph-layout'

// The subscription graph's drawing: node and edge renderers, the
// graph → React Flow conversion, and the fit maths. The marketing site
// imports this file (site/src/components/AgentGraphMock.tsx) to draw the
// same cards from a fixture, so keep it free of the store, the backend and
// anything else that only exists inside the app. CI typechecks and builds
// the site to catch a slip.

export type GroupFlowNode = Node<{ group: GraphGroup }, 'worktree'>
export type AgentFlowNode = Node<{ node: GraphAgentNode }, 'agent'>
export type PRFlowNode = Node<{ node: GraphPRNode }, 'pr'>
export type FlowNode = GroupFlowNode | AgentFlowNode | PRFlowNode
export type FlowEdge = Edge<{ edge: GraphEdge }, 'graph'>

/** False where clicking a card does nothing (the site's demo), so the
 *  cards drop their pointer cursor and "Click to open" hints. */
export const GraphInteractiveContext = createContext(true)

export const EDGE_STYLE: Record<
  GraphEdgeKind,
  { color: string; dash?: string; label: string; hint: string }
> = {
  subscription: {
    color: 'var(--color-accent)',
    label: 'Subscribed',
    hint: 'subscribe_to_worktree: gets PR, CI, review and progress updates'
  },
  spawned: {
    color: 'var(--color-info)',
    dash: '6 4',
    label: 'Created',
    hint: 'Created this worktree, and follows it while the tab is open'
  },
  'own-pr': {
    color: 'var(--color-success)',
    label: 'Own PR',
    hint: 'The worktree’s agent is told about its PR (CI notify on)'
  },
  review: {
    color: 'var(--color-warning)',
    dash: '2 4',
    label: 'Reviewing',
    hint: 'A reviewer tab; its review goes back to this agent'
  }
}

const VERDICT_LABEL = {
  approve: 'approved',
  'changes-requested': 'changes requested',
  comment: 'commented'
} as const

function edgeTitle(e: GraphEdge): string {
  const base = EDGE_STYLE[e.kind].hint
  const parts = [base]
  if (e.kind === 'subscription' && e.mode) {
    parts.push(
      e.mode === 'interrupt' ? 'Interrupts with every update' : 'Routine updates held for the next turn'
    )
  }
  if (e.notLiveReason === 'creator-closed')
    parts.push('Creator tab is closed, so nobody follows it from here')
  if (e.notLiveReason === 'terminal-creator')
    parts.push('Created from a terminal tab, which doesn’t receive updates')
  if (e.note) parts.push(`Watching for: ${e.note}`)
  if (e.verdict) parts.push(`Last verdict: ${VERDICT_LABEL[e.verdict]}`)
  return parts.join('\n')
}

/** Left/right for edges between worktrees; top/bottom for edges between
 *  nodes stacked in the same worktree (own PR, reviewer). */
function Handles(): JSX.Element {
  return (
    <>
      <Handle
        id="t-left"
        type="target"
        position={Position.Left}
        isConnectable={false}
        className="sg-handle"
      />
      <Handle
        id="s-right"
        type="source"
        position={Position.Right}
        isConnectable={false}
        className="sg-handle"
      />
      <Handle id="t-top" type="target" position={Position.Top} isConnectable={false} className="sg-handle" />
      <Handle id="s-top" type="source" position={Position.Top} isConnectable={false} className="sg-handle" />
      <Handle
        id="t-bottom"
        type="target"
        position={Position.Bottom}
        isConnectable={false}
        className="sg-handle"
      />
      <Handle
        id="s-bottom"
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className="sg-handle"
      />
    </>
  )
}

function edgeHandles(
  e: GraphEdge,
  groupOf: Map<string, string>,
  boxes: Record<string, Box>
): { sourceHandle: string; targetHandle: string } {
  const a = groupOf.get(e.source)
  if (a === undefined || a !== groupOf.get(e.target))
    return { sourceHandle: 's-right', targetHandle: 't-left' }
  return boxes[e.source].y < boxes[e.target].y
    ? { sourceHandle: 's-bottom', targetHandle: 't-top' }
    : { sourceHandle: 's-top', targetHandle: 't-bottom' }
}

function StatusDot({ status }: { status: GraphGroup['status'] }): JSX.Element {
  return (
    <span
      className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS[status]}`}
      title={STATUS_LABELS[status]}
    />
  )
}

const GroupNode = memo(function GroupNode({ data }: NodeProps<GroupFlowNode>): JSX.Element {
  const g = data.group
  const interactive = useContext(GraphInteractiveContext)
  return (
    <div
      className={`sg-group w-full h-full rounded-lg border ${
        g.external ? 'border-dashed border-border-strong bg-transparent' : 'border-border-strong bg-panel'
      }`}
    >
      <Handles />
      <div className={`flex items-center gap-2 px-3 h-10 min-w-0 ${interactive ? 'cursor-pointer' : ''}`}>
        <StatusDot status={g.merged ? 'idle' : g.status} />
        <span className={`text-sm font-medium truncate ${g.merged ? 'text-dim' : 'text-fg-bright'}`}>
          {g.name}
        </span>
        {g.name !== g.branch && <span className="text-xs text-faint truncate">{g.branch}</span>}
        <span className="flex-1" />
        {g.isMain && <span className="text-xs text-faint shrink-0">main</span>}
        {g.merged && <span className="text-xs text-accent shrink-0">merged</span>}
        {g.external && <span className="text-xs text-faint shrink-0">other repo</span>}
      </div>
    </div>
  )
})

function AgentStatus({ n }: { n: GraphAgentNode }): JSX.Element | null {
  if (n.status === 'processing')
    return (
      <Loader2 className="icon-xs shrink-0 animate-spin text-success" aria-label={STATUS_LABELS.processing} />
    )
  if (n.status === 'waiting')
    return <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-warning" title={STATUS_LABELS.waiting} />
  if (n.status === 'needs-approval') {
    return (
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0 bg-danger animate-pulse"
        title={STATUS_LABELS['needs-approval']}
      />
    )
  }
  if (n.asleep) return <Moon className="icon-xs shrink-0 text-faint" aria-label="Asleep" />
  return null
}

const AgentNode = memo(function AgentNode({ data }: NodeProps<AgentFlowNode>): JSX.Element {
  const n = data.node
  const interactive = useContext(GraphInteractiveContext)
  const busy = n.status !== 'idle'
  return (
    <div
      className={`w-full h-full flex items-center gap-2 px-2.5 rounded-md border bg-panel-raised transition-colors hover:border-fg/40 ${
        interactive ? 'cursor-pointer' : ''
      } ${
        n.status === 'needs-approval' ? 'border-danger/60' : busy ? 'border-border-strong' : 'border-border'
      } ${n.asleep && !busy ? 'opacity-70' : ''}`}
      title={`${n.label}${n.chat ? '' : ' (terminal)'}${n.reviewer ? ' — reviewer' : ''}${
        interactive ? '\nClick to open' : ''
      }`}
    >
      <Handles />
      <AgentIcon kind={n.agentKind} className="icon-sm shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-fg truncate leading-tight">{n.label}</div>
        <div className="text-xs text-faint truncate leading-tight">
          {n.reviewer ? 'Reviewer' : n.chat ? 'Chat' : 'Terminal'}
          {busy ? ` · ${STATUS_LABELS[n.status].replace(/\.+$/, '').toLowerCase()}` : ''}
        </div>
      </div>
      {!n.chat && <SquareTerminal className="icon-xs shrink-0 text-faint" aria-hidden="true" />}
      <AgentStatus n={n} />
    </div>
  )
})

const CHECKS_LABEL: Record<GraphPRNode['checks'], string> = {
  success: 'checks passing',
  failure: 'checks failing',
  pending: 'checks running',
  none: 'no checks'
}

const REVIEW_LABEL: Record<GraphPRNode['reviewDecision'], string> = {
  approved: 'approved',
  changes_requested: 'changes requested',
  review_required: 'review required',
  none: ''
}

const PRNode = memo(function PRNode({ data }: NodeProps<PRFlowNode>): JSX.Element {
  const n = data.node
  const interactive = useContext(GraphInteractiveContext)
  const { iconColor } = prIconStyle({
    state: n.state,
    hasConflict: n.hasConflict,
    checksOverall: n.checks
  } as PRStatus)
  const status =
    n.state === 'merged' || n.state === 'closed' || n.state === 'draft'
      ? n.state
      : n.hasConflict
        ? 'merge conflict'
        : CHECKS_LABEL[n.checks]
  const review = REVIEW_LABEL[n.reviewDecision]
  return (
    <div
      className={`w-full h-full flex items-center gap-2 px-2.5 rounded-md border border-border bg-app transition-colors hover:border-fg/40 ${
        interactive ? 'cursor-pointer' : ''
      }`}
      title={`#${n.number} ${n.title}${interactive ? '\nClick to open on GitHub' : ''}`}
    >
      <Handles />
      <GitPullRequest className={`icon-sm shrink-0 ${iconColor}`} />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-fg truncate leading-tight">
          <span className="text-dim tabular-nums">#{n.number}</span> {n.title}
        </div>
        <div className="text-xs text-faint truncate leading-tight">
          {status}
          {review ? ` · ${review}` : ''}
        </div>
      </div>
    </div>
  )
})

function GraphEdgeView({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd
}: EdgeProps<FlowEdge>): JSX.Element | null {
  if (!data) return null
  const e = data.edge
  const style = EDGE_STYLE[e.kind]
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition
  })
  const faded = !e.live || e.mode === 'silent'
  return (
    <g className="sg-edge">
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: style.color,
          strokeWidth: e.kind === 'subscription' && e.mode === 'interrupt' ? 2 : 1.5,
          strokeDasharray: style.dash,
          opacity: faded ? 0.55 : 0.9
        }}
      />
      <path d={path} fill="none" stroke="transparent" strokeWidth={14}>
        <title>{edgeTitle(e)}</title>
      </path>
    </g>
  )
}

export const nodeTypes = { worktree: GroupNode, agent: AgentNode, pr: PRNode }
export const edgeTypes = { graph: GraphEdgeView }

export function toFlow(
  g: SubscriptionGraph,
  boxes: Record<string, Box>
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = []
  for (const group of g.groups) {
    const b = boxes[group.id]
    if (!b) continue
    nodes.push({
      id: group.id,
      type: 'worktree',
      position: { x: b.x, y: b.y },
      width: b.width,
      height: b.height,
      data: { group },
      selectable: false,
      zIndex: 0
    })
  }
  for (const n of g.nodes) {
    const b = boxes[n.id]
    if (!b || !boxes[n.groupId]) continue
    const base = {
      id: n.id,
      parentId: n.groupId,
      extent: 'parent' as const,
      position: { x: b.x, y: b.y },
      width: b.width,
      height: b.height,
      selectable: false,
      zIndex: 1
    }
    nodes.push(
      n.kind === 'agent'
        ? { ...base, type: 'agent', data: { node: n } }
        : { ...base, type: 'pr', data: { node: n } }
    )
  }
  const groupOf = new Map(g.nodes.map((n) => [n.id, n.groupId]))
  const edges: FlowEdge[] = g.edges
    .filter((e) => boxes[e.source] && boxes[e.target])
    .map((e) => ({
      id: e.id,
      type: 'graph',
      source: e.source,
      target: e.target,
      ...edgeHandles(e, groupOf, boxes),
      // Between worktrees, behind the opaque boxes so a long edge doesn't
      // scribble over the cards it passes; inside one, above its box.
      zIndex: groupOf.get(e.source) !== undefined && groupOf.get(e.source) === groupOf.get(e.target) ? 2 : 0,
      data: { edge: e },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: EDGE_STYLE[e.kind].color,
        width: 16,
        height: 16
      }
    }))
  return { nodes, edges }
}

export function Legend({ className = '' }: { className?: string }): JSX.Element {
  return (
    <div className={`flex items-center gap-4 text-xs text-muted ${className}`}>
      {(Object.keys(EDGE_STYLE) as GraphEdgeKind[]).map((k) => {
        const s = EDGE_STYLE[k]
        return (
          <span key={k} className="flex items-center gap-1.5" title={s.hint}>
            <svg width="22" height="8" aria-hidden="true">
              <line x1="0" y1="4" x2="22" y2="4" stroke={s.color} strokeWidth="2" strokeDasharray={s.dash} />
            </svg>
            {s.label}
          </span>
        )
      })}
    </div>
  )
}

export const MIN_ZOOM = 0.2
const MAX_FIT_ZOOM = 1.1
const FIT_PAD = 32

/** The viewport that centres every group in a `width`×`height` pane.
 *  Computed from the layout boxes rather than React Flow's fitView, which
 *  reads its own measurements and fit the graph off-centre here. */
export function fitViewport(
  boxes: Record<string, Box>,
  groups: GraphGroup[],
  width: number,
  height: number,
  pad = FIT_PAD
): { x: number; y: number; zoom: number } {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const g of groups) {
    const b = boxes[g.id]
    if (!b) continue
    x0 = Math.min(x0, b.x)
    y0 = Math.min(y0, b.y)
    x1 = Math.max(x1, b.x + b.width)
    y1 = Math.max(y1, b.y + b.height)
  }
  if (!Number.isFinite(x0) || width <= 0 || height <= 0) return { x: 0, y: 0, zoom: 1 }
  const zoom = Math.max(
    MIN_ZOOM,
    Math.min(MAX_FIT_ZOOM, (width - 2 * pad) / (x1 - x0), (height - 2 * pad) / (y1 - y0))
  )
  return {
    x: (width - (x1 - x0) * zoom) / 2 - x0 * zoom,
    y: (height - (y1 - y0) * zoom) / 2 - y0 * zoom,
    zoom
  }
}
