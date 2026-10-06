import { describe, it, expect, vi } from 'vitest'
import { buildPinActions, buildRowActions, buildRowMenuEntries } from './worktree-row-actions'
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

describe('buildRowMenuEntries (desktop right-click menu)', () => {
  const handlers = {
    onSnooze: () => {},
    onUnsnooze: () => {},
    onDelete: () => {},
    onTogglePin: () => {}
  }
  const aliasHandlers = { onEditAlias: () => {}, onClearAlias: () => {} }

  function labels(entries: ReturnType<typeof buildRowMenuEntries>): string[] {
    return entries.map((e) => ('separator' in e ? '---' : e.label))
  }

  it('orders pin, snooze and alias above a separator, with delete below', () => {
    expect(labels(buildRowMenuEntries(row(), handlers, aliasHandlers))).toEqual([
      'Pin Worktree',
      'Snooze',
      'Alias Worktree…',
      '---',
      'Remove worktree'
    ])
  })

  it('shows Unpin and the wake action when pinned and snoozed', () => {
    const entries = buildRowMenuEntries(
      row({ isPinned: true, isSnoozed: true }),
      handlers,
      aliasHandlers
    )
    expect(labels(entries)[0]).toBe('Unpin Worktree')
    expect(labels(entries)[1]).toBe('Wake up')
  })

  it('includes Clear Alias above the separator when the row has an alias', () => {
    const entries = buildRowMenuEntries(row({ alias: 'thing' }), handlers, aliasHandlers)
    const l = labels(entries)
    expect(l.indexOf('Clear Alias')).toBeLessThan(l.indexOf('---'))
  })

  it('omits the separator when there is no destructive action', () => {
    const entries = buildRowMenuEntries(row(), { onTogglePin: () => {} }, aliasHandlers)
    expect(labels(entries)).toEqual(['Pin Worktree', 'Alias Worktree…'])
  })

  it('puts prune below the separator for a prunable worktree', () => {
    const prunable = row({ worktree: { ...row().worktree, prunable: true } })
    const l = labels(
      buildRowMenuEntries(prunable, { ...handlers, onPrune: () => {} }, aliasHandlers)
    )
    expect(l[l.length - 2]).toBe('---')
    expect(l[l.length - 1]).toContain('Prune')
  })

  it('omits snooze for the main worktree but keeps pin', () => {
    const main = row({ worktree: { ...row().worktree, isMain: true } })
    const l = labels(buildRowMenuEntries(main, handlers, aliasHandlers))
    expect(l).toContain('Pin Worktree')
    expect(l).not.toContain('Snooze')
  })
})
