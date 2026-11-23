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

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

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

/** The laid-out graph's extent, from the origin. */
const SIZE = FULL.groups.reduce(
  (acc, g) => ({
    w: Math.max(acc.w, BOXES[g.id].x + BOXES[g.id].width),
    h: Math.max(acc.h, BOXES[g.id].y + BOXES[g.id].height)
  }),
  { w: 0, h: 0 }
)

export default function AgentGraphMock({ reduced, playing }: { reduced: boolean; playing: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const width = useWidth(hostRef)
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
    const { nodes, edges } = toFlow(graph, BOXES)
    const pending = (id: string): string | undefined => (shown.has(id) ? undefined : 'agm-pending')
    return {
      nodes: nodes.map((n) => ({ ...n, className: pending(n.id) })),
      edges: edges.map((e) => ({ ...e, className: pending(e.id) }))
    }
  }, [graph, shown])

  // Height follows the layout, so the graph is never letterboxed in a
  // fixed box.
  // Before the first measure (width 0) assume it fits; the layout effect
  // measures before paint.
  const fit = width > 0 ? Math.min(1, (width - 2 * PAD) / SIZE.w) : 1
  const scrolls = fit < MIN_FIT_ZOOM
  const zoom = scrolls ? SCROLL_ZOOM : fit
  const canvasW = scrolls ? Math.round(SIZE.w * zoom + 2 * PAD) : width
  const height = Math.round(SIZE.h * zoom + 2 * PAD)
  const viewport = fitViewport(BOXES, FULL.groups, canvasW, height, PAD)

  // Keep whatever the story just revealed in view when the canvas is wider
  // than the screen.
  useEffect(() => {
    const el = hostRef.current
    if (!el || !scrolls) return
    const added = BEATS[beat].adds.map((id) => FULL.nodes.find((n) => n.id === id)?.groupId ?? id)
    const b = BOXES[added.find((id) => id.startsWith('wt:')) ?? '']
    if (!b) return
    const cx = viewport.x + (b.x + b.width / 2) * viewport.zoom
    el.scrollTo({
      left: cx - width / 2,
      behavior: reduced ? 'auto' : 'smooth'
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per beat
  }, [beat, scrolls, width])

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
          {count(FULL.groups.filter((g) => shown.has(g.id)).length, 'worktree')} ·{' '}
          {count(FULL.nodes.filter((n) => n.kind === 'agent' && shown.has(n.id)).length, 'agent')} ·{' '}
          {count(FULL.edges.filter((e) => shown.has(e.id)).length, 'link')}
        </span>
        <span className="flex-1" />
        <Legend className="flex-wrap gap-y-1" />
      </div>
      <div ref={hostRef} className="agm-scroll overflow-x-auto overflow-y-hidden" style={{ height }}>
        {width > 0 && (
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
