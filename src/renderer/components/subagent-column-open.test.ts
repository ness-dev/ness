import { describe, expect, it } from 'vitest'
import { isColumnOpen, parseColumnChoices, withColumnChoice } from './subagent-column-open'

describe('subagents column open state', () => {
  it('follows the setting for a session with no explicit choice', () => {
    expect(isColumnOpen({}, 's1', 'expanded')).toBe(true)
    expect(isColumnOpen({}, 's1', 'collapsed')).toBe(false)
  })

  it('lets an explicit choice win over the setting in either direction', () => {
    expect(isColumnOpen({ s1: true }, 's1', 'collapsed')).toBe(true)
    expect(isColumnOpen({ s1: false }, 's1', 'expanded')).toBe(false)
  })

  it('records the latest choice last and drops the oldest past the cap', () => {
    let choices = {}
    for (let i = 0; i < 200; i++) choices = withColumnChoice(choices, `s${i}`, false)
    choices = withColumnChoice(choices, 's0', true)
    choices = withColumnChoice(choices, 'new', true)
    const keys = Object.keys(choices)
    expect(keys).toHaveLength(200)
    expect(keys).not.toContain('s1')
    expect(keys.slice(-2)).toEqual(['s0', 'new'])
  })

  it('reads back only well-formed choices', () => {
    expect(parseColumnChoices(null)).toEqual({})
    expect(parseColumnChoices('not json')).toEqual({})
    expect(parseColumnChoices('["s1"]')).toEqual({})
    expect(parseColumnChoices('{"a":true,"b":"x","c":false}')).toEqual({ a: true, c: false })
  })
})
