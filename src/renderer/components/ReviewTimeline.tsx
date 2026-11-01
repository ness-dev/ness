import { useEffect, useMemo, useRef } from 'react'
import {
  Bot,
  CheckCheck,
  CornerDownRight,
  GitCommitHorizontal,
  GitPullRequestArrow,
  History,
  MessageSquare,
  SquareCode,
  User,
  Zap
} from 'lucide-react'
import type {
  BranchCommit,
  ReviewAuthor,
  ReviewComment,
  ReviewCommentStatus,
  ReviewRequest,
  ReviewSubmission,
  TestRun
} from '../types'
import { useWorktreePanes } from '../store'
import { getLeaves } from '../../shared/state/terminals'
import { shortCommentId } from '../../shared/review-format'
import {
  actorRole,
  buildReviewTimeline,
  reviewerTabIds,
  type ActorRole,
  type TimelineEntry,
  type TimelineThread
} from '../review-timeline'
import { SubmissionCard, useTabLabels } from './ReviewSubmissions'
import { ExpandableMarkdown, ReviewMarkdown } from './ReviewMarkdown'
import { TestRunCard } from './TestRunCard'

const STATUS_CLASS: Record<ReviewCommentStatus, string> = {
  open: 'text-info',
  resolved: 'text-success',
  outdated: 'text-faint'
}

const ROLE_CLASS: Record<ActorRole, string> = {
  human: 'text-fg-bright',
  implementer: 'text-info',
  reviewer: 'text-accent'
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === new Date().toDateString()) return time
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
}

interface ActorContext {
  tabLabels: Map<string, string>
  reviewers: Set<string>
}

function Actor({ author, ctx }: { author: ReviewAuthor; ctx: ActorContext }): JSX.Element {
  const role = actorRole(author, ctx.reviewers)
  const Icon = role === 'human' ? User : role === 'reviewer' ? Bot : SquareCode
  const name =
    author.kind === 'human'
      ? 'You'
      : (ctx.tabLabels.get(author.tabId) ?? author.label ?? 'Agent')
  return (
    <span className={`inline-flex items-center gap-1.5 font-medium ${ROLE_CLASS[role]}`}>
      <Icon className="icon-xs shrink-0" />
      {name}
    </span>
  )
}

function Time({ at }: { at: number }): JSX.Element {
  return <span className="shrink-0 text-faint tabular-nums">{formatTime(at)}</span>
}

function CommentRef({
  comment,
  onJump
}: {
  comment: ReviewComment
  onJump: (c: ReviewComment) => void
}): JSX.Element {
  return (
    <button
      onClick={() => onJump(comment)}
      className="inline-flex items-center gap-1.5 min-w-0 font-mono text-fg hover:text-fg-bright hover:underline cursor-pointer"
    >
      <span className="text-faint">[{shortCommentId(comment.id)}]</span>
      <span className="truncate">
        {comment.filePath}:{comment.line}
      </span>
    </button>
  )
}

