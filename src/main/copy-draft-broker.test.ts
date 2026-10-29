import { describe, it, expect, vi } from 'vitest'

vi.mock('./debug', () => ({
  log: () => {}
}))

import { Store } from './store'
import { CopyDraftBroker } from './copy-draft-broker'
import { initialState } from '../shared/state'

function setup(chatSessions: string[] = []): { store: Store; broker: CopyDraftBroker } {
  const store = new Store(initialState)
  const broker = new CopyDraftBroker(store, (id) => chatSessions.includes(id))
  return { store, broker }
}

const input = { terminalId: 'term-1', worktreePath: '/wt', draft: 'Get started now!', title: 'Headline' }

describe('CopyDraftBroker', () => {
  it('publishes the draft and settles the waiter with the human answer', async () => {
    const { store, broker } = setup()
    const { id, result } = broker.request(input)
    expect(store.getSnapshot().state.copyDrafts.pending[id]).toMatchObject(input)

    expect(broker.resolve(id, { kind: 'submitted', text: 'Start here' })).toBe(true)
    await expect(result).resolves.toEqual({ kind: 'submitted', text: 'Start here' })
    expect(store.getSnapshot().state.copyDrafts.pending[id]).toBeUndefined()
  })

  it('only the first answer wins', async () => {
    const { broker } = setup()
    const { id, result } = broker.request(input)
    broker.cancel(id)
    expect(broker.resolve(id, { kind: 'submitted', text: 'late' })).toBe(false)
    await expect(result).resolves.toEqual({ kind: 'cancelled' })
  })

  it('flags a terminal tab as needs-approval until the human answers', () => {
    const { store, broker } = setup()
    const { id } = broker.request(input)
    const terminals = (): typeof initialState.terminals => store.getSnapshot().state.terminals
    expect(terminals().statuses['term-1']).toBe('needs-approval')
    expect(terminals().pendingTools['term-1']?.name).toBe('edit_copy')

    broker.resolve(id, { kind: 'dismissed' })
    expect(terminals().statuses['term-1']).toBe('processing')
  })

  it('leaves Chat-tab status to the json-claude deriver', () => {
    const { store, broker } = setup(['term-1'])
    broker.request(input)
    expect(store.getSnapshot().state.terminals.statuses['term-1']).toBeUndefined()
  })
})
