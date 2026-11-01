export type ReviewAuthor = { kind: 'human' } | { kind: 'agent'; tabId: string; label?: string }

export type ReviewCommentStatus = 'open' | 'resolved' | 'outdated'

export type ReviewSide = 'old' | 'new'

export interface ReviewReply {
  id: string
  author: ReviewAuthor
  body: string
  createdAt: number
}

export interface ReviewAnchor {
  /** Commit whose content the comment was written against. Review diffs
   *  only ever show committed content (whole-branch is merge-base..HEAD),
   *  so this is always a real SHA — HEAD or the selected tip for the new
   *  side, the diff base for the old side. */
  commitSha: string
  /** Line in `commitSha`'s version of the file. Never changes. */
  line: number
  /** Trimmed text of the anchored line at `commitSha`. Compared against
   *  newer revisions to relocate or outdate the comment. */
  snippet: string
}

export interface ReviewComment {
  id: string
  filePath: string
  side: ReviewSide
  /** Current line, valid for `anchoredSha`. Starts equal to `anchor.line`
   *  and follows the snippet as new commits land. */
  line: number
  /** Commit `line` was last verified against. Lets the anchor refresh
   *  skip comments that are already current without touching git. */
  anchoredSha: string
  anchor: ReviewAnchor
  author: ReviewAuthor
  status: ReviewCommentStatus
  body: string
  createdAt: number
  replies?: ReviewReply[]
  /** Who resolved it and when. Set only while `status` is 'resolved';
   *  absent on comments resolved before this was recorded. */
  resolvedBy?: ReviewAuthor
  resolvedAt?: number
}

export type ReviewVerdict = 'approve' | 'changes-requested' | 'comment'

export type ReviewSubmissionState = 'draft' | 'sent' | 'failed'

/** A finished review: a verdict and summary over the author's comments
 *  that were open when it was submitted. Delivered to one agent tab, the
 *  author of the code under review. */
export interface ReviewSubmission {
  id: string
  author: ReviewAuthor
  verdict: ReviewVerdict
  summary: string
  /** Open comments by `author` at submit time. Only the ones still open
   *  when the submission is sent go out with it. */
  commentIds: string[]
  createdAt: number
  state: ReviewSubmissionState
  /** Tab the submission was (or will be) delivered to. Picked at submit
   *  time so a draft shows where Send will go; the sender can override. */
  targetTabId?: string
  sentAt?: number
  /** Why the last delivery attempt failed. Cleared on success. */
  error?: string
  /** HEAD when the review was submitted, so a round can be tied to the
   *  commits it saw. Absent on older submissions. */
  headSha?: string
}

export type ReviewRequestSource = 'agent' | 'ci-green' | 'user'

/** One ask for a review: an agent's request_review, the CI-green
 *  auto-spawn, or the user's "Request AI review". Recorded when the
 *  reviewer is opened, so the history can show what started each round. */
export interface ReviewRequest {
  id: string
  /** Tab the review is for; the finished review is delivered back to it. */
  requester: ReviewAuthor
  reviewer: ReviewAuthor
  context: string
  source: ReviewRequestSource
  /** True when an already-open reviewer was asked for another look. */
  reused: boolean
  createdAt: number
}

export type TestStepStatus = 'running' | 'passed' | 'failed' | 'skipped'

/** One thing a tester checked: "npm test", "log in on the dev server",
 *  "settings page renders at 375px". Posted while it happens, then
 *  updated with its outcome, so the Review tab shows a run in progress. */
export interface TestStep {
  id: string
  title: string
  status: TestStepStatus
  /** What was run and what came back: the command, the output that
   *  matters, what the page showed. Markdown. */
  detail?: string
  /** Absolute paths of screenshots on the machine running the tester. */
  screenshots?: string[]
  startedAt: number
  updatedAt: number
}

export type TestRunStatus = 'running' | 'passed' | 'failed' | 'inconclusive'

/** One validation pass over a branch by a tester agent: it runs the
 *  tests, starts dev servers, drives the browser, and reports each step
 *  as it goes. Started when the tester is opened; finished when it calls
 *  finish_test_run, at which point the results go back to `requester`. */
export interface TestRun {
  id: string
  requester: ReviewAuthor
  tester: ReviewAuthor
  context: string
  source: ReviewRequestSource
  /** True when an already-open tester was asked to run again. */
  reused: boolean
  status: TestRunStatus
  steps: TestStep[]
  createdAt: number
  summary?: string
  finishedAt?: number
  /** HEAD when the run finished, so the result can be tied to a commit. */
  headSha?: string
  /** Delivery of the finished results to the requester. */
  delivery?: { state: 'sent' | 'failed'; targetTabId?: string; at: number; error?: string }
}