function CommentThread({
  thread,
  ctx,
  onJump
}: {
  thread: TimelineThread
  ctx: ActorContext
  onJump: (c: ReviewComment) => void
}): JSX.Element {
  const { comment, replies } = thread
  const jump = (): void => {
    // Selecting text in a code block shouldn't yank the view to the diff.
    if (window.getSelection()?.toString()) return
    onJump(comment)
  }
  return (
    <div className="rounded-md border border-border/60 bg-surface/40">
      <div className="flex items-center gap-2.5 px-3 py-2 border-b border-border/40">
        <CommentRef comment={comment} onJump={onJump} />
        {comment.side === 'old' && <span className="text-faint">(removed line)</span>}
        <span className={`shrink-0 ${STATUS_CLASS[comment.status]}`}>{comment.status}</span>
        <div className="flex-1" />
        <Actor author={comment.author} ctx={ctx} />
        <Time at={comment.createdAt} />
      </div>
      <div onClick={jump} className="px-3 py-2.5 cursor-pointer hover:bg-panel/60">
        <ReviewMarkdown text={comment.body} />
      </div>
      {replies.length > 0 && (
        <div className="px-3 pt-1 pb-3 flex flex-col gap-3">
          {replies.map((r) => (
            <div key={r.id} className="flex gap-2">
              <CornerDownRight className="icon-xs shrink-0 mt-0.5 text-faint" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2.5 mb-1">
                  <Actor author={r.author} ctx={ctx} />
                  <Time at={r.createdAt} />
                </div>
                <ReviewMarkdown text={r.body} />
              </div>
            </div>
          ))}
        </div>
      )}
      {thread.resolved && (
        <div className="flex items-center gap-2 px-3 py-2 border-t border-border/40 text-faint">
          <CheckCheck className="icon-xs shrink-0 text-success" />
          <span>{comment.resolvedBy ? 'Resolved by' : 'Resolved'}</span>
          {comment.resolvedBy && <Actor author={comment.resolvedBy} ctx={ctx} />}
          {comment.resolvedAt !== undefined && <Time at={comment.resolvedAt} />}
        </div>
      )}
    </div>
  )
}

function RequestEntry({ request, ctx }: { request: ReviewRequest; ctx: ActorContext }): JSX.Element {
  const asked = request.reused ? 'asked for another look from' : 'requested review from'
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        {request.source === 'ci-green' ? (
          <>
            <Zap className="icon-xs text-success" />
            <span className="text-fg">CI went green; Ness {asked}</span>
            <Actor author={request.reviewer} ctx={ctx} />
            <span className="text-fg">for</span>
            <Actor author={request.requester} ctx={ctx} />
          </>
        ) : request.source === 'user' ? (
          <>
            <Actor author={{ kind: 'human' }} ctx={ctx} />
            <span className="text-fg">{asked}</span>
            <Actor author={request.reviewer} ctx={ctx} />
            <span className="text-fg">for</span>
            <Actor author={request.requester} ctx={ctx} />
          </>
        ) : (
          <>
            <Actor author={request.requester} ctx={ctx} />
            <span className="text-fg">{asked}</span>
            <Actor author={request.reviewer} ctx={ctx} />
          </>
        )}
        <div className="flex-1" />
        <Time at={request.createdAt} />
      </div>
      {request.context && request.source === 'agent' && (
        <div className="ml-5 pl-3 py-0.5 border-l-2 border-border">
          <ExpandableMarkdown text={request.context} />
        </div>
      )}
    </div>
  )
}

function TestRunEntry({
  run,
  worktreePath,
  ctx
}: {
  run: TestRun
  worktreePath: string
  ctx: ActorContext
}): JSX.Element {
  const asked = run.reused ? 'asked for another run from' : 'requested a test run from'
  const header = (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        {run.source === 'ci-green' ? (
          <>
            <Zap className="icon-xs text-success" />
            <span className="text-fg">CI went green; Ness {asked}</span>
            <Actor author={run.tester} ctx={ctx} />
            <span className="text-fg">for</span>
            <Actor author={run.requester} ctx={ctx} />
          </>
        ) : run.source === 'user' ? (
          <>
            <Actor author={{ kind: 'human' }} ctx={ctx} />
            <span className="text-fg">{asked}</span>
            <Actor author={run.tester} ctx={ctx} />
            <span className="text-fg">for</span>
            <Actor author={run.requester} ctx={ctx} />
          </>
        ) : (
          <>
            <Actor author={run.requester} ctx={ctx} />
            <span className="text-fg">{asked}</span>
            <Actor author={run.tester} ctx={ctx} />
          </>
        )}
        <div className="flex-1" />
        <Time at={run.createdAt} />
      </div>
      {run.context && run.source === 'agent' && (
        <div className="ml-5 pl-3 py-0.5 border-l-2 border-border">
          <ExpandableMarkdown text={run.context} />
        </div>
      )}
    </div>
  )
  return (
    <TestRunCard worktreePath={worktreePath} run={run} header={header} tabLabels={ctx.tabLabels} />
  )
}

