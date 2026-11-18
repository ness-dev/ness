import { useState } from 'react'
import { ChevronDown, ChevronUp, PenLine } from 'lucide-react'
import type { CopyDraftRequest } from '../../shared/state/copy-drafts'
import { useCopyDraftForTerminal, useWithdrawnCopyDraftForTerminal } from '../store'
import { useBackend } from '../backend'

/** What the user has typed, per draft id. Lives outside the component so
 *  nothing that remounts the editor — a mobile tab switch, the Chat card
 *  moving from the bottom of the log to its tool call, the draft being
 *  withdrawn — throws their rewrite away. Per-client, so not slice state. */
const inProgress = new Map<string, { text: string; note: string }>()

/** Docked editor for an agent's `edit_copy` call, rendered over the bottom of
 *  a Terminal tab. Chat tabs render `CopyDraftCard` inline in the transcript
 *  instead, under the tool call it answers. */
export function CopyDraftOverlay({ terminalId }: { terminalId: string }): JSX.Element | null {
  const pending = useCopyDraftForTerminal(terminalId)
  const withdrawn = useWithdrawnCopyDraftForTerminal(terminalId)
  const draft = pending ?? withdrawn
  if (!draft) return null
  return <CopyDraftEditor key={draft.id} draft={draft} docked withdrawn={!pending} />
}

export function CopyDraftCard({
  draft,
  withdrawn = false
}: {
  draft: CopyDraftRequest
  withdrawn?: boolean
}): JSX.Element {
  return <CopyDraftEditor key={draft.id} draft={draft} docked={false} withdrawn={withdrawn} />
}

