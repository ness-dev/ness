import { describe, it, expect } from 'vitest'
import { inboxReducer, initialInbox, isTurnUnread, type InboxTurn } from './inbox'

const turn = (over: Partial<InboxTurn> = {}): InboxTurn => ({
  worktreePath: '/wt/a',
  endedAt: 100,
  kind: 'finished',
  text: 'Done.',
  ...over
})

describe('inboxReducer', () => {
  it('inbox/turnEnded records the turn and is identity-preserving on a repeat', () => {
    const s1 = inboxReducer(initialInbox, { type: 'inbox/turnEnded', payload: { tabId: 't1', turn: turn() } })
    expect(s1.turns.t1).toEqual(turn())
    expect(isTurnUnread(s1, 't1')).toBe(true)
    const s2 = inboxReducer(s1, { type: 'inbox/turnEnded', payload: { tabId: 't1', turn: turn() } })
    expect(s2).toBe(s1)
    const s3 = inboxReducer(s1, {
      type: 'inbox/turnEnded',
      payload: { tabId: 't1', turn: turn({ text: 'Filled in later' }) }
    })
    expect(s3.turns.t1.text).toBe('Filled in later')
  })

  it('inbox/seen marks read and never moves backwards', () => {
    const s1 = inboxReducer(initialInbox, { type: 'inbox/turnEnded', payload: { tabId: 't1', turn: turn() } })
    const s2 = inboxReducer(s1, { type: 'inbox/seen', payload: { tabId: 't1', ts: 200 } })
    expect(isTurnUnread(s2, 't1')).toBe(false)
    const s3 = inboxReducer(s2, { type: 'inbox/seen', payload: { tabId: 't1', ts: 150 } })
    expect(s3).toBe(s2)
    expect(s3.turns).toBe(s1.turns)
  })

  it('inbox/prSeen stores the fingerprint and no-ops on the same one', () => {
    const s1 = inboxReducer(initialInbox, {
      type: 'inbox/prSeen',
      payload: { worktreePath: '/wt/a', fingerprint: 'ci:1:abc' }
    })
    expect(s1.prSeen['/wt/a']).toBe('ci:1:abc')
    expect(
      inboxReducer(s1, { type: 'inbox/prSeen', payload: { worktreePath: '/wt/a', fingerprint: 'ci:1:abc' } })
    ).toBe(s1)
  })

  it('inbox/statusSince keeps the first timestamp while the status holds', () => {
    const s1 = inboxReducer(initialInbox, {
      type: 'inbox/statusSince',
      payload: { tabId: 't1', status: 'needs-approval', since: 10 }
    })
    const s2 = inboxReducer(s1, {
      type: 'inbox/statusSince',
      payload: { tabId: 't1', status: 'needs-approval', since: 20 }
    })
    expect(s2).toBe(s1)
    const s3 = inboxReducer(s2, { type: 'inbox/statusSince', payload: { tabId: 't1', status: 'waiting', since: 30 } })
    expect(s3.statusSince.t1).toEqual({ status: 'waiting', since: 30 })
  })

  it('inbox/tabsForgotten drops every record for the tabs and no-ops on unknown ids', () => {
    let s = inboxReducer(initialInbox, { type: 'inbox/turnEnded', payload: { tabId: 't1', turn: turn() } })
    s = inboxReducer(s, { type: 'inbox/turnEnded', payload: { tabId: 't2', turn: turn() } })
    s = inboxReducer(s, { type: 'inbox/seen', payload: { tabId: 't1', ts: 5 } })
    s = inboxReducer(s, { type: 'inbox/statusSince', payload: { tabId: 't1', status: 'idle', since: 1 } })
    const next = inboxReducer(s, { type: 'inbox/tabsForgotten', payload: { tabIds: ['t1'] } })
    expect(Object.keys(next.turns)).toEqual(['t2'])
    expect(next.seenAt).toEqual({})
    expect(next.statusSince).toEqual({})
    expect(inboxReducer(next, { type: 'inbox/tabsForgotten', payload: { tabIds: ['nope'] } })).toBe(next)
  })
})
