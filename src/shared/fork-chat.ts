// Agent-initiated chat forking. An agent that notices a tangent mid-answer
// calls `fork_chat`, which copies its transcript so far into a new session
// and parks it. Nothing spawns until the human opens it.
//
// There is deliberately no slice backing a proposed fork. Everything the
// card needs is already durable in the parent's transcript: the topic and
// prompt are the tool_use input, the new session id is in the tool_result,
// and "has it been opened yet" is answered by the panes tree. A parallel
// record would be a second source of truth that a restart could disagree
// with, so the result text is the only carrier — hence the marker below.

import type { JsonClaudeChatEntry } from './state/json-claude'

/** Bare tool name. The wire name is MCP-prefixed; see `isForkChatTool`. */
export const FORK_TOOL_NAME = 'fork_chat'

/** How many forks may sit unopened on one conversation before the tool
 *  starts refusing. The point of a fork is that ignoring it is free, which
 *  stops being true once the header count is a chore to clear. */
export const MAX_UNOPENED_FORKS = 3

const FORK_ID_PATTERN = /\(fork id: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/

/** Matches both the `ness-control` prefix and the pre-rename
 *  `harness-control` one, for the same reason the automated-message parser
 *  accepts both: transcripts written by older builds are still on disk. */
export function isForkChatTool(name: string | undefined): boolean {
  if (!name) return false
  return (
    name === `mcp__ness-control__${FORK_TOOL_NAME}` ||
    name === `mcp__harness-control__${FORK_TOOL_NAME}`
  )
}

/** The model-facing result of a `fork_chat` call. Written by the control
 *  server rather than the bridge so the id marker is produced by the same
 *  module that parses it back out. */
export function formatForkResult(args: {
  forkSessionId: string
  topic: string
  remaining: number
}): string {
  const budget =
    args.remaining > 0
      ? `You can park ${args.remaining} more before the tool starts refusing.`
      : 'That is the last one this conversation can park until some are opened.'
  return (
    `Parked a fork of this conversation for "${args.topic}" (fork id: ${args.forkSessionId}). ` +
    'It holds everything said here so far, and its first message is queued. ' +
    'Nothing is running: it stays idle until the user opens it from the card in this chat. ' +
    `Say one line about what you noticed and carry on with the original task — do not start working on the tangent yourself. ${budget}`
  )
}

/** Recover the forked session id from a `fork_chat` tool_result. Returns
 *  null for a result that failed or predates the marker, which the card
 *  renders as a fork it can no longer open. */
export function parseForkSessionId(content: string | undefined): string | null {
  if (!content) return null
  const m = FORK_ID_PATTERN.exec(content)
  return m ? m[1] : null
}

export interface ForkChatInput {
  topic: string
  prompt: string
}

export interface ParkedFork extends ForkChatInput {
  /** tool_use id of the `fork_chat` call that parked it. */
  toolUseId: string
  forkSessionId: string
}

/** Every fork this conversation has parked, oldest first. Main counts these
 *  against the cap; the chat header counts the ones with no tab yet. Calls
 *  whose result failed or lacks the id marker are skipped — there is nothing
 *  to open. */
export function collectParkedForks(
  entries: readonly JsonClaudeChatEntry[]
): ParkedFork[] {
  const resultById = new Map<string, string>()
  for (const entry of entries) {
    if (entry.kind !== 'tool_result' || !entry.blocks) continue
    for (const b of entry.blocks) {
      if (b.type === 'tool_result' && b.toolUseId && !b.isError) {
        resultById.set(b.toolUseId, b.content || '')
      }
    }
  }
  const forks: ParkedFork[] = []
  for (const entry of entries) {
    if (!entry.blocks) continue
    for (const b of entry.blocks) {
      if (b.type !== 'tool_use' || !b.id || !isForkChatTool(b.name)) continue
      const forkSessionId = parseForkSessionId(resultById.get(b.id))
      if (!forkSessionId) continue
      forks.push({
        toolUseId: b.id,
        forkSessionId,
        ...parseForkChatInput(b.input)
      })
    }
  }
  return forks
}

/** Read the tool_use input back out, tolerating the arbitrary shape a model
 *  can produce. Both fields are required by the schema, but a malformed call
 *  should render a degraded card rather than throw inside a transcript. */
export function parseForkChatInput(
  input: Record<string, unknown> | undefined
): ForkChatInput {
  const topic = typeof input?.topic === 'string' ? input.topic.trim() : ''
  const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : ''
  return { topic: topic || 'Untitled fork', prompt }
}
