import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { ReactFlow, Background, BackgroundVariant } from '@xyflow/react'
import {
  GraphInteractiveContext,
  Legend,
  edgeTypes,
  fitViewport,
  nodeTypes,
  toFlow
} from '../../../src/renderer/components/SubscriptionGraphCanvas'
import type { Box } from '../../../src/renderer/subscription-graph-layout'
import { BEATS, FULL, graphAt } from './agent-graph-story'
import AGENT_GRAPH_BOXES from './agent-graph-boxes.json'

// The app's subscription graph view, drawn by its own node and edge
// components, fed a fixture instead of the store. The layout is the app's
// own ELK pass, run ahead of time (agent-graph-story.test.ts keeps the JSON
// in step with it) so this chunk doesn't carry ELK. Lazy-loaded by
// AgentsRunAgents: nothing above the fold needs React Flow.

const BOXES: Record<string, Box> = AGENT_GRAPH_BOXES

const PAD = 24
/** Fitting the whole graph on a phone shrinks the cards past reading.
 *  Below this zoom, show it at SCROLL_ZOOM and scroll sideways instead. */
const MIN_FIT_ZOOM = 0.7
const SCROLL_ZOOM = 0.8

function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [ref])
  return w
}

function bounds(boxes: Record<string, Box>): { w: number; h: number } {
  let w = 0
  let h = 0
  for (const g of FULL.groups) {
    const b = boxes[g.id]
    if (b) {
      w = Math.max(w, b.x + b.width)
      h = Math.max(h, b.y + b.height)
    }
  }
  return { w, h }
}

export default function AgentGraphMock({ reduced, playing }: { reduced: boolean; playing: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const width = useWidth(hostRef)
  const boxes = BOXES
  const [beat, setBeat] = useState(reduced ? BEATS.length - 1 : 0)

  // Restart from the top whenever it scrolls back into view.
  useEffect(() => {
    if (reduced) setBeat(BEATS.length - 1)
    else if (!playing) setBeat(0)
  }, [playing, reduced])

  useEffect(() => {
    if (reduced || !playing) return
    // The last beat holds, then the story starts over.
    const t = setTimeout(() => setBeat((b) => (b + 1) % BEATS.length), BEATS[beat].ms)
    return () => clearTimeout(t)
  }, [beat, playing, reduced])

  const { graph, shown } = useMemo(() => graphAt(beat), [beat])
  const flow = useMemo(() => {
    if (!boxes) return null
    const { nodes, edges } = toFlow(graph, boxes)
    const pending = (id: string): string | undefined => (shown.has(id) ? undefined : 'agm-pending')
    return {
      nodes: nodes.map((n) => ({ ...n, className: pending(n.id) })),
      edges: edges.map((e) => ({ ...e, className: pending(e.id) }))
    }
  }, [graph, shown, boxes])

  // Height follows the layout, so the graph is never letterboxed in a
  // fixed box.
  const size = boxes ? bounds(boxes) : null
  const fit = size ? Math.min(1, (width - 2 * PAD) / size.w) : 1
  const scrolls = fit < MIN_FIT_ZOOM
  const zoom = scrolls ? SCROLL_ZOOM : fit
  const canvasW = size && scrolls ? Math.round(size.w * zoom + 2 * PAD) : width
  const height = size ? Math.round(size.h * zoom + 2 * PAD) : 420
  const viewport = boxes ? fitViewport(boxes, FULL.groups, canvasW, height, PAD) : undefined

  // Keep whatever the story just revealed in view when the canvas is wider
  // than the screen.
  useEffect(() => {
    const el = hostRef.current
    if (!el || !boxes || !viewport || !scrolls) return
    const added = BEATS[beat].adds.map((id) => FULL.nodes.find((n) => n.id === id)?.groupId ?? id)
    const b = boxes[added.find((id) => id.startsWith('wt:')) ?? '']
    if (!b) return
    const cx = viewport.x + (b.x + b.width / 2) * viewport.zoom
    el.scrollTo({
      left: cx - width / 2,
      behavior: reduced ? 'auto' : 'smooth'
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per beat
  }, [beat, boxes, scrolls, width])

  return (
    <div className="agm rounded-xl overflow-hidden border border-border-strong shadow-2xl shadow-black/70 bg-app font-sans select-none">
      <div className="h-10 shrink-0 border-b border-border relative bg-panel flex items-center justify-center">
        <div className="flex items-center gap-2 text-sm font-medium text-fg">
          <span>Subscriptions</span>
          <span className="text-faint">·</span>
          <span className="text-info">ness</span>
        </div>
      </div>
      <div className="min-h-9 py-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 border-b border-border bg-panel">
        <span className="text-xs text-faint tabular-nums">
          {FULL.groups.filter((g) => shown.has(g.id)).length} worktrees ·{' '}
          {FULL.nodes.filter((n) => n.kind === 'agent' && shown.has(n.id)).length} agents ·{' '}
          {FULL.edges.filter((e) => shown.has(e.id)).length} links
        </span>
        <span className="flex-1" />
        <Legend className="flex-wrap gap-y-1" />
      </div>
      <div ref={hostRef} className="agm-scroll overflow-x-auto overflow-y-hidden" style={{ height }}>
        {flow && viewport && width > 0 && (
          <div className="relative h-full" style={{ width: canvasW }}>
            <GraphInteractiveContext.Provider value={false}>
              <ReactFlow
                className="sg-flow"
                nodes={flow.nodes}
                edges={flow.edges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                viewport={viewport}
                nodesDraggable={false}
                nodesConnectable={false}
                nodesFocusable={false}
                edgesFocusable={false}
                elementsSelectable={false}
                panOnDrag={false}
                panOnScroll={false}
                zoomOnScroll={false}
                zoomOnPinch={false}
                zoomOnDoubleClick={false}
                preventScrolling={false}
                zIndexMode="manual"
                proOptions={{ hideAttribution: true }}
              >
                <Background
                  variant={BackgroundVariant.Dots}
                  gap={20}
                  size={1}
                  color="var(--color-border-strong)"
                />
              </ReactFlow>
            </GraphInteractiveContext.Provider>
          </div>
        )}
      </div>
      <div className="border-t border-border bg-panel px-4 py-2.5 min-h-[3.25rem] flex items-center gap-3">
        {!reduced && (
          <span className="text-xs tabular-nums text-faint shrink-0">
            {beat + 1}/{BEATS.length}
          </span>
        )}
        <p key={beat} className="agm-caption text-sm text-muted leading-snug">
          {BEATS[beat].caption}
        </p>
      </div>
    </div>
  )
}
