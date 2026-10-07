// Per-tool cards for json-claude assistant tool_use blocks. Each tool
// gets a small focused renderer; unknown tools fall through to the
// generic JSON-dump card. Cards lazy-grow new sections per tool — most
// of them are intentionally minimal (input summary in the chrome,
// result body in a <pre>) so adding e.g. WebFetch is a small addition.
//
// Lives in a sibling directory so the main JsonModeChat component
// stays focused on layout + scroll + input + statusbar.

import { useState, type ReactNode } from 'react'
import type {
  JsonClaudeBackgroundAgent,
  JsonClaudeImageRef,
  JsonClaudeMessageBlock
} from '../../../shared/state/json-claude'
import {
  extractArgs,
  getToolDisplay,
  isNessControl,
  prettyToolName,
  type ArgEntry
} from './tool-display'
import type { ToolIcon } from './tool-icons'
import { HighlightedText, useFind } from '../JsonModeChatFind'

export { extractArgs, getToolDisplay, isNessControl, prettyToolName }
export type { ArgEntry }

export interface ToolResultView {
  content: string
  isError: boolean
  /** Images the tool returned — browser screenshots, in practice. Held
   *  as on-disk paths; the thumbnail component reads them lazily. */
  images?: JsonClaudeImageRef[]
}

export interface ToolCardProps {
  block: JsonClaudeMessageBlock
  result?: ToolResultView
  autoApproved?: { model: string; reason: string; timestamp: number }
  sessionAllowed?: { toolName: string; timestamp: number }
  /** Sub-agent fields. Only set by the Task case; other cards ignore
   *  them. Threaded through dispatchToolCard so the renderer keeps the
   *  same call shape for every tool. */
  subAgentBody?: ReactNode
  subAgentChildCount?: number
  subAgentDescendantHasPendingApproval?: boolean
  /** Set when this Task launched a detached (run_in_background) agent.
   *  Such a call resolves its tool_result immediately, so the card needs
   *  this to know it's still working rather than instantly finished. */
  backgroundAgent?: JsonClaudeBackgroundAgent
}

export function basename(p: string): string {
  return p.split('/').pop() || p
}

export function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

