import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  BaseEdge,
  getBezierPath,
  MarkerType,
  ControlButton,
  type ReactFlowInstance,
  type Node,
  type Edge,
  type NodeProps,
  type EdgeProps
} from '@xyflow/react'
import '@xyflow/react/dist/base.css'
import './subscription-graph.css'
import { ArrowLeft, Eye, EyeOff, GitPullRequest, Loader2, Maximize, Moon, SquareTerminal, X } from 'lucide-react'
import { useAppState } from '../store'
import { useBackend } from '../backend'
import { AgentIcon } from './AgentIcon'
import { repoNameColor } from './RepoIcon'
import { STATUS_COLORS, STATUS_LABELS, prIconStyle } from '../worktree-row-style'
import type { PRStatus } from '../types'
import {
  buildSubscriptionGraph,
  filterSubscriptionGraph,
  graphTopologyKey,
  type GraphAgentNode,
  type GraphEdge,
  type GraphEdgeKind,
  type GraphGroup,
  type GraphPRNode,
  type SubscriptionGraph
} from '../../shared/subscription-graph'
import { layoutSubscriptionGraph, type Box } from '../subscription-graph-layout'

export interface SubscriptionGraphViewProps {
  repoRoot: string
  onChangeRepo: (repoRoot: string) => void
  onClose: () => void
  onFocusTab: (worktreePath: string, tabId: string) => void
  onOpenWorktree: (worktreePath: string) => void
}

type GroupFlowNode = Node<{ group: GraphGroup }, 'worktree'>
type AgentFlowNode = Node<{ node: GraphAgentNode }, 'agent'>
type PRFlowNode = Node<{ node: GraphPRNode }, 'pr'>
type FlowNode = GroupFlowNode | AgentFlowNode | PRFlowNode
type FlowEdge = Edge<{ edge: GraphEdge }, 'graph'>

const EDGE_STYLE: Record<GraphEdgeKind, { color: string; dash?: string; label: string; hint: string }> = {
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
  if (e.notLiveReason === 'creator-closed') parts.push('Creator tab is closed, so nobody follows it from here')
  if (e.notLiveReason === 'terminal-creator') parts.push('Created from a terminal tab, which doesn’t receive updates')
  if (e.note) parts.push(`Watching for: ${e.note}`)
  if (e.verdict) parts.push(`Last verdict: ${VERDICT_LABEL[e.verdict]}`)
  return parts.join('\n')
}

/** The graph as one string, so the selector result only changes when
 *  something the view draws does. The derivation reads chat sessions
 *  (author-tab recency), which churn per streamed token.
 *
 *  Known cost: while the view is open, every store event (each streamed
 *  token included) re-runs the derivation and the stringify, O(worktrees ×
 *  tabs + subscriptions). Comparing strings saves the re-render, not that
 *  work. Fine for a view that's open briefly. If it shows up in
 *  `[renderer-slow]`, key it on its inputs by reference first. */
function selectGraph(repoRoot: string) {
  return (s: Parameters<typeof buildSubscriptionGraph>[0]): string =>
    JSON.stringify(buildSubscriptionGraph(s, repoRoot))
}

function rootScale(): number {
  const px = parseFloat(getComputedStyle(document.documentElement).fontSize)
  return Number.isFinite(px) && px > 0 ? px / 16 : 1
}

/** The root font-size ratio, tracked live. Read from the DOM rather than
 *  settings: under a remote backend's scope, settings are that backend's,
 *  but the root font-size is this window's. */
