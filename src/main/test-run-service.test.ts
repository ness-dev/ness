import { describe, it, expect, vi } from 'vitest'
import { Store } from './store'
import { initialState, type AppState } from '../shared/state'
import type { PaneNode, TerminalTab } from '../shared/state/terminals'
import { parseAutomatedMessage } from '../shared/state/json-claude'
import {
  activeTestRun,
  buildTestRequest,
  finishTestRun,
  reportTestStep,
  requestTestRun,
  type TestRunServiceDeps
} from './test-run-service'
import { pickAuthorTab } from './review-service'

const WT = '/wt'

function setup(extraTabs: TerminalTab[] = []): {
  store: Store
  deps: TestRunServiceDeps
  deliver: ReturnType<typeof vi.fn>
  openTester: ReturnType<typeof vi.fn>
} {
  const tree: PaneNode = {
    type: 'leaf',
    id: 'p',
    tabs: [
      { id: 'author', type: 'json-claude', label: 'Chat' },
      { id: 'term', type: 'agent', label: 'Claude' },
      { id: 'rev', type: 'json-claude', label: 'Reviewer', reviewOf: 'author' },
      ...extraTabs
    ],
    activeTabId: 'author'
  }
  const state: AppState = {
    ...initialState,
    terminals: { ...initialState.terminals, panes: { [WT]: tree } }
  }
  const store = new Store(state)
  // Stands in for PanesFSM: adds the tester tab to the tree the way
  // openTesterTab does, so the run's tester author resolves a label.
  const openTester = vi.fn((wt: string, requesterTabId: string) => {
    const leaf = store.getSnapshot().state.terminals.panes[wt] as Extract<PaneNode, { type: 'leaf' }>
    const existing = leaf.tabs.find((t) => t.testOf === requesterTabId)
    if (existing) return { tabId: existing.id, reused: true }
    store.dispatch({
      type: 'terminals/panesForWorktreeChanged',
      payload: {
        worktreePath: wt,
        panes: {
          ...leaf,
          tabs: [...leaf.tabs, { id: 'tester', type: 'json-claude', label: 'Tester', testOf: requesterTabId }]
        }
      }
    })
    return { tabId: 'tester', reused: false }
  })
  const deliver = vi.fn((_wt: string, tabId: string) => ({ ok: true as const, tabId, woke: false }))
  const deps: TestRunServiceDeps = {
    store,
    deliver,
    openTester,
    testDefaults: () => ({ prompt: 'TEST INSTRUCTIONS', repoInstructions: 'npm run dev on :5173' })
  }
  return { store, deps, deliver, openTester }
}

describe('buildTestRequest', () => {
  it('wraps the request with the repo notes and the tool guidance', () => {
    const text = buildTestRequest('Chat', 'try login', 'TEST INSTRUCTIONS', {
      repoInstructions: 'npm run dev'
    })
    const parsed = parseAutomatedMessage(text)
    expect(parsed).toMatchObject({ source: 'test-request', from: 'Chat' })
    expect(parsed?.body).toContain('try login')
    expect(parsed?.body).toContain('notes for testers (from .ness.json):\nnpm run dev')
    expect(text).toContain('report_test_step')
  })
})

describe('requestTestRun', () => {
  it('opens a tester and starts a running run linked to the requester', () => {
    const { store, deps, openTester } = setup()
    const r = requestTestRun(deps, WT, 'author', 'check the form')
    expect(r).toMatchObject({ ok: true, testerTabId: 'tester', reused: false })
    expect(openTester.mock.calls[0][2]).toContain('npm run dev on :5173')
    const runs = store.getSnapshot().state.reviews.byPath[WT].testRuns!
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      status: 'running',
      context: 'check the form',
      requester: { kind: 'agent', tabId: 'author', label: 'Chat' },
      tester: { kind: 'agent', tabId: 'tester', label: 'Tester' }
    })
  })

  it('refuses terminal tabs, reviewers and testers as requesters', () => {
    const { deps } = setup([{ id: 'tst', type: 'json-claude', label: 'T', testOf: 'author' }])
    expect(requestTestRun(deps, WT, 'term', 'x')).toMatchObject({ ok: false })
    expect(requestTestRun(deps, WT, 'rev', 'x')).toMatchObject({ ok: false })
    expect(requestTestRun(deps, WT, 'tst', 'x')).toMatchObject({ ok: false })
  })

  it('closes out an unfinished run when the same tester is asked again', () => {
    const { store, deps } = setup()
    requestTestRun(deps, WT, 'author', 'first')
    const again = requestTestRun(deps, WT, 'author', 'second')
    expect(again).toMatchObject({ ok: true, reused: true })
    const runs = store.getSnapshot().state.reviews.byPath[WT].testRuns!
    expect(runs.map((r) => r.status)).toEqual(['inconclusive', 'running'])
  })
})

describe('pickAuthorTab', () => {
  it('skips tester tabs', () => {
    const { store } = setup([{ id: 'tst', type: 'json-claude', label: 'T', testOf: 'author' }])
    expect(pickAuthorTab(store.getSnapshot().state, WT)).toBe('author')
  })
})

describe('reportTestStep + finishTestRun', () => {
  it('adds and updates steps, then delivers the results to the requester', () => {
    const { store, deps, deliver } = setup()
    requestTestRun(deps, WT, 'author', 'check')
    expect(reportTestStep(store, WT, 'author', { status: 'running', title: 'x' })).toMatchObject({
      error: expect.stringMatching(/no test run in progress/)
    })

    const added = reportTestStep(store, WT, 'tester', { status: 'running', title: 'npm test' })
    if ('error' in added) throw new Error(added.error)
    const updated = reportTestStep(store, WT, 'tester', {
      stepId: added.step.id.slice(0, 8),
      status: 'failed',
      detail: '2 failing',
      screenshots: ['/tmp/a.png']
    })
    if ('error' in updated) throw new Error(updated.error)
    expect(updated.run.steps).toHaveLength(1)
    expect(updated.step).toMatchObject({
      title: 'npm test',
      status: 'failed',
      detail: '2 failing',
      screenshots: ['/tmp/a.png']
    })
    expect(
      reportTestStep(store, WT, 'tester', { status: 'passed', title: 'shot', screenshots: ['rel.png'] })
    ).toMatchObject({ error: expect.stringMatching(/absolute/) })
    expect(reportTestStep(store, WT, 'tester', { status: 'passed' })).toMatchObject({
      error: expect.stringMatching(/title is required/)
    })

    const done = finishTestRun(deps, WT, 'tester', { status: 'failed', summary: 'tests fail', headSha: 'abc1234def' })
    if ('error' in done) throw new Error(done.error)
    expect(done.run).toMatchObject({ status: 'failed', headSha: 'abc1234def', delivery: { state: 'sent' } })
    expect(deliver).toHaveBeenCalledTimes(1)
    const [, target, message] = deliver.mock.calls[0]
    expect(target).toBe('author')
    const parsed = parseAutomatedMessage(message)
    expect(parsed?.source).toBe('test-results')
    expect(parsed?.body).toContain('Test run: Failed at abc1234 (0 passed, 1 failed)')
    expect(parsed?.body).toContain('- npm test\n  2 failing\n  Screenshot: /tmp/a.png')
    expect(activeTestRun(store.getSnapshot().state, WT, 'tester')).toBeNull()
    expect(finishTestRun(deps, WT, 'tester', { status: 'passed', summary: '' })).toMatchObject({
      error: expect.any(String)
    })
  })
})
