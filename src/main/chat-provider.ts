// Chat tabs talk to an agent through a ChatProvider. JsonClaudeManager is
// the Claude one; each provider owns its subprocesses, its wire protocol
// and its on-disk history format, and translates everything into the
// shared jsonClaude/* events so the slice and the renderer stay
// agent-neutral.
//
// ChatRouter is what the rest of main calls. It resolves a session's
// provider from the agentKind recorded on its slice entry, so callers
// never branch on agent kind themselves. Which affordances a provider
// supports (rewind, fork, …) is declared in shared/agent-registry.ts as
// ChatCapabilities, not here, because the renderer needs it too.

import type { Store } from './store'
import type { AgentKind } from '../shared/state/terminals'
import type { JsonClaudePermissionMode } from '../shared/state/json-claude'
import { log } from './debug'

export interface RewindOutcome {
  ok: boolean
  reason?: string
}

export interface ForkOutcome {
  ok: boolean
  newSessionId?: string
  /** The agent's own id for the forked conversation, for agents that
   *  assign their own (Codex). Stored on the new tab. */
  providerSessionId?: string
  reason?: string
}

export interface ChatImageInput {
  mediaType: string
  data: string
  path: string
}

export interface ChatProvider {
  hasSession(sessionId: string): boolean
  /** Replay on-disk history into the slice before the first spawn, so a
   *  restarted app shows the scrollback. No-op when there's none. */
  seedFromTranscript(sessionId: string, worktreePath: string): void
  create(
    sessionId: string,
    worktreePath: string,
    permissionMode: JsonClaudePermissionMode,
    modelOverride?: string
  ): void
  /** Starts a turn, or injects into the running one when busy. */
  send(sessionId: string, text: string, images?: ChatImageInput[]): void
  cancelQueued(sessionId: string, entryId: string): void
  interrupt(sessionId: string): void
  kill(sessionId: string): void
  killAll(): void
  /** Only reached when the agent's ChatCapabilities.rewind is true. */
  rewindTo(sessionId: string, fromEntryId: string): RewindOutcome | Promise<RewindOutcome>
  /** Only reached when the agent's ChatCapabilities.fork is true. */
  forkAt(sourceSessionId: string, fromEntryId: string): ForkOutcome | Promise<ForkOutcome>
  /** Only reached when the agent's ChatCapabilities.permissionModes is true. */
  setPermissionMode(sessionId: string, mode: JsonClaudePermissionMode): void
}

export class ChatRouter {
  constructor(
    private store: Store,
    private providers: Partial<Record<AgentKind, ChatProvider>>
  ) {}

  agentKindOf(sessionId: string): AgentKind {
    return this.store.getSnapshot().state.jsonClaude.sessions[sessionId]?.agentKind ?? 'claude'
  }

  private providerFor(sessionId: string): ChatProvider | null {
    const kind = this.agentKindOf(sessionId)
    const provider = this.providers[kind]
    if (!provider) log('chat-router', `no chat provider for kind=${kind} sessionId=${sessionId}`)
    return provider ?? null
  }

  /** Asks every provider rather than routing, because callers check this
   *  before `sessionStarted` has recorded the session's agentKind. */
  hasSession(sessionId: string): boolean {
    return Object.values(this.providers).some((p) => p?.hasSession(sessionId))
  }

  seedFromTranscript(sessionId: string, worktreePath: string): void {
    this.providerFor(sessionId)?.seedFromTranscript(sessionId, worktreePath)
  }

  create(
    sessionId: string,
    worktreePath: string,
    permissionMode: JsonClaudePermissionMode,
    modelOverride?: string
  ): void {
    const provider = this.providerFor(sessionId)
    if (!provider) {
      this.store.dispatch({
        type: 'jsonClaude/sessionStateChanged',
        payload: {
          sessionId,
          state: 'exited',
          exitReason: `Chat isn't available for ${this.agentKindOf(sessionId)} yet`
        }
      })
      return
    }
    provider.create(sessionId, worktreePath, permissionMode, modelOverride)
  }

  send(sessionId: string, text: string, images?: ChatImageInput[]): void {
    this.providerFor(sessionId)?.send(sessionId, text, images)
  }

  cancelQueued(sessionId: string, entryId: string): void {
    this.providerFor(sessionId)?.cancelQueued(sessionId, entryId)
  }

  interrupt(sessionId: string): void {
    this.providerFor(sessionId)?.interrupt(sessionId)
  }

  kill(sessionId: string): void {
    this.providerFor(sessionId)?.kill(sessionId)
  }

  killAll(): void {
    for (const provider of Object.values(this.providers)) provider?.killAll()
  }

  async rewindTo(sessionId: string, fromEntryId: string): Promise<RewindOutcome> {
    const provider = this.providerFor(sessionId)
    if (!provider) return { ok: false, reason: 'no chat provider' }
    return provider.rewindTo(sessionId, fromEntryId)
  }

  async forkAt(sourceSessionId: string, fromEntryId: string): Promise<ForkOutcome> {
    const provider = this.providerFor(sourceSessionId)
    if (!provider) return { ok: false, reason: 'no chat provider' }
    return provider.forkAt(sourceSessionId, fromEntryId)
  }

  setPermissionMode(sessionId: string, mode: JsonClaudePermissionMode): void {
    this.providerFor(sessionId)?.setPermissionMode(sessionId, mode)
  }
}
