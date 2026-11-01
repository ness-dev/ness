import { randomUUID } from 'crypto'
import { isAbsolute } from 'path'
import type { Store } from './store'
import type { AppState } from '../shared/state'
import type {
  ReviewRequestSource,
  TestRun,
  TestRunStatus,
  TestStep,
  TestStepStatus
} from '../shared/state/reviews'
import type { AgentKind } from '../shared/state/terminals'
import { findTabInWorktree, findTesterTab, tabLabel } from '../shared/agent-tabs'
import { wrapAutomatedMessage } from '../shared/state/json-claude'
import { formatTestRunResults } from '../shared/test-run-format'
import { describeTabDeliveryFailure, type TabDeliveryResult } from './chat-delivery'
import { agentAuthor, modelForAgent, type ReviewSendResult } from './review-service'

export interface TestRunServiceDeps {
  store: Store
  deliver: (worktreePath: string, tabId: string, message: string) => TabDeliveryResult
  /** Open (or reuse) the tester Chat tab for a requester and hand it the
   *  request as its first turn. */
  openTester: (
    worktreePath: string,
    requesterTabId: string,
    prompt: string,
    opts?: { agentKind?: AgentKind; model?: string }
  ) => { tabId: string; reused: boolean }
  /** Which agent and model a tester runs as, what it is told to do, and
   *  the repo's own testing notes from .ness.json. */
  testDefaults: (worktreePath: string) => {
    agentKind?: AgentKind
    model?: string
    prompt: string
    repoInstructions?: string
  }
}

/** Prompt handed to a tester tab as its first turn. */
export function buildTestRequest(
  requesterLabel: string,
  context: string,
  instructions: string,
  opts?: { reRequest?: boolean; repoInstructions?: string }
): string {
  const lines = [
    opts?.reRequest
      ? `${requesterLabel} has pushed changes and is asking you to test this branch again.`
      : `${requesterLabel} has finished a piece of work on this branch and is asking you to test it.`,
    '',
    `What ${requesterLabel} says about it:`,
    context.trim(),
    '',
    instructions.trim()
  ]
  const repo = opts?.repoInstructions?.trim()
  if (repo) {
    lines.push('', "This repository's notes for testers (from .ness.json):", repo)
  }
  return wrapAutomatedMessage('test-request', lines.join('\n'), { from: requesterLabel })
}

function runsFor(state: AppState, worktreePath: string): TestRun[] {
  return state.reviews.byPath[worktreePath]?.testRuns ?? []
}

function findRun(state: AppState, worktreePath: string, runId: string): TestRun | null {
  return runsFor(state, worktreePath).find((r) => r.id === runId) ?? null
}

/** The run a tester is working on: its newest, if that is still going. */
export function activeTestRun(
  state: AppState,
  worktreePath: string,
  testerTabId: string
): TestRun | null {
  const runs = runsFor(state, worktreePath)
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i]
    if (r.tester.kind === 'agent' && r.tester.tabId === testerTabId) {
      return r.status === 'running' ? r : null
    }
  }
  return null
}

/** Context for a test run the user asked for from the PR panel. */
export function buildUserTestContext(pr?: {
  number: number
  title: string
  url: string
  branch: string
} | null): string {
  const lines = ['The user asked for this test run from the Pull Request panel.']
  if (pr) lines.push('', `PR #${pr.number}: ${pr.title}`, pr.url)
  lines.push('', 'Validate the whole branch against its base.')
  return lines.join('\n')
}

