import { Fragment, useState, type ReactNode } from 'react'
import { Brain } from 'lucide-react'
import { getToolDisplay, isNessControl } from './index'

export interface ToolGroupRow {
  key: string
  node: ReactNode
  toolName?: string
  hasError?: boolean
  hasPendingApproval?: boolean
  /** This row's tool returned an image (a browser screenshot). Opens the
   *  group by default so the screenshot is visible in the transcript
   *  rather than buried behind a chevron. */
  hasImages?: boolean
  /** Thinking blocks ride along in the same group as adjacent tool_use
   *  rows since they're both agent work between user-facing replies.
   *  ToolGroup counts them under their own label so the header isn't
   *  misleading ("5 tool calls" when 2 of them are actually thoughts). */
  isThinking?: boolean
}

export function ToolGroup({ rows }: { rows: ToolGroupRow[] }): JSX.Element {
  const hasError = rows.some((r) => r.hasError)
  const hasPending = rows.some((r) => r.hasPendingApproval)
  // Brand styling only fires when an actual ness-control tool is in
  // the group — thinking rows shouldn't trigger the gold gradient.
  const anyBrand = rows.some(
    (r) => !r.isThinking && isNessControl(r.toolName)
  )
  // Auto-expand for pending approvals (they need user action) and for
  // screenshots (they're the payload, not a detail). Errors get a header
  // badge but stay collapsed; user can drill in.
  //
  // null means "no explicit choice yet, follow autoExpand" — so a group
  // opens when an approval lands and closes again once it resolves,
  // while a click pins it either way. Tracking the user's choice as its
  // own state (rather than reverting via an effect) is what lets a
  // screenshot group be collapsed at all: hasImages never goes back to
  // false, so an effect-driven revert would immediately re-open it.
  const autoExpand = hasPending || rows.some((r) => r.hasImages)
  const [userChoice, setUserChoice] = useState<boolean | null>(null)
  const expanded = userChoice ?? autoExpand

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
        <span
          className="opacity-60 truncate flex-1 min-w-0 flex items-center gap-1.5"
          style={{ fontFamily: 'var(--chat-tool-name-family)' }}
        >
          {summary}
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