function Entry({
  entry,
  worktreePath,
  ctx,
  onJump
}: {
  entry: TimelineEntry
  worktreePath: string
  ctx: ActorContext
  onJump: (c: ReviewComment) => void
}): JSX.Element {
  switch (entry.kind) {
    case 'request':
      return <RequestEntry request={entry.request} ctx={ctx} />
    case 'test':
      return <TestRunEntry run={entry.run} worktreePath={worktreePath} ctx={ctx} />
    case 'review':
      return (
        <ReviewEntry
          submission={entry.submission}
          threads={entry.threads}
          missing={entry.missing}
          worktreePath={worktreePath}
          ctx={ctx}
          onJump={onJump}
        />
      )
    case 'comment':
      return <CommentThread thread={entry.thread} ctx={ctx} onJump={onJump} />
    case 'reply':
      return (
        <div className="flex items-center gap-2 min-w-0">
          <MessageSquare className="icon-xs shrink-0 text-faint" />
          <Actor author={entry.reply.author} ctx={ctx} />
          <span className="shrink-0 text-faint">replied on</span>
          <CommentRef comment={entry.comment} onJump={onJump} />
          <span className="truncate min-w-0 flex-1 text-dim">{entry.reply.body.split('\n')[0]}</span>
          <Time at={entry.at} />
        </div>
      )
    case 'resolved':
      return (
        <div className="flex items-center gap-2 min-w-0">
          <CheckCheck className="icon-xs shrink-0 text-success" />
          {entry.by ? <Actor author={entry.by} ctx={ctx} /> : <span className="text-fg">Someone</span>}
          <span className="shrink-0 text-faint">resolved</span>
          <CommentRef comment={entry.comment} onJump={onJump} />
          <div className="flex-1" />
          <Time at={entry.at} />
        </div>
      )
    case 'commit':
      return (
        <div className="flex items-center gap-2 min-w-0">
          <GitCommitHorizontal className="icon-xs shrink-0 text-faint" />
          <span className="shrink-0 font-mono text-warning">{entry.commit.shortHash}</span>
          <span className="truncate min-w-0 flex-1 text-fg">{entry.commit.subject}</span>
          <Time at={entry.at} />
        </div>
      )
  }
}

function ReviewEntry({
  submission,
  threads,
  missing,
  worktreePath,
  ctx,
  onJump
}: {
  submission: ReviewSubmission
  threads: TimelineThread[]
  missing: number
  worktreePath: string
  ctx: ActorContext
  onJump: (c: ReviewComment) => void
}): JSX.Element {
  return (
    <SubmissionCard
      worktreePath={worktreePath}
      submission={submission}
      tabLabels={ctx.tabLabels}
      className="rounded-md border border-border bg-panel px-4 py-3"
      fullSummary
    >
      <div className="mt-2 flex items-center gap-3 text-faint">
        <Time at={submission.createdAt} />
        {submission.headSha && (
          <span>
            reviewed at <span className="font-mono">{submission.headSha.slice(0, 7)}</span>
          </span>
        )}
      </div>
      {(threads.length > 0 || missing > 0) && (
        <div className="mt-3 flex flex-col gap-3">
          {threads.map((t) => (
            <CommentThread key={t.comment.id} thread={t} ctx={ctx} onJump={onJump} />
          ))}
          {missing > 0 && (
            <div className="text-faint">
              {missing} {missing === 1 ? 'comment' : 'comments'} since deleted
            </div>
          )}
        </div>
      )}
    </SubmissionCard>
  )
}

/** Chronological history of the review rounds on a worktree: who asked,
 *  what the reviewer said, how the author answered, and what landed in
 *  between. Clicking a comment opens it in the diff. */