export function buildCiGreenTestContext(pr: {
  number: number
  branch: string
  title?: string
  url?: string
}): string {
  return [
    `CI has gone green on PR #${pr.number} (${pr.branch}), so Ness started this test run automatically — the author did not ask for it by hand.`,
    '',
    'CI has already run the automated checks, so spend your time on what CI cannot see: run the change and exercise it.',
    pr.title ? `\nPR title: ${pr.title}` : '',
    pr.url ? `PR: ${pr.url}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

export type RequestTestRunResult =
  | { ok: true; testerTabId: string; reused: boolean; runId: string }
  | { ok: false; error: string }

/** Open a tester for `requesterTabId`, hand it the request, and start a
 *  run in the Review tab that its steps will land in. */
export function requestTestRun(
  deps: TestRunServiceDeps,
  worktreePath: string,
  requesterTabId: string,
  context: string,
  source: ReviewRequestSource = 'agent'
): RequestTestRunResult {
  const state = deps.store.getSnapshot().state
  const requester = findTabInWorktree(state, worktreePath, requesterTabId)
  if (!requester) return { ok: false, error: 'caller tab is not in this worktree' }
  if (requester.type !== 'json-claude') {
    return {
      ok: false,
      error:
        'only a Chat tab can request a test run — the results are delivered back to the requester, and Ness can only deliver into Chat tabs.'
    }
  }
  if (requester.testOf) {
    return {
      ok: false,
      error: 'you are the tester for this branch — report with finish_test_run rather than requesting another run.'
    }
  }
  if (requester.reviewOf) {
    return { ok: false, error: 'a reviewer cannot request a test run; mention it in your review instead.' }
  }
  const previous = findTesterTab(state, worktreePath, requesterTabId)
  const defaults = deps.testDefaults(worktreePath)
  const agentKind = defaults.agentKind ?? requester.agentKind ?? 'claude'
  const opened = deps.openTester(
    worktreePath,
    requesterTabId,
    buildTestRequest(tabLabel(requester), context, defaults.prompt, {
      reRequest: !!previous,
      repoInstructions: defaults.repoInstructions
    }),
    { agentKind, model: modelForAgent(agentKind, defaults.model) }
  )
  const after = deps.store.getSnapshot().state
  // The tester is starting over, so a run it never finished is abandoned
  // rather than left spinning beside the new one.
  const stale = activeTestRun(after, worktreePath, opened.tabId)
  const now = Date.now()
  if (stale) {
    deps.store.dispatch({
      type: 'reviews/testRunFinished',
      payload: {
        worktreePath,
        runId: stale.id,
        status: 'inconclusive',
        summary: stale.summary || 'Superseded by a new test run before it finished.',
        at: now
      }
    })
  }
  const run: TestRun = {
    id: randomUUID(),
    requester: agentAuthor(after, worktreePath, requesterTabId),
    tester: agentAuthor(after, worktreePath, opened.tabId),
    context: context.trim(),
    source,
    reused: opened.reused,
    status: 'running',
    steps: [],
    createdAt: now
  }
  deps.store.dispatch({ type: 'reviews/testRunStarted', payload: { worktreePath, run } })
  return { ok: true, testerTabId: opened.tabId, reused: opened.reused, runId: run.id }
}

export interface ReportTestStepInput {
  /** Update this step (full id or short id) instead of adding one. */
  stepId?: string
  title?: string
  status: TestStepStatus
  detail?: string
  screenshots?: string[]
}

const MIN_STEP_ID_PREFIX = 6

function findStep(run: TestRun, idOrPrefix: string): TestStep | { error: string } {
  const q = idOrPrefix.trim().replace(/^\[|\]$/g, '')
  const exact = run.steps.find((s) => s.id === q)
  if (exact) return exact
  if (q.length >= MIN_STEP_ID_PREFIX) {
    const matches = run.steps.filter((s) => s.id.startsWith(q))
    if (matches.length === 1) return matches[0]
  }
  return { error: `no step "${q}" in the current test run — omit step_id to add a new step` }
}

/** Add a step to the caller's active run, or update one of its steps.
 *  Screenshots accumulate across updates; detail and title replace. */
export function reportTestStep(
  store: Store,
  worktreePath: string,
  testerTabId: string,
  input: ReportTestStepInput
): { run: TestRun; step: TestStep } | { error: string } {
  const state = store.getSnapshot().state
  const run = activeTestRun(state, worktreePath, testerTabId)
  if (!run) {
    return {
      error:
        'no test run in progress for this tab — test runs start from request_test_run or the "Request AI test run" button'
    }
  }
  const shots = (input.screenshots ?? []).map((p) => p.trim()).filter(Boolean)
  const badShot = shots.find((p) => !isAbsolute(p))
  if (badShot) return { error: `screenshot paths must be absolute: "${badShot}"` }
  const now = Date.now()
  let step: TestStep
  if (input.stepId) {
    const found = findStep(run, input.stepId)
    if ('error' in found) return found
    const screenshots = [...(found.screenshots ?? [])]
    for (const p of shots) if (!screenshots.includes(p)) screenshots.push(p)
    step = {
      ...found,
      status: input.status,
      updatedAt: now,
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      ...(input.detail?.trim() ? { detail: input.detail.trim() } : {}),
      ...(screenshots.length ? { screenshots } : {})
    }
  } else {
    const title = input.title?.trim()
    if (!title) return { error: 'title is required for a new step' }
    step = {
      id: randomUUID(),
      title,
      status: input.status,
      startedAt: now,
      updatedAt: now,
      ...(input.detail?.trim() ? { detail: input.detail.trim() } : {}),
      ...(shots.length ? { screenshots: shots } : {})
    }
  }
  store.dispatch({
    type: 'reviews/testStepReported',
    payload: { worktreePath, runId: run.id, step }
  })
  const updated = findRun(store.getSnapshot().state, worktreePath, run.id) ?? run
  return { run: updated, step }
}

/** Deliver a finished run to the tab that asked for it and record the
 *  outcome on the run. */
export function sendTestRunResults(
  deps: TestRunServiceDeps,
  worktreePath: string,
  runId: string
): ReviewSendResult {
  const state = deps.store.getSnapshot().state
  const run = findRun(state, worktreePath, runId)
  if (!run) return { ok: false, error: 'Test run not found' }
  if (run.status === 'running') return { ok: false, error: 'Test run has not finished' }
  const target =
    run.requester.kind === 'agent' && findTabInWorktree(state, worktreePath, run.requester.tabId)
      ? run.requester.tabId
      : null

  const record = (result: ReviewSendResult): ReviewSendResult => {
    deps.store.dispatch({
      type: 'reviews/testRunDelivered',
      payload: {
        worktreePath,
        runId,
        state: result.ok ? 'sent' : 'failed',
        ...(target ? { targetTabId: target } : {}),
        at: Date.now(),
        ...(result.ok ? {} : { error: result.error })
      }
    })
    return result
  }

  if (!target) return record({ ok: false, error: 'The tab that asked for this run is closed' })
  const message = wrapAutomatedMessage('test-results', formatTestRunResults(run), {
    from: run.tester.kind === 'agent' ? run.tester.label : undefined
  })
  const result = deps.deliver(worktreePath, target, message)
  if (!result.ok) {
    return record({ ok: false, error: describeTabDeliveryFailure(result.reason), tabId: target })
  }
  return record({ ok: true, tabId: result.tabId, woke: result.woke })
}

export type FinishTestRunResult =
  | { run: TestRun; delivery: ReviewSendResult }
  | { error: string }

export function finishTestRun(
  deps: TestRunServiceDeps,
  worktreePath: string,
  testerTabId: string,
  input: { status: Exclude<TestRunStatus, 'running'>; summary: string; headSha?: string }
): FinishTestRunResult {
  const run = activeTestRun(deps.store.getSnapshot().state, worktreePath, testerTabId)
  if (!run) return { error: 'no test run in progress for this tab' }
  deps.store.dispatch({
    type: 'reviews/testRunFinished',
    payload: {
      worktreePath,
      runId: run.id,
      status: input.status,
      summary: input.summary.trim(),
      at: Date.now(),
      ...(input.headSha ? { headSha: input.headSha } : {})
    }
  })
  const delivery = sendTestRunResults(deps, worktreePath, run.id)
  const latest = findRun(deps.store.getSnapshot().state, worktreePath, run.id) ?? run
  return { run: latest, delivery }
}
