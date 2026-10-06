import type { AgentKind } from './state/terminals'

export interface AgentInfo {
  kind: AgentKind
  displayName: string
  vendor: string
  /** If true, Ness generates a session ID and passes it to the CLI on
   * first spawn. If false, the agent assigns its own ID and Ness
   * discovers it from the first hook event. */
  assignsSessionId: boolean
  /** Whether a conversation can be forked INTO a new worktree running this
   * agent. Requires a transcript format Ness can rewrite and a CLI flag
   * to resume it by id — only Claude Code qualifies today. Agents that
   * assign their own session ids can't be handed a pre-seeded one at all. */
  supportsConversationFork: boolean
}

export const AGENT_REGISTRY: AgentInfo[] = [
  {
    kind: 'claude',
    displayName: 'Claude Code',
    vendor: 'Anthropic',
    assignsSessionId: true,
    supportsConversationFork: true
  },
  {
    kind: 'codex',
    displayName: 'Codex',
    vendor: 'OpenAI',
    assignsSessionId: false,
    supportsConversationFork: false
  },
  {
    kind: 'cursor',
    displayName: 'Cursor Agent',
    vendor: 'Cursor',
    assignsSessionId: false,
    supportsConversationFork: false
  }
]

export interface ModelOption {
  id: string
  displayName: string
  /** 'alias' passes a CLI family alias (`opus`) as --model instead of a
   *  pinned id, so the choice follows Anthropic's releases with no
   *  Harness change. 'current'/'legacy' are version-pinned and only
   *  worth picking to deliberately hold an older model. */
  tier: 'alias' | 'current' | 'legacy'
}

/** Family aliases the `claude` CLI resolves at launch. Verified against
 *  the real binary: `opus` → Opus 5.5, `sonnet` → Sonnet 5, `haiku` →
 *  Haiku 4.5, `fable` → Fable 5.1, `best` → Fable 5.1, `opusplan` → Opus
 *  while planning then Sonnet. An unknown alias is rejected at startup
 *  with a clear message.
 *
 *  Must stay within the intersection of the two CLIs Harness spawns:
 *  Terminal tabs use the user's PATH `claude`, Chat tabs use the pinned
 *  bundled one. The bundled build is the narrower of the two and does not
 *  validate --model at startup, so an alias it doesn't know wouldn't fail
 *  fast — it would blow up later at API-call time. agent-registry.test.ts
 *  enforces this; re-derive its list after bumping the pin.
 *
 *  `mythos` is deliberately omitted: it exists in the alias table but is
 *  invitation-only (Project Glasswing), so it would 404 for most users.
 *  The `[1m]` variants are omitted too — they force the 1M context
 *  window, which is a separate axis from model choice.
 *
 *  These never go stale, so prefer adding an alias over pinning an id. */
export const CLAUDE_MODEL_ALIASES: ModelOption[] = [
  { id: 'opus', displayName: 'Claude Opus (latest)', tier: 'alias' },
  { id: 'sonnet', displayName: 'Claude Sonnet (latest)', tier: 'alias' },
  { id: 'haiku', displayName: 'Claude Haiku (latest)', tier: 'alias' },
  { id: 'fable', displayName: 'Claude Fable (latest)', tier: 'alias' },
  { id: 'best', displayName: 'Best available', tier: 'alias' },
  {
    id: 'opusplan',
    displayName: 'Opus while planning, then Sonnet',
    tier: 'alias'
  }
]