function CopyDraftEditor({
  draft,
  docked,
  withdrawn
}: {
  draft: CopyDraftRequest
  docked: boolean
  withdrawn: boolean
}): JSX.Element {
  const backend = useBackend()
  const saved = inProgress.get(draft.id)
  const [text, setTextState] = useState(saved?.text ?? draft.draft)
  const [note, setNoteState] = useState(saved?.note ?? '')
  const [collapsed, setCollapsed] = useState(false)
  const [sending, setSending] = useState(false)
  const [copied, setCopied] = useState(false)
  const edited = text !== draft.draft

  function remember(next: { text: string; note: string }): void {
    inProgress.set(draft.id, next)
  }
  function setText(value: string): void {
    setTextState(value)
    remember({ text: value, note })
  }
  function setNote(value: string): void {
    setNoteState(value)
    remember({ text, note: value })
  }

  async function answer(
    outcome:
      | { kind: 'submitted'; text: string; note?: string }
      | { kind: 'dismissed'; note?: string }
  ): Promise<void> {
    setSending(true)
    try {
      if (await backend.resolveCopyDraft(draft.id, outcome)) inProgress.delete(draft.id)
    } finally {
      setSending(false)
    }
  }

  async function copyText(): Promise<void> {
    await navigator.clipboard.writeText(text)
    setCopied(true)
  }

  function close(): void {
    inProgress.delete(draft.id)
    void backend.clearWithdrawnCopyDraft(draft.id)
  }

  const submit = (): Promise<void> => answer({ kind: 'submitted', text, note })
  const dismiss = (): Promise<void> => answer({ kind: 'dismissed', note })

  const heading = (
    <>
      <PenLine className="icon-sm shrink-0 text-accent" />
      <span className="text-xs font-semibold uppercase tracking-wide text-accent shrink-0">
        Edit copy
      </span>
      {draft.title && <span className="text-sm text-fg-bright truncate">{draft.title}</span>}
      {withdrawn && <span className="text-xs text-muted shrink-0">· not sent</span>}
    </>
  )

  if (docked && collapsed) {
    return (
      <div className="absolute inset-x-0 bottom-0 z-20 border-t border-accent/40 bg-panel-raised shadow-lg">
        <button
          onClick={() => setCollapsed(false)}
          className="w-full flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-accent/5"
        >
          {heading}
          <span className="ml-auto flex items-center gap-1 text-xs text-muted shrink-0">
            {withdrawn ? 'Agent stopped waiting' : 'Waiting on you'}
            <ChevronUp className="icon-sm" />
          </span>
        </button>
      </div>
    )
  }

  return (
    <div
      id={draft.id}
      className={
        docked
          ? 'absolute inset-x-0 bottom-0 z-20 max-h-[85%] flex flex-col border-t border-accent/40 bg-panel-raised shadow-lg'
          : withdrawn
            ? 'rounded-md border border-border bg-panel my-2 overflow-hidden flex flex-col'
            : 'rounded-md border border-accent/40 bg-accent/5 my-2 overflow-hidden flex flex-col'
      }
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-accent/30 bg-accent/10 shrink-0">
        {heading}
        {docked && (
          <button
            onClick={() => setCollapsed(true)}
            title="Hide to read the conversation — the agent keeps waiting"
            className="ml-auto p-0.5 rounded text-muted hover:text-fg hover:bg-surface/60 cursor-pointer"
          >
            <ChevronDown className="icon-sm" />
          </button>
        )}
      </div>

      <div className="px-3 py-2 space-y-2 overflow-y-auto min-h-0">
        {withdrawn && (
          <div className="text-xs text-warning">
            The agent stopped waiting before you sent this, so it never got your text. Copy
            it now if you want to keep it.
          </div>
        )}
        {draft.context && (
          <div className="text-xs text-muted whitespace-pre-wrap">{draft.context}</div>
        )}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !withdrawn) {
              e.preventDefault()
              if (!sending && text.trim()) void submit()
            }
          }}
          autoFocus={docked}
          spellCheck
          className="w-full field-sizing-content min-h-24 bg-app/60 border border-border rounded p-2 text-sm text-fg-bright leading-relaxed outline-none focus:border-accent resize-y"
        />
        {!withdrawn && (
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note for the agent (optional) — e.g. “keep this tone for the rest”"
            className="w-full bg-app/40 border border-border rounded px-2 py-1 text-xs outline-none focus:border-accent"
          />
        )}
      </div>

      {withdrawn ? (
        <div className="px-3 pb-2 pt-1 flex items-center gap-1.5 flex-wrap shrink-0">
          <button
            onClick={() => void copyText()}
            className="px-3 py-1 text-xs font-semibold rounded bg-accent/30 hover:bg-accent/40 text-accent border border-accent/50 transition-colors cursor-pointer"
          >
            {copied ? 'Copied' : 'Copy text'}
          </button>
          <button
            onClick={close}
            className="px-2.5 py-1 text-xs rounded text-muted hover:text-fg hover:bg-surface/60 transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      ) : (
        <div className="px-3 pb-2 pt-1 flex items-center gap-1.5 flex-wrap shrink-0">
          <button
            onClick={() => void submit()}
            disabled={sending || !text.trim()}
            title="⌘↵"
            className="px-3 py-1 text-xs font-semibold rounded bg-accent/30 hover:bg-accent/40 text-accent border border-accent/50 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {edited ? 'Use my version' : 'Looks good'}
          </button>
          {edited && (
            <button
              onClick={() => setText(draft.draft)}
              disabled={sending}
              className="px-2.5 py-1 text-xs rounded bg-surface hover:bg-surface/60 text-fg transition-colors cursor-pointer"
            >
              Reset to draft
            </button>
          )}
          <button
            onClick={() => void dismiss()}
            disabled={sending}
            title="Reject the draft — the agent won't use it. Add a note to say why."
            className="px-2.5 py-1 text-xs rounded text-muted hover:text-fg hover:bg-surface/60 transition-colors cursor-pointer"
          >
            Dismiss
          </button>
          <span className="ml-auto text-xs text-muted">The agent is waiting for this</span>
        </div>
      )}
    </div>
  )
}
