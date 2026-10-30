import { describe, it, expect, vi } from 'vitest'

vi.mock('./debug', () => ({ log: () => {} }))

import { Store } from './store'
import { initialState, type AppState } from '../shared/state'
import type { PRStatus } from '../shared/state/prs'
import type { PaneNode, TerminalTab } from '../shared/state/terminals'
import { ReviewSpawner } from './review-spawner'

const WT = '/wt'

function pr(over: Partial<PRStatus> = {}): PRStatus {
  return {
    number: 7,
    state: 'open',
    title: 'Add div',
    url: 'https://github.com/o/r/pull/7',
    branch: 'feature',
    checksOverall: 'success',
    headSha: 'sha-1',
    checks: [],
    reviewDecision: null,
    isDraft: false,
    hasConflict: false,
    updatedAt: 0
  } as unknown as PRStatus
}

function panes(tabs: TerminalTab[]): PaneNode {
  return { type: 'leaf', id: 'p', tabs, activeTabId: tabs[0]?.id ?? '' }
}

const chat = (id: string, over: Partial<TerminalTab> = {}): TerminalTab => ({
  id,
  type: 'json-claude',
  label: 'Chat',
  ...over
})

function setup(
  opts: { tabs?: TerminalTab[]; enabled?: boolean; sessions?: AppState['jsonClaude']['sessions'] } = {}
) {
  const tabs = opts.tabs ?? [chat('author')]
  const state: AppState = {
    ...initialState,
    terminals: { ...initialState.terminals, panes: { [WT]: panes(tabs) } },
    jsonClaude: { ...initialState.jsonClaude, sessions: opts.sessions ?? {} }
  }
  const store = new Store(state)
  const requestReview = vi.fn(
    (_worktreePath: string, _requesterTabId: string, _context: string) =>
      ({ ok: true }) as { ok: true } | { ok: false; error: string }
  )
  const spawner = new ReviewSpawner(store, {
    isEnabled: () => opts.enabled !== false,
    requestReview
  })
  const green = async (status: PRStatus | null = pr()): Promise<void> => {
    store.dispatch({ type: 'prs/statusChanged', payload: { path: WT, status } })
    await new Promise((r) => setImmediate(r))
  }
  return { store, spawner, requestReview, green }
}

describe('ReviewSpawner', () => {
  it('opens a reviewer for the author tab when CI goes green', async () => {
    const { spawner, requestReview, green } = setup()
    spawner.start()
    await green({ ...pr(), checksOverall: 'pending' })
    expect(requestReview).not.toHaveBeenCalled()
    await green()
    expect(requestReview).toHaveBeenCalledTimes(1)
    const [path, tabId, context] = requestReview.mock.calls[0]
    expect([path, tabId]).toEqual([WT, 'author'])
    expect(context).toMatch(/CI has gone green on PR #7/)
  })

  it('reviews a given commit once, however often it is polled', async () => {
    const { spawner, requestReview, green } = setup()
    spawner.start()
    await green({ ...pr(), checksOverall: 'pending' })
    await green()
    await green()
    expect(requestReview).toHaveBeenCalledTimes(1)
    // A new commit that also goes green is a new review.
    await green({ ...pr(), headSha: 'sha-2' })
    expect(requestReview).toHaveBeenCalledTimes(2)
  })

  it('stays quiet about a PR that was already green at the first poll', async () => {
    const { spawner, requestReview, green } = setup()
    spawner.start()
    await green()
    expect(requestReview).not.toHaveBeenCalled()
  })

  it('does nothing when the setting is off', async () => {
    const { spawner, requestReview, green } = setup({ enabled: false })
    spawner.start()
    await green({ ...pr(), checksOverall: 'pending' })
    await green()
    expect(requestReview).not.toHaveBeenCalled()
  })

  it('ignores a merged or closed PR', async () => {
    const { spawner, requestReview, green } = setup()
    spawner.start()
    await green({ ...pr(), checksOverall: 'pending' })
    await green({ ...pr(), state: 'merged' })
    expect(requestReview).not.toHaveBeenCalled()
  })

  it('skips a reviewer tab and picks the most recently active author', async () => {
    const { spawner, requestReview, green } = setup({
      tabs: [chat('old'), chat('reviewer', { reviewOf: 'old' }), chat('recent')],
      sessions: {
        old: { entries: [{ entryId: 'e', kind: 'user', timestamp: 10 }] },
        recent: { entries: [{ entryId: 'e', kind: 'user', timestamp: 50 }] },
        reviewer: { entries: [{ entryId: 'e', kind: 'user', timestamp: 99 }] }
      } as unknown as AppState['jsonClaude']['sessions']
    })
    spawner.start()
    await green({ ...pr(), checksOverall: 'pending' })
    await green()
    expect(requestReview.mock.calls[0][1]).toBe('recent')
  })

  it('retries on the next poll when there is no Chat tab to review for', async () => {
    const { spawner, requestReview, green } = setup({ tabs: [] })
    spawner.start()
    await green({ ...pr(), checksOverall: 'pending' })
    await green()
    expect(requestReview).not.toHaveBeenCalled()
    // The commit claim was released, so a later poll of the same commit
    // tries again — by then the user may have opened a Chat tab.
    await green()
    expect(requestReview).not.toHaveBeenCalled()
  })

  it('releases the commit when the spawn itself fails, so a later poll retries', async () => {
    const { spawner, requestReview, green } = setup()
    requestReview.mockReturnValueOnce({ ok: false, error: 'nope' })
    spawner.start()
    await green({ ...pr(), checksOverall: 'pending' })
    await green()
    expect(requestReview).toHaveBeenCalledTimes(1)
    await green()
    expect(requestReview).toHaveBeenCalledTimes(2)
  })

  it('forgets a worktree whose PR is gone', async () => {
    const { spawner, requestReview, green } = setup()
    spawner.start()
    await green({ ...pr(), checksOverall: 'pending' })
    await green()
    await green(null)
    await green()
    // First observation again after the PR vanished — stays quiet.
    expect(requestReview).toHaveBeenCalledTimes(1)
  })
})
