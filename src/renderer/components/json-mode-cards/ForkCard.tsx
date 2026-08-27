// The card an agent leaves behind when it calls fork_chat. Unlike every
// other card here it isn't a log of something that happened — it's an
// offer. The fork exists as a jsonl on disk and nothing else until this
// button is pressed, so the card is the entire mechanism by which a
// parked tangent becomes a running one.

import { useState } from 'react'
import { GitFork, Loader2 } from 'lucide-react'
import type { ToolCardProps } from './index'
import { parseForkChatInput, parseForkSessionId } from '../../../shared/fork-chat'
import { HighlightedText } from '../JsonModeChatFind'
import { getBackend } from '../../backend'
import { useAppState } from '../../store'
import { getLeaves } from '../../../shared/state/terminals'

/** Whether a tab already exists for this fork — which is also the answer
 *  to "has the user opened it", since opening is what creates the tab.
 *  Selects the one worktree's tree so an unrelated pane change elsewhere
 *  doesn't re-render every fork card in the transcript. */
function useForkIsOpen(worktreePath: string, forkSessionId: string): boolean {
  const tree = useAppState((s) => s.terminals.panes[worktreePath])
  if (!tree) return false
  return getLeaves(tree).some((leaf) =>
    leaf.tabs.some((t) => t.id === forkSessionId)
  )
}

export function ForkCard({ block, result, fork }: ToolCardProps): JSX.Element {
  const { topic, prompt } = parseForkChatInput(block.input)
  const forkSessionId = parseForkSessionId(result?.content)
  const isOpen = useForkIsOpen(fork?.worktreePath ?? '', forkSessionId ?? '')
  const [busy, setBusy] = useState(false)

  // No fork id means the call errored or is still in flight — there is
  // nothing to open, so fall back to reporting what was asked for.
  const openable = !!forkSessionId && !!fork && !result?.isError

  return (
    <div
      data-fork-card-id={forkSessionId ?? undefined}
      className="my-2 border border-warning/40 bg-panel overflow-hidden"
      style={{ borderRadius: 'var(--chat-bubble-radius)' }}
    >
      <div className="brand-gradient-bg h-0.5" />
      <div
        className="flex items-start gap-2"
        style={{
          paddingInline: 'var(--chat-chrome-px)',
          paddingBlock: 'var(--chat-chrome-py)'
        }}
      >
        <GitFork className="icon-sm shrink-0 mt-0.5 text-warning" />
        <div className="flex-1 min-w-0">
          <div
            className="uppercase tracking-wide text-muted"
            style={{ fontSize: 'var(--chat-meta-text)' }}
          >
            {result?.isError
              ? 'fork not parked'
              : isOpen
                ? 'forked thread · opened'
                : 'forked thread · parked'}
          </div>
          <div
            className="font-semibold brand-gradient-text truncate"
            style={{ fontSize: 'var(--chat-chrome-text)' }}
          >
            <HighlightedText text={topic} />
          </div>
          {prompt && (
            <div
              className="mt-1 opacity-70 whitespace-pre-wrap line-clamp-3"
              style={{ fontSize: 'var(--chat-chrome-text)' }}
            >
              <HighlightedText text={prompt} />
            </div>
          )}
          {result?.isError && (
            <div
              className="mt-1 text-danger whitespace-pre-wrap"
              style={{ fontSize: 'var(--chat-chrome-text)' }}
            >
              <HighlightedText text={result.content} />
            </div>
          )}
        </div>
        {openable && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void getBackend()
                .openParkedFork(fork.parentSessionId, forkSessionId)
                .finally(() => setBusy(false))
            }}
            className="shrink-0 border border-border hover:border-warning/60 hover:bg-app/60 disabled:opacity-50 rounded px-2 py-1 cursor-pointer transition-colors flex items-center gap-1.5"
            style={{ fontSize: 'var(--chat-chrome-text)' }}
          >
            {busy && <Loader2 className="icon-xs animate-spin" />}
            {isOpen ? 'Go to thread' : 'Open thread'}
          </button>
        )}
      </div>
    </div>
  )
}
