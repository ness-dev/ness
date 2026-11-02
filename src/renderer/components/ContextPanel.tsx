import { useMemo, useState } from 'react'
import { RightPanel } from './RightPanel'
import { useContextWindow, usePanes } from '../store'
import { useBackend } from '../backend'
import { findTabById, isClaudeBackedTab } from '../../shared/state/terminals'
import type { ContextSnapshot } from '../../shared/state/context-window'

interface ContextPanelProps {
  /** Tab whose window we're showing. Works for terminal agent tabs and
   *  chat tabs alike — both key the slice by tab id. */
  focusedTabId: string | null
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function shortModel(model: string): string {
  return model.replace(/^claude-/, '')
}

/** MCP tool ids are `mcp__<server>__<tool>` and blow out the label column.
 *  The server is the part worth seeing at a glance. */
function shortToolName(name: string): string {
  const mcp = name.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/)
  if (mcp) return `${mcp[1]}/${mcp[2]}`
  return name
}

interface Row {
  label: string
  tokens: number
  /** Tailwind bg class for the bar and the stacked meter segment. */
  color: string
  title?: string
}

function Meter({ rows, used, limit }: { rows: Row[]; used: number; limit: number }): JSX.Element {
  const free = Math.max(0, limit - used)
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-sm bg-panel-raised/40">
      {rows
        .filter((r) => r.tokens > 0)
        .map((r) => (
          <div
            key={r.label}
            className={r.color}
            style={{ width: `${(r.tokens / limit) * 100}%` }}
            title={`${r.label} — ${formatTokens(r.tokens)}`}
          />
        ))}
      <div className="flex-1" title={`free — ${formatTokens(free)}`} />
    </div>
  )
}

function BarRow({ row, used }: { row: Row; used: number }): JSX.Element {
  const pct = used > 0 ? (row.tokens / used) * 100 : 0
  return (
    <div className="flex items-center gap-2 text-xs leading-tight" title={row.title}>
      <span className={`w-2 h-2 shrink-0 rounded-sm ${row.color}`} />
      <span className="text-faint truncate flex-1 min-w-0">{row.label}</span>
      <span className="text-faint tabular-nums w-8 text-right shrink-0">
        {pct >= 1 ? `${Math.round(pct)}%` : '<1%'}
      </span>
      <span className="text-text tabular-nums w-12 text-right shrink-0">
        {formatTokens(row.tokens)}
      </span>
    </div>
  )
}

function buildRows(snapshot: ContextSnapshot): Row[] {
  const c = snapshot.categories
  const rows: Row[] = [
    {
      label: 'System + tools',
      tokens: c.systemAndTools,
      color: 'bg-faint',
      title: 'System prompt and tool schemas. Derived as the part of the window the conversation does not account for.'
    },
    {
      label: 'CLAUDE.md',
      tokens: c.memoryFiles,
      color: 'bg-muted',
      title: 'Memory files, sized from disk. The API folds these into the system block, so this is an estimate.'
    },
    {
      label: 'Carried summary',
      tokens: c.carriedSummary,
      color: 'bg-warning',
      title: 'The continuation summary written by the last compaction.'
    },
    {
      label: 'Attachments',
      tokens: c.attachments,
      color: 'bg-accent',
      title: 'Skill listings, agent listings, todo reminders and @-mentioned files.'
    },
    { label: 'Your messages', tokens: c.userPrompts, color: 'bg-success' },
    { label: 'Claude replies', tokens: c.assistantText, color: 'bg-fg' },
    { label: 'Thinking', tokens: c.thinking, color: 'bg-fg-bright' },
    {
      label: 'Tool calls',
      tokens: c.toolCalls,
      color: 'bg-danger',
      title: 'Arguments passed to tools. Write and Edit carry whole file bodies, so this is often larger than it looks like it should be.'
    }
  ]
  for (const [name, tokens] of Object.entries(c.toolResults)) {
    rows.push({ label: shortToolName(name), tokens, color: 'bg-error', title: name })
  }
  return rows
}

