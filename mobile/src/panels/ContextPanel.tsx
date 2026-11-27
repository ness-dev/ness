// Port of renderer/components/ContextPanel.tsx. Same support check, rows,
// sort, Codex single-row fallback, and interest gate:
// `contextWindow:setInterest` follows the collapse state (RightPanel
// reports `true` = collapsed on unmount). Hover titles are tap-to-expand:
// tap a category row for its explanation, the "until compact" line for
// the threshold, the caveat for how the split is computed. The meter's
// per-segment titles are omitted — every segment is a row right below.
import { useMemo, useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { findTabById, isClaudeBackedTab } from '../../../src/shared/state/terminals'
import type { ContextSnapshot } from '../../../src/shared/state/context-window'
import { useNess } from '../ness'
import { alpha, c, fs } from '../theme'
import { RightPanel } from './RightPanel'
import type { PanelProps } from './types'

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function shortModel(model: string): string {
  return model.replace(/^claude-/, '')
}

/** `mcp__<server>__<tool>` → `<server>/<tool>`. */
function shortToolName(name: string): string {
  const mcp = name.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/)
  if (mcp) return `${mcp[1]}/${mcp[2]}`
  return name
}

interface Row {
  label: string
  tokens: number
  /** Swatch + meter segment colour. */
  color: string
  title?: string
}

// Tool-result rows: `bg-danger` on the desktop (it used to be the
// non-existent `bg-error`, which rendered colourless).


function buildRows(snapshot: ContextSnapshot): Row[] {
  const k = snapshot.categories
  const rows: Row[] = [
    {
      label: 'System + tools',
      tokens: k.systemAndTools,
      color: c.faint,
      title: 'System prompt and tool schemas. Derived as the part of the window the conversation does not account for.'
    },
    {
      label: 'CLAUDE.md',
      tokens: k.memoryFiles,
      color: c.muted,
      title: 'Memory files, sized from disk. The API folds these into the system block, so this is an estimate.'
    },
    { label: 'Carried summary', tokens: k.carriedSummary, color: c.warning, title: 'The continuation summary written by the last compaction.' },
    { label: 'Attachments', tokens: k.attachments, color: c.accent, title: 'Skill listings, agent listings, todo reminders and @-mentioned files.' },
    { label: 'Your messages', tokens: k.userPrompts, color: c.success },
    { label: 'Claude replies', tokens: k.assistantText, color: c.fg },
    { label: 'Thinking', tokens: k.thinking, color: c.fgBright },
    {
      label: 'Tool calls',
      tokens: k.toolCalls,
      color: c.danger,
      title: 'Arguments passed to tools. Write and Edit carry whole file bodies, so this is often larger than it looks like it should be.'
    }
  ]
  for (const [name, tokens] of Object.entries(k.toolResults)) {
    rows.push({ label: shortToolName(name), tokens, color: c.danger, title: name })
  }
  return rows
}

const num = { fontSize: fs.xs, fontVariant: ['tabular-nums' as const] }

function Meter({ rows, limit }: { rows: Row[]; limit: number }) {
  return (
    <View style={{ flexDirection: 'row', height: 8, width: '100%', overflow: 'hidden', borderRadius: 2, backgroundColor: alpha(c.panelRaised, 0.4) }}>
      {rows
        .filter((r) => r.tokens > 0)
        .map((r) => (
          <View key={r.label} style={{ backgroundColor: r.color, width: `${(r.tokens / limit) * 100}%` }} />
        ))}
      <View style={{ flex: 1 }} />
    </View>
  )
}

function BarRow({ row, used }: { row: Row; used: number }) {
  const [open, setOpen] = useState(false)
  const pct = used > 0 ? (row.tokens / used) * 100 : 0
  return (
    <Pressable onPress={() => setOpen((v) => !v)} disabled={!row.title} style={{ minHeight: 28, justifyContent: 'center' }} hitSlop={{ top: 8, bottom: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: row.color }} />
        <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: fs.xs, color: c.faint }}>
          {row.label}
        </Text>
        <Text style={{ ...num, color: c.faint, width: 36, textAlign: 'right' }}>{pct >= 1 ? `${Math.round(pct)}%` : '<1%'}</Text>
        <Text style={{ ...num, color: c.fg, width: 52, textAlign: 'right' }}>{formatTokens(row.tokens)}</Text>
      </View>
      {open && row.title && <Text style={{ fontSize: fs.xs, color: c.faint, paddingLeft: 16, paddingTop: 2 }}>{row.title}</Text>}
    </Pressable>
  )
}

