import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./debug', () => ({ log: () => {} }))

vi.mock('./worktree', () => ({
  listWorktrees: vi.fn(async () => []),
  addWorktree: vi.fn(),
  defaultWorktreeDir: vi.fn((repoRoot: string) => `${repoRoot}/wt`),
  fetchPullRequestRef: vi.fn(),
  localBranchExists: vi.fn(async () => false),
  runWorktreeScript: vi.fn(),
  unsymlinkClaudeSettings: vi.fn(() => null)
}))
vi.mock('./github', () => ({
  getPRMetadata: vi.fn()
}))
vi.mock('./repo-config', () => ({
  loadRepoConfig: vi.fn(() => ({}))
}))

import { Store } from './store'
import { sanitizeHeadBranchForLocal, WorktreesFSM } from './worktrees-fsm'
import { listWorktrees, addWorktree, runWorktreeScript } from './worktree'
import { parseAutomatedMessage } from '../shared/state/json-claude'

describe('sanitizeHeadBranchForLocal', () => {
  it('returns the head ref unchanged for typical names', () => {
    expect(sanitizeHeadBranchForLocal('fix-the-thing')).toBe('fix-the-thing')
    expect(sanitizeHeadBranchForLocal('release_2024.10-rc1')).toBe('release_2024.10-rc1')
  })

  it('preserves slashes — git accepts them and worktree nesting matches fresh-start', () => {
    expect(sanitizeHeadBranchForLocal('feature/foo')).toBe('feature/foo')
    expect(sanitizeHeadBranchForLocal('users/alice/wip')).toBe('users/alice/wip')
  })

  it('strips control chars and other ref-name-illegal punctuation', () => {
    expect(sanitizeHeadBranchForLocal('wip:@{v1.0}')).toBe('wipv1.0}')
    expect(sanitizeHeadBranchForLocal('a~b^c?d')).toBe('abcd')
  })

  it('collapses `..` sequences and trims leading/trailing dashes and dots', () => {
    expect(sanitizeHeadBranchForLocal('feature..foo')).toBe('feature.foo')
    expect(sanitizeHeadBranchForLocal('---weird---')).toBe('---weird---'.replace(/^[-.]+|[-.]+$/g, ''))
    expect(sanitizeHeadBranchForLocal('.leading')).toBe('leading')
  })
})

describe('WorktreesFSM.refreshListDebounced', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    ;(listWorktrees as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces 30 back-to-back calls into one refresh', () => {
    const fsm = new WorktreesFSM(new Store(), {
      getRepoRoots: () => ['/repo'],
      getWorktreeSetupCmd: () => '',
      getWorktreeBaseMode: () => 'remote',
      onWorktreeCreated: () => {}
    })

    for (let i = 0; i < 30; i++) fsm.refreshListDebounced()
    // Nothing should have fired yet — debounce is trailing.
    expect(listWorktrees).not.toHaveBeenCalled()

    vi.advanceTimersByTime(250)

    expect(listWorktrees).toHaveBeenCalledTimes(1)
  })

  it('a later call resets the timer instead of firing separately', () => {
    const fsm = new WorktreesFSM(new Store(), {
      getRepoRoots: () => ['/repo'],
      getWorktreeSetupCmd: () => '',
      getWorktreeBaseMode: () => 'remote',
      onWorktreeCreated: () => {}
    })

    fsm.refreshListDebounced()
    vi.advanceTimersByTime(200) // still under the 250ms threshold
    fsm.refreshListDebounced()
    vi.advanceTimersByTime(200) // 400ms after the first call, only 200 after the last
    expect(listWorktrees).not.toHaveBeenCalled()

    vi.advanceTimersByTime(60)
    expect(listWorktrees).toHaveBeenCalledTimes(1)
  })
})

