import { describe, it, expect } from 'vitest'
import { classifyTurnText } from './inbox-turn'

describe('classifyTurnText', () => {
  it('reads a closing question as a question, quoting the question', () => {
    const r = classifyTurnText('I fixed the parser.\n\nShould I also update the docs?')
    expect(r).toEqual({ kind: 'question', text: 'Should I also update the docs?' })
  })

  it('finds the question inside a closing paragraph with a trailing sentence', () => {
    const r = classifyTurnText('Want me to open the PR now? Otherwise I will wait.')
    expect(r.kind).toBe('question')
    expect(r.text).toBe('Want me to open the PR now?')
  })

  it('ignores rhetorical questions before the closing paragraph', () => {
    const r = classifyTurnText('Why did it fail? A stale cache.\n\nFixed it and the tests pass.')
    expect(r).toEqual({ kind: 'finished', text: 'Why did it fail? A stale cache.' })
  })

  it('ignores question marks inside fenced code', () => {
    const r = classifyTurnText('Updated the regex:\n\n```ts\nconst re = /a?b/\n```')
    expect(r.kind).toBe('finished')
    expect(r.text).toBe('Updated the regex:')
  })

  it('strips markdown from the summary line', () => {
    expect(classifyTurnText('## **Done** — `npm test` passes').text).toBe('Done — npm test passes')
  })

  it('returns finished with no text for an empty message', () => {
    expect(classifyTurnText('  \n ')).toEqual({ kind: 'finished', text: '' })
  })
})
