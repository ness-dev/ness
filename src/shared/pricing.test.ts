import { describe, it, expect } from 'vitest'
import { rateFor, priceFor, isKnownModel } from './pricing'

describe('rateFor', () => {
  it('returns Fable 5 rates for the exact id', () => {
    expect(rateFor('claude-fable-5')).toEqual({ in: 10, out: 50 })
  })

  it('prefix-matches dated Fable 5 variants', () => {
    expect(rateFor('claude-fable-5-20260401')).toEqual({ in: 10, out: 50 })
  })

  it('returns Mythos 5 rates', () => {
    expect(rateFor('claude-mythos-5')).toEqual({ in: 10, out: 50 })
  })

  it('bills dated Opus 4.8 at post-4.5-cut rates, not the old catch-all', () => {
    expect(rateFor('claude-opus-4-8-20260527')).toEqual({ in: 5, out: 25 })
  })

  it('bills Opus 4.5 through 4.8 at $5/$25', () => {
    for (const id of ['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5', 'claude-opus-4-5-20251101']) {
      expect(rateFor(id)).toEqual({ in: 5, out: 25 })
    }
  })

  it('bills Opus 5 at $5/$25 (bare id and dated variant)', () => {
    expect(rateFor('claude-opus-5')).toEqual({ in: 5, out: 25 })
    expect(rateFor('claude-opus-5-20260601')).toEqual({ in: 5, out: 25 })
  })

  it('keeps the old-lineage catch-all for Opus 4.0 / 4.1 dated ids', () => {
    expect(rateFor('claude-opus-4-1-20250805')).toEqual({ in: 15, out: 75 })
    expect(rateFor('claude-opus-4-0')).toEqual({ in: 15, out: 75 })
  })

  it('returns Sonnet 5 introductory rates', () => {
    expect(rateFor('claude-sonnet-5')).toEqual({ in: 2, out: 10 })
  })

  it('returns null for unknown models', () => {
    expect(rateFor('gpt-99-turbo')).toBeNull()
    expect(isKnownModel('gpt-99-turbo')).toBe(false)
  })
})

describe('priceFor', () => {
  it('applies cache read/write multipliers to Fable 5', () => {
    const cost = priceFor('claude-fable-5', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000
    })
    // 10 in + 50 out + 10*0.1 read + 10*1.25 write
    expect(cost).toBeCloseTo(73.5, 6)
  })

  it('prices a dated Opus 4.8 turn at the new rate', () => {
    const cost = priceFor('claude-opus-4-8-20260527', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000
    })
    expect(cost).toBeCloseTo(30, 6)
  })

  it('returns 0 for unknown models', () => {
    expect(priceFor('mystery-model', { input_tokens: 100 })).toBe(0)
  })
})

// One million tokens, so each expectation reads as the published $/MTok
// figure from Anthropic's pricing page.
const MTOK = 1_000_000

describe('Claude Opus 5.5', () => {
  it('bills base input and output at $4 / $20 per MTok', () => {
    expect(priceFor('claude-opus-5-5', { input_tokens: MTOK })).toBeCloseTo(4, 6)
    expect(priceFor('claude-opus-5-5', { output_tokens: MTOK })).toBeCloseTo(20, 6)
  })

  it('bills cache reads at $0.20 per MTok (0.05x input, not the usual 0.1x)', () => {
    expect(
      priceFor('claude-opus-5-5', { cache_read_input_tokens: MTOK })
    ).toBeCloseTo(0.2, 6)
  })

  it('bills 5m cache writes at $5 per MTok (1.25x input)', () => {
    expect(
      priceFor('claude-opus-5-5', { cache_creation_input_tokens: MTOK })
    ).toBeCloseTo(5, 6)
  })

  it('does not let a dated 5.5 id fall through to Opus 5 rates', () => {
    // 'claude-opus-5' is a prefix of 'claude-opus-5-5', so if the keys were
    // ordered the other way rateFor's insertion-order scan would bill a
    // dated 5.5 id at $5/$25 instead of $4/$20.
    expect(rateFor('claude-opus-5-5-20260922')).toEqual(
      rateFor('claude-opus-5-5')
    )
    expect(rateFor('claude-opus-5-5-20260922')?.in).toBe(4)
  })

  it('leaves every other model on the standard 0.1x read multiplier', () => {
    // Haiku 4.5 is $1/MTok input -> $0.10/MTok; Sonnet 5 is $2 -> $0.20.
    expect(
      priceFor('claude-haiku-4-5', { cache_read_input_tokens: MTOK })
    ).toBeCloseTo(0.1, 6)
    expect(
      priceFor('claude-sonnet-5', { cache_read_input_tokens: MTOK })
    ).toBeCloseTo(0.2, 6)
  })
})
