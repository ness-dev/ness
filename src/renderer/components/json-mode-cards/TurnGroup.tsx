import { useState, type ReactNode } from 'react'
import { ToolTimeline } from './ToolGroup'
import { ChatRowChildren, Chevron } from './ChatRow'
import { useFind } from '../JsonModeChatFind'
import {
  formatTurnDuration,
  turnHasFindHit,
  type TurnRow,
  type TurnSummary
} from './turn-collapse'

function summaryLabel(summary: TurnSummary): string {
  const parts = [
    summary.durationMs !== undefined
      ? `Worked for ${formatTurnDuration(summary.durationMs)}`
      : 'Worked',
    `${summary.toolCount} tool${summary.toolCount === 1 ? '' : 's'}`
  ]
  if (summary.editedFileCount > 0) {
    parts.push(
      `${summary.editedFileCount} file${summary.editedFileCount === 1 ? '' : 's'} edited`
    )
  }
  return parts.join(' · ')
}

/** A finished turn's work, folded into one line above its final answer.
 *  Opens on its own while find-in-chat has a hit inside it, so the match
 *  is rendered (and its <mark> counted) without the user expanding it. */
export function TurnGroup({
  rows,
  summary,
  children
}: {
  rows: TurnRow[]
  summary: TurnSummary
  children: ReactNode
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const { hitEntryIds } = useFind()
  const forceOpen = turnHasFindHit(rows, hitEntryIds)
  const isOpen = expanded || forceOpen
  const hasError = rows.some((r) => r.hasError)
  const hasImages = rows.some((r) => (r.images?.length ?? 0) > 0)
  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded(!isOpen)}
        aria-expanded={isOpen}
        className="w-full flex items-center gap-2 cursor-pointer text-left text-muted hover:text-fg transition-colors"
        style={{ fontSize: 'var(--chat-chrome-text)' }}
      >
        <Chevron open={isOpen} />
        <span className="shrink-0">{summaryLabel(summary)}</span>
        {hasError && (
          <span
            className="text-danger/80 uppercase tracking-wide shrink-0"
            style={{ fontSize: 'var(--chat-meta-text)' }}
          >
            errors
          </span>
        )}
      </button>
      {!isOpen && hasImages && (
        <div className="pt-1.5 -mx-2">
          <ToolTimeline rows={rows} />
        </div>
      )}
      {isOpen && (
        <ChatRowChildren>
          <div className="space-y-3">{children}</div>
        </ChatRowChildren>
      )}
    </div>
  )
}