export interface WorktreeReview {
  comments: ReviewComment[]
  /** Absent ⇒ none. Oldest first. */
  submissions?: ReviewSubmission[]
  /** Absent ⇒ none. Oldest first. */
  requests?: ReviewRequest[]
  /** Absent ⇒ none. Oldest first. */
  testRuns?: TestRun[]
}

export interface ReviewsState {
  /** Keyed by worktree path. Absent ⇒ no comments. */
  byPath: Record<string, WorktreeReview>
}

export interface ReviewAnchorUpdate {
  id: string
  line: number
  anchoredSha: string
  status: ReviewCommentStatus
}

export type ReviewsEvent =
  | { type: 'reviews/commentAdded'; payload: { worktreePath: string; comment: ReviewComment } }
  | { type: 'reviews/commentDeleted'; payload: { worktreePath: string; id: string } }
  | {
      type: 'reviews/commentStatusChanged'
      payload: {
        worktreePath: string
        id: string
        status: ReviewCommentStatus
        /** Recorded on the comment when `status` is 'resolved'. */
        by?: ReviewAuthor
        at?: number
      }
    }
  | {
      type: 'reviews/replyAdded'
      payload: { worktreePath: string; commentId: string; reply: ReviewReply }
    }
  | {
      type: 'reviews/anchorsUpdated'
      payload: { worktreePath: string; updates: ReviewAnchorUpdate[] }
    }
  | {
      type: 'reviews/commentEdited'
      payload: { worktreePath: string; id: string; body: string }
    }
  | {
      type: 'reviews/submissionAdded'
      payload: { worktreePath: string; submission: ReviewSubmission }
    }
  | {
      type: 'reviews/submissionEdited'
      payload: { worktreePath: string; id: string; summary: string; verdict: ReviewVerdict }
    }
  | {
      type: 'reviews/submissionDelivered'
      payload: {
        worktreePath: string
        id: string
        state: Exclude<ReviewSubmissionState, 'draft'>
        targetTabId: string | null
        at: number
        error?: string
      }
    }
  | { type: 'reviews/submissionDeleted'; payload: { worktreePath: string; id: string } }
  | { type: 'reviews/requestRecorded'; payload: { worktreePath: string; request: ReviewRequest } }
  | { type: 'reviews/testRunStarted'; payload: { worktreePath: string; run: TestRun } }
  | {
      type: 'reviews/testStepReported'
      /** Adds the step, or replaces the run's step with the same id. */
      payload: { worktreePath: string; runId: string; step: TestStep }
    }
  | {
      type: 'reviews/testRunFinished'
      payload: {
        worktreePath: string
        runId: string
        status: Exclude<TestRunStatus, 'running'>
        summary: string
        at: number
        headSha?: string
      }
    }
  | {
      type: 'reviews/testRunDelivered'
      payload: {
        worktreePath: string
        runId: string
        state: 'sent' | 'failed'
        targetTabId?: string
        at: number
        error?: string
      }
    }
  | { type: 'reviews/testRunDeleted'; payload: { worktreePath: string; runId: string } }
  | { type: 'reviews/worktreeRemoved'; payload: { worktreePath: string } }

export const initialReviews: ReviewsState = {
  byPath: {}
}

export const EMPTY_REVIEW_COMMENTS: ReviewComment[] = []
export const EMPTY_REVIEW_SUBMISSIONS: ReviewSubmission[] = []
export const EMPTY_REVIEW_REQUESTS: ReviewRequest[] = []
export const EMPTY_TEST_RUNS: TestRun[] = []

/** Replace one worktree's comments, submissions, requests and/or test
 *  runs. An entry with none of them is dropped, so an absent key keeps
 *  meaning "nothing here". */
function withEntry(
  state: ReviewsState,
  worktreePath: string,
  patch: Partial<WorktreeReview>
): ReviewsState {
  const prev = state.byPath[worktreePath]
  const comments = patch.comments ?? prev?.comments ?? EMPTY_REVIEW_COMMENTS
  const submissions = 'submissions' in patch ? patch.submissions : prev?.submissions
  const requests = 'requests' in patch ? patch.requests : prev?.requests
  const testRuns = 'testRuns' in patch ? patch.testRuns : prev?.testRuns
  const byPath = { ...state.byPath }
  if (
    comments.length === 0 &&
    !submissions?.length &&
    !requests?.length &&
    !testRuns?.length
  ) {
    delete byPath[worktreePath]
  } else {
    const entry: WorktreeReview = { comments }
    if (submissions?.length) entry.submissions = submissions
    if (requests?.length) entry.requests = requests
    if (testRuns?.length) entry.testRuns = testRuns
    byPath[worktreePath] = entry
  }
  return { ...state, byPath }
}