export function ReviewTimeline({
  worktreePath,
  requests,
  submissions,
  comments,
  commits,
  testRuns,
  onJumpToComment
}: {
  worktreePath: string
  requests: ReviewRequest[]
  submissions: ReviewSubmission[]
  comments: ReviewComment[]
  commits: BranchCommit[]
  testRuns: TestRun[]
  onJumpToComment: (c: ReviewComment) => void
}): JSX.Element {
  const tabLabels = useTabLabels(worktreePath)
  const tree = useWorktreePanes(worktreePath)
  // Testers count as reviewers here: both are the second agent on the
  // branch, and the timeline only needs to tell them from the author.
  const linked = useMemo(() => {
    const ids = testRuns.flatMap((r) => (r.tester.kind === 'agent' ? [r.tester.tabId] : []))
    if (!tree) return ids
    return [
      ...ids,
      ...getLeaves(tree).flatMap((l) =>
        l.tabs.filter((t) => t.reviewOf || t.testOf).map((t) => t.id)
      )
    ]
  }, [tree, testRuns])
  const ctx = useMemo<ActorContext>(
    () => ({ tabLabels, reviewers: reviewerTabIds(requests, submissions, linked) }),
    [tabLabels, requests, submissions, linked]
  )
  const rounds = useMemo(
    () => buildReviewTimeline({ requests, submissions, comments, commits, testRuns }),
    [requests, submissions, comments, commits, testRuns]
  )

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const hasRounds = rounds.length > 0
  // A live run grows from the bottom; follow it while it does, unless
  // the user has scrolled up to read something.
  const liveStepCount = useMemo(
    () =>
      testRuns.reduce((n, r) => (r.status === 'running' ? n + r.steps.length + 1 : n), 0),
    [testRuns]
  )
  const pinnedRef = useRef(true)
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [hasRounds])
  useEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current && liveStepCount > 0) el.scrollTop = el.scrollHeight
  }, [liveStepCount, testRuns])

  if (!hasRounds) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 text-faint text-sm">
        <History className="icon-xl" />
        <div className="text-fg">No reviews or test runs on this branch yet</div>
        <div className="text-xs max-w-sm text-center">
          When an agent calls request_review or request_test_run, CI goes green with auto-review
          or auto-test on, or you use Request AI review or Request AI test run, each round shows
          up here.
        </div>
      </div>
    )
  }

  return (
    <div
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget
        pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
      }}
      className="flex-1 min-h-0 overflow-y-auto"
    >
      <div className="max-w-4xl mx-auto px-6 py-5 flex flex-col gap-8 text-xs">
        {rounds.map((round) => (
          <section key={round.index}>
            <div className="flex items-center gap-2 mb-3 text-faint">
              {round.index === 0 ? (
                <span>Before the first review</span>
              ) : (
                <>
                  <GitPullRequestArrow className="icon-xs" />
                  <span className="font-medium text-fg">Round {round.index}</span>
                </>
              )}
              <div className="flex-1 h-px bg-border/60" />
            </div>
            <div className="flex flex-col gap-4 pl-4 border-l border-border/60">
              {round.entries.map((e) => (
                <Entry
                  key={entryKey(e)}
                  entry={e}
                  worktreePath={worktreePath}
                  ctx={ctx}
                  onJump={onJumpToComment}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

function entryKey(e: TimelineEntry): string {
  switch (e.kind) {
    case 'request':
      return `q:${e.request.id}`
    case 'review':
      return `s:${e.submission.id}`
    case 'comment':
      return `c:${e.thread.comment.id}`
    case 'reply':
      return `r:${e.reply.id}`
    case 'resolved':
      return `x:${e.comment.id}`
    case 'commit':
      return `g:${e.commit.hash}`
    case 'test':
      return `t:${e.run.id}`
  }
}