describe('WorktreesFSM.runPending', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(listWorktrees as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([])
  })

  it('publishes createdPath before running the setup script', async () => {
    // The generic pane sweep skips mid-creation worktrees by matching this
    // field. `git worktree add` has already made the path visible to
    // `git worktree list`, so publishing it late loses the race and the
    // first agent tab gets initialized without its kickoff prompt or
    // forked session id.
    ;(addWorktree as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      path: '/repo/wt/new',
      branch: 'new'
    })
    const seenAtSetup: (string | undefined)[] = []
    ;(runWorktreeScript as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      seenAtSetup.push(store.getSnapshot().state.worktrees.pending[0]?.createdPath)
      return { ok: true, exitCode: 0 }
    })

    const store = new Store()
    const fsm = new WorktreesFSM(store, {
      getRepoRoots: () => ['/repo'],
      getWorktreeSetupCmd: () => 'echo hi',
      getWorktreeBaseMode: () => 'remote',
      onWorktreeCreated: () => {}
    })

    await fsm.runPending({ id: 'pending:1', repoRoot: '/repo', branchName: 'new' })

    expect(seenAtSetup).toEqual(['/repo/wt/new'])
  })

  it('names the branch from the prompt when no branchName is given', async () => {
    ;(addWorktree as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      path: '/repo/wt/add-dark-mode-toggle',
      branch: 'add-dark-mode-toggle'
    })
    const created: Array<{ initialPrompt?: string }> = []
    const store = new Store()
    const fsm = new WorktreesFSM(store, {
      getRepoRoots: () => ['/repo'],
      getWorktreeSetupCmd: () => '',
      getWorktreeBaseMode: () => 'remote',
      onWorktreeCreated: (params) => {
        created.push(params)
      }
    })

    const outcome = await fsm.runPending({
      id: 'pending:auto',
      repoRoot: '/repo',
      branchName: '',
      initialPrompt: 'Add a dark mode toggle to Settings'
    })

    expect(outcome.outcome).toBe('success')
    expect(addWorktree).toHaveBeenCalledWith(
      '/repo',
      '/repo/wt',
      'add-dark-mode-toggle-settings',
      expect.anything()
    )
    // The agent is told to replace the guess — that's the other half of
    // auto-naming, and without it the slug is the name forever. It rides in
    // the automated-message sentinel so the chat card shows only what the
    // user typed.
    expect(created[0].initialPrompt).toContain('rename_worktree')
    expect(parseAutomatedMessage(created[0].initialPrompt)).toEqual({
      source: 'worktree-autoname',
      body: 'Add a dark mode toggle to Settings'
    })
  })

  it('leaves an explicit branchName alone and adds no rename instruction', async () => {
    ;(addWorktree as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      path: '/repo/wt/chosen',
      branch: 'chosen'
    })
    const created: Array<{ initialPrompt?: string }> = []
    const fsm = new WorktreesFSM(new Store(), {
      getRepoRoots: () => ['/repo'],
      getWorktreeSetupCmd: () => '',
      getWorktreeBaseMode: () => 'remote',
      onWorktreeCreated: (params) => {
        created.push(params)
      }
    })

    await fsm.runPending({
      id: 'pending:explicit',
      repoRoot: '/repo',
      branchName: 'chosen',
      initialPrompt: 'Add a dark mode toggle'
    })

    expect(addWorktree).toHaveBeenCalledWith('/repo', '/repo/wt', 'chosen', expect.anything())
    expect(created[0].initialPrompt).toBe('Add a dark mode toggle')
  })

  it('errors when there is neither a branch name nor a prompt to name from', async () => {
    const store = new Store()
    const fsm = new WorktreesFSM(store, {
      getRepoRoots: () => ['/repo'],
      getWorktreeSetupCmd: () => '',
      getWorktreeBaseMode: () => 'remote',
      onWorktreeCreated: () => {}
    })

    const outcome = await fsm.runPending({
      id: 'pending:empty',
      repoRoot: '/repo',
      branchName: ''
    })

    expect(outcome).toMatchObject({ outcome: 'error' })
    expect(addWorktree).not.toHaveBeenCalled()
    // The renderer routes an error outcome to the pending entry's screen,
    // so the entry has to exist for the failure to be visible at all.
    expect(store.getSnapshot().state.worktrees.pending[0]).toMatchObject({
      id: 'pending:empty',
      status: 'error'
    })
  })
})
