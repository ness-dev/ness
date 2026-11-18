import { Fragment, useState, type ReactNode } from 'react'
import { Brain } from 'lucide-react'
import { getToolAction, getToolDisplay } from './index'
import {
  buildTimeline,
  summarizeTools,
  type TimelineRow
} from './tool-timeline'
import { JsonModeChatImageThumb } from '../JsonModeChatImageThumb'
import {
  CHAT_ROW_CLASS,
  CHAT_ROW_STYLE,
  ChatRowChildren,
  Chevron
} from './ChatRow'

export interface ToolGroupRow extends TimelineRow {
  node: ReactNode
  /** See getToolIntent — the provider's label for the call. */
  toolIntent?: string
  hasPendingApproval?: boolean
}

/** Max steps drawn in the collapsed timeline before it gives up and
 *  appends a "+N". Thumbnails are wide, so this is a layout bound as
 *  much as a legibility one. Runs are folded first (see buildTimeline),
 *  so hitting this cap takes a genuinely long session. */
const MAX_TIMELINE_STEPS = 14

/** A left-to-right record of what the agent did in this group:
 *  thumbnails for the steps that produced a screenshot, tool icons for
 *  everything in between — so a browser session reads as
 *  `[shot] click scroll type [shot]` without expanding anything. */
export function ToolTimeline({ rows }: { rows: TimelineRow[] }): JSX.Element {
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
        // Prefer the action icon: a browser run is all ness-control, so
        // the brand mark would repeat down the whole strip.
        const Icon = getToolAction(s.toolName)?.icon ?? display.icon
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
            {Icon ? (
              <Icon className="icon-xs" />
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

  const toolRows = rows.filter((r) => !r.isThinking)
  const thinkingCount = rows.length - toolRows.length

  // The timeline earns its row of vertical space only when there are
  // real screenshots in it. Browser use on its own doesn't qualify — a
  // strip of bare action icons says nothing the count label
  // ("4 clicks · 2 scrolls") doesn't already say in words.
  const allNamed =
    toolRows.length > 0 && toolRows.every((r) => getToolAction(r.toolName))
  const hasImages = rows.some((r) => (r.images?.length ?? 0) > 0)
  const showTimeline = !expanded && hasImages
  // Chips repeat what the count label already spells out once every
  // call is named ("4 clicks · 2 screenshots"), and the timeline says
  // it a third time. Keep them for mixed groups, where the label's
  // "N more calls" remainder is vague on its own.
  const showChips = !showTimeline && !allNamed

  // A chip reads as the model's stated intent when the tool carries one
  // ("Run typecheck" beats "Bash"); the icon still says which tool.
  const displays = toolRows.map((r) => {
    const d = getToolDisplay(r.toolName)
    return { icon: d.icon, text: r.toolIntent ?? d.compactLabel }
  })
  const visibleDisplays = displays.slice(0, 6)
  const moreCount = displays.length - 6
  const summary = (
    <>
      {visibleDisplays.map((d, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="opacity-40 shrink-0">·</span>}
          {d.icon && <d.icon className="icon-xs shrink-0" />}
          <span className="truncate shrink-0 max-w-[16rem]" title={d.text}>
            {d.text}
          </span>
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

  const thinkingLabel =
    thinkingCount > 0
      ? `${thinkingCount} thought${thinkingCount === 1 ? '' : 's'}`
      : ''
  const countLabel = [thinkingLabel, ...summarizeTools(toolRows)]
    .filter(Boolean)
    .join(' · ')

  return (
    <div>
      <button
        type="button"
        onClick={() => setUserChoice(!expanded)}
        className={CHAT_ROW_CLASS}
        style={CHAT_ROW_STYLE}
      >
        <Chevron open={expanded} className="" />
        {thinkingCount > 0 && <Brain className="icon-xs shrink-0" />}
        <span className="shrink-0">{countLabel}</span>
        {/* Stays in the tree even when empty — it's the flex-1 spacer
            that keeps the badges on the right from shifting as chips
            come and go. */}
        <span
          className="opacity-70 overflow-hidden whitespace-nowrap flex-1 min-w-0 flex items-center gap-1.5"
          style={{
            maskImage: 'linear-gradient(to right, black calc(100% - 2rem), transparent)'
          }}
        >
          {showChips ? summary : null}
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
      {showTimeline && (
        <div className="pt-1 -mx-2">
          <ToolTimeline rows={rows} />
        </div>
      )}
      {expanded && (
        <ChatRowChildren>
          {rows.map((r) => (
            <div key={r.key}>{r.node}</div>
          ))}
        </ChatRowChildren>
      )}
    </div>
  )
}