export function ContextPanel({ client, focusedTabId }: PanelProps) {
  const panes = useNess(client, (s) => s.terminals.panes)
  const snapshot = useNess(client, (s) => (focusedTabId ? s.contextWindow.byTerminal[focusedTabId] : undefined))
  const [showDiscoverable, setShowDiscoverable] = useState(false)
  const [showCompactHint, setShowCompactHint] = useState(false)
  const [showCaveat, setShowCaveat] = useState(false)

  // Non-Claude terminal tabs never produce a snapshot; hide outright.
  const supported = useMemo(() => {
    const tab = focusedTabId ? findTabById(panes, focusedTabId) : null
    return tab?.type === 'json-claude' || isClaudeBackedTab(tab)
  }, [panes, focusedTabId])

  const rows = useMemo(() => (snapshot ? buildRows(snapshot) : []), [snapshot])

  if (!supported) return null

  const breakdown = rows.filter((r) => r.tokens > 0).sort((a, b) => b.tokens - a.tokens)
  // Codex reports a total but no breakdown; one row keeps the meter honest.
  const sorted: Row[] =
    breakdown.length === 0 && snapshot && snapshot.usedTokens > 0
      ? [{ label: 'In use', tokens: snapshot.usedTokens, color: c.fg, title: 'This agent reports how much of the window is in use, not what is using it.' }]
      : breakdown
  const pct = snapshot && snapshot.limit > 0 ? (snapshot.usedTokens / snapshot.limit) * 100 : 0
  const toCompact = snapshot ? snapshot.autocompactAt - snapshot.usedTokens : 0

  return (
    <RightPanel
      id="context"
      title="Context"
      defaultCollapsed
      onCollapsedChange={(collapsed) => {
        void client.api.setContextWindowInterest(!collapsed)
      }}
      actions={snapshot ? <Text style={{ ...num, color: c.faint }}>{Math.round(pct)}%</Text> : undefined}
    >
      {!snapshot ? (
        <Text style={{ paddingHorizontal: 12, paddingVertical: 8, fontSize: fs.xs, color: c.faint, fontStyle: 'italic' }}>No context data yet. Updates after each turn.</Text>
      ) : (
        <>
          {/* Pinned: the headline stays readable while the list scrolls. */}
          <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 8, gap: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
              <Text style={{ fontSize: fs.base, fontWeight: '500', color: c.fg, fontVariant: ['tabular-nums'] }}>{Math.round(pct)}%</Text>
              <Text style={{ ...num, color: c.faint }}>
                {formatTokens(snapshot.usedTokens)} / {formatTokens(snapshot.limit)}
              </Text>
            </View>
            <Meter rows={sorted} limit={snapshot.limit} />
            <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
              <Pressable onPress={() => setShowCompactHint((v) => !v)} hitSlop={12} style={{ flexShrink: 1 }}>
                <Text style={{ fontSize: fs.xs, color: c.faint }}>{toCompact > 0 ? `${formatTokens(toCompact)} until compact` : 'compact imminent'}</Text>
              </Pressable>
              {snapshot.model && (
                <Text numberOfLines={1} style={{ fontSize: fs.xs, color: c.faint, flexShrink: 1 }}>
                  {shortModel(snapshot.model)}
                </Text>
              )}
            </View>
            {showCompactHint && (
              <Text style={{ fontSize: fs.xs, color: c.faint }}>
                {toCompact > 0 ? `Expected to auto-compact around ${formatTokens(snapshot.autocompactAt)}` : 'Past the expected auto-compact point'}
              </Text>
            )}
          </View>

          {/* max-h-48 scroller: the tool list is unbounded in practice. */}
          <ScrollView style={{ maxHeight: 192 }} nestedScrollEnabled contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 8, gap: 12 }}>
            <View style={{ gap: 4 }}>
              {sorted.map((r) => (
                <BarRow key={r.label} row={r} used={snapshot.usedTokens} />
              ))}
            </View>

            {snapshot.compactions > 0 && (
              <Text style={{ fontSize: fs.xs, color: c.faint }}>
                {snapshot.compactions} compaction{snapshot.compactions === 1 ? '' : 's'} so far — everything before the last one is gone.
              </Text>
            )}

            {snapshot.discoverableTools.length > 0 && (
              <View style={{ gap: 4 }}>
                <Pressable onPress={() => setShowDiscoverable((v) => !v)} style={{ minHeight: 44, justifyContent: 'center' }}>
                  <Text style={{ fontSize: fs.xs, color: c.faint }}>
                    {showDiscoverable ? '▾' : '▸'} {snapshot.discoverableTools.length} tools discoverable, not loaded
                  </Text>
                </Pressable>
                {showDiscoverable && (
                  <>
                    <Text style={{ fontSize: fs.xs, color: c.faint, fontStyle: 'italic' }}>
                      Tools the agent can pull in on demand. Their schemas are not in the window until used.
                    </Text>
                    <Text style={{ fontSize: fs.xs, color: c.faint, lineHeight: 20 }}>{snapshot.discoverableTools.map(shortToolName).join(', ')}</Text>
                  </>
                )}
              </View>
            )}

            {breakdown.length > 0 && (
              <Pressable onPress={() => setShowCaveat((v) => !v)} style={{ minHeight: 44, justifyContent: 'center' }}>
                <Text style={{ fontSize: fs.xs, color: c.faint, fontStyle: 'italic' }}>total is exact, split is estimated</Text>
                {showCaveat && (
                  <Text style={{ fontSize: fs.xs, color: c.faint, marginTop: 2 }}>
                    The total is exact — it comes off the last turn's usage record. The category split is anchored to the measured token delta between turns and divided within each turn by char proportion.
                  </Text>
                )}
              </Pressable>
            )}
          </ScrollView>
        </>
      )}
    </RightPanel>
  )
}
