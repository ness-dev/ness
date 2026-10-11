import { useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Sparkles, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import type { AgentSummary } from '../../shared/state/json-claude-agents'
import {
  agentElapsedMs,
  formatElapsed
} from '../../shared/state/json-claude-agents'
import { AgentStepLine } from './AgentStepLine'
import { AgentStatusDot, agentStatusLabel } from './AgentStatusDot'

/** How much of a text block to show inline in the feed. The peek is a
 *  "what is it doing" view, not a transcript — the full text is in the
 *  chat's own Task card. */
const TEXT_PREVIEW = 600

interface AgentPeekProps {
  agent: AgentSummary
  /** Live clock, passed down so every peek and panel row ticks off the
   *  same interval rather than each mounting its own. */
  now: number
  onClose: () => void
  /** Opens a nested agent's peek, replacing this one. */
  onPeekAgent: (toolUseId: string) => void
}

/** A flyout over the chat showing one agent's activity as it happens.
 *  Deliberately not the chat's own card renderer: that machinery needs a
 *  full render ctx (approval cards, find-highlighting, image fetching)
 *  and produces the collapsed-group chrome that makes scanning a running
 *  agent hard. Here every step gets exactly one line, newest at the
 *  bottom, and the view follows along. */
export function AgentPeek({
  agent,
  now,
  onClose,
  onPeekAgent
}: AgentPeekProps): JSX.Element {
  const feedRef = useRef<HTMLDivElement>(null)
  const pinnedToBottomRef = useRef(true)
  const stepCount = agent.steps.length

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Follow the tail only while the user hasn't scrolled away — an agent
  // mid-run appends constantly, and yanking the viewport back down while
  // someone is reading an earlier step is worse than not following.
  useLayoutEffect(() => {
    const el = feedRef.current
    if (!el || !pinnedToBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [stepCount, agent.result])

  const elapsed = formatElapsed(agentElapsedMs(agent, now))
  const usage = agent.usage
  const meta = [
    agent.subagentType,
    agent.model,
    `${agent.toolCount} ${agent.toolCount === 1 ? 'tool' : 'tools'}`,
    usage?.totalTokens !== undefined
      ? `${Math.round(usage.totalTokens / 1000)}k tokens`
      : null,
    elapsed
  ].filter(Boolean) as string[]

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="flex flex-col bg-panel border border-border shadow-2xl overflow-hidden"
        style={{
          width: 'min(44rem, 88vw)',
          height: 'min(36rem, 82vh)',
          borderRadius: 'var(--chat-bubble-radius)'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border/60 shrink-0">
          <Sparkles className="icon-sm text-muted shrink-0" />
          <span className="text-sm text-fg-bright truncate flex-1 min-w-0">
            {agent.description}
          </span>
          {agent.isBackground && (
            <span className="uppercase tracking-wide text-muted bg-app/60 border border-border/50 rounded px-1 py-0.5 shrink-0 text-xs">
              background
            </span>
          )}
          <AgentStatusDot agent={agent} />
          <span className="text-xs text-muted shrink-0">
            {agentStatusLabel(agent)}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close agent peek"
            className="ml-1 p-1 text-muted hover:text-fg-bright cursor-pointer shrink-0"
          >
            <X className="icon-sm" />
          </button>
        </div>

        <div className="px-3 py-1.5 border-b border-border/40 shrink-0 flex items-center gap-2 flex-wrap">
          {meta.map((m) => (
            <span key={m} className="text-xs text-faint tabular-nums">
              {m}
            </span>
          ))}
          {agent.parentDescription && (
            <span className="text-xs text-faint truncate">
              via {agent.parentDescription}
            </span>
          )}
        </div>

        <div
          ref={feedRef}
          onScroll={(e) => {
            const el = e.currentTarget
            pinnedToBottomRef.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 32
          }}
          className="flex-1 overflow-y-auto px-3 py-2 text-xs space-y-1"
        >
          {agent.steps.length === 0 && (
            <div className="text-muted italic py-2">
              {agent.status === 'running'
                ? 'agent is starting…'
                : 'no activity recorded'}
            </div>
          )}
          {agent.steps.map((step) =>
            step.kind === 'text' ? (
              <div
                key={step.key}
                className="py-1 pl-4 border-l-2 border-border/50 markdown"
              >
                <ReactMarkdown>
                  {step.text && step.text.length > TEXT_PREVIEW
                    ? `${step.text.slice(0, TEXT_PREVIEW)}…`
                    : (step.text ?? '')}
                </ReactMarkdown>
              </div>
            ) : step.childAgentToolUseId ? (
              <button
                key={step.key}
                type="button"
                onClick={() => onPeekAgent(step.childAgentToolUseId!)}
                className="w-full text-left hover:bg-app/60 rounded px-1 py-0.5 cursor-pointer"
              >
                <AgentStepLine step={step} />
              </button>
            ) : (
              <div key={step.key} className="px-1 py-0.5">
                <AgentStepLine step={step} />
              </div>
            )
          )}
          {agent.status === 'running' && (
            <div className="flex items-center gap-2 px-1 py-1">
              <span className="json-claude-spinner shrink-0" />
              <span className="text-muted italic">working…</span>
            </div>
          )}
        </div>

        {agent.result && (
          <div className="shrink-0 border-t border-border/60 max-h-48 overflow-y-auto">
            <div className="px-3 pt-2 text-xs text-faint uppercase tracking-wide">
              {agent.resultIsError ? 'error' : 'report'}
            </div>
            <div
              className={`px-3 pb-2 text-xs markdown ${
                agent.resultIsError ? 'text-danger' : ''
              }`}
            >
              <ReactMarkdown>{agent.result}</ReactMarkdown>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
