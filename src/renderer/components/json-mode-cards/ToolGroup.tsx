import { Fragment, useState, type ReactNode } from 'react'
import { Brain } from 'lucide-react'
import type { JsonClaudeImageRef } from '../../../shared/state/json-claude'
import { getToolDisplay, isNessControl } from './index'
import { JsonModeChatImageThumb } from '../JsonModeChatImageThumb'

export interface ToolGroupRow {
  key: string
  node: ReactNode
  toolName?: string
  hasError?: boolean
  hasPendingApproval?: boolean
  /** Images this row's tool returned — browser screenshots, in practice.
   *  Rendered as half-size thumbnails in the collapsed timeline strip so
   *  the group doesn't have to force itself open to show them. */
  images?: JsonClaudeImageRef[]
  /** Thinking blocks ride along in the same group as adjacent tool_use
   *  rows since they're both agent work between user-facing replies.
   *  ToolGroup counts them under their own label so the header isn't
   *  misleading ("5 tool calls" when 2 of them are actually thoughts). */
  isThinking?: boolean
}

/** Max steps drawn in the collapsed timeline before it gives up and
 *  appends a "+N". Thumbnails are wide, so this is a layout bound as
 *  much as a legibility one. Runs are collapsed first (see
 *  buildTimeline), so hitting this cap takes a genuinely long session. */
const MAX_TIMELINE_STEPS = 14

type TimelineStep =
  | { kind: 'images'; key: string; images: JsonClaudeImageRef[] }
  | {
      kind: 'tool'
      key: string
      toolName?: string
      count: number
      hasError: boolean
    }

/** Consecutive calls to the same tool fold into one step with a count
 *  (`scroll ×4`), so eight scrolls between two screenshots don't push
 *  the second one off the end of the strip. Rows that returned an image
 *  never fold — each screenshot is its own beat in the timeline. */
function buildTimeline(rows: ToolGroupRow[]): TimelineStep[] {
  const steps: TimelineStep[] = []
  for (const r of rows) {
    if (r.isThinking) continue
    if (r.images && r.images.length > 0) {
      steps.push({ kind: 'images', key: r.key, images: r.images })
      continue
    }
    const prev = steps[steps.length - 1]
    if (prev && prev.kind === 'tool' && prev.toolName === r.toolName) {
      prev.count += 1
      prev.hasError = prev.hasError || !!r.hasError
      continue
    }
    steps.push({
      kind: 'tool',
      key: r.key,
      toolName: r.toolName,
      count: 1,
      hasError: !!r.hasError
    })
  }
  return steps
}

/** A left-to-right record of what the agent did in this group:
 *  thumbnails for the steps that produced a screenshot, tool icons for
 *  everything in between — so a browser session reads as
 *  `[shot] click scroll type [shot]` without expanding anything. */
function ToolTimeline({ rows }: { rows: ToolGroupRow[] }): JSX.Element {
  const steps = buildTimeline(rows)
  const shown = steps.slice(0, MAX_TIMELINE_STEPS)
  const moreCount = steps.length - shown.length
  return (
    <div className="flex flex-wrap items-center gap-1 px-2 pb-1.5">
      {shown.map((s) => {
        if (s.kind === 'images') {
          return (
            <Fragment key={s.key}>
              {s.images.map((img) => (
                <JsonModeChatImageThumb
                  key={img.path}
                  path={img.path}
                  mediaType={img.mediaType}
                  shape="wide"
                  size="sm"
                />
              ))}
            </Fragment>
          )
        }
        const display = getToolDisplay(s.toolName)
        return (
          <span
            key={s.key}
            title={
              s.count > 1
                ? `${display.compactLabel} ×${s.count}`
                : display.compactLabel
            }
            className={`h-6 shrink-0 rounded border flex items-center justify-center gap-0.5 ${
              s.count > 1 ? 'px-1' : 'w-6'
            } ${
              s.hasError
                ? 'border-danger/50 text-danger bg-danger/10'
                : 'border-border/60 text-muted bg-app/40'
            }`}
          >
            {display.icon ? (
              <display.icon className="icon-xs" />
            ) : (
              <span style={{ fontSize: 'var(--chat-meta-text)' }}>
                {display.compactLabel.slice(0, 1)}
              </span>
            )}
            {s.count > 1 && (
              <span
                className="tabular-nums"
                style={{ fontSize: 'var(--chat-meta-text)' }}
              >
                {s.count}
              </span>
            )}
          </span>
        )
      })}
      {moreCount > 0 && (
        <span
          className="text-muted shrink-0 pl-0.5"
          style={{ fontSize: 'var(--chat-meta-text)' }}
        >
          +{moreCount}
        </span>
      )}
    </div>
  )
}

