import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, ChevronDown, ChevronRight, MessageSquare, Pencil, Send, SquareTerminal, X } from 'lucide-react'
import type { AgentTabInfo, ReviewSubmission, ReviewVerdict } from '../types'
import { useBackend } from '../backend'
import { useWorktreePanes } from '../store'
import { getLeaves } from '../../shared/state/terminals'
import { tabLabel } from '../../shared/agent-tabs'
import { REVIEW_VERDICT_LABELS, reviewAuthorLabel } from '../../shared/review-format'

const VERDICT_CLASS: Record<ReviewVerdict, string> = {
  approve: 'bg-success/15 text-success',
  'changes-requested': 'bg-warning/15 text-warning',
  comment: 'bg-info/15 text-info'
}

const VERDICTS: ReviewVerdict[] = ['approve', 'changes-requested', 'comment']

function useTabLabels(worktreePath: string): Map<string, string> {
  const tree = useWorktreePanes(worktreePath)
  return useMemo(() => {
    const out = new Map<string, string>()
    if (!tree) return out
    for (const leaf of getLeaves(tree)) {
      for (const t of leaf.tabs) out.set(t.id, tabLabel(t))
    }
    return out
  }, [tree])
}

/** Dropdown of the worktree's agent tabs, most recently active first —
 *  the first entry is the default. Fetched on open because terminal-tab
 *  recency lives in main, not the store. */
