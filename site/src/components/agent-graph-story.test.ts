import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { layoutSubscriptionGraph } from '../../../src/renderer/subscription-graph-layout'
import { BEATS, FULL, graphAt } from './agent-graph-story'

const BOXES_FILE = join(__dirname, 'agent-graph-boxes.json')

describe('agent graph story', () => {
  // The site ships these boxes instead of ELK. If the app's layout or the
  // story changes, regenerate with:
  //   UPDATE_AGENT_GRAPH=1 npx vitest run site/src/components/agent-graph-story.test.ts
  it('ships the boxes the app layout produces', async () => {
    const boxes = await layoutSubscriptionGraph(FULL, 1)
    if (process.env.UPDATE_AGENT_GRAPH) writeFileSync(BOXES_FILE, JSON.stringify(boxes, null, 2) + '\n')
    expect(JSON.parse(readFileSync(BOXES_FILE, 'utf8'))).toEqual(boxes)
  })

  it('reveals only ids that exist, and everything by the last beat', () => {
    const ids = new Set([...FULL.groups, ...FULL.nodes, ...FULL.edges].map((x) => x.id))
    for (const b of BEATS) for (const id of b.adds) expect(ids).toContain(id)
    const { shown } = graphAt(BEATS.length - 1)
    expect([...ids].filter((id) => !shown.has(id))).toEqual([])
  })

  it('never shows an edge before both of its ends', () => {
    const groupOf = new Map(FULL.nodes.map((n) => [n.id, n.groupId]))
    BEATS.forEach((_, i) => {
      const { shown } = graphAt(i)
      for (const e of FULL.edges) {
        if (!shown.has(e.id)) continue
        for (const end of [e.source, e.target]) {
          expect(shown).toContain(end)
          const g = groupOf.get(end)
          if (g) expect(shown).toContain(g)
        }
      }
    })
  })
})