export const CLAUDE_MODELS: ModelOption[] = [
  ...CLAUDE_MODEL_ALIASES,
  { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', tier: 'current' },
  { id: 'claude-fable-5', displayName: 'Claude Fable 5', tier: 'current' },
  { id: 'claude-opus-5', displayName: 'Claude Opus 5', tier: 'current' },
  { id: 'claude-opus-4-8', displayName: 'Claude Opus 4.8', tier: 'current' },
  { id: 'claude-opus-4-7', displayName: 'Claude Opus 4.7', tier: 'current' },
  { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', tier: 'current' },
  { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', tier: 'current' },
  { id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', tier: 'current' },
  { id: 'claude-opus-4-6', displayName: 'Claude Opus 4.6', tier: 'legacy' },
  { id: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5', tier: 'legacy' },
  { id: 'claude-opus-4-5', displayName: 'Claude Opus 4.5', tier: 'legacy' },
  { id: 'claude-opus-4-1', displayName: 'Claude Opus 4.1', tier: 'legacy' },
  { id: 'claude-sonnet-4-0', displayName: 'Claude Sonnet 4.0', tier: 'legacy' },
  { id: 'claude-opus-4-0', displayName: 'Claude Opus 4.0', tier: 'legacy' },
  { id: 'claude-3-5-sonnet-latest', displayName: 'Claude 3.5 Sonnet', tier: 'legacy' },
  { id: 'claude-3-5-haiku-latest', displayName: 'Claude 3.5 Haiku', tier: 'legacy' },
  { id: 'claude-3-opus-latest', displayName: 'Claude 3 Opus', tier: 'legacy' }
]

export const CODEX_MODELS: ModelOption[] = [
  { id: 'gpt-5-codex', displayName: 'GPT-5 Codex', tier: 'current' },
  { id: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex', tier: 'current' },
  { id: 'gpt-5.2-codex', displayName: 'GPT-5.2 Codex', tier: 'current' },
  { id: 'gpt-5.1-codex', displayName: 'GPT-5.1 Codex', tier: 'current' },
  { id: 'gpt-5.1-codex-max', displayName: 'GPT-5.1 Codex Max', tier: 'current' },
  { id: 'gpt-5.1-codex-mini', displayName: 'GPT-5.1 Codex Mini', tier: 'current' },
  { id: 'gpt-5.4', displayName: 'GPT-5.4', tier: 'current' },
  { id: 'gpt-5.4-mini', displayName: 'GPT-5.4 Mini', tier: 'current' },
  { id: 'gpt-5.4-nano', displayName: 'GPT-5.4 Nano', tier: 'current' },
  { id: 'o3', displayName: 'o3', tier: 'legacy' },
  { id: 'o4-mini', displayName: 'o4-mini', tier: 'legacy' },
  { id: 'gpt-4.1', displayName: 'GPT-4.1', tier: 'legacy' },
  { id: 'gpt-4.1-mini', displayName: 'GPT-4.1 Mini', tier: 'legacy' },
]

export const CURSOR_MODELS: ModelOption[] = [
  { id: 'composer-2.5', displayName: 'Composer 2.5', tier: 'current' },
  { id: 'composer-2.5-fast', displayName: 'Composer 2.5 Fast', tier: 'current' },
  { id: 'gpt-5.3-codex', displayName: 'Codex 5.3', tier: 'current' },
  { id: 'gpt-5.3-codex-high', displayName: 'Codex 5.3 High', tier: 'current' },
  { id: 'gpt-5.4', displayName: 'GPT-5.4', tier: 'current' },
  { id: 'claude-opus-4-8', displayName: 'Claude Opus 4.8', tier: 'current' },
  { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', tier: 'current' },
  { id: 'auto', displayName: 'Auto', tier: 'current' },
  { id: 'gpt-5.2', displayName: 'GPT-5.2', tier: 'legacy' },
  { id: 'gpt-5.2-codex', displayName: 'Codex 5.2', tier: 'legacy' },
]

export function getAgentInfo(kind: AgentKind): AgentInfo {
  return AGENT_REGISTRY.find((a) => a.kind === kind) ?? AGENT_REGISTRY[0]
}

export function agentDisplayName(kind: AgentKind | undefined): string {
  if (!kind) return AGENT_REGISTRY[0].displayName
  return getAgentInfo(kind).displayName
}

export function supportsConversationFork(kind: AgentKind): boolean {
  return getAgentInfo(kind).supportsConversationFork
}
