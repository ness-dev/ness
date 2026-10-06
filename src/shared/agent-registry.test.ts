import { describe, expect, it } from 'vitest'
import {
  CLAUDE_MODELS,
  CLAUDE_MODEL_ALIASES,
  CODEX_MODELS
} from './agent-registry'

/** Aliases the bundled CLI understands. Harness spawns two different
 *  `claude` binaries — the user's PATH one for Terminal tabs and the
 *  pinned bundled one for Chat tabs — so a --model value is only safe if
 *  BOTH accept it. This is the bundled binary's alias array, which is the
 *  narrower of the two, and it does NOT validate --model at startup: an
 *  alias missing here fails late, at API-call time, not at spawn.
 *
 *  Derived from @anthropic-ai/claude-code 2.1.285. Re-derive after
 *  bumping the pin:
 *    strings -a node_modules/@anthropic-ai/claude-code-*\/claude \
 *      | grep -oE '=\["sonnet","opus"[^]]*\]' | sort -u */
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
    // Both pickers render alias/current/legacy groups only; anything else
    // would silently vanish from the dropdown.
    for (const m of [...CLAUDE_MODELS, ...CODEX_MODELS]) {
      expect(['alias', 'current', 'legacy']).toContain(m.tier)
    }
  })
})