export function ContextPanel({ focusedTabId }: ContextPanelProps): JSX.Element | null {
  const backend = useBackend()
  const panes = usePanes()
  const snapshot = useContextWindow(focusedTabId)
  const [showDiscoverable, setShowDiscoverable] = useState(false)

  // Terminal tabs other than Claude never produce a snapshot, so a "no
  // data yet" message would promise something that is never coming. Every
  // chat provider reports one (Codex from its own usage events).
  const supported = useMemo(() => {
    const tab = focusedTabId ? findTabById(panes, focusedTabId) : null
    return tab?.type === 'json-claude' || isClaudeBackedTab(tab)
  }, [panes, focusedTabId])

  const rows = useMemo(() => (snapshot ? buildRows(snapshot) : []), [snapshot])

  // Hide the panel outright rather than render an empty shell — same
  // pattern as JsonClaudeTodosPanel. Shell / diff / browser tabs take
  // this path too.
  if (!supported) return null

  // Sorted so the biggest consumer is always the first thing read —
  // that's the whole point of the panel.
  const breakdown = rows.filter((r) => r.tokens > 0).sort((a, b) => b.tokens - a.tokens)
  // Codex reports a total but no breakdown; one row keeps the meter honest.
  const sorted: Row[] =
    breakdown.length === 0 && snapshot && snapshot.usedTokens > 0
      ? [
          {
            label: 'In use',
            tokens: snapshot.usedTokens,
            color: 'bg-fg',
            title: 'This agent reports how much of the window is in use, not what is using it.'
          }
        ]
      : breakdown
  const pct = snapshot && snapshot.limit > 0 ? (snapshot.usedTokens / snapshot.limit) * 100 : 0
  const toCompact = snapshot ? snapshot.autocompactAt - snapshot.usedTokens : 0

  return (
    <RightPanel
      id="context"
      title="Context"
      defaultCollapsed
      onCollapsedChange={(c) => {
        backend.setContextWindowInterest(!c)
      }}
      actions={
        snapshot ? (
          <span className="text-xs text-faint tabular-nums">
            {Math.round(pct)}%
          </span>
        ) : undefined
      }
    >
      {!snapshot ? (
        <div className="px-3 py-2 text-xs text-faint italic">
          No context data yet. Updates after each turn.
        </div>
      ) : (
        <>
          {/* Pinned: the headline stays readable while the list scrolls. */}
          <div className="shrink-0 px-3 pt-2 pb-2 flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-base font-medium text-text tabular-nums">
                {Math.round(pct)}%
              </span>
              <span className="text-xs text-faint tabular-nums">
                {formatTokens(snapshot.usedTokens)} / {formatTokens(snapshot.limit)}
              </span>
            </div>
            <Meter rows={sorted} used={snapshot.usedTokens} limit={snapshot.limit} />
            <div className="flex items-baseline justify-between gap-2 text-xs text-faint">
              <span
                title={
                  toCompact > 0
                    ? `Expected to auto-compact around ${formatTokens(snapshot.autocompactAt)}`
                    : 'Past the expected auto-compact point'
                }
              >
                {toCompact > 0
                  ? `${formatTokens(toCompact)} until compact`
                  : 'compact imminent'}
              </span>
              {snapshot.model && (
                <span className="truncate">{shortModel(snapshot.model)}</span>
              )}
            </div>
          </div>

          {/* The category list grows with however many distinct tools a
              session has touched — unbounded in practice, and an
              MCP-heavy session produces enough rows to push every panel
              below it off screen.
              The cap lives here rather than on RightPanel's maxHeight:
              that would put a max-height on the body and leave this
              region to work out its own share via flex-1, which only
              resolves if every ancestor cooperates — and it didn't, so
              the tail of the list ended up below the viewport instead of
              inside a scroller. Capping the scroller itself is
              self-contained and can't be undone by a parent.
              The discoverable-tools list and the estimate caveat live in
              here too, so neither is pinned. */}
          <div className="max-h-48 overflow-y-auto px-3 pb-2 flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              {sorted.map((r) => (
                <BarRow key={r.label} row={r} used={snapshot.usedTokens} />
              ))}
            </div>

            {snapshot.compactions > 0 && (
              <div className="text-xs text-faint">
                {snapshot.compactions} compaction{snapshot.compactions === 1 ? '' : 's'} so
                far — everything before the last one is gone.
              </div>
            )}

            {snapshot.discoverableTools.length > 0 && (
              <div className="flex flex-col gap-1">
                <button
                  className="text-xs text-faint hover:text-text text-left"
                  onClick={() => setShowDiscoverable((v) => !v)}
                  title="Tools the agent can pull in on demand. Their schemas are not in the window until used."
                >
                  {showDiscoverable ? '▾' : '▸'} {snapshot.discoverableTools.length} tools
                  discoverable, not loaded
                </button>
                {showDiscoverable && (
                  <div className="text-xs text-faint leading-relaxed break-words">
                    {snapshot.discoverableTools.map(shortToolName).join(', ')}
                  </div>
                )}
              </div>
            )}

            {breakdown.length > 0 && (
              <div
                className="text-xs text-faint italic"
                title="The total is exact — it comes off the last turn's usage record. The category split is anchored to the measured token delta between turns and divided within each turn by char proportion."
              >
                total is exact, split is estimated
              </div>
            )}
          </div>
        </>
      )}
    </RightPanel>
  )
}