function useRootScale(): number {
  const [scale, setScale] = useState(rootScale)
  useEffect(() => {
    const mo = new MutationObserver(() => setScale(rootScale()))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    return () => mo.disconnect()
  }, [])
  return scale
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
  return (
    <div
      className={`sg-group w-full h-full rounded-lg border ${
        g.external ? 'border-dashed border-border-strong bg-transparent' : 'border-border-strong bg-panel'
      }`}
    >
      <Handles />
      <div className="flex items-center gap-2 px-3 h-10 min-w-0 cursor-pointer">
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
  const busy = n.status !== 'idle'
  return (
    <div
      className={`w-full h-full flex items-center gap-2 px-2.5 rounded-md border bg-panel-raised cursor-pointer transition-colors hover:border-fg/40 ${
        n.status === 'needs-approval' ? 'border-danger/60' : busy ? 'border-border-strong' : 'border-border'
      } ${n.asleep && !busy ? 'opacity-70' : ''}`}
      title={`${n.label}${n.chat ? '' : ' (terminal)'}${n.reviewer ? ' — reviewer' : ''}\nClick to open`}
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
      className="w-full h-full flex items-center gap-2 px-2.5 rounded-md border border-border bg-app cursor-pointer transition-colors hover:border-fg/40"
      title={`#${n.number} ${n.title}\nClick to open on GitHub`}
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

const nodeTypes = { worktree: GroupNode, agent: AgentNode, pr: PRNode }
const edgeTypes = { graph: GraphEdgeView }

function toFlow(g: SubscriptionGraph, boxes: Record<string, Box>): { nodes: FlowNode[]; edges: FlowEdge[] } {
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

/** A pill in the toolbar that reveals a class of hidden worktrees. Shows
 *  how many it's hiding while off, so nothing disappears silently. */
function FilterToggle({
  on,
  count,
  label,
  title,
  onToggle
}: {
  on: boolean
  count: number | undefined
  label: string
  title: string
  onToggle: () => void
}): JSX.Element | null {
  if (!on && !count) return null
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      title={on ? `${title}. Click to hide them.` : `${title}. Click to show them.`}
      className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-xs cursor-pointer transition-colors ${
        on
          ? 'border-accent/50 bg-accent/10 text-fg'
          : 'border-border-strong text-muted hover:text-fg hover:border-fg/40'
      }`}
    >
      {on ? <EyeOff className="icon-xs" /> : <Eye className="icon-xs" />}
      {on ? `Hide ${label.toLowerCase()}` : `${label} (${count})`}
    </button>
  )
}

function Legend(): JSX.Element {
  return (
    <div className="flex items-center gap-4 text-xs text-muted">
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

const MIN_ZOOM = 0.2
const MAX_FIT_ZOOM = 1.1
const FIT_PAD = 32

/** The viewport that centres every group in a `width`×`height` pane.
 *  Computed from the layout boxes rather than React Flow's fitView, which
 *  reads its own measurements and fit the graph off-centre here. */
function fitViewport(
  boxes: Record<string, Box>,
  groups: GraphGroup[],
  width: number,
  height: number
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
    Math.min(MAX_FIT_ZOOM, (width - 2 * FIT_PAD) / (x1 - x0), (height - 2 * FIT_PAD) / (y1 - y0))
  )
  return {
    x: (width - (x1 - x0) * zoom) / 2 - x0 * zoom,
    y: (height - (y1 - y0) * zoom) / 2 - y0 * zoom,
    zoom
  }
}

function GraphCanvas({
  graph,
  onFocusTab,
  onOpenWorktree
}: {
  graph: SubscriptionGraph
  onFocusTab: SubscriptionGraphViewProps['onFocusTab']
  onOpenWorktree: SubscriptionGraphViewProps['onOpenWorktree']
}): JSX.Element {
  const backend = useBackend()
  const scale = useRootScale()
  // Layout sizes are px scaled from rem, so a uiScale change re-lays out.
  const topology = `${graphTopologyKey(graph)}@${scale}`
  const [layout, setLayout] = useState<{
    key: string
    boxes: Record<string, Box>
  } | null>(null)

  // Layout runs only when the node/edge set changes, so status and label
  // updates repaint in place instead of reshuffling the boxes.
  useEffect(() => {
    let cancelled = false
    layoutSubscriptionGraph(graph, scale)
      .then((boxes) => {
        if (!cancelled) setLayout({ key: topology, boxes })
      })
      .catch((err: unknown) => {
        console.error('[subscription-graph] layout failed', err)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on topology on purpose
  }, [topology])

  const { nodes, edges } = useMemo(
    () => (layout ? toFlow(graph, layout.boxes) : { nodes: [], edges: [] }),
    [graph, layout]
  )

  const wrapRef = useRef<HTMLDivElement | null>(null)
  const instanceRef = useRef<ReactFlowInstance<FlowNode, FlowEdge> | null>(null)
  const fit = useCallback(() => {
    const el = wrapRef.current
    const inst = instanceRef.current
    if (!el || !inst || !layout) return
    const r = el.getBoundingClientRect()
    void inst.setViewport(fitViewport(layout.boxes, graph.groups, r.width, r.height), { duration: 200 })
  }, [layout, graph.groups])

  if (!layout) {
    return (
      <div className="h-full flex items-center justify-center text-faint">
        <Loader2 className="icon-base animate-spin" />
      </div>
    )
  }

  return (
    <div ref={wrapRef} className="w-full h-full">
      {/* Keyed on topology: a new shape remounts and is fitted on init;
          a status flip re-renders in place and keeps the viewport. */}
      <ReactFlow<FlowNode, FlowEdge>
        key={layout.key}
        className="sg-flow"
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        edgesFocusable={false}
        minZoom={MIN_ZOOM}
        // Our own zIndex values, as set in toFlow. The default lifts an edge to
        // the z of the child nodes it joins, which drew edges between
        // worktrees over the cards they pass.
        zIndexMode="manual"
        onInit={(inst) => {
          instanceRef.current = inst
          const r = wrapRef.current?.getBoundingClientRect()
          if (r) void inst.setViewport(fitViewport(layout.boxes, graph.groups, r.width, r.height))
        }}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_e, node) => {
          if (node.type === 'agent') onFocusTab(node.data.node.worktreePath, node.data.node.tabId)
          else if (node.type === 'pr') backend.openExternal(node.data.node.url)
          else if (node.type === 'worktree') onOpenWorktree(node.data.group.path)
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--color-border-strong)" />
        <Controls showInteractive={false} showFitView={false} position="bottom-right">
          <ControlButton onClick={fit} title="Fit graph" aria-label="Fit graph">
            <Maximize />
          </ControlButton>
        </Controls>
      </ReactFlow>
    </div>
  )
}

/** Every agent in one project, grouped by worktree, with an edge to each
 *  worktree it follows, created, or reviews, and to its own PR. */
export default function SubscriptionGraphView({
  repoRoot,
  onChangeRepo,
  onClose,
  onFocusTab,
  onOpenWorktree
}: SubscriptionGraphViewProps): JSX.Element {
  const selector = useMemo(() => selectGraph(repoRoot), [repoRoot])
  const json = useAppState(selector)
  const full = useMemo<SubscriptionGraph>(() => JSON.parse(json), [json])
  // Per-viewer, like any view filter. Off by default: with dozens of
  // worktrees the links are what this view is for, and drawing every
  // merged or standalone worktree shrank them out of reach.
  const [showMerged, setShowMerged] = useState(false)
  const [showUnlinked, setShowUnlinked] = useState(false)
  const { graph, hidden } = useMemo(
    () => filterSubscriptionGraph(full, { showMerged, showUnlinked }),
    [full, showMerged, showUnlinked]
  )
  const repoRoots = useAppState((s) => s.worktrees.repoRoots)
  const repoName = repoRoot.split('/').pop() || repoRoot
  const agentCount = graph.nodes.filter((n) => n.kind === 'agent').length
  const linkCount = graph.edges.length
  const totalWorktrees = full.groups.filter((g) => !g.external).length

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="flex flex-col h-full w-full bg-app">
      <div className="drag-region h-10 shrink-0 border-b border-border relative bg-panel">
        <button
          onClick={onClose}
          className="no-drag absolute left-4 top-1/2 -translate-y-1/2 flex items-center gap-1.5 text-xs text-muted hover:text-fg-bright transition-colors cursor-pointer"
        >
          <ArrowLeft className="icon-sm" />
          Back
        </button>
        <div className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 flex items-center gap-2 text-sm font-medium text-fg">
          <span>Subscriptions</span>
          <span className="text-faint">·</span>
          {repoRoots.length > 1 ? (
            <select
              value={repoRoot}
              onChange={(e) => onChangeRepo(e.target.value)}
              className={`no-drag bg-transparent cursor-pointer outline-none ${repoNameColor(repoName)}`}
            >
              {repoRoots.map((r) => (
                <option key={r} value={r} className="bg-panel text-fg">
                  {r.split('/').pop() || r}
                </option>
              ))}
            </select>
          ) : (
            <span className={repoNameColor(repoName)}>{repoName}</span>
          )}
        </div>
        <button
          onClick={onClose}
          className="no-drag absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded text-muted hover:text-fg-bright hover:bg-surface cursor-pointer"
          aria-label="Close"
        >
          <X className="icon-sm" />
        </button>
      </div>
      <div className="h-9 shrink-0 flex items-center gap-4 px-4 border-b border-border bg-panel">
        <span className="text-xs text-faint tabular-nums">
          {graph.groups.filter((g) => !g.external).length} of {totalWorktrees} worktrees · {agentCount} agents ·{' '}
          {linkCount} links
        </span>
        <FilterToggle
          on={showUnlinked}
          count={showUnlinked ? undefined : hidden.unlinked}
          label="Without links"
          title="Worktrees with no subscription, spawn or review link to another worktree"
          onToggle={() => setShowUnlinked((v) => !v)}
        />
        <FilterToggle
          on={showMerged}
          count={showMerged ? undefined : hidden.merged}
          label="Merged"
          title="Merged worktrees. One an unmerged worktree still links to is always shown."
          onToggle={() => setShowMerged((v) => !v)}
        />
        <span className="flex-1" />
        <Legend />
      </div>
      <div className="flex-1 min-h-0 flex relative">
        {graph.groups.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-sm text-faint">
            {totalWorktrees === 0 ? (
              `No worktrees in ${repoName}.`
            ) : (
              <>
                <span>No links between worktrees in {repoName} yet.</span>
                <span className="text-xs">
                  Agents link to worktrees they create, ones they subscribe to, and the tabs they review.
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setShowUnlinked(true)
                    setShowMerged(true)
                  }}
                  className="text-xs text-accent hover:underline cursor-pointer"
                >
                  Show all {totalWorktrees} worktrees
                </button>
              </>
            )}
          </div>
        ) : (
          // A definite box: as a flex item React Flow measured itself
          // wider than the visible pane and fit the graph off-centre.
          <div className="absolute inset-0">
            <GraphCanvas graph={graph} onFocusTab={onFocusTab} onOpenWorktree={onOpenWorktree} />
          </div>
        )}
        {graph.groups.length > 0 && linkCount === 0 && (
          <div className="absolute left-1/2 -translate-x-1/2 bottom-4 text-xs text-faint bg-panel border border-border rounded px-3 py-1.5 pointer-events-none">
            No connections yet. Agents follow worktrees they create, ones they subscribe to, and their own PR.
          </div>
        )}
      </div>
    </div>
  )
}
