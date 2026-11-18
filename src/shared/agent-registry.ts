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
   * agent. Claude copies its transcript into the new worktree's project
   * dir; Codex's new chat tab runs thread/fork on the source thread at
   * boot. Either way the new worktree runs the same agent as the source. */
  supportsConversationFork: boolean
  /** Present when this agent can back a Chat tab. Absent means the agent
   *  only runs in Terminal tabs. */
  chat?: ChatCapabilities
}

/** What a Chat tab can offer for a given agent. The renderer gates
 *  affordances on these rather than on the agent kind, so a new chat
 *  provider only has to declare what it supports. */
export interface ChatCapabilities {
  /** Drop everything after a message and continue from there. */
  rewind: boolean
  /** Copy the conversation up to a message into a new tab. */
  fork: boolean
  /** Claude's permission-mode cycle (default / acceptEdits / plan / auto). */
  permissionModes: boolean
  /** Agent-advertised slash commands. */
  slashCommands: boolean
  /** The synthetic `/model` picker. Its list comes from the session's
   *  `availableModels` when the provider reports one, else CLAUDE_MODELS. */
  modelPicker: boolean
  /** A deny can carry a note the agent reads. Codex's approval reply is a
   *  bare decision, so the approval card hides the note there. */
  approvalDenyReason: boolean
  /** An approval can be answered with edited tool input ("Allow with
   *  edits"). Codex runs the command it asked about or nothing. */
  approvalEditInput: boolean
}

/** The agents with a ChatProvider in main. ChatRouter requires one per
 *  kind listed here, and agent-registry.test.ts requires this list to match
 *  the registry entries that declare `chat` — so giving an agent chat
 *  capabilities fails a test until it's listed here, and listing it fails
 *  typecheck until main registers its provider. */
export const CHAT_AGENT_KINDS = ['claude', 'codex'] as const satisfies readonly AgentKind[]
export type ChatAgentKind = (typeof CHAT_AGENT_KINDS)[number]

export const AGENT_REGISTRY: AgentInfo[] = [
  {
    kind: 'claude',
    displayName: 'Claude Code',
    vendor: 'Anthropic',
    assignsSessionId: true,
    supportsConversationFork: true,
    chat: {
      rewind: true,
      fork: true,
      permissionModes: true,
      slashCommands: true,
      modelPicker: true,
      approvalDenyReason: true,
      approvalEditInput: true
    }
  },
  {
    kind: 'codex',
    displayName: 'Codex',
    vendor: 'OpenAI',
    assignsSessionId: false,
    supportsConversationFork: true,
    chat: {
      rewind: true,
      fork: true,
      permissionModes: false,
      slashCommands: false,
      modelPicker: true,
      approvalDenyReason: false,
      approvalEditInput: false
    }
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

/** Family aliases the `claude` CLI resolves at launch. Resolution read
 *  out of the bundled binary's own `init` event (2.1.285): `opus` → Opus
 *  5.5, `sonnet` → Sonnet 5.5, `haiku` → Haiku 4.5, `fable` → Fable 5.1,
 *  `best` → Fable 5.1, `opusplan` → Opus while planning then Sonnet 5.5.
 *
 *  Whatever an alias resolves to needs a pricing entry: the resolved id
 *  is what lands in the transcript and what priceFor() bills against, so
 *  a new family version with a different cache-read multiplier silently
 *  inherits its predecessor's. See the header comment in pricing.ts.
 *
 *  Must stay within the intersection of the two CLIs Harness spawns:
 *  Terminal tabs use the user's PATH `claude`, Chat tabs use the pinned
 *  bundled one. The bundled build is the narrower of the two, so it's the
 *  binding constraint. agent-registry.test.ts enforces this; re-derive
 *  its list after bumping the pin.
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
  { id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', tier: 'current' },
  { id: 'claude-fable-5-1', displayName: 'Claude Fable 5.1', tier: 'current' },
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

export function supportsChat(kind: AgentKind | undefined): boolean {
  return !!getAgentInfo(kind ?? 'claude').chat
}

const NO_CHAT_CAPABILITIES: ChatCapabilities = {
  rewind: false,
  fork: false,
  permissionModes: false,
  slashCommands: false,
  modelPicker: false,
  approvalDenyReason: false,
  approvalEditInput: false
}

/** A missing kind means Claude — chat sessions and tabs created before
 *  `agentKind` existed were all Claude. */
export function getChatCapabilities(kind: AgentKind | undefined): ChatCapabilities {
  return getAgentInfo(kind ?? 'claude').chat ?? NO_CHAT_CAPABILITIES
}
