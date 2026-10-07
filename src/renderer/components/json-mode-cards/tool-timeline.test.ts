import { describe, it, expect } from 'vitest'
import { buildTimeline, summarizeTools, type TimelineRow } from './tool-timeline'

const ness = (tool: string): string => `mcp__ness-control__${tool}`

function row(toolName: string, extra: Partial<TimelineRow> = {}): TimelineRow {
  return { key: `${toolName}-${Math.random()}`, toolName, ...extra }
}

function shot(key = 'shot'): TimelineRow {
  return {
    key,
    toolName: ness('screenshot_tab'),
    images: [{ path: `/tmp/${key}.png`, mediaType: 'image/png' }]
  }
}

describe('summarizeTools', () => {
  it('falls back to the generic bucket for built-ins', () => {
    expect(summarizeTools([row('Read'), row('Edit'), row('Bash')])).toEqual([
      '3 tool calls'
    ])
  })

  it('singularizes the generic bucket', () => {
    expect(summarizeTools([row('Read')])).toEqual(['1 tool call'])
  })

  it('breaks out ness-control actions by what they did', () => {
    const rows = [
      shot('a'),
      row(ness('click_tab')),
      row(ness('click_tab')),
      row(ness('scroll_tab')),
      shot('b')
    ]
    expect(summarizeTools(rows)).toEqual(['2 screenshots', '2 clicks', '1 scroll'])
  })

  it('keeps first-appearance order, not frequency order', () => {
    const rows = [
      row(ness('scroll_tab')),
      row(ness('click_tab')),
      row(ness('click_tab')),
      row(ness('click_tab'))
    ]
    expect(summarizeTools(rows)).toEqual(['1 scroll', '3 clicks'])
  })

  it('merges back/forward/navigate into one navigation count', () => {
    const rows = [
      row(ness('navigate_tab')),
      row(ness('back_tab')),
      row(ness('forward_tab'))
    ]
    expect(summarizeTools(rows)).toEqual(['3 navigations'])
  })

  it('calls the generic remainder "more calls" when mixed', () => {
    const rows = [row(ness('click_tab')), row('Read'), row('Edit')]
    expect(summarizeTools(rows)).toEqual(['1 click', '2 more calls'])
  })

  it('caps named groups and folds the rest into the remainder', () => {
    const rows = [
      row(ness('click_tab')),
      row(ness('scroll_tab')),
      row(ness('type_tab')),
      row(ness('reload_tab')),
      // 5th distinct action — past the cap, so it joins the remainder.
      row(ness('get_tab_dom')),
      row(ness('get_tab_dom'))
    ]
    expect(summarizeTools(rows)).toEqual([
      '1 click',
      '1 scroll',
      '1 keystroke',
      '1 reload',
      '2 more calls'
    ])
  })

  it('returns nothing for an empty group', () => {
    expect(summarizeTools([])).toEqual([])
  })
})

describe('buildTimeline', () => {
  it('folds consecutive calls to the same tool', () => {
    const steps = buildTimeline([
      shot('a'),
      row(ness('scroll_tab')),
      row(ness('scroll_tab')),
      row(ness('scroll_tab')),
      shot('b')
    ])
    expect(steps.map((s) => (s.kind === 'images' ? 'img' : s.count))).toEqual([
      'img',
      3,
      'img'
    ])
  })

  it('does not fold across a different tool', () => {
    const steps = buildTimeline([
      row(ness('click_tab')),
      row(ness('scroll_tab')),
      row(ness('click_tab'))
    ])
    expect(steps).toHaveLength(3)
    expect(steps.every((s) => s.kind === 'tool' && s.count === 1)).toBe(true)
  })

  it('never folds image rows together', () => {
    const steps = buildTimeline([shot('a'), shot('b')])
    expect(steps).toHaveLength(2)
    expect(steps.every((s) => s.kind === 'images')).toBe(true)
  })

  it('propagates an error from any row in a folded run', () => {
    const steps = buildTimeline([
      row(ness('click_tab')),
      row(ness('click_tab'), { hasError: true })
    ])
    expect(steps).toHaveLength(1)
    expect(steps[0].kind === 'tool' && steps[0].hasError).toBe(true)
  })

  it('skips thinking rows', () => {
    const steps = buildTimeline([
      { key: 't', isThinking: true },
      row(ness('click_tab'))
    ])
    expect(steps).toHaveLength(1)
    expect(steps[0].kind === 'tool' && steps[0].toolName).toBe(ness('click_tab'))
  })

  it('a thinking row between two same-tool calls does not block folding', () => {
    const steps = buildTimeline([
      row(ness('click_tab')),
      { key: 't', isThinking: true },
      row(ness('click_tab'))
    ])
    expect(steps).toHaveLength(1)
    expect(steps[0].kind === 'tool' && steps[0].count).toBe(2)
  })
})