function patchTestRun(
  state: ReviewsState,
  worktreePath: string,
  id: string,
  patch: (r: TestRun) => TestRun
): ReviewsState {
  const runs = state.byPath[worktreePath]?.testRuns
  if (!runs) return state
  const i = runs.findIndex((r) => r.id === id)
  if (i === -1) return state
  const next = patch(runs[i])
  if (next === runs[i]) return state
  return withEntry(state, worktreePath, {
    testRuns: [...runs.slice(0, i), next, ...runs.slice(i + 1)]
  })
}

function withComments(
  state: ReviewsState,
  worktreePath: string,
  comments: ReviewComment[]
): ReviewsState {
  return withEntry(state, worktreePath, { comments })
}

function patchSubmission(
  state: ReviewsState,
  worktreePath: string,
  id: string,
  patch: (s: ReviewSubmission) => ReviewSubmission
): ReviewsState {
  const submissions = state.byPath[worktreePath]?.submissions
  if (!submissions) return state
  const i = submissions.findIndex((s) => s.id === id)
  if (i === -1) return state
  const next = patch(submissions[i])
  if (next === submissions[i]) return state
  return withEntry(state, worktreePath, {
    submissions: [...submissions.slice(0, i), next, ...submissions.slice(i + 1)]
  })
}

function patchComment(
  state: ReviewsState,
  worktreePath: string,
  id: string,
  patch: (c: ReviewComment) => ReviewComment
): ReviewsState {
  const comments = state.byPath[worktreePath]?.comments
  if (!comments) return state
  const i = comments.findIndex((c) => c.id === id)
  if (i === -1) return state
  const next = patch(comments[i])
  if (next === comments[i]) return state
  return withComments(state, worktreePath, [
    ...comments.slice(0, i),
    next,
    ...comments.slice(i + 1)
  ])
}

