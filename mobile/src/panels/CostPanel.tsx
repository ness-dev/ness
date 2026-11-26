// Port of renderer/components/CostPanel.tsx. Same aggregation (agent +
// chat tabs in this worktree, deduped by transcriptPath), same sections,
// and the same interest gate: `costs:setInterest` follows the collapse
// state (RightPanel also reports `true` = collapsed on unmount), so the
// backend only tallies while someone is looking. Hover titles (message
// count, estimate caveat) are revealed by tapping the total / caveat.
import { useMemo, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { getLeaves } from '../../../src/shared/state/terminals'
import {
  totalForSession,
  addBreakdown,
  cloneBreakdown,
  emptyBreakdown,
  emptyTally,
  type ContentBreakdown,
  type ModelTally
} from '../../../src/shared/state/costs'
import { useNess } from '../ness'
import { alpha, c, fs } from '../theme'
import { RightPanel } from './RightPanel'
import type { PanelProps } from './types'

function formatCost(n: number): string {
  if (n === 0) return '$0.00'
  if (n < 0.01) return '<$0.01'
  return `$${n.toFixed(2)}`
}

function shortModel(model: string): string {
  return model.replace(/^claude-/, '')
}

interface Row {
  label: string
  cost: number
}

const num = { fontSize: fs.xs, fontVariant: ['tabular-nums' as const] }

function Bar({ row, max, total }: { row: Row; max: number; total: number }) {
  const pct = total > 0 ? (row.cost / total) * 100 : 0
  // Same as desktop: bar length is relative to the section's largest row
  // (which always draws full), while the % label is the share of the total.
  const width = max > 0 ? (row.cost / max) * 100 : 0
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Text numberOfLines={1} style={{ fontSize: fs.xs, color: c.faint, width: 80 }}>
        {row.label}
      </Text>
      <View style={{ flex: 1, height: 6, backgroundColor: alpha(c.panelRaised, 0.4), borderRadius: 2, overflow: 'hidden' }}>
        <View style={{ height: '100%', width: `${width}%`, backgroundColor: alpha(c.accent, 0.7) }} />
      </View>
      <Text style={{ ...num, color: c.faint, width: 40, textAlign: 'right' }}>{pct >= 1 ? `${Math.round(pct)}%` : '<1%'}</Text>
      <Text style={{ ...num, color: c.fg, width: 52, textAlign: 'right' }}>{formatCost(row.cost)}</Text>
    </View>
  )
}

function Section({ title, rows, total }: { title: string; rows: Row[]; total: number }) {
  const nonZero = rows.filter((r) => r.cost > 0).sort((a, b) => b.cost - a.cost)
  if (nonZero.length === 0) return null
  const max = nonZero[0].cost
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ fontSize: fs.xs, color: c.faint, textTransform: 'uppercase', letterSpacing: 0.6 }}>{title}</Text>
      {nonZero.map((r) => (
        <Bar key={r.label} row={r} max={max} total={total} />
      ))}
    </View>
  )
}

export function CostPanel({ client, worktreePath }: PanelProps) {
  const costs = useNess(client, (s) => s.costs)
  const panes = useNess(client, (s) => s.terminals.panes)
  const [showMessages, setShowMessages] = useState(false)
  const [showCaveat, setShowCaveat] = useState(false)

  const { total, breakdown, currentModel, hasData } = useMemo(() => {
    const breakdown: ContentBreakdown = cloneBreakdown(emptyBreakdown)
    const total: ModelTally = { ...emptyTally }
    let currentModel: string | null = null
    let latestTs = -Infinity
    let hasData = false

    if (worktreePath) {
      const tree = panes[worktreePath]
      const terminalIds = new Set<string>()
      if (tree) {
        for (const leaf of getLeaves(tree)) {
          for (const tab of leaf.tabs) {
            if (tab.type === 'agent' || tab.type === 'json-claude') terminalIds.add(tab.id)
          }
        }
      }
      // Dedup by transcriptPath so a --resume'd tab doesn't double-count.
      const seenTranscripts = new Set<string>()
      for (const tid of terminalIds) {
        const usage = costs.byTerminal[tid]
        if (!usage || seenTranscripts.has(usage.transcriptPath)) continue
        seenTranscripts.add(usage.transcriptPath)
        hasData = true
        const sessionTotal = totalForSession(usage)
        total.messages += sessionTotal.messages
        total.input += sessionTotal.input
        total.output += sessionTotal.output
        total.cacheRead += sessionTotal.cacheRead
        total.cacheWrite += sessionTotal.cacheWrite
        total.cost += sessionTotal.cost
        addBreakdown(breakdown, usage.breakdown)
        if (usage.updatedAt > latestTs && usage.currentModel) {
          latestTs = usage.updatedAt
          currentModel = usage.currentModel
        }
      }
    }
    return { total, breakdown, currentModel, hasData }
  }, [worktreePath, costs, panes])

  if (!worktreePath) return null

  const outputRows: Row[] = [
    { label: 'text', cost: breakdown.text },
    { label: 'thinking', cost: breakdown.thinking },
    { label: 'tool_use', cost: breakdown.toolUse }
  ]
  const inputRows: Row[] = [
    { label: 'user prompt', cost: breakdown.userPrompt },
    { label: 'asst echo', cost: breakdown.assistantEcho },
    ...Object.entries(breakdown.toolResults).map(([name, cost]) => ({ label: name, cost }))
  ]

  return (
    <RightPanel
      id="cost"
      title="Cost"
      defaultCollapsed
      onCollapsedChange={(collapsed) => {
        void client.req('costs:setInterest', !collapsed)
      }}
    >
      <View style={{ paddingHorizontal: 12, paddingVertical: 8, gap: 12 }}>
        {!hasData ? (
          <Text style={{ fontSize: fs.xs, color: c.faint, fontStyle: 'italic' }}>No usage yet. Tallies update after each Claude turn.</Text>
        ) : (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
              <Pressable onPress={() => setShowMessages((v) => !v)} hitSlop={12} style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                <Text style={{ fontSize: fs.base, fontWeight: '500', color: c.fg, fontVariant: ['tabular-nums'] }}>{formatCost(total.cost)}</Text>
                {showMessages && <Text style={{ fontSize: fs.xs, color: c.faint }}>{total.messages} assistant messages</Text>}
              </Pressable>
              {currentModel && (
                <Text numberOfLines={1} style={{ fontSize: fs.xs, color: c.faint, flexShrink: 1 }}>
                  {shortModel(currentModel)}
                </Text>
              )}
            </View>
            <Section title="Output (produced)" rows={outputRows} total={total.cost} />
            <Section title="Input (context)" rows={inputRows} total={total.cost} />
            <Pressable onPress={() => setShowCaveat((v) => !v)} style={{ minHeight: 44, justifyContent: 'center' }}>
              <Text style={{ fontSize: fs.xs, color: c.faint, fontStyle: 'italic' }}>breakdown is estimated</Text>
              {showCaveat && (
                <Text style={{ fontSize: fs.xs, color: c.faint, marginTop: 2 }}>
                  Per-block token counts aren't in the Anthropic usage field. Category splits are estimated by char-length proportion within each turn. The top-line total is exact.
                </Text>
              )}
            </Pressable>
          </>
        )}
      </View>
    </RightPanel>
  )
}
