import { describe, it, expect } from 'vitest'
import { foldCodexLines, newFoldState } from './jsonl-fold'

function codexRollout(usage: Record<string, number>): string {
  return [
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-luna' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: usage } } })
  ].join('\n')
}

describe('foldCodexLines', () => {
  it('bills cached tokens once — they are a subset of OpenAI input_tokens', () => {
    const state = newFoldState()
    foldCodexLines(
      codexRollout({ input_tokens: 1_000_000, cached_input_tokens: 800_000, output_tokens: 100_000 }),
      state
    )
    const tally = state.byModel['gpt-6-luna']
    expect(tally.input).toBe(200_000)
    expect(tally.cacheRead).toBe(800_000)
    // 200k uncached @ $0.10 + 800k cached @ $0.01 + 100k out @ $0.50
    expect(tally.cost).toBeCloseTo(0.02 + 0.008 + 0.05, 6)
  })

  it('never goes negative when cached exceeds input', () => {
    const state = newFoldState()
    foldCodexLines(codexRollout({ input_tokens: 10, cached_input_tokens: 20, output_tokens: 0 }), state)
    expect(state.byModel['gpt-6-luna'].input).toBe(0)
  })
})
