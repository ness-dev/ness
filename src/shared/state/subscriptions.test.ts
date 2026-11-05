import { describe, expect, it } from 'vitest'
import {
  initialSubscriptions,
  explicitSubscribersOf,
  explicitSubscriptionsOfTab,
  subscriptionsReducer,
  type WorktreeSubscription
} from './subscriptions'

function sub(over: Partial<WorktreeSubscription> = {}): WorktreeSubscription {
  return {
    id: 's1',
    subscriberPath: '/wt/a',
    subscriberTabId: 'tab-a',
    targetPath: '/wt/b',
    createdAt: 1,
    ...over
  }
}

describe('subscriptionsReducer', () => {
  it('subscriptions/added appends a new subscription', () => {
    const next = subscriptionsReducer(initialSubscriptions, {
      type: 'subscriptions/added',
      payload: sub()
    })
    expect(next.list).toEqual([sub()])
  })

  it('subscriptions/added for an existing (tab, target) updates the note in place', () => {
    const other = sub({ id: 's0', targetPath: '/wt/c' })
    const state = { list: [other, sub({ note: 'old' })] }
    const next = subscriptionsReducer(state, {
      type: 'subscriptions/added',
      payload: sub({ id: 's2', note: 'new', createdAt: 9 })
    })
    expect(next.list).toHaveLength(2)
    expect(next.list[1]).toEqual(sub({ note: 'new' }))
    expect(next.list[0]).toBe(other)
  })

  it('subscriptions/added with an unchanged note keeps reference identity', () => {
    const state = { list: [sub({ note: 'n' })] }
    const next = subscriptionsReducer(state, {
      type: 'subscriptions/added',
      payload: sub({ id: 'x', note: 'n' })
    })
    expect(next).toBe(state)
  })

  it('subscriptions/removed drops matching ids and no-ops when none match', () => {
    const state = { list: [sub(), sub({ id: 's2', targetPath: '/wt/c' })] }
    const next = subscriptionsReducer(state, {
      type: 'subscriptions/removed',
      payload: { ids: ['s1'] }
    })
    expect(next.list.map((s) => s.id)).toEqual(['s2'])
    expect(
      subscriptionsReducer(state, { type: 'subscriptions/removed', payload: { ids: ['zz'] } })
    ).toBe(state)
  })

  it('selectors filter by target and by subscriber tab', () => {
    const state = {
      list: [sub(), sub({ id: 's2', subscriberTabId: 'tab-z' }), sub({ id: 's3', targetPath: '/wt/c' })]
    }
    expect(explicitSubscribersOf(state, '/wt/b').map((s) => s.id)).toEqual(['s1', 's2'])
    expect(explicitSubscriptionsOfTab(state, 'tab-a').map((s) => s.id)).toEqual(['s1', 's3'])
  })
})
