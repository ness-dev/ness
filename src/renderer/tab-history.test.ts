import { describe, it, expect } from 'vitest'
import {
  emptyTabHistory,
  recordVisit,
  pruneTabHistory,
  stepTabHistory,
  settleVisit,
  MAX_TAB_HISTORY,
  type PendingNavigation,
  type TabHistory,
  type TabHistoryEntry
} from './tab-history'

const e = (worktreePath: string, tabId: string): TabHistoryEntry => ({ worktreePath, tabId })
const all = (): boolean => true
const visit = (...entries: TabHistoryEntry[]): TabHistory =>
  entries.reduce(recordVisit, emptyTabHistory)

describe('recordVisit', () => {
  it('appends and moves the index to the new entry', () => {
    const h = visit(e('/a', '1'), e('/b', '2'))
    expect(h.entries).toEqual([e('/a', '1'), e('/b', '2')])
    expect(h.index).toBe(1)
  })

  it('returns the same object when revisiting the current entry', () => {
    const h = visit(e('/a', '1'))
    expect(recordVisit(h, e('/a', '1'))).toBe(h)
  })

  it('drops forward entries after stepping back', () => {
    const back = stepTabHistory(visit(e('/a', '1'), e('/a', '2'), e('/a', '3')), -1, all).history
    const h = recordVisit(back, e('/b', '4'))
    expect(h.entries).toEqual([e('/a', '1'), e('/a', '2'), e('/b', '4')])
    expect(h.index).toBe(2)
  })

  it('caps length by dropping the oldest entries', () => {
    let h = emptyTabHistory
    for (let i = 0; i < MAX_TAB_HISTORY + 5; i++) h = recordVisit(h, e('/a', String(i)))
    expect(h.entries).toHaveLength(MAX_TAB_HISTORY)
    expect(h.entries[0]).toEqual(e('/a', '5'))
    expect(h.index).toBe(MAX_TAB_HISTORY - 1)
  })
})

describe('pruneTabHistory', () => {
  it('returns the same object when everything is live', () => {
    const h = visit(e('/a', '1'), e('/a', '2'))
    expect(pruneTabHistory(h, all)).toBe(h)
  })

  it('removes dead entries and collapses the duplicates left behind', () => {
    const h = visit(e('/a', '1'), e('/a', '2'), e('/a', '1'), e('/a', '3'))
    const pruned = pruneTabHistory(h, (x) => x.tabId !== '2')
    expect(pruned.entries).toEqual([e('/a', '1'), e('/a', '3')])
    expect(pruned.index).toBe(1)
  })

  it('keeps the index on the same logical entry', () => {
    const h = stepTabHistory(visit(e('/a', '1'), e('/a', '2'), e('/a', '3')), -1, all).history
    const pruned = pruneTabHistory(h, (x) => x.tabId !== '1')
    expect(pruned.entries).toEqual([e('/a', '2'), e('/a', '3')])
    expect(pruned.index).toBe(0)
  })

  it('empties cleanly when nothing is live', () => {
    expect(pruneTabHistory(visit(e('/a', '1')), () => false)).toEqual(emptyTabHistory)
  })
})

describe('stepTabHistory', () => {
  it('steps back across worktrees and forward again', () => {
    const h = visit(e('/a', '1'), e('/b', '2'))
    const back = stepTabHistory(h, -1, all)
    expect(back.target).toEqual(e('/a', '1'))
    const fwd = stepTabHistory(back.history, 1, all)
    expect(fwd.target).toEqual(e('/b', '2'))
    expect(fwd.history.index).toBe(1)
  })

  it('returns no target at either end', () => {
    const h = visit(e('/a', '1'))
    expect(stepTabHistory(h, -1, all).target).toBeNull()
    expect(stepTabHistory(h, 1, all).target).toBeNull()
  })

  it('skips closed tabs', () => {
    const h = visit(e('/a', '1'), e('/b', '2'), e('/a', '3'))
    const back = stepTabHistory(h, -1, (x) => x.tabId !== '2')
    expect(back.target).toEqual(e('/a', '1'))
  })
})

describe('settleVisit', () => {
  const pending: PendingNavigation = { target: e('/b', '2'), expiresAt: 1000 }

  it('records when no jump is in flight', () => {
    expect(settleVisit(null, e('/a', '1'), 0)).toEqual({ record: true, pending: null })
  })

  it('clears the jump without recording once the target lands', () => {
    expect(settleVisit(pending, e('/b', '2'), 0)).toEqual({ record: false, pending: null })
  })

  it('skips the in-between state in the target worktree', () => {
    expect(settleVisit(pending, e('/b', 'old'), 999)).toEqual({ record: false, pending })
  })

  it('records focus in another worktree as the user moving on', () => {
    expect(settleVisit(pending, e('/c', '3'), 0)).toEqual({ record: true, pending: null })
  })

  it('records anything once the jump has expired', () => {
    expect(settleVisit(pending, e('/b', 'old'), 1000)).toEqual({ record: true, pending: null })
  })
})
