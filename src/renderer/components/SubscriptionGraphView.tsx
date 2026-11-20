import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ReactFlow, Background, BackgroundVariant, Controls, ControlButton, type ReactFlowInstance } from '@xyflow/react'
import { ArrowLeft, Eye, EyeOff, Loader2, Maximize, X } from 'lucide-react'
import { useAppState } from '../store'
import { useBackend } from '../backend'
import { repoNameColor } from './RepoIcon'
import {
  buildSubscriptionGraph,
  filterSubscriptionGraph,
  graphTopologyKey,
  type SubscriptionGraph
} from '../../shared/subscription-graph'
import { layoutSubscriptionGraph, type Box } from '../subscription-graph-layout'
import {
  Legend,
  MIN_ZOOM,
  edgeTypes,
  fitViewport,
  nodeTypes,
  toFlow,
  type FlowEdge,
  type FlowNode
} from './SubscriptionGraphCanvas'

export interface SubscriptionGraphViewProps {
  repoRoot: string
  onChangeRepo: (repoRoot: string) => void
  onClose: () => void
  onFocusTab: (worktreePath: string, tabId: string) => void
  onOpenWorktree: (worktreePath: string) => void
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
