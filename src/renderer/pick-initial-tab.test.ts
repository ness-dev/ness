import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../shared/state/terminals'
import { pickInitialTab } from './pick-initial-tab'

const tab = (id: string, type: TerminalTab['type']): TerminalTab => ({ id, type, label: id }) as TerminalTab

describe('pickInitialTab', () => {
  it('prefers a Chat tab over an earlier Shell', () => {
    expect(pickInitialTab([tab('s', 'shell'), tab('c', 'json-claude')])).toBe('c')
  })
  it('takes the first conversation in tab order, Chat or Claude Code', () => {
    expect(pickInitialTab([tab('a', 'agent'), tab('c', 'json-claude')])).toBe('a')
    expect(pickInitialTab([tab('c', 'json-claude'), tab('a', 'agent')])).toBe('c')
  })
  it('falls back to a shell, then the first tab, then null', () => {
    expect(pickInitialTab([tab('b', 'browser'), tab('s', 'shell')])).toBe('s')
    expect(pickInitialTab([tab('b', 'browser')])).toBe('b')
    expect(pickInitialTab([])).toBeNull()
  })
})
