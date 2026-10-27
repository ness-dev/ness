import type { AgentKind } from '../../shared/state/terminals'
import * as claude from './claude'
import * as codex from './codex'
import * as cursor from './cursor'

export type { AgentKind }

export interface AgentSpawnOpts {
  command: string
  cwd: string
  sessionId?: string
  initialPrompt?: string
  teleportSessionId?: string
  sessionName?: string
  mcpConfigPath?: string | null
  model?: string | null
  systemPrompt?: string
  tuiFullscreen?: boolean
}

export interface AgentModule {
  hookEvents: string[]
  defaultCommand: string
  /** If true, Ness generates the session ID and passes it to the agent
   * CLI on first spawn (e.g. Claude's --session-id). If false, the agent
   * assigns its own ID and Ness discovers it from the first hook event. */
  assignsSessionId: boolean
  /** Install status hooks at the agent's user-scope settings file
   *  (settings.json in every Claude home a worktree resolves to — see
   *  claude-env.ts — or ~/.codex/hooks.json for Codex).
   *  The hook command is gated on $HARNESS_TERMINAL_ID so sessions spawned
   *  outside Ness are untouched. */
  installHooks(): void
  hooksInstalled(): boolean
  /** Remove only the Ness-marked entries from the user-scope settings file.
   *  Any user-authored hooks and unrelated keys survive. */
  uninstallHooks(): void
  /** Migration: strip legacy Ness entries from a single worktree's
   *  per-worktree settings file. Returns true if the file was modified. */
  stripHooksFromWorktree(worktreePath: string): boolean
  sessionFileExists(cwd: string, sessionId: string): boolean
  latestSessionId(cwd: string): string | null
  buildSpawnArgs(opts: AgentSpawnOpts): string
  /** Pull the agent-assigned session ID out of a hook event payload,
   *  or return null if this payload doesn't carry one. Keeps agent-specific
   *  field names (session_id vs conversation_id) out of shared code.
   *  Agents with `assignsSessionId: true` implement this too — an in-session
   *  reset (Claude's `/clear`) hands the conversation a new ID that Ness
   *  would otherwise never see. */
  extractSessionId?(payload: Record<string, unknown>): string | null
}

const agents: Record<AgentKind, AgentModule> = { claude, codex, cursor }

export function getAgent(kind: AgentKind): AgentModule {
  return agents[kind]
}