export function ToolCardChrome({
  id,
  name,
  subtitle,
  variant,
  isError,
  brand,
  icon: Icon,
  autoApproved,
  sessionAllowed,
  autoExpand = false,
  children
}: {
  /** Stable id for find-integration. When Cmd+F cycles to a match inside
   *  this card, the FindContext adds the id to forceOpenIds and this
   *  card renders as expanded regardless of local state. */
  id?: string
  /** Open the card without a click until the user says otherwise. Set
   *  for results worth seeing at a glance (browser screenshots). Read on
   *  every render rather than as an initial useState value, because the
   *  tool_result lands after the card first mounts. */
  autoExpand?: boolean
  name: string
  /** Accepts a ReactNode so cards whose primary render is the subtitle
   *  (Grep/Glob's pattern field) can pass a <HighlightedText> here. */
  subtitle: ReactNode
  variant: 'info' | 'warn'
  isError?: boolean
  brand?: boolean
  icon?: ToolIcon | null
  autoApproved?: { model: string; reason: string; timestamp: number }
  sessionAllowed?: { toolName: string; timestamp: number }
  children: ReactNode
}): JSX.Element {
  // Collapsed by default. Errors get a visible "error" badge in the
  // header so they're discoverable, but we don't force-expand — the
  // user can choose to drill in.
  //
  // null means "no explicit choice yet, follow autoExpand"; once the
  // user clicks, their decision sticks even if autoExpand flips.
  const [expanded, setExpanded] = useState<boolean | null>(null)
  const find = useFind()
  const forceOpen = !!id && find.forceOpenIds.has(id)
  const isOpen = forceOpen || (expanded ?? autoExpand)
  const isCurrentHit = !!id && find.currentHitBlockId === id

  const ring = isCurrentHit
    ? 'border-accent ring-2 ring-accent/50'
    : isError
    ? 'border-danger/50'
    : brand
      ? 'border-warning/40'
      : variant === 'warn'
        ? 'border-warning/30'
        : 'border-border'
  const headerBg = isError ? 'bg-danger/10' : 'bg-app/40'
  const headerHover = isError ? 'hover:bg-danger/15' : 'hover:bg-app/60'
  // `group` enables the .group:hover .brand-gradient-flow-text-hover rule
  // (same trick the Add worktree button uses) — animated flow on hover,
  // static gradient otherwise.
  const groupClass = brand ? 'group' : ''
  const nameClass = brand
    ? 'brand-gradient-text brand-gradient-flow-text-hover'
    : 'text-accent'

  return (
    <div
      data-find-block-id={id}
      className={`my-2 border ${ring} bg-panel overflow-hidden`}
      style={{ borderRadius: 'var(--chat-bubble-radius)' }}
    >
      {brand && <div className="brand-gradient-bg h-0.5" />}
      <button
        type="button"
        onClick={() => setExpanded((v) => !(v ?? autoExpand))}
        className={`${groupClass} w-full flex items-center gap-2 ${isOpen ? 'border-b border-border' : ''} ${headerBg} ${headerHover} cursor-pointer transition-colors text-left`}
        style={{
          paddingInline: 'var(--chat-chrome-px)',
          paddingBlock: 'var(--chat-chrome-py)',
          fontSize: 'var(--chat-chrome-text)'
        }}
      >
        <span className="text-muted text-xs w-2 shrink-0 select-none">
          {isOpen ? '▾' : '▸'}
        </span>
        {Icon && <Icon className="icon-sm shrink-0" />}
        <span
          className={`font-semibold shrink-0 ${nameClass}`}
          style={{ fontFamily: 'var(--chat-tool-name-family)' }}
        >
          <HighlightedText text={name} />
        </span>
        <span className="opacity-70 truncate flex-1 min-w-0">{subtitle}</span>
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
            title={`allowed by session policy · ${sessionAllowed.toolName}`}
            className="uppercase tracking-wide text-muted bg-app/60 border border-border/50 rounded px-1 py-0.5 shrink-0"
            style={{ fontSize: 'var(--chat-meta-text)' }}
          >
            session
          </span>
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
      {isOpen && children}
    </div>
  )
}

import { ReadCard } from './ReadCard'
import { EditCard } from './EditCard'
import { MultiEditCard } from './MultiEditCard'
import { WriteCard } from './WriteCard'
import { BashCard } from './BashCard'
import { GrepCard } from './GrepCard'
import { GlobCard } from './GlobCard'
import { TodoWriteCard } from './TodoWriteCard'
import { TaskCard } from './TaskCard'
import { GenericToolCard } from './GenericToolCard'

export function dispatchToolCard(props: ToolCardProps): JSX.Element {
  switch (props.block.name) {
    case 'Read':
      return <ReadCard {...props} />
    case 'Edit':
      return <EditCard {...props} />
    case 'MultiEdit':
      return <MultiEditCard {...props} />
    case 'Write':
      return <WriteCard {...props} />
    case 'Bash':
      return <BashCard {...props} />
    case 'Grep':
      return <GrepCard {...props} />
    case 'Glob':
      return <GlobCard {...props} />
    case 'TodoWrite':
      return <TodoWriteCard {...props} />
    // 'Task' (older Claude Code) and 'Agent' (2.1.126+) both route to
    // the subagent runner — render either as TaskCard.
    case 'Task':
    case 'Agent':
      return (
        <TaskCard
          {...props}
          subAgentBody={props.subAgentBody ?? null}
          subAgentChildCount={props.subAgentChildCount ?? 0}
          subAgentDescendantHasPendingApproval={
            props.subAgentDescendantHasPendingApproval ?? false
          }
          backgroundAgent={props.backgroundAgent}
        />
      )
    default:
      return <GenericToolCard {...props} />
  }
}