export function reviewsReducer(state: ReviewsState, event: ReviewsEvent): ReviewsState {
  switch (event.type) {
    case 'reviews/commentAdded': {
      const { worktreePath, comment } = event.payload
      const existing = state.byPath[worktreePath]?.comments ?? EMPTY_REVIEW_COMMENTS
      if (existing.some((c) => c.id === comment.id)) return state
      return withComments(state, worktreePath, [...existing, comment])
    }
    case 'reviews/commentDeleted': {
      const { worktreePath, id } = event.payload
      const comments = state.byPath[worktreePath]?.comments
      if (!comments) return state
      const i = comments.findIndex((c) => c.id === id)
      if (i === -1) return state
      return withComments(state, worktreePath, [
        ...comments.slice(0, i),
        ...comments.slice(i + 1)
      ])
    }
    case 'reviews/commentStatusChanged': {
      const { worktreePath, id, status, by, at } = event.payload
      return patchComment(state, worktreePath, id, (c) => {
        if (c.status === status) return c
        const next: ReviewComment = { ...c, status }
        delete next.resolvedBy
        delete next.resolvedAt
        if (status === 'resolved') {
          if (by) next.resolvedBy = by
          if (at !== undefined) next.resolvedAt = at
        }
        return next
      })
    }
    case 'reviews/replyAdded': {
      const { worktreePath, commentId, reply } = event.payload
      return patchComment(state, worktreePath, commentId, (c) =>
        c.replies?.some((r) => r.id === reply.id)
          ? c
          : { ...c, replies: [...(c.replies ?? []), reply] }
      )
    }
    case 'reviews/anchorsUpdated': {
      const { worktreePath, updates } = event.payload
      const comments = state.byPath[worktreePath]?.comments
      if (!comments || updates.length === 0) return state
      const byId = new Map(updates.map((u) => [u.id, u]))
      let changed = false
      const next = comments.map((c) => {
        const u = byId.get(c.id)
        if (!u) return c
        if (c.line === u.line && c.anchoredSha === u.anchoredSha && c.status === u.status) {
          return c
        }
        changed = true
        return { ...c, line: u.line, anchoredSha: u.anchoredSha, status: u.status }
      })
      return changed ? withComments(state, worktreePath, next) : state
    }
    case 'reviews/commentEdited': {
      const { worktreePath, id, body } = event.payload
      return patchComment(state, worktreePath, id, (c) => (c.body === body ? c : { ...c, body }))
    }
    case 'reviews/submissionAdded': {
      const { worktreePath, submission } = event.payload
      const existing = state.byPath[worktreePath]?.submissions ?? EMPTY_REVIEW_SUBMISSIONS
      if (existing.some((s) => s.id === submission.id)) return state
      return withEntry(state, worktreePath, { submissions: [...existing, submission] })
    }
    case 'reviews/submissionEdited': {
      const { worktreePath, id, summary, verdict } = event.payload
      return patchSubmission(state, worktreePath, id, (s) =>
        s.summary === summary && s.verdict === verdict ? s : { ...s, summary, verdict }
      )
    }
    case 'reviews/submissionDelivered': {
      const { worktreePath, id, state: next, targetTabId, at, error } = event.payload
      return patchSubmission(state, worktreePath, id, (s) => {
        const updated: ReviewSubmission = { ...s, state: next }
        if (targetTabId) updated.targetTabId = targetTabId
        if (next === 'sent') {
          updated.sentAt = at
          delete updated.error
        } else {
          updated.error = error ?? 'Delivery failed'
        }
        return updated
      })
    }
    case 'reviews/submissionDeleted': {
      const { worktreePath, id } = event.payload
      const submissions = state.byPath[worktreePath]?.submissions
      if (!submissions) return state
      const i = submissions.findIndex((s) => s.id === id)
      if (i === -1) return state
      return withEntry(state, worktreePath, {
        submissions: [...submissions.slice(0, i), ...submissions.slice(i + 1)]
      })
    }
    case 'reviews/requestRecorded': {
      const { worktreePath, request } = event.payload
      const existing = state.byPath[worktreePath]?.requests ?? EMPTY_REVIEW_REQUESTS
      if (existing.some((r) => r.id === request.id)) return state
      return withEntry(state, worktreePath, { requests: [...existing, request] })
    }
    case 'reviews/testRunStarted': {
      const { worktreePath, run } = event.payload
      const existing = state.byPath[worktreePath]?.testRuns ?? EMPTY_TEST_RUNS
      if (existing.some((r) => r.id === run.id)) return state
      return withEntry(state, worktreePath, { testRuns: [...existing, run] })
    }
    case 'reviews/testStepReported': {
      const { worktreePath, runId, step } = event.payload
      return patchTestRun(state, worktreePath, runId, (r) => {
        const i = r.steps.findIndex((s) => s.id === step.id)
        if (i === -1) return { ...r, steps: [...r.steps, step] }
        return { ...r, steps: [...r.steps.slice(0, i), step, ...r.steps.slice(i + 1)] }
      })
    }
    case 'reviews/testRunFinished': {
      const { worktreePath, runId, status, summary, at, headSha } = event.payload
      return patchTestRun(state, worktreePath, runId, (r) => {
        // A step still marked running when the run ends was abandoned;
        // leaving its spinner going would read as work still happening.
        const steps = r.steps.some((s) => s.status === 'running')
          ? r.steps.map((s) =>
              s.status === 'running' ? { ...s, status: 'skipped' as const, updatedAt: at } : s
            )
          : r.steps
        const next: TestRun = { ...r, status, summary, finishedAt: at, steps }
        if (headSha) next.headSha = headSha
        return next
      })
    }
    case 'reviews/testRunDelivered': {
      const { worktreePath, runId, state: delivered, targetTabId, at, error } = event.payload
      return patchTestRun(state, worktreePath, runId, (r) => ({
        ...r,
        delivery: {
          state: delivered,
          at,
          ...(targetTabId ? { targetTabId } : {}),
          ...(delivered === 'failed' ? { error: error ?? 'Delivery failed' } : {})
        }
      }))
    }
    case 'reviews/testRunDeleted': {
      const { worktreePath, runId } = event.payload
      const runs = state.byPath[worktreePath]?.testRuns
      if (!runs) return state
      const i = runs.findIndex((r) => r.id === runId)
      if (i === -1) return state
      return withEntry(state, worktreePath, {
        testRuns: [...runs.slice(0, i), ...runs.slice(i + 1)]
      })
    }
    case 'reviews/worktreeRemoved': {
      const { worktreePath } = event.payload
      if (!(worktreePath in state.byPath)) return state
      const byPath = { ...state.byPath }
      delete byPath[worktreePath]
      return { ...state, byPath }
    }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}