export function AgentTabPicker({
  worktreePath,
  excludeTabId,
  terminalNote,
  disabled,
  className,
  children,
  onPick
}: {
  worktreePath: string
  excludeTabId?: string
  /** Shown beside terminal tabs, e.g. when they can't receive yet. */
  terminalNote?: string
  disabled?: boolean
  className: string
  children: React.ReactNode
  onPick: (tabId: string) => void
}): JSX.Element {
  const backend = useBackend()
  // Fixed-positioned from the button's rect: the submissions panel
  // scrolls, and an absolute dropdown would be clipped by it.
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null)
  const open = anchor !== null
  const [tabs, setTabs] = useState<AgentTabInfo[] | null>(null)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const toggle = (e: React.MouseEvent<HTMLButtonElement>): void => {
    if (anchor) return setAnchor(null)
    const r = e.currentTarget.getBoundingClientRect()
    setAnchor({ top: r.bottom + 4, right: window.innerWidth - r.right })
  }

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setTabs(null)
    backend
      .listReviewTargets(worktreePath)
      .then((list) => {
        if (!cancelled) setTabs(list.filter((t) => t.id !== excludeTabId))
      })
      .catch(() => {
        if (!cancelled) setTabs([])
      })
    const close = (e: MouseEvent): void => {
      if (e.target instanceof Node && wrapperRef.current?.contains(e.target)) return
      setAnchor(null)
    }
    window.addEventListener('mousedown', close)
    return () => {
      cancelled = true
      window.removeEventListener('mousedown', close)
    }
  }, [open, backend, worktreePath, excludeTabId])

  return (
    <div ref={wrapperRef} className="relative">
      <button onClick={toggle} disabled={disabled} className={className}>
        {children}
        <ChevronDown className="icon-2xs" />
      </button>
      {anchor && (
        <div
          style={{ top: anchor.top, right: anchor.right }}
          className="fixed z-50 w-64 bg-panel-raised border border-border-strong rounded shadow-lg py-1"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1 text-xs text-faint">Send to</div>
          {tabs === null && <div className="px-3 py-1.5 text-xs text-faint">Loading…</div>}
          {tabs?.length === 0 && (
            <div className="px-3 py-1.5 text-xs text-faint">No agent tabs in this worktree</div>
          )}
          {tabs?.map((t, i) => (
            <button
              key={t.id}
              onClick={() => {
                setAnchor(null)
                onPick(t.id)
              }}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left cursor-pointer hover:bg-panel ${
                i === 0 ? 'text-fg-bright' : 'text-fg'
              }`}
            >
              {t.kind === 'chat' ? (
                <MessageSquare className="icon-xs shrink-0 text-faint" />
              ) : (
                <SquareTerminal className="icon-xs shrink-0 text-faint" />
              )}
              <span className="truncate flex-1">{t.label}</span>
              <span className="shrink-0 text-faint">
                {t.kind === 'terminal' && terminalNote
                  ? terminalNote
                  : i === 0
                    ? 'most recent'
                    : t.asleep
                      ? 'asleep'
                      : ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function SubmissionCard({
  worktreePath,
  submission,
  tabLabels
}: {
  worktreePath: string
  submission: ReviewSubmission
  tabLabels: Map<string, string>
}): JSX.Element {
  const backend = useBackend()
  const [editing, setEditing] = useState(false)
  const [summary, setSummary] = useState(submission.summary)
  const [verdict, setVerdict] = useState<ReviewVerdict>(submission.verdict)
  const [sending, setSending] = useState(false)
  const reviewerTabId = submission.author.kind === 'agent' ? submission.author.tabId : undefined
  const target = submission.targetTabId
    ? (tabLabels.get(submission.targetTabId) ?? 'a closed tab')
    : null

  const send = useCallback(
    (targetTabId?: string) => {
      setSending(true)
      void backend
        .sendReviewSubmission(worktreePath, submission.id, targetTabId)
        .finally(() => setSending(false))
    },
    [backend, worktreePath, submission.id]
  )

  const save = (): void => {
    void backend.editReviewSubmission(worktreePath, submission.id, summary, verdict)
    setEditing(false)
  }

  const status =
    submission.state === 'sent'
      ? `Sent to ${target ?? 'agent'}`
      : submission.state === 'failed'
        ? `Not sent${target ? ` to ${target}` : ''}`
        : target
          ? `Draft · will go to ${target}`
          : 'Draft · no agent tab to send to'

  const count = submission.commentIds.length

  return (
    <div className="px-3 py-2 border-t border-border/50 first:border-t-0 text-xs">
      <div className="flex items-center gap-2">
        <span className={`shrink-0 px-1.5 py-0.5 rounded font-medium ${VERDICT_CLASS[submission.verdict]}`}>
          {REVIEW_VERDICT_LABELS[submission.verdict]}
        </span>
        <span className="shrink-0 flex items-center gap-1 text-accent">
          {submission.author.kind === 'agent' && <Bot className="icon-xs" />}
          {reviewAuthorLabel(submission.author)}
        </span>
        <span className="shrink-0 text-faint tabular-nums">
          {count} {count === 1 ? 'comment' : 'comments'}
        </span>
        <span
          className={`truncate min-w-0 ${
            submission.state === 'failed'
              ? 'text-danger'
              : submission.state === 'sent'
                ? 'text-success'
                : 'text-faint'
          }`}
        >
          {status}
        </span>
        <div className="flex-1" />
        {submission.state !== 'sent' && (
          <>
            <button
              onClick={() => send()}
              disabled={sending || !submission.targetTabId}
              className="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded bg-accent text-fg font-medium hover:bg-accent/80 cursor-pointer disabled:opacity-30 disabled:cursor-default"
            >
              <Send className="icon-xs" />
              {submission.state === 'failed' ? 'Retry' : 'Send'}
            </button>
            <AgentTabPicker
              worktreePath={worktreePath}
              excludeTabId={reviewerTabId}
              terminalNote="not supported yet"
              disabled={sending}
              onPick={(id) => send(id)}
              className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded border border-border text-faint hover:text-fg cursor-pointer disabled:opacity-30"
            >
              To…
            </AgentTabPicker>
            <button
              onClick={() => {
                setSummary(submission.summary)
                setVerdict(submission.verdict)
                setEditing((v) => !v)
              }}
              aria-label="Edit review"
              className="shrink-0 text-faint hover:text-fg cursor-pointer"
            >
              <Pencil className="icon-xs" />
            </button>
          </>
        )}
        <button
          onClick={() => void backend.deleteReviewSubmission(worktreePath, submission.id)}
          aria-label={submission.state === 'sent' ? 'Dismiss review' : 'Delete review'}
          className="shrink-0 text-faint hover:text-danger cursor-pointer"
        >
          <X className="icon-xs" />
        </button>
      </div>
      {submission.state === 'failed' && submission.error && (
        <div className="mt-1 text-danger">{submission.error}</div>
      )}
      {editing ? (
        <div className="mt-1.5 flex flex-col gap-1.5">
          <div className="flex gap-1">
            {VERDICTS.map((v) => (
              <button
                key={v}
                onClick={() => setVerdict(v)}
                className={`px-1.5 py-0.5 rounded cursor-pointer ${
                  verdict === v ? VERDICT_CLASS[v] : 'text-faint hover:text-fg'
                }`}
              >
                {REVIEW_VERDICT_LABELS[v]}
              </button>
            ))}
          </div>
          <textarea
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                save()
              }
              if (e.key === 'Escape') setEditing(false)
              e.stopPropagation()
            }}
            rows={Math.min(8, Math.max(2, summary.split('\n').length))}
            className="w-full bg-surface text-fg text-xs rounded border border-border px-2 py-1 resize-none outline-none"
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => setEditing(false)} className="text-faint hover:text-fg cursor-pointer">
              Cancel
            </button>
            <button
              onClick={save}
              className="px-2 py-0.5 rounded bg-accent text-fg font-medium hover:bg-accent/80 cursor-pointer"
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        submission.summary && (
          <div className="mt-1 text-fg whitespace-pre-wrap line-clamp-4">{submission.summary}</div>
        )
      )}
    </div>
  )
}

/** Submitted reviews for this worktree, newest first. Drafts can be
 *  edited, re-targeted and sent; their comments are edited inline in the
 *  diff like any other comment. */
export function ReviewSubmissionsPanel({
  worktreePath,
  submissions
}: {
  worktreePath: string
  submissions: ReviewSubmission[]
}): JSX.Element | null {
  const [collapsed, setCollapsed] = useState(false)
  const tabLabels = useTabLabels(worktreePath)
  const ordered = useMemo(() => [...submissions].reverse(), [submissions])
  if (submissions.length === 0) return null
  const pending = submissions.filter((s) => s.state !== 'sent').length
  return (
    <div className="shrink-0 border-b border-border bg-panel max-h-[16rem] overflow-y-auto">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center gap-1 px-3 py-1 text-xs text-faint hover:text-fg cursor-pointer"
      >
        <ChevronRight className={`icon-2xs shrink-0 transition-transform ${collapsed ? '' : 'rotate-90'}`} />
        {submissions.length} submitted {submissions.length === 1 ? 'review' : 'reviews'}
        {pending > 0 && <span className="text-warning">· {pending} not sent</span>}
      </button>
      {!collapsed &&
        ordered.map((s) => (
          <SubmissionCard key={s.id} worktreePath={worktreePath} submission={s} tabLabels={tabLabels} />
        ))}
    </div>
  )
}
