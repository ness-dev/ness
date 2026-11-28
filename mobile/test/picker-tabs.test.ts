import { describe, expect, it } from 'vitest'
import type { PaneNode, TerminalTab } from '../../src/shared/state/terminals'
import { worktreeTabEntries, type WorktreeTabEntry } from '../../src/renderer/worktree-tab-entries'
import { nestedTabA11yLabel, nestedTabStatus, tabKindLabel, visibleTabEntries } from '../src/picker-tabs'

const tab = (id: string, type: TerminalTab['type'] = 'json-claude', mode?: TerminalTab['mode']): TerminalTab => ({ id, type, label: id, mode })
const entries = (n: number): WorktreeTabEntry[] => Array.from({ length: n }, (_, i) => ({ paneId: 'p', tab: tab(`t${i}`) }))
const ids = (es: WorktreeTabEntry[]) => es.map((e) => e.tab.id)

describe('worktreeTabEntries', () => {
  it('flattens panes in leaf order, keeping each tab’s pane', () => {
    const tree: PaneNode = {
      type: 'split',
      id: 's',
      direction: 'horizontal',
      children: [
        { type: 'leaf', id: 'a', tabs: [tab('1'), tab('2')], activeTabId: '1' },
        { type: 'leaf', id: 'b', tabs: [tab('3', 'shell')], activeTabId: '3' }
      ]
    } as PaneNode
    expect(worktreeTabEntries(tree).map((e) => [e.paneId, e.tab.id])).toEqual([
      ['a', '1'],
      ['a', '2'],
      ['b', '3']
    ])
  })
  it('is empty with no pane tree', () => {
    expect(worktreeTabEntries(undefined)).toEqual([])
  })
})

describe('visibleTabEntries', () => {
  it('shows everything up to the limit plus one (an overflow row would cost as much)', () => {
    expect(visibleTabEntries(entries(6), null, 5)).toEqual({ shown: entries(6), hidden: 0 })
  })
  it('folds the rest behind a count past that', () => {
    const r = visibleTabEntries(entries(9), null, 5)
    expect(ids(r.shown)).toEqual(['t0', 't1', 't2', 't3', 't4'])
    expect(r.hidden).toBe(4)
  })
  it('never folds away the selected tab', () => {
    const r = visibleTabEntries(entries(9), 't7', 5)
    expect(ids(r.shown)).toEqual(['t0', 't1', 't2', 't3', 't7'])
    expect(r.hidden).toBe(4)
  })
})

describe('nestedTabStatus', () => {
  it('maps agent/chat PTY statuses like the desktop', () => {
    expect(nestedTabStatus(tab('a', 'agent'), 'processing', false, false)).toBe('working')
    expect(nestedTabStatus(tab('a'), 'waiting', false, false)).toBe('waiting')
    expect(nestedTabStatus(tab('a'), 'needs-approval', false, false)).toBe('needs-approval')
    expect(nestedTabStatus(tab('a'), 'idle', false, false)).toBeNull()
  })
  it('shells show only a running command (or asleep)', () => {
    expect(nestedTabStatus(tab('s', 'shell'), 'processing', true, false)).toBe('running')
    expect(nestedTabStatus(tab('s', 'shell'), 'processing', false, false)).toBeNull()
    expect(nestedTabStatus(tab('s', 'shell', 'asleep'), undefined, false, false)).toBe('asleep')
  })
  it('an exited chat session reads exited; only chats can', () => {
    expect(nestedTabStatus(tab('c'), 'idle', false, true)).toBe('exited')
    expect(nestedTabStatus(tab('a', 'agent'), 'idle', false, true)).toBeNull()
  })
  it('asleep, but attention wins over it', () => {
    expect(nestedTabStatus(tab('c', 'json-claude', 'asleep'), undefined, false, false)).toBe('asleep')
    expect(nestedTabStatus(tab('c', 'json-claude', 'asleep'), 'needs-approval', false, false)).toBe('needs-approval')
  })
  it('file and diff tabs have no status', () => {
    expect(nestedTabStatus(tab('f', 'file'), undefined, false, false)).toBeNull()
    expect(nestedTabStatus(tab('d', 'diff'), undefined, false, false)).toBeNull()
  })
})

describe('tabKindLabel', () => {
  it('names each kind for VoiceOver', () => {
    expect(tabKindLabel({ type: 'json-claude' })).toBe('Chat')
    expect(tabKindLabel({ type: 'shell' })).toBe('Shell')
    expect(tabKindLabel({ type: 'diff' })).toBe('Diff')
  })
})

describe('nestedTabA11yLabel', () => {
  it('reads kind, title and status', () => {
    expect(nestedTabA11yLabel({ type: 'json-claude' }, 'Fix login', 'needs-approval')).toBe('Chat: Fix login, Needs approval')
  })
  it('does not repeat a title that is just the kind', () => {
    expect(nestedTabA11yLabel({ type: 'shell' }, 'Shell', null)).toBe('Shell')
    expect(nestedTabA11yLabel({ type: 'json-claude' }, 'Chat', 'waiting')).toBe('Chat, Waiting for input')
  })
})
