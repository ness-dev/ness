import { describe, expect, it } from 'vitest'
import {
  CLAUDE_MODELS,
  CLAUDE_MODEL_ALIASES,
  CODEX_MODELS,
  CURSOR_MODELS
} from './agent-registry'
import { isKnownModel } from './pricing'

/** Aliases the bundled CLI understands. Harness spawns two different
 *  `claude` binaries — the user's PATH one for Terminal tabs and the
 *  pinned bundled one for Chat tabs — so a --model value is only safe if
 *  BOTH accept it. This is the bundled binary's alias array, which is the
 *  narrower of the two. It does reject an unknown --model up front with a
 *  readable "isn't described by this version's model catalog" message, so
 *  a miss here costs a broken tab rather than a silent mischarge — still
 *  worth catching at build time.
 *
 *  Derived from @anthropic-ai/claude-code 2.1.285. Re-derive after
 *  bumping the pin — stop at `;` rather than `]`, or the bracketed
 *  `sonnet[1m]` entries truncate the array mid-token:
 *    strings -a node_modules/@anthropic-ai/claude-code-*\/claude \
 *      | grep -oE '\["sonnet","opus"[^;]{0,200}' | sort -u */
const BUNDLED_CLI_ALIASES = new Set([
  'sonnet',
  'opus',
  'haiku',
  'fable',
  'best',
  'sonnet[1m]',
  'opus[1m]',
  'fable[1m]',
  'opusplan'
])

/** What each offered alias resolved to under the bundled 2.1.285 binary.
 *  `opusplan` is listed at its non-planning model, which is what a normal
 *  turn bills against. */
const ALIAS_RESOLVES_TO: Record<string, string> = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-4-5-20251001',
  fable: 'claude-fable-5-1',
  best: 'claude-fable-5-1',
  opusplan: 'claude-sonnet-5-5'
}

describe('CLAUDE_MODEL_ALIASES', () => {
  it('only offers aliases both spawned CLIs accept', () => {
    for (const m of CLAUDE_MODEL_ALIASES) {
      expect(
        BUNDLED_CLI_ALIASES.has(m.id),
        `"${m.id}" is not in the bundled CLI's alias list — it would break ` +
          `Chat tabs. See the comment on BUNDLED_CLI_ALIASES.`
      ).toBe(true)
    }
  })

  it('marks every alias entry with the alias tier', () => {
    for (const m of CLAUDE_MODEL_ALIASES) expect(m.tier).toBe('alias')
  })

  it('uses bare aliases, never pinned model ids', () => {
    // A `claude-`-prefixed id here would defeat the whole point: it would
    // go stale on the next release, which is what aliases exist to avoid.
    for (const m of CLAUDE_MODEL_ALIASES) {
      expect(m.id.startsWith('claude-')).toBe(false)
    }
  })

  it('resolves only to models pricing.ts can bill', () => {
    // The alias is never what gets billed — the CLI resolves it and the
    // resolved id is what lands in the transcript and reaches priceFor.
    // So every alias target needs pricing, or a session silently costs $0.
    // Read out of the bundled 2.1.285 binary's `init` event; re-derive
    // after bumping the pin with:
    //   claude --model <alias> -p x --output-format stream-json --verbose
    for (const resolved of Object.values(ALIAS_RESOLVES_TO)) {
      expect(
        isKnownModel(resolved),
        `"${resolved}" has no pricing entry — a session on it bills $0.`
      ).toBe(true)
    }
  })

  it('pins a resolution for every alias it offers', () => {
    for (const m of CLAUDE_MODEL_ALIASES) {
      expect(Object.keys(ALIAS_RESOLVES_TO)).toContain(m.id)
    }
  })
})

describe('CLAUDE_MODELS', () => {
  it('surfaces the aliases ahead of the pinned versions', () => {
    const firstPinned = CLAUDE_MODELS.findIndex((m) => m.tier !== 'alias')
    const lastAlias = CLAUDE_MODELS.map((m) => m.tier).lastIndexOf('alias')
    expect(lastAlias).toBeLessThan(firstPinned)
  })

  it('has no duplicate ids', () => {
    const ids = CLAUDE_MODELS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('still offers the current pinned Opus', () => {
    const opus = CLAUDE_MODELS.find((m) => m.id === 'claude-opus-5-5')
    expect(opus).toBeDefined()
    expect(opus?.tier).toBe('current')
  })

  it('every entry lands in a group the pickers render', () => {
    // The pickers render alias/current/legacy groups only; anything else
    // would silently vanish from the dropdown. Covers all three registries
    // because Settings renders a picker for each.
    for (const m of [...CLAUDE_MODELS, ...CODEX_MODELS, ...CURSOR_MODELS]) {
      expect(['alias', 'current', 'legacy']).toContain(m.tier)
    }
  })
})
