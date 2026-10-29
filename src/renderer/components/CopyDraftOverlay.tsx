import { useState } from 'react'
import { ChevronDown, ChevronUp, PenLine } from 'lucide-react'
import type { CopyDraftRequest } from '../../shared/state/copy-drafts'
import { useCopyDraftForTerminal } from '../store'
import { useBackend } from '../backend'

/** Docked editor for an agent's `edit_copy` call, rendered over the bottom of
 *  the tab that made it. The agent is blocked until this is answered, so it
 *  covers the composer/TUI rather than sitting in the transcript where it
 *  could scroll out of view. */
export function CopyDraftOverlay({ terminalId }: { terminalId: string }): JSX.Element | null {
  const draft = useCopyDraftForTerminal(terminalId)
  if (!draft) return null
  return <CopyDraftEditor key={draft.id} draft={draft} />
}

function CopyDraftEditor({ draft }: { draft: CopyDraftRequest }): JSX.Element {
  const backend = useBackend()
  const [text, setText] = useState(draft.draft)
  const [note, setNote] = useState('')
  const [collapsed, setCollapsed] = useState(false)
  const [sending, setSending] = useState(false)
  const edited = text !== draft.draft

  async function answer(
    outcome:
      | { kind: 'submitted'; text: string; note?: string }
      | { kind: 'dismissed'; note?: string }
  ): Promise<void> {
    setSending(true)
    try {
      await backend.resolveCopyDraft(draft.id, outcome)
    } finally {
      setSending(false)
    }
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
    </>
  )

  if (collapsed) {
    return (
      <div className="absolute inset-x-0 bottom-0 z-20 border-t border-accent/40 bg-panel-raised shadow-lg">
        <button
          onClick={() => setCollapsed(false)}
          className="w-full flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-accent/5"
        >
          {heading}
          <span className="ml-auto flex items-center gap-1 text-xs text-muted shrink-0">
            Waiting on you
            <ChevronUp className="icon-sm" />
          </span>
        </button>
      </div>
    )
  }

  return (
    <div className="absolute inset-x-0 bottom-0 z-20 max-h-[85%] flex flex-col border-t border-accent/40 bg-panel-raised shadow-lg">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-accent/30 bg-accent/10 shrink-0">
        {heading}
        <button
          onClick={() => setCollapsed(true)}
          title="Hide to read the conversation — the agent keeps waiting"
          className="ml-auto p-0.5 rounded text-muted hover:text-fg hover:bg-surface/60 cursor-pointer"
        >
          <ChevronDown className="icon-sm" />
        </button>
      </div>

      <div className="px-3 py-2 space-y-2 overflow-y-auto min-h-0">
        {draft.context && (
          <div className="text-xs text-muted whitespace-pre-wrap">{draft.context}</div>
        )}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              if (!sending && text.trim()) void submit()
            }
          }}
          autoFocus
          spellCheck
          className="w-full field-sizing-content min-h-24 bg-app/60 border border-border rounded p-2 text-sm text-fg-bright leading-relaxed outline-none focus:border-accent resize-y"
        />
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note for the agent (optional) — e.g. “keep this tone for the rest”"
          className="w-full bg-app/40 border border-border rounded px-2 py-1 text-xs outline-none focus:border-accent"
        />
      </div>

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
    </div>
  )
}
