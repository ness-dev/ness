import { describe, it, expect, vi } from 'vitest'
import { buildPinActions, buildRowActions } from './worktree-row-actions'
import type { WorktreeRowModel } from '../worktree-list-model'
import type { Worktree } from '../types'

function row(overrides: Partial<WorktreeRowModel> = {}): WorktreeRowModel {
  const worktree = {
    path: '/w/a',
    branch: 'a',
    head: 'abc',
    isBare: false,
    isMain: false,
    createdAt: 0,
    repoRoot: '/repo'
  } as Worktree
  return {
    worktree,
    path: worktree.path,
    status: 'idle',
    displayStatus: 'idle',
    pendingTool: null,
    shellActive: false,
    prStatus: null,
    isMerged: false,
    isSnoozed: false,
    isPinned: false,
    deleting: false,
    ...overrides
  } as WorktreeRowModel
}

describe('buildPinActions', () => {
  it('offers Pin Worktree when the row is not pinned', () => {
    const actions = buildPinActions(row(), { onTogglePin: () => {} })
    expect(actions.map((a) => a.label)).toEqual(['Pin Worktree'])
  })

  it('offers Unpin Worktree when the row is pinned', () => {
    const actions = buildPinActions(row({ isPinned: true }), { onTogglePin: () => {} })
    expect(actions.map((a) => a.label)).toEqual(['Unpin Worktree'])
  })

  it('is empty when no handler is supplied (e.g. a deleting row)', () => {
    expect(buildPinActions(row(), {})).toEqual([])
  })

  it('offers pinning for the main worktree too', () => {
    const main = row({ worktree: { ...row().worktree, isMain: true } })
    expect(buildPinActions(main, { onTogglePin: () => {} })).toHaveLength(1)
  })

  it('invokes the handler on select', () => {
    const onTogglePin = vi.fn()
    buildPinActions(row(), { onTogglePin })[0].onSelect()
    expect(onTogglePin).toHaveBeenCalledOnce()
  })
})

describe('buildRowActions includes pinning', () => {
  it('surfaces the pin action among the hover/sheet actions', () => {
    const actions = buildRowActions(row(), { onTogglePin: () => {} })
    expect(actions.map((a) => a.key)).toContain('pin')
  })

  it('surfaces unpin when pinned', () => {
    const actions = buildRowActions(row({ isPinned: true }), { onTogglePin: () => {} })
    expect(actions.map((a) => a.key)).toContain('unpin')
  })
})
