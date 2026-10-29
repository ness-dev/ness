import { describe, it, expect } from 'vitest'
import {
  initialCopyDrafts,
  copyDraftsReducer,
  firstDraftForTerminal,
  type CopyDraftRequest
} from './copy-drafts'

function req(id: string, terminalId: string, timestamp: number): CopyDraftRequest {
  return { id, terminalId, worktreePath: '/wt', draft: `draft ${id}`, timestamp }
}

describe('copyDraftsReducer', () => {
  it('copyDrafts/requested adds the draft', () => {
    const next = copyDraftsReducer(initialCopyDrafts, {
      type: 'copyDrafts/requested',
      payload: req('a', 't1', 1)
    })
    expect(next.pending.a).toEqual(req('a', 't1', 1))
  })

  it('copyDrafts/resolved removes the draft', () => {
    const state = copyDraftsReducer(initialCopyDrafts, {
      type: 'copyDrafts/requested',
      payload: req('a', 't1', 1)
    })
    const next = copyDraftsReducer(state, {
      type: 'copyDrafts/resolved',
      payload: { id: 'a', terminalId: 't1' }
    })
    expect(next.pending).toEqual({})
  })

  it('copyDrafts/resolved for an unknown id returns the same state', () => {
    const next = copyDraftsReducer(initialCopyDrafts, {
      type: 'copyDrafts/resolved',
      payload: { id: 'missing', terminalId: 't1' }
    })
    expect(next).toBe(initialCopyDrafts)
  })
})

describe('firstDraftForTerminal', () => {
  it('returns the oldest draft for that terminal only', () => {
    let state = initialCopyDrafts
    for (const r of [req('late', 't1', 5), req('early', 't1', 2), req('other', 't2', 1)]) {
      state = copyDraftsReducer(state, { type: 'copyDrafts/requested', payload: r })
    }
    expect(firstDraftForTerminal(state, 't1')?.id).toBe('early')
    expect(firstDraftForTerminal(state, 't3')).toBeNull()
  })
})
