import { describe, expect, it } from 'vitest'
import {
  initialNotifications,
  MAX_PENDING_PER_TAB,
  notificationsReducer,
  type PendingNotice
} from './notifications'

function notice(id: string): PendingNotice {
  return { id, source: 'subscription-update', wire: `w-${id}`, queuedAt: 0 }
}

describe('notificationsReducer', () => {
  it('notifications/queued appends per tab and caps the backlog', () => {
    let state = initialNotifications
    for (let i = 0; i < MAX_PENDING_PER_TAB + 3; i++) {
      state = notificationsReducer(state, {
        type: 'notifications/queued',
        payload: { tabId: 't', notice: notice(String(i)) }
      })
    }
    const list = state.pendingByTab['t']
    expect(list).toHaveLength(MAX_PENDING_PER_TAB)
    expect(list[0].id).toBe('3')
  })

  it('notifications/drained clears the named tabs and no-ops on unknown ones', () => {
    const state = { pendingByTab: { a: [notice('1')], b: [notice('2')] } }
    const next = notificationsReducer(state, {
      type: 'notifications/drained',
      payload: { tabIds: ['a'] }
    })
    expect(Object.keys(next.pendingByTab)).toEqual(['b'])
    expect(
      notificationsReducer(state, { type: 'notifications/drained', payload: { tabIds: ['z'] } })
    ).toBe(state)
  })
})
