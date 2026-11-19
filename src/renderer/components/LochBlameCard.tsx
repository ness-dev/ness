import type { LochConversation, LochSessionInfo } from '../../shared/loch'

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

/** A labelled block of prompt text. Clamped while hovering; a pinned card
 *  scrolls instead so the whole thing can be read. */
function PromptBlock({
  label,
  text,
  pinned,
  clampClass,
  maxHeightClass
}: {
  label: string
  text: string
  pinned: boolean
  clampClass: string
  maxHeightClass: string
}): JSX.Element {
  return (
    <div className="mx-3 mb-2">
      <div className="text-faint mb-1">{label}</div>
      {/* The clamp sits on an inner element: on the padded box itself the
          clipped lines would show through the bottom padding. */}
      <div
        className={`px-2 py-1.5 rounded bg-panel border border-border text-dim ${
          pinned ? `${maxHeightClass} overflow-y-auto` : ''
        }`}
      >
        <div className={`whitespace-pre-wrap break-words ${pinned ? '' : clampClass}`}>{text}</div>
      </div>
    </div>
  )
}

/** Hover card for one blame hunk. Prompts are rendered as plain text nodes —
 *  never markdown or HTML — since they can carry raw harness markup
 *  (`<task-notification>` etc.). The turn prompt is loch-redacted; the first
 *  prompt is read by Ness from the user's own local transcript. */
export function LochBlameCard({
  conversation,
  start,
  end,
  colorSlot,
  session,
  pinned = false,
  onAsk
}: {
  conversation: LochConversation
  start: number
  end: number
  colorSlot: number
  session?: LochSessionInfo
  pinned?: boolean
  /** Present only on a pinned card: the explicit, turn-spending action. */
  onAsk?: (atTurn: boolean) => void
}): JSX.Element {
  const title = conversation.title?.trim() || 'Untitled session'
  const turnPrompt = conversation.prompt?.trim()
  const firstPrompt = session?.firstPrompt?.trim()
  // Turn 1's prompt usually IS the first prompt; loch's copy is a truncated
  // prefix of it, so showing both would repeat the same words.
  const sameAsFirst =
    !!firstPrompt && !!turnPrompt && firstPrompt.startsWith(turnPrompt.replace(/…$/, ''))
  return (
    <div className="w-[34rem] max-w-[80vw] rounded-md border border-border bg-panel-raised shadow-lg text-xs text-fg overflow-hidden">
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
      {firstPrompt && (
        <PromptBlock
          label="Conversation started with"
          text={firstPrompt}
          pinned={pinned}
          clampClass="line-clamp-[10]"
          maxHeightClass="max-h-[16rem]"
        />
      )}
      {turnPrompt && !sameAsFirst && (
        <PromptBlock
          label={`Turn ${conversation.index} prompt`}
          text={turnPrompt}
          pinned={pinned}
          clampClass="line-clamp-4 font-mono"
          maxHeightClass="max-h-[8rem] font-mono"
        />
      )}
      {!conversation.available ? (
        <div className="px-3 py-1.5 border-t border-border text-faint">
          Transcript not available — can’t open a chat
        </div>
      ) : onAsk ? (
        <div className="px-3 py-2 border-t border-border flex items-center gap-2">
          <button
            onClick={() => onAsk(false)}
            className="px-2 py-1 rounded bg-accent/15 text-fg-bright hover:bg-accent/25 cursor-pointer"
            title="Fork this conversation into a new Chat tab and ask it about this line"
          >
            Ask this conversation
          </button>
          <button
            onClick={() => onAsk(true)}
            className="px-2 py-1 rounded text-dim hover:text-fg hover:bg-panel cursor-pointer"
            title="Fork from the end of the turn that wrote the line, before anything later in the session"
          >
            As of this turn
          </button>
        </div>
      ) : (
        <div className="px-3 py-1.5 border-t border-border text-faint">
          Click the bar to pin this card
        </div>
      )}
    </div>
  )
}
