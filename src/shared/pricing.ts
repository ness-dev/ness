// Anthropic Claude pricing in USD per million tokens. Update when
// Anthropic posts new rates. Unknown models return 0 and are logged so
// we notice a mismatch rather than silently charging 0.
//
// Cache multipliers (the load-bearing math that's wrong by ~10x if you
// forget it):
//   cache read  = input rate x 0.10   (90% discount)
//   cache write = input rate x 1.25   (25% surcharge)
//
// The 0.10 cache-read multiplier is not universal any more. Opus 5.5
// discounts reads to 0.05x; set `cacheReadMult` per model to override it.
// Getting this wrong doubles the reported cost of a cache-heavy agent
// session, where reads dominate token volume.

export interface TokenUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  cached_input_tokens?: number
  reasoning_output_tokens?: number
}

interface ModelRate {
  in: number
  out: number
  reasoning?: number
  /** Cache-read discount as a multiple of the input rate. Defaults to 0.10. */
  cacheReadMult?: number
}

const RATES: Record<string, ModelRate> = {
  // Anthropic Claude. Opus pricing dropped from $15/$75 to $5/$25 at
  // Opus 4.5 (Nov 24 2025), so 4-5 and later have explicit entries at
  // the new rate while the bare 'claude-opus-4' key stays at the old
  // rate as a catch-all for the 4-0 / 4-1 lineage only. Key order
  // matters: rateFor's prefix fallback iterates in insertion order, so
  // the specific opus keys must precede the bare 'claude-opus-4' or
  // dated ids like claude-opus-4-8-20260527 would bill at old rates.
  // Same rule puts 'claude-opus-5-5' ahead of 'claude-opus-5', which is
  // a prefix of it — otherwise a dated 5.5 id would bill at Opus 5 rates.
  'claude-fable-5': { in: 10, out: 50 },
  'claude-mythos-5': { in: 10, out: 50 },
  'claude-opus-5-5': { in: 4, out: 20, cacheReadMult: 0.05 },
  'claude-opus-5': { in: 5, out: 25 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-opus-4-7': { in: 5, out: 25 },
  'claude-opus-4-6': { in: 5, out: 25 },
  'claude-opus-4-5': { in: 5, out: 25 },
  'claude-opus-4': { in: 15, out: 75 },
  // Sonnet 5 introductory pricing through Aug 31 2026; $3/$15 from Sep 1 2026.
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-sonnet-4-5': { in: 3, out: 15 },
  'claude-sonnet-4': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
  // OpenAI (used by Codex)
  'o3': { in: 10, out: 40, reasoning: 40 },
  'o4-mini': { in: 1.10, out: 4.40, reasoning: 4.40 },
  'gpt-5-codex': { in: 2, out: 8, reasoning: 8 },
  'gpt-4.1': { in: 2, out: 8 },
  'gpt-4.1-mini': { in: 0.40, out: 1.60 },
  'gpt-4.1-nano': { in: 0.10, out: 0.40 }
}

export function rateFor(model: string): ModelRate | null {
  if (RATES[model]) return RATES[model]
  for (const key of Object.keys(RATES)) {
    if (model.startsWith(key)) return RATES[key]
  }
  return null
}

export function priceFor(model: string, usage: TokenUsage): number {
  const rate = rateFor(model)
  if (!rate) return 0
  const inTok = usage.input_tokens ?? 0
  const outTok = usage.output_tokens ?? 0
  const reasoningTok = usage.reasoning_output_tokens ?? 0
  // Claude uses cache_read_input_tokens; Codex uses cached_input_tokens
  const cacheRead = (usage.cache_read_input_tokens ?? 0) + (usage.cached_input_tokens ?? 0)
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  const reasoningRate = rate.reasoning ?? rate.out
  return (
    (inTok * rate.in +
      (outTok - reasoningTok) * rate.out +
      reasoningTok * reasoningRate +
      cacheRead * rate.in * (rate.cacheReadMult ?? 0.1) +
      cacheWrite * rate.in * 1.25) /
    1_000_000
  )
}

export function isKnownModel(model: string): boolean {
  return rateFor(model) !== null
}