export function ToolGroup({ rows }: { rows: ToolGroupRow[] }): JSX.Element {
  const hasError = rows.some((r) => r.hasError)
  const hasPending = rows.some((r) => r.hasPendingApproval)
  // Brand styling only fires when an actual ness-control tool is in
  // the group — thinking rows shouldn't trigger the gold gradient.
  const anyBrand = rows.some(
    (r) => !r.isThinking && isNessControl(r.toolName)
  )
  // Auto-expand only for pending approvals — they need user action.
  // Errors get a header badge but stay collapsed; user can drill in.
  // Screenshots used to force-expand too, which meant any group
  // containing one could never sit collapsed; they now ride along in
  // the collapsed timeline strip instead.
  //
  // null means "no explicit choice yet, follow autoExpand" — so a group
  // opens when an approval lands and closes again once it resolves,
  // while a click pins it either way.
  const autoExpand = hasPending
  const [userChoice, setUserChoice] = useState<boolean | null>(null)
  const expanded = userChoice ?? autoExpand
  // Only worth drawing when something visual came back — a group of
  // plain Reads reads better as the text chips in the header.
  const showTimeline = !expanded && rows.some((r) => (r.images?.length ?? 0) > 0)

  const toolRows = rows.filter((r) => !r.isThinking)
  const thinkingCount = rows.length - toolRows.length

  const displays = toolRows.map((r) => getToolDisplay(r.toolName))
  const visibleDisplays = displays.slice(0, 6)
  const moreCount = displays.length - 6
  const summary = (
    <>
      {visibleDisplays.map((d, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="opacity-40">·</span>}
          {d.icon && <d.icon className="icon-xs shrink-0" />}
          <span>{d.compactLabel}</span>
        </Fragment>
      ))}
      {moreCount > 0 && (
        <>
          <span className="opacity-40">·</span>
          <span>+{moreCount} more</span>
        </>
      )}
    </>
  )

  // Count label: "3 tool calls", "2 thoughts", or "2 thoughts · 3 tools"
  // when mixed. Singular gets singular ("1 thought", "1 tool call").
  const toolLabel =
    toolRows.length > 0
      ? `${toolRows.length} tool${toolRows.length === 1 ? ' call' : ' calls'}`
      : ''
  const thinkingLabel =
    thinkingCount > 0
      ? `${thinkingCount} thought${thinkingCount === 1 ? '' : 's'}`
      : ''
  const countLabel = [thinkingLabel, toolLabel].filter(Boolean).join(' · ')

  return (
    <div
      className={`my-2 border ${anyBrand ? 'border-warning/30' : 'border-border/60'} bg-app/30 overflow-hidden`}
      style={{ borderRadius: 'var(--chat-bubble-radius)' }}
    >
      {anyBrand && <div className="brand-gradient-bg h-0.5" />}
      <button
        type="button"
        onClick={() => setUserChoice(!expanded)}
        className={`${anyBrand ? 'group' : ''} w-full flex items-center gap-2 cursor-pointer hover:bg-app/60 transition-colors text-left`}
        style={{
          paddingInline: 'var(--chat-chrome-px)',
          paddingBlock: 'var(--chat-chrome-py)',
          fontSize: 'var(--chat-chrome-text)'
        }}
      >
        <span className="text-muted text-xs w-2 shrink-0 select-none">
          {expanded ? '▾' : '▸'}
        </span>
        {thinkingCount > 0 && (
          <Brain className="icon-xs text-muted shrink-0" />
        )}
        <span
          className={`shrink-0 ${anyBrand ? 'brand-gradient-text brand-gradient-flow-text-hover' : 'text-muted'}`}
          style={{ fontFamily: 'var(--chat-tool-name-family)' }}
        >
          {countLabel}
        </span>
        {/* The timeline strip below says the same thing with icons and
            thumbnails, so the text chips would just be noise next to
            it. The span stays as the flex-1 spacer either way so the
            badges on the right don't shift between states. */}
        <span
          className="opacity-60 truncate flex-1 min-w-0 flex items-center gap-1.5"
          style={{ fontFamily: 'var(--chat-tool-name-family)' }}
        >
          {showTimeline ? null : summary}
        </span>
        {hasPending && (
          <span
            className="text-warning uppercase tracking-wide shrink-0"
            style={{ fontSize: 'var(--chat-meta-text)' }}
          >
            needs approval
          </span>
        )}
        {hasError && (
          <span
            className="text-danger uppercase tracking-wide shrink-0"
            style={{ fontSize: 'var(--chat-meta-text)' }}
          >
            error
          </span>
        )}
      </button>
      {showTimeline && <ToolTimeline rows={rows} />}
      {expanded && (
        <div className="px-2">
          {rows.map((r) => (
            <div key={r.key}>{r.node}</div>
          ))}
        </div>
      )}
    </div>
  )
}
