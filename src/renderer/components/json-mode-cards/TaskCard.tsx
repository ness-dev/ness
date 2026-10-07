import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Sparkles } from 'lucide-react'
import { trunc, type ToolCardProps } from './index'

export interface TaskCardProps extends ToolCardProps {
  /** Pre-rendered ReactNode for the sub-agent's chronological activity.
   *  The recursion happens upstream in JsonModeChat against the full
   *  entries array — TaskCard only owns the expandable chrome. */
  subAgentBody: ReactNode
  /** Number of immediate child entries from the sub-agent. Surfaced in
   *  the header so the user can see how much work is hidden. */
  subAgentChildCount: number
  /** True when any descendant tool call currently has a pending
   *  approval. Drives the auto-expand behavior so the user sees the
   *  approval card without having to manually click in. */
  subAgentDescendantHasPendingApproval: boolean
}

/** Rendered the same way as ToolGroup so sub-agent nesting reads as
 *  another level of the existing tool grouping design rather than its
 *  own visual idiom. The header is Task-specific (Sparkles icon, the
 *  Task description, sub-agent entry count) but the chrome, auto-expand
 *  behavior, and collapsed-by-default body all mirror ToolGroup. */
export function TaskCard({
  block,
  result,
  autoApproved,
  sessionAllowed,
  subAgentBody,
  subAgentChildCount,
  subAgentDescendantHasPendingApproval,
  backgroundAgent
}: TaskCardProps): JSX.Element {
  const input = (block.input ?? {}) as Record<string, unknown>
  const description =
    typeof input.description === 'string' && input.description.length > 0
      ? input.description
      : typeof input.subagent_type === 'string' &&
          (input.subagent_type as string).length > 0
        ? (input.subagent_type as string)
        : 'Task'

  // A background agent's tool_result lands immediately (it's the launch
  // stub, not the answer), so `result` can't stand in for "still working"
  // the way it does for a synchronous sub-agent.
  const backgroundRunning = backgroundAgent?.status === 'running'
  const taskInFlight = backgroundAgent ? backgroundRunning : !result
  const autoExpandTrigger =
    taskInFlight || subAgentDescendantHasPendingApproval

  // Auto-expand fires on the *edges* of the trigger, never on its steady
  // state — depending on `expanded` here would re-open the card the instant
  // the user collapsed it, which for a long-running background agent means
  // it can't be collapsed at all.
  const prevTriggerRef = useRef(autoExpandTrigger)
  const prevApprovalRef = useRef(subAgentDescendantHasPendingApproval)
  const userOverrodeRef = useRef(false)
  const [expanded, setExpanded] = useState<boolean>(autoExpandTrigger)
  useEffect(() => {
    const prevTrigger = prevTriggerRef.current
    const prevApproval = prevApprovalRef.current
    prevTriggerRef.current = autoExpandTrigger
    prevApprovalRef.current = subAgentDescendantHasPendingApproval

    // A newly-arrived approval overrides a manual collapse — the user has
    // to see what they're being asked to approve.
    if (subAgentDescendantHasPendingApproval && !prevApproval) {
      userOverrodeRef.current = false
      setExpanded(true)
    } else if (autoExpandTrigger && !prevTrigger) {
      userOverrodeRef.current = false
      setExpanded(true)
    } else if (!autoExpandTrigger && prevTrigger && !userOverrodeRef.current) {
      setExpanded(false)
    }
  }, [autoExpandTrigger, subAgentDescendantHasPendingApproval])

  const isError = !!result?.isError || backgroundAgent?.status === 'failed'
  const countLabel =
    subAgentChildCount === 0
      ? taskInFlight
        ? 'starting…'
        : 'no activity'
      : `${subAgentChildCount} ${subAgentChildCount === 1 ? 'entry' : 'entries'}`
  const usage = backgroundAgent?.usage
  const usageLabel = usage
    ? [
        typeof usage.toolUses === 'number' ? `${usage.toolUses} tools` : null,
        typeof usage.totalTokens === 'number'
          ? `${Math.round(usage.totalTokens / 1000)}k tokens`
          : null,
        typeof usage.durationMs === 'number'
          ? `${Math.round(usage.durationMs / 1000)}s`
          : null
      ]
        .filter(Boolean)
        .join(' · ')
    : ''

  return (
    <div
      className={`my-2 border ${isError ? 'border-danger/50' : 'border-border/60'} bg-app/30 overflow-hidden`}
      style={{ borderRadius: 'var(--chat-bubble-radius)' }}
    >
      <button
        type="button"
        onClick={() => {
          userOverrodeRef.current = true
          setExpanded((v) => !v)
        }}
        className="w-full flex items-center gap-2 cursor-pointer hover:bg-app/60 transition-colors text-left"
        style={{
          paddingInline: 'var(--chat-chrome-px)',
          paddingBlock: 'var(--chat-chrome-py)',
          fontSize: 'var(--chat-chrome-text)'
        }}
      >
        <span className="text-muted text-xs w-2 shrink-0 select-none">
          {expanded ? '▾' : '▸'}
        </span>
        <Sparkles className="icon-xs text-muted shrink-0" />
        <span
          className="text-muted shrink-0"
          style={{ fontFamily: 'var(--chat-tool-name-family)' }}
        >
          Task
        </span>
        <span
          className="opacity-60 truncate flex-1 min-w-0"
          style={{ fontFamily: 'var(--chat-tool-name-family)' }}
        >
          {trunc(description, 120)}
        </span>
        {backgroundAgent && (
          <span
            title={`background agent ${backgroundAgent.agentId}`}
            className="uppercase tracking-wide text-muted bg-app/60 border border-border/50 rounded px-1 py-0.5 shrink-0"
            style={{ fontSize: 'var(--chat-meta-text)' }}
          >
            background
          </span>
        )}
        <span
          className="text-muted/70 shrink-0"
          style={{ fontSize: 'var(--chat-meta-text)' }}
        >
          {usageLabel || countLabel}
        </span>
        {autoApproved && (
          <span
            title={`auto-approved by ${autoApproved.model} · ${autoApproved.reason}`}
            className="uppercase tracking-wide text-muted bg-app/60 border border-border/50 rounded px-1 py-0.5 shrink-0"
            style={{ fontSize: 'var(--chat-meta-text)' }}
          >
            auto · haiku
          </span>
        )}
        {sessionAllowed && (
          <span
            title={
              sessionAllowed.rule
                ? `allowed by saved rule · ${sessionAllowed.rule}`
                : `allowed by session policy · ${sessionAllowed.toolName}`
            }
            className="uppercase tracking-wide text-muted bg-app/60 border border-border/50 rounded px-1 py-0.5 shrink-0"
            style={{ fontSize: 'var(--chat-meta-text)' }}
          >
            {sessionAllowed.rule ? 'always' : 'session'}
          </span>
        )}
        {subAgentDescendantHasPendingApproval && (
          <span
            className="text-warning uppercase tracking-wide shrink-0"
            style={{ fontSize: 'var(--chat-meta-text)' }}
          >
            needs approval
          </span>
        )}
        {taskInFlight && !subAgentDescendantHasPendingApproval && (
          <span
            className="json-claude-spinner shrink-0"
            aria-label="sub-agent running"
          />
        )}
        {isError && (
          <span
            className="uppercase tracking-wide text-danger shrink-0"
            style={{ fontSize: 'var(--chat-meta-text)' }}
          >
            error
          </span>
        )}
      </button>
      {expanded && (
        <div className="px-2">
          {subAgentChildCount === 0 ? (
            <div className="px-1 py-2 text-xs text-muted italic">
              {taskInFlight
                ? 'sub-agent is starting…'
                : 'no sub-agent activity recorded'}
            </div>
          ) : (
            subAgentBody
          )}
          {/* While a background agent runs, `result` is still the launch
              stub ("Async agent launched successfully…"), which is noise —
              show it only once the real result has superseded it. */}
          {result && !backgroundRunning && (
            <pre
              className={`my-1 px-2 py-1 text-xs font-mono whitespace-pre-wrap max-h-60 overflow-auto rounded bg-app/40 ${
                result.isError ? 'text-danger' : 'opacity-80'
              }`}
            >
              {trunc(result.content, 3000)}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
