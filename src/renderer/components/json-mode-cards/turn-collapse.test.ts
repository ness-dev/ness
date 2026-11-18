import { describe, it, expect } from 'vitest'
import {
  foldFinishedTurns,
  formatTurnDuration,
  getEditedPaths,
  type TurnItem,
  type TurnRow
} from './turn-collapse'

let n = 0
const user = (timestamp: number): TurnRow => ({
  key: `u${n++}`,
  type: 'text',
  isTurnStart: true,
  timestamp
})
const text = (timestamp: number): TurnRow => ({
  key: `t${n++}`,
  type: 'text',
  timestamp
})
const tool = (
  timestamp: number,
  toolName = 'Bash',
  extra: Partial<TurnRow> = {}
): TurnRow => ({ key: `x${n++}`, type: 'tool', toolName, timestamp, ...extra })
const thought = (timestamp: number): TurnRow => ({
  key: `th${n++}`,
  type: 'tool',
  isThinking: true,
  timestamp
})

const kinds = (items: TurnItem<TurnRow>[]): string[] =>
  items.map((i) => (i.kind === 'turn' ? `turn:${i.rows.length}` : `rows:${i.rows.length}`))

const idle = { busy: false }

describe('foldFinishedTurns', () => {
  it('folds the work between the prompt and the final answer', () => {
    const rows = [user(0), text(1), tool(2), text(3), tool(4), text(5), text(6)]
    const out = foldFinishedTurns(rows, idle)
    expect(kinds(out)).toEqual(['rows:1', 'turn:4', 'rows:2'])
    const turn = out[1]
    expect(turn.kind === 'turn' && turn.rows.map((r) => r.key)).toEqual(
      rows.slice(1, 5).map((r) => r.key)
    )
  })

  it('keeps the prompt and answer of consecutive turns in one rows run', () => {
    const rows = [user(0), tool(1), text(2), user(3), tool(4), text(5)]
    expect(kinds(foldFinishedTurns(rows, idle))).toEqual([
      'rows:1',
      'turn:1',
      'rows:2',
      'turn:1',
      'rows:1'
    ])
  })

  it('leaves a turn that ended on a tool call expanded', () => {
    const rows = [user(0), text(1), tool(2)]
    expect(kinds(foldFinishedTurns(rows, idle))).toEqual(['rows:3'])
  })

  it('leaves a turn with no tool calls alone', () => {
    const rows = [user(0), thought(1), text(2)]
    expect(kinds(foldFinishedTurns(rows, idle))).toEqual(['rows:3'])
  })

  it('does not fold the last turn while busy', () => {
    const rows = [user(0), tool(1), text(2)]
    expect(kinds(foldFinishedTurns(rows, { busy: true }))).toEqual(['rows:3'])
  })

  it('folds earlier turns while the current one streams', () => {
    const rows = [user(0), tool(1), text(2), user(10), tool(11)]
    expect(
      kinds(foldFinishedTurns(rows, { busy: true, turnStartedAt: 10 }))
    ).toEqual(['rows:1', 'turn:1', 'rows:3'])
  })

  it('treats the part of a live turn before an interjection as live', () => {
    const rows = [user(10), tool(11), text(12), user(13), tool(14)]
    expect(
      kinds(foldFinishedTurns(rows, { busy: true, turnStartedAt: 10 }))
    ).toEqual(['rows:5'])
  })

  it('never folds a pending approval or a turn-level error', () => {
    const pending = [user(0), tool(1, 'Bash', { hasPendingApproval: true }), text(2)]
    expect(kinds(foldFinishedTurns(pending, idle))).toEqual(['rows:3'])
    const errored = [user(0), tool(1), { ...text(2), isTurnError: true }, text(3)]
    expect(kinds(foldFinishedTurns(errored, idle))).toEqual(['rows:4'])
  })

  it('still folds a turn whose tool calls failed', () => {
    const rows = [user(0), tool(1, 'Bash', { hasError: true }), text(2)]
    expect(kinds(foldFinishedTurns(rows, idle))).toEqual(['rows:1', 'turn:1', 'rows:1'])
  })

  it('does not fold rows before the first prompt in the window', () => {
    const rows = [tool(1), text(2), user(3), tool(4), text(5)]
    expect(kinds(foldFinishedTurns(rows, idle))).toEqual(['rows:3', 'turn:1', 'rows:1'])
  })

  it('summarizes duration, tool count and distinct edited files', () => {
    const rows = [
      user(1000),
      thought(2000),
      tool(3000, 'Edit', { editedPaths: ['/a.ts'] }),
      tool(4000, 'Edit', { editedPaths: ['/a.ts'] }),
      tool(5000, 'ApplyPatch', { editedPaths: ['/b.ts', '/c.ts'] }),
      text(65000)
    ]
    const turn = foldFinishedTurns(rows, idle)[1]
    expect(turn.kind === 'turn' && turn.summary).toEqual({
      durationMs: 64000,
      toolCount: 3,
      editedFileCount: 3
    })
  })
})

describe('getEditedPaths', () => {
  it('reads Claude and Codex edit inputs', () => {
    expect(getEditedPaths('Edit', { file_path: '/a' })).toEqual(['/a'])
    expect(getEditedPaths('NotebookEdit', { notebook_path: '/n' })).toEqual(['/n'])
    expect(
      getEditedPaths('ApplyPatch', { changes: [{ path: '/x' }, { path: '/y' }] })
    ).toEqual(['/x', '/y'])
    expect(getEditedPaths('Read', { file_path: '/a' })).toBeUndefined()
  })
})

describe('formatTurnDuration', () => {
  it('scales units', () => {
    expect(formatTurnDuration(400)).toBe('1s')
    expect(formatTurnDuration(42_000)).toBe('42s')
    expect(formatTurnDuration(120_000)).toBe('2m')
    expect(formatTurnDuration(252_000)).toBe('4m 12s')
    expect(formatTurnDuration(3_900_000)).toBe('1h 5m')
  })
})
