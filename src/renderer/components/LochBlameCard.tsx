import type { LochConversation } from '../../shared/loch'

function ago(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const diff = Date.now() - t
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  const days = Math.floor(diff / 86_400_000)
  if (days < 30) return `${days}d ago`
  return new Date(t).toLocaleDateString()
}

/** Hover card for one blame hunk. The prompt is loch-redacted but may carry
 *  raw harness markup (`<task-notification>` etc.), so it is rendered as a
 *  plain text node — never markdown, never HTML. */
export function LochBlameCard({
  conversation,
  start,
  end,
  colorSlot
}: {
  conversation: LochConversation
  start: number
  end: number
  colorSlot: number
}): JSX.Element {
  const title = conversation.title?.trim() || 'Untitled session'
  const prompt = conversation.prompt?.trim()
  return (
    <div className="w-[26rem] max-w-[70vw] rounded-md border border-border bg-panel-raised shadow-lg text-xs text-fg overflow-hidden">
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
        <span className={`loch-swatch loch-c${colorSlot} shrink-0`} />
        <span className="font-medium text-fg-bright truncate flex-1 min-w-0" title={title}>
          {title}
        </span>
        <span className="text-faint shrink-0">{conversation.agent}</span>
      </div>
      <div className="px-3 pb-2 text-dim flex items-center gap-1.5 flex-wrap">
        <span>Turn {conversation.index}</span>
        <span className="text-faint">·</span>
        <span title={conversation.ended}>ended {ago(conversation.ended)}</span>
        <span className="text-faint">·</span>
        <span>{start === end ? `line ${start}` : `lines ${start}–${end}`}</span>
        {conversation.backfilled && (
          <span
            className="text-faint italic"
            title="Reconstructed by `loch backfill` from transcripts and commits, so the attribution is coarser than a hook-recorded turn."
          >
            · backfilled
          </span>
        )}
      </div>
      {prompt && (
        <div className="mx-3 mb-2 px-2 py-1.5 rounded bg-panel border border-border font-mono text-dim whitespace-pre-wrap break-words line-clamp-6">
          {prompt}
        </div>
      )}
      <div className="px-3 py-1.5 border-t border-border text-faint">
        {conversation.available
          ? 'Click the bar to ask this conversation about it'
          : 'Transcript not available — can’t open a chat'}
      </div>
    </div>
  )
}
