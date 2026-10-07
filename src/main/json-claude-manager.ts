// Runs `claude -p --input-format stream-json --output-format stream-json`
// as a long-lived subprocess per json-claude tab. Mirrors PtyManager's
// lifecycle shape (create / send / kill / killAll) and dispatches state
// into the jsonClaude slice so the renderer re-renders through the normal
// store path.
//
// Permissions: we pass --permission-mode default and
// --permission-prompt-tool mcp__ness-permissions__approve, where that
// MCP server is the bundled out/main/permission-prompt-mcp.js (see
// ApprovalBridge for the socket side of that).
//
// Memory isolation: Claude Code's auto-memory subsystem writes to
// ~/.claude/projects/<cwd-encoded>/memory/ by default. Running this as a
// child process would pollute the user's personal memory dir with
// conversations they didn't have in their "real" Claude Code sessions.
// We redirect that by setting CLAUDE_CONFIG_DIR to a per-session temp
// dir so all project-dir-derived reads and writes land there instead.

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { homedir } from 'os'
import { dirname, join, sep } from 'path'
import { isPackaged, resolveBundledMcpScript } from './paths'
import type { Store } from './store'
import type {
  JsonClaudeChatEntry,
  JsonClaudeImageRef,
  JsonClaudeMessageBlock,
  JsonClaudePermissionMode,
  JsonClaudeSessionState
} from '../shared/state/json-claude'
import { parseAutomatedMessage } from '../shared/state/json-claude'
import { writeResultImage } from './json-claude-attachments'
import type { ClaudeLaunchSettings } from './claude-launch'
import { log } from './debug'
import { shellQuote } from './shell-quote'
import { resolveUserShell, loginShellCommandArgs } from './user-shell'

interface JsonClaudeInstance {
  proc: ChildProcessWithoutNullStreams
  sessionId: string
  worktreePath: string
  buf: string
  /** In-flight assistant message tracked for --include-partial-messages.
   *  Cleared when the consolidated `assistant` event arrives (or the
   *  proc exits). One assistant turn at a time — claude doesn't
   *  multiplex turns through stream-json. */
  partial: PartialMessageState | null
  /** Dedup state for rate_limit_event warnings. Stream emits these on
   *  every usage update; we only surface a card when we cross the
   *  threshold from below or when the reset window changes. Tracks
   *  whether the last emitted warning was over-threshold and the
   *  resetAt that was on the most recent dispatched warning. */
  lastRateLimitWarning: { overThreshold: boolean; resetAt?: number }
}

interface PartialMessageState {
  messageId: string
  entryId: string
  pendingText: string
  pendingThinking: string
  textFlushTimer: NodeJS.Timeout | null
  thinkingFlushTimer: NodeJS.Timeout | null
  placeholderCreated: boolean
  /** When this assistant message was emitted by a sub-agent spawned via
   *  the Task tool, the tool_use id of the parent Task call. Captured at
   *  message_start so the placeholder entry created on the first
   *  content_block_start carries the field through the reducer. */
  parentToolUseId?: string
}

/** ms to coalesce text deltas before dispatching. Below ~16ms re-renders
 *  start to dominate; much higher feels laggy for actively-read text. */
const PARTIAL_TEXT_FLUSH_MS = 30
/** Thinking deltas land in a card that auto-collapses once the model
 *  moves on, so the user isn't actively reading every token; with some
 *  models thinking is summarized or hidden entirely. Throttle hard so
 *  long thinking turns don't pin CPU re-rendering text the user can't
 *  see. 4Hz still feels live if the card is expanded. */
const PARTIAL_THINKING_FLUSH_MS = 250

export interface JsonClaudeControlServerInfo {
  port: number
  token: string
}

export interface JsonClaudeCallerScope {
  worktreePath: string
  repoRoot: string
  isMain: boolean
}

export interface JsonClaudeManagerOptions {
  getClaudeCommand: () => string
  /** When true, json-mode tabs spawn the user's PATH `claude` (the
   *  pre-bundling behavior) instead of the bundled native binary.
   *  Diagnostic toggle wired to settings.useSystemClaudeForJsonMode —
   *  no UI, defaults false. */
  getUseSystemClaude: () => boolean
  getApprovalSocketPath: (sessionId: string) => string
  closeApprovalSession: (sessionId: string) => void
  getClaudeEnvVars: () => Record<string, string>
  /** Looked up from main when building the inline MCP config. Returning
   *  null means the ness-control bridge isn't injected (settings flag
   *  off, or control server not yet up). */
  getControlServer: () => JsonClaudeControlServerInfo | null
  /** Returns the bundled ness-control bridge script path. Lives in
   *  resources/ same as permission-prompt-mcp.js — index.ts already
   *  knows how to resolve it via getBridgeScriptPath(). */
  getControlBridgeScriptPath: () => string
  /** True when the user has disabled the ness-control MCP via
   *  settings.harnessMcpEnabled. Skips the bridge entry entirely. */
  isHarnessMcpEnabled: () => boolean
  /** Looks up scope (worktree + repo + isMain) for a given session id.
   *  Mirrors resolveCallerScope() in index.ts but only needs the
   *  worktree/repo bits, not the terminalId echo. */
  getCallerScope: (sessionId: string) => JsonClaudeCallerScope | null
  /** Resolves the Claude launch flags (--append-system-prompt, --model,
   *  --name) at spawn time from the live config + worktree list. Same
   *  source of truth as the xterm spawn path; see buildClaudeLaunchSettings
   *  in claude-launch.ts. */
  getLaunchSettings: (worktreePath: string, modelOverride?: string) => ClaudeLaunchSettings
}

/** Resolves the bundled @anthropic-ai/claude-code native binary by going
 *  through the platform-specific subpackage. The wrapper package's
 *  postinstall hardlinks the platform binary into bin/claude.exe, but
 *  electron-builder dedups hardlinks during asar packing — only one
 *  copy survives. Resolving via the platform subpackage's own file
 *  works identically in dev and packaged. Mirrors the platform
 *  detection in install.cjs / cli-wrapper.cjs. The dynamic-require
 *  pattern matches paths.ts's electron lookup: keeps the bundler from
 *  resolving the module statically. */
const PLATFORM_PACKAGES: Record<string, { pkg: string; bin: string }> = {
  'darwin-arm64': { pkg: '@anthropic-ai/claude-code-darwin-arm64', bin: 'claude' },
  'darwin-x64': { pkg: '@anthropic-ai/claude-code-darwin-x64', bin: 'claude' },
  'linux-x64': { pkg: '@anthropic-ai/claude-code-linux-x64', bin: 'claude' },
  'linux-arm64': { pkg: '@anthropic-ai/claude-code-linux-arm64', bin: 'claude' },
  'linux-x64-musl': { pkg: '@anthropic-ai/claude-code-linux-x64-musl', bin: 'claude' },
  'linux-arm64-musl': { pkg: '@anthropic-ai/claude-code-linux-arm64-musl', bin: 'claude' },
  'win32-x64': { pkg: '@anthropic-ai/claude-code-win32-x64', bin: 'claude.exe' },
  'win32-arm64': { pkg: '@anthropic-ai/claude-code-win32-arm64', bin: 'claude.exe' }
}

function detectMusl(): boolean {
  if (process.platform !== 'linux') return false
  const report =
    typeof process.report?.getReport === 'function' ? process.report.getReport() : null
  // glibc reports a runtime version; musl doesn't. Same heuristic install.cjs uses.
  return report != null && (report as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime === undefined
}

function platformKey(): string {
  if (process.platform === 'linux') {
    return `linux-${process.arch}${detectMusl() ? '-musl' : ''}`
  }
  return `${process.platform}-${process.arch}`
}

let cachedBundledClaudeBinPath: string | null = null
export function bundledClaudeBinPath(): string {
  if (cachedBundledClaudeBinPath) return cachedBundledClaudeBinPath
  const info = PLATFORM_PACKAGES[platformKey()]
  if (!info) {
    throw new Error(
      `bundled claude-code: unsupported platform ${platformKey()}; supported: ${Object.keys(PLATFORM_PACKAGES).join(', ')}`
    )
  }
  const dynamicRequire = createRequire(__filename)
  const pkgPath = dynamicRequire.resolve(`${info.pkg}/package.json`)
  // In packaged builds the resolved path lives inside app.asar (where the
  // package.json is readable via Electron's asar shim), but spawn() goes
  // through the OS and asar isn't a real directory — ENOTDIR. The actual
  // binary is extracted to app.asar.unpacked/ via the asarUnpack config.
  cachedBundledClaudeBinPath = join(dirname(pkgPath), info.bin).replace(
    `${sep}app.asar${sep}`,
    `${sep}app.asar.unpacked${sep}`
  )
  return cachedBundledClaudeBinPath
}


function transcriptPathFor(sessionId: string, worktreePath: string): string {
  return join(
    homedir(),
    '.claude',
    'projects',
    worktreePath.replace(/[^a-zA-Z0-9]/g, '-'),
    `${sessionId}.jsonl`
  )
}

/** Whether this session has a transcript on disk that `forkTranscript`
 *  could copy. False for terminal-tab ids (which aren't session ids at all)
 *  and for chat tabs that haven't produced a turn yet — lets the MCP path
 *  reject a fork request up front instead of returning success and handing
 *  the caller an empty chat. */
export function hasForkableTranscript(sessionId: string, worktreePath: string): boolean {
  return existsSync(transcriptPathFor(sessionId, worktreePath))
}

export interface RewindOutcome {
  ok: boolean
  reason?: string
}

export interface ForkOutcome {
  ok: boolean
  newSessionId?: string
  reason?: string
}

export interface ForkTranscriptParams {
  sourceSessionId: string
  sourceWorktreePath: string
  /** Where the forked transcript should live. Pass the same value as
   *  `sourceWorktreePath` for an in-place fork. */
  destWorktreePath: string
  /** Cut the copy after the LAST jsonl line whose inner `message.id`
   *  matches. Omit to copy the whole transcript. */
  throughApiMessageId?: string
}

/** Copy a session's transcript into a new jsonl under a fresh session id,
 *  optionally truncating at an assistant message and optionally landing it
 *  in a different worktree's project dir. The source is untouched — no
 *  kill, no truncation, no slice mutation. Callers wire up the new tab;
 *  the CLI's `--resume` path (which keys off the file existing at
 *  `<destWorktreePath>`'s encoded project dir) does the rest.
 *
 *  Why we rewrite the `sessionId` field on each kept line: the CLI
 *  reads/writes `~/.claude/projects/<dir>/<sessionId>.jsonl` keyed by
 *  the filename, but every jsonl line ALSO carries its own `sessionId`
 *  field. On --resume the CLI appends further lines stamped with the
 *  filename's session id, so if the copied prefix keeps the source id,
 *  the resulting file is a hybrid where the first N lines disagree with
 *  the last M — some tooling (and the CLI's own auto-memory subsystem)
 *  key off the inner id. Rewriting keeps filename and record consistent.
 *
 *  The per-line `cwd` / `gitBranch` fields are deliberately NOT rewritten
 *  on a cross-worktree fork. The CLI binds cwd from the spawned process,
 *  not from the transcript, so they're historical metadata — and leaving
 *  them accurate keeps the record of where each turn actually happened.
 *  The resumed agent is told about the move via a relocation preamble
 *  prepended to its kickoff prompt (see fork-relocation.ts).
 *
 *  Same jsonl-scan shape as truncateTranscriptAfterMessage: one assistant
 *  API turn can span several jsonl lines (thinking, tool_use, text) all
 *  sharing the message.id, so we cut after the LAST line carrying it. */
export function forkTranscript(params: ForkTranscriptParams): ForkOutcome {
  const { sourceSessionId, sourceWorktreePath, destWorktreePath, throughApiMessageId } = params
  const newSessionId = randomUUID()
  const sourcePath = transcriptPathFor(sourceSessionId, sourceWorktreePath)
  if (!existsSync(sourcePath)) {
    return { ok: false, reason: 'source transcript missing' }
  }

  let raw: string
  try {
    raw = readFileSync(sourcePath, 'utf8')
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    log('json-claude', `fork read failed sessionId=${sourceSessionId}`, reason)
    return { ok: false, reason }
  }

  const lines = raw.split('\n')
  let lastKeptIdx = lines.length - 1
  if (throughApiMessageId) {
    let lastMatchIdx = -1
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (parsed['type'] !== 'assistant') continue
      const inner = parsed['message'] as { id?: unknown } | undefined
      if (typeof inner?.id === 'string' && inner.id === throughApiMessageId) {
        lastMatchIdx = i
      }
    }
    if (lastMatchIdx === -1) {
      log(
        'json-claude',
        `fork: no jsonl line matched apiMessageId=${throughApiMessageId} sessionId=${sourceSessionId}`
      )
      return { ok: false, reason: 'no matching jsonl record' }
    }
    lastKeptIdx = lastMatchIdx
  }

  const rewritten: string[] = []
  for (let i = 0; i <= lastKeptIdx; i++) {
    const trimmed = lines[i].trim()
    if (!trimmed) continue
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if ('sessionId' in parsed) parsed['sessionId'] = newSessionId
    rewritten.push(JSON.stringify(parsed))
  }
  const body = rewritten.length > 0 ? rewritten.join('\n') + '\n' : ''

  const destPath = transcriptPathFor(newSessionId, destWorktreePath)
  const tmpPath = `${destPath}.fork-${Date.now()}.tmp`
  try {
    // A brand-new worktree has no project dir yet — the in-place fork
    // never had to create one because the source dir always existed.
    mkdirSync(dirname(destPath), { recursive: true })
    writeFileSync(tmpPath, body, 'utf8')
    renameSync(tmpPath, destPath)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    log('json-claude', `fork write failed sessionId=${newSessionId}`, reason)
    return { ok: false, reason }
  }
  log(
    'json-claude',
    `fork wrote sessionId=${newSessionId} from=${sourceSessionId} keptLines=${rewritten.length} dest=${destWorktreePath}`
  )
  return { ok: true, newSessionId }
}

export class JsonClaudeManager {
  private instances = new Map<string, JsonClaudeInstance>()
  private store: Store
  private opts: JsonClaudeManagerOptions
  /** Per-cwd slash command list, sourced from a one-shot probe (see
   *  probeSlashCommands). Cached because the list is stable across
   *  sessions in the same worktree — it depends on the user's installed
   *  Skills + plugin commands + project-local `.claude/commands/*.md`,
   *  none of which change during normal use. */
  private slashCommandsByCwd = new Map<string, string[]>()
  /** Inflight probes per cwd so concurrent create() calls share one. */
  private probeInflightByCwd = new Map<string, Promise<string[]>>()
  /** Per-session chat-entry sequence. Keyed by sessionId rather than held
   *  on the instance because a sleep/wake kills the instance while the
   *  slice keeps its entries — restarting at 0 would mint an entryId that
   *  already exists, and React drops the duplicate-keyed row, so the first
   *  message after a wake would silently never render. */
  private entrySeqBySession = new Map<string, number>()

  constructor(store: Store, opts: JsonClaudeManagerOptions) {
    this.store = store
    this.opts = opts
  }

  hasSession(sessionId: string): boolean {
    return this.instances.has(sessionId)
  }

  /** Mint the next chat entry id for a session. `kind` distinguishes the
   *  producers (user / queued user / assistant / control) but the sequence
   *  is shared, so ids are unique across an entire session lifetime
   *  including respawns. */
  private nextEntryId(sessionId: string, kind: 'u' | 'uq' | 'a' | 'c'): string {
    const n = (this.entrySeqBySession.get(sessionId) ?? 0) + 1
    this.entrySeqBySession.set(sessionId, n)
    return `${sessionId}-${kind}-${n}`
  }

  /** Replay the on-disk session jsonl into the slice as chat entries.
   *  Called from the jsonClaude:start IPC handler before spawning the
   *  subprocess. Without this, --resume restores Claude's context but
   *  the renderer's chat scrollback is empty after a full app restart.
   *  No-op if the jsonl doesn't exist yet (first turn) or the session
   *  already has entries (renderer reload — main's slice survived). */
  seedFromTranscript(sessionId: string, worktreePath: string): void {
    const session =
      this.store.getSnapshot().state.jsonClaude.sessions[sessionId]
    if (session && session.entries.length > 0) return

    const seededEntries = this.parseTranscriptEntries(sessionId, worktreePath)
    if (seededEntries.length === 0) return
    const compactCount = seededEntries.filter((e) => e.kind === 'compact').length
    log(
      'json-claude',
      `seed dispatch sessionId=${sessionId} total=${seededEntries.length} compact=${compactCount}`
    )
    this.store.dispatch({
      type: 'jsonClaude/entriesSeeded',
      payload: { sessionId, entries: seededEntries }
    })
  }

  /** Pure parser — reads the on-disk jsonl and returns the slice
   *  entries it should produce. Used by `seedFromTranscript` and by
   *  `rewindTo` (after truncating the jsonl, to force-reseed the slice
   *  with the truncated transcript as the authoritative source). No
   *  store interaction. Returns an empty array on read errors so the
   *  caller can decide how to handle. */
  private parseTranscriptEntries(
    sessionId: string,
    worktreePath: string
  ): JsonClaudeChatEntry[] {
    const transcriptPath = transcriptPathFor(sessionId, worktreePath)
    if (!existsSync(transcriptPath)) return []

    let counter = 0
    let raw: string
    try {
      raw = readFileSync(transcriptPath, 'utf8')
    } catch (err) {
      log(
        'json-claude',
        `transcript read failed sessionId=${sessionId}`,
        err instanceof Error ? err.message : String(err)
      )
      return []
    }
    const seededEntries: JsonClaudeChatEntry[] = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        continue
      }
      const type = parsed['type']
      // The session jsonl contains the same user/assistant message
      // shapes the live stream emits, plus internal bookkeeping types
      // (queue-operation, attachment, ai-title, last-prompt) we ignore.
      const transcriptUuid =
        typeof parsed['uuid'] === 'string' ? (parsed['uuid'] as string) : undefined
      if (type === 'user') {
        // Skip SDK-synthetic user records that surround compactions and
        // slash-command invocations. Without this filter the seeded
        // scrollback shows the entire continuation summary as a giant
        // user bubble plus stray '<local-command-stdout>Compacted'
        // and '<command-name>/compact' echo lines.
        //   isCompactSummary  — the post-compaction continuation summary
        //   isMeta            — the '<local-command-caveat>' wrapper
        // Plus content-prefix matches for the local-command echo pair
        // ('<command-name>' / '<local-command-stdout>') which arrive
        // without isMeta but are equally not user-typed input.
        if (parsed['isCompactSummary'] === true) continue
        if (parsed['isMeta'] === true) continue
        const message = parsed['message'] as { content?: unknown } | undefined
        const content = message?.content
        if (typeof content === 'string') {
          if (
            content.startsWith('<command-name>') ||
            content.startsWith('<local-command-stdout>')
          ) {
            continue
          }
          const automated = parseAutomatedMessage(content)
          seededEntries.push({
            kind: 'user',
            text: automated ? automated.body : content,
            timestamp: Date.now(),
            entryId: `${sessionId}-seed-u-${counter++}`,
            ...(automated ? { automation: automated.source } : {}),
            ...(automated?.from ? { automationFrom: automated.from } : {}),
            ...(transcriptUuid ? { transcriptUuid } : {})
          })
        } else if (Array.isArray(content)) {
          for (const r of extractToolResultsFromArray(content)) {
            seededEntries.push({
              entryId: `${sessionId}-tr-${r.toolUseId}-${seededEntries.length}`,
              kind: 'tool_result',
              timestamp: Date.now(),
              ...(transcriptUuid ? { transcriptUuid } : {}),
              blocks: [
                {
                  type: 'tool_result',
                  toolUseId: r.toolUseId,
                  content: r.content,
                  isError: r.isError,
                  ...(r.images ? { images: r.images } : {})
                }
              ]
            })
          }
        }
      } else if (type === 'assistant') {
        const blocks = extractAssistantBlocks(parsed)
        if (blocks.length === 0) continue
        // Same envelope shape as the live stream — parent_tool_use_id
        // is at the top level of the record, not on the inner message.
        const parentToolUseId =
          typeof parsed['parent_tool_use_id'] === 'string'
            ? (parsed['parent_tool_use_id'] as string)
            : undefined
        const innerMessage = parsed['message'] as { id?: unknown } | undefined
        const apiMessageId =
          typeof innerMessage?.id === 'string'
            ? (innerMessage.id as string)
            : undefined
        seededEntries.push({
          kind: 'assistant',
          blocks,
          timestamp: Date.now(),
          entryId: `${sessionId}-seed-a-${counter++}`,
          ...(transcriptUuid ? { transcriptUuid } : {}),
          ...(apiMessageId ? { apiMessageId } : {}),
          ...(parentToolUseId ? { parentToolUseId } : {})
        })
      } else if (type === 'attachment') {
        // Mid-turn interjections are the one kind of user input claude
        // does NOT write as a `user` record: they land as an attachment
        // of type 'queued_command', positioned at the agent-loop
        // boundary where claude drained them (its `timestamp` field is
        // still the moment the user hit enter). Without this branch a
        // reload silently dropped every message the user sent while the
        // agent was working. Every other attachment subtype is internal
        // bookkeeping (token reminders, tool/agent listing deltas) and
        // stays ignored.
        const attachment = parsed['attachment'] as
          | { type?: unknown; prompt?: unknown }
          | undefined
        if (attachment?.type !== 'queued_command') continue
        const prompt = attachment.prompt
        if (typeof prompt !== 'string' || prompt.length === 0) continue
        const automated = parseAutomatedMessage(prompt)
        seededEntries.push({
          kind: 'user',
          text: automated ? automated.body : prompt,
          timestamp: Date.now(),
          entryId: `${sessionId}-seed-u-${counter++}`,
          ...(automated ? { automation: automated.source } : {}),
          ...(automated?.from ? { automationFrom: automated.from } : {}),
          ...(transcriptUuid ? { transcriptUuid } : {})
        })
      } else if (type === 'system' && parsed['subtype'] === 'compact_boundary') {
        const meta = parsed['compactMetadata'] as
          | { trigger?: unknown; preTokens?: unknown; postTokens?: unknown }
          | undefined
        const trigger =
          meta?.trigger === 'auto' || meta?.trigger === 'manual'
            ? meta.trigger
            : undefined
        const preTokens =
          typeof meta?.preTokens === 'number' ? meta.preTokens : undefined
        const postTokens =
          typeof meta?.postTokens === 'number' ? meta.postTokens : undefined
        seededEntries.push({
          kind: 'compact',
          timestamp: Date.now(),
          entryId: `${sessionId}-seed-c-${counter++}`,
          ...(transcriptUuid ? { transcriptUuid } : {}),
          ...(trigger ? { compactTrigger: trigger } : {}),
          ...(typeof preTokens === 'number'
            ? { compactPreTokens: preTokens }
            : {}),
          ...(typeof postTokens === 'number'
            ? { compactPostTokens: postTokens }
            : {})
        })
      }
    }
    return seededEntries
  }

  create(
    sessionId: string,
    worktreePath: string,
    permissionMode: JsonClaudePermissionMode = 'default',
    modelOverride?: string
  ): void {
    if (this.instances.has(sessionId)) {
      log('json-claude', `create no-op — already running sessionId=${sessionId}`)
      return
    }
    // Pre-flight cwd check. Node's child_process.spawn reports a missing
    // cwd as ENOENT against the executable path — a confusing surface,
    // and the failure lands in the async 'error' event where every
    // downstream write to stdin (etc.) would throw. Cheaper and clearer
    // to fail here with a directed error card.
    if (!existsSync(worktreePath)) {
      const reason = `Worktree directory no longer exists on disk: ${worktreePath}`
      log('json-claude', `create cwd missing sessionId=${sessionId} cwd=${worktreePath}`)
      this.dispatchState(sessionId, 'exited', { exitReason: reason })
      this.dispatchSpawnFailedEntry(sessionId, reason)
      this.opts.closeApprovalSession(sessionId)
      return
    }
    log('json-claude', `create begin sessionId=${sessionId} mode=${permissionMode}`)
    const socketPath = this.opts.getApprovalSocketPath(sessionId)

    // MCP config — two stdio servers, both spawned via
    // ELECTRON_RUN_AS_NODE=1 against the Electron binary so we don't
    // need a separate Node install in packaged builds.
    //   * ness-permissions: receives the per-tool approval requests
    //     Claude raises via --permission-prompt-tool. Tool is 'approve'.
    //   * ness-control: the same MCP bridge used by xterm-backed
    //     Claude tabs, exposing ness-control tools (worktree mgmt,
    //     browser tabs, shell tabs, etc.). Skipped when settings has
    //     harnessMcpEnabled=false or the control server isn't up.
    const mcpServers: Record<
      string,
      { command: string; args: string[]; env: Record<string, string> }
    > = {
      'ness-permissions': {
        command: process.execPath,
        args: [resolveBundledMcpScript('permission-prompt-mcp.js')],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          HARNESS_APPROVAL_SOCKET: socketPath,
          HARNESS_JSON_CLAUDE_SESSION_ID: sessionId
        }
      }
    }
    if (this.opts.isHarnessMcpEnabled()) {
      const controlInfo = this.opts.getControlServer()
      if (controlInfo) {
        const scope = this.opts.getCallerScope(sessionId)
        const controlEnv: Record<string, string> = {
          ELECTRON_RUN_AS_NODE: '1',
          HARNESS_PORT: String(controlInfo.port),
          HARNESS_TOKEN: controlInfo.token,
          // The bridge keys every control-server call by terminal id —
          // for json-claude tabs the tab id IS the session id.
          HARNESS_TERMINAL_ID: sessionId,
          HARNESS_SESSION_ID: sessionId
        }
        if (scope) {
          controlEnv.HARNESS_WORKTREE_ID = scope.worktreePath
          controlEnv.HARNESS_REPO_ROOT = scope.repoRoot
          if (scope.isMain) controlEnv.HARNESS_IS_MAIN = '1'
        }
        mcpServers['ness-control'] = {
          command: process.execPath,
          args: [this.opts.getControlBridgeScriptPath()],
          env: controlEnv
        }
      }
    }
    const mcpConfig = { mcpServers }

    const useSystemClaude = this.opts.getUseSystemClaude()
    const claudeCommand = this.opts.getClaudeCommand() || 'claude'
    const existingSession = existsSync(transcriptPathFor(sessionId, worktreePath))
    const resumeOrSet = existingSession
      ? ['--resume', sessionId]
      : ['--session-id', sessionId]

    const launchSettings = this.opts.getLaunchSettings(worktreePath, modelOverride)
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--permission-mode',
      permissionMode,
      '--permission-prompt-tool',
      'mcp__ness-permissions__approve',
      '--mcp-config',
      JSON.stringify(mcpConfig),
      ...resumeOrSet
    ]
    if (launchSettings.systemPrompt) {
      args.push('--append-system-prompt', launchSettings.systemPrompt)
    }
    // The bundled binary doesn't see the user's claudeCommand string, so
    // their --model override there can't apply. Honor launchSettings.model
    // unconditionally in that path. For the system path we keep the prior
    // behavior of yielding to a --model in the user's claudeCommand.
    if (
      launchSettings.model &&
      (useSystemClaude ? !claudeCommand.includes('--model') : true)
    ) {
      args.push('--model', launchSettings.model)
    }
    if (launchSettings.sessionName) {
      args.push('--name', launchSettings.sessionName)
    }

    log(
      'json-claude',
      `spawn sessionId=${sessionId} cwd=${worktreePath} mode=${permissionMode} bundled=${!useSystemClaude}`
    )

    const envVars = this.opts.getClaudeEnvVars() || {}
    // Build env for the subprocess. We start from process.env, scrub
    // env vars that the user-scope Ness hooks key off of so the
    // subprocess's hook firings don't masquerade as the parent agent
    // tab, then layer on json-claude-specific vars.
    const childEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') childEnv[k] = v
    }
    delete childEnv.CLAUDE_HARNESS_ID
    delete childEnv.HARNESS_TERMINAL_ID
    const spawnEnv = {
      ...childEnv,
      ...envVars,
      // Memory isolation: the auto-memory subsystem writes into
      // ~/.claude/projects/<project>/memory/ by default, which
      // means json-claude sessions would scribble into the user's
      // personal memory dir for whatever project their worktree
      // belongs to. This env var skips that path entirely. Session
      // jsonls still persist (needed for --resume), they just land
      // in projects/<project>/ without a sibling memory/ dir.
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      // So our bundled MCP server can identify its parent session
      // when it opens the approval socket.
      HARNESS_JSON_CLAUDE_SESSION_ID: sessionId
    }
    let proc: ChildProcessWithoutNullStreams
    try {
      if (useSystemClaude) {
        // Diagnostic path: same login-shell wrapping PtyManager uses for
        // classic Claude tabs so the user's PATH (Homebrew, nvm, etc.) is
        // available. POSIX single-quote escaping because the system
        // prompt contains backticks that would be command-substituted
        // inside JSON.stringify's double quotes.
        const quoted = args.map(shellQuote).join(' ')
        const cmdLine = `${claudeCommand} ${quoted}`
        proc = spawn(resolveUserShell(), loginShellCommandArgs(cmdLine), {
          cwd: worktreePath,
          env: spawnEnv,
          stdio: ['pipe', 'pipe', 'pipe']
        })
      } else {
        proc = spawn(bundledClaudeBinPath(), args, {
          cwd: worktreePath,
          env: spawnEnv,
          stdio: ['pipe', 'pipe', 'pipe']
        })
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      log('json-claude', `spawn failed sessionId=${sessionId}`, reason)
      this.dispatchState(sessionId, 'exited', { exitReason: reason })
      this.dispatchSpawnFailedEntry(sessionId, reason)
      this.opts.closeApprovalSession(sessionId)
      return
    }

    const instance: JsonClaudeInstance = {
      proc,
      sessionId,
      worktreePath,
      buf: '',
      partial: null,
      lastRateLimitWarning: { overThreshold: false }
    }
    this.instances.set(sessionId, instance)
    log('json-claude', `create spawned sessionId=${sessionId} pid=${proc.pid ?? '?'} → running`)
    this.dispatchState(sessionId, 'running')

    // Debug for issue #167: distinguish "spawn() returned a pid but execv
    // failed" (error event) from "child actually started executing"
    // (spawn event). Without this we only log the pre-spawn pid.
    proc.once('spawn', () => {
      log('json-claude', `claude spawn complete sessionId=${sessionId} pid=${proc.pid ?? '?'}`)
    })
    proc.once('error', (err) => {
      const reason = err.message
      log('json-claude', `claude spawn error sessionId=${sessionId}`, reason)
      // Stale-error guard mirrors the exit handler: a kill()+create()
      // cycle can register a fresh instance before this async event
      // fires. Bail so we don't clobber the replacement.
      if (this.instances.get(sessionId) !== instance) return
      // Removing the instance from the map before dispatching means the
      // subsequent 'exit' event's stale-instance guard will bail — we
      // only surface one card, not two.
      this.instances.delete(sessionId)
      this.clearPartial(instance)
      this.dispatchState(sessionId, 'exited', { exitReason: reason })
      this.dispatchSpawnFailedEntry(sessionId, reason)
      this.dispatchBusy(sessionId, false)
      this.opts.closeApprovalSession(sessionId)
      // Best-effort: unhook streams so buffered stdin/stdout writes
      // (typically none, but just in case) don't throw on the dead pipe.
      try { proc.stdin.destroy() } catch { /* ignore */ }
      try { proc.stdout.destroy() } catch { /* ignore */ }
      try { proc.stderr.destroy() } catch { /* ignore */ }
    })

    // Kick a slash-command probe in the background. Result populates the
    // slice so the autocomplete popover can render before the user sends
    // their first turn (the real session's init won't fire until then).
    void this.ensureSlashCommandsForCwd(worktreePath).then((list) => {
      if (list.length === 0) return
      // Guard: the session may have been killed between probe start and
      // probe finish.
      const live = this.store.getSnapshot().state.jsonClaude.sessions[sessionId]
      if (!live) return
      this.store.dispatch({
        type: 'jsonClaude/slashCommandsChanged',
        payload: { sessionId, slashCommands: list }
      })
    })

    proc.stdout.on('data', (chunk: Buffer) => {
      instance.buf += chunk.toString('utf8')
      let idx: number
      while ((idx = instance.buf.indexOf('\n')) >= 0) {
        const line = instance.buf.slice(0, idx).trim()
        instance.buf = instance.buf.slice(idx + 1)
        if (!line) continue
        this.handleStreamLine(instance, line)
      }
    })

    // Line-buffered stderr so each --mcp-debug message lands intact in
    // debug.log. The prior per-chunk 200-char slice cut MCP debug lines
    // in half (issue #167 instrumentation).
    let stderrBuf = ''
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8')
      let idx: number
      while ((idx = stderrBuf.indexOf('\n')) >= 0) {
        const line = stderrBuf.slice(0, idx).replace(/\r$/, '')
        stderrBuf = stderrBuf.slice(idx + 1)
        if (line) log('json-claude', `stderr sessionId=${sessionId}: ${line}`)
      }
    })

    proc.on('exit', (code, signal) => {
      log(
        'json-claude',
        `exit sessionId=${sessionId} code=${code} signal=${signal} pid=${proc.pid ?? '?'}`
      )
      // Stale-exit guard: SIGTERM is async, so a kill() + create() cycle
      // on the same sessionId (e.g. tab-type swap, Reconnect button)
      // can register a fresh instance before the old process's exit
      // event lands. Without this check, the late exit would mark the
      // freshly-started session 'exited' and close its approval socket.
      if (this.instances.get(sessionId) !== instance) {
        log('json-claude', `exit guard bailed — stale instance sessionId=${sessionId}`)
        return
      }
      this.clearPartial(instance)
      const exitReason = signal
        ? `signal ${signal}`
        : code === 0
          ? 'clean'
          : `exit ${code}`
      this.dispatchState(sessionId, 'exited', {
        exitCode: code,
        exitReason
      })
      this.dispatchSubprocessExitEntry(sessionId, exitReason)
      this.dispatchBusy(sessionId, false)
      this.instances.delete(sessionId)
      this.opts.closeApprovalSession(sessionId)
    })
  }

  send(
    sessionId: string,
    text: string,
    images?: Array<{ mediaType: string; data: string; path: string }>
  ): void {
    const inst = this.instances.get(sessionId)
    if (!inst) return
    // Mid-turn injection: if a turn is already in flight, append the
    // user entry tagged isQueued (so the user sees their message land,
    // with a cancel affordance) and write to stdin immediately.
    // Claude's stream-json input buffers between agent-loop steps, so
    // the message gets injected at the next safe boundary (typically
    // post-tool_result) within the current turn — matching the TUI's
    // interject-while-busy behavior.
    //
    // The entry starts out wherever the user hit enter, which is
    // mid-stream of whatever claude was already saying. When claude
    // drains its input queue into the next request (the `system/status:
    // requesting` branch in handleLine) the entry both loses isQueued
    // and moves to the tail — its real position in the conversation,
    // just before the response that considers it.
    const session =
      this.store.getSnapshot().state.jsonClaude.sessions[sessionId]
    if (session?.busy) {
      this.appendUserEntry(inst, text, images, {
        entryId: this.nextEntryId(sessionId, 'uq'),
        isQueued: true
      })
      this.writeUserStdin(inst, text, images)
      return
    }
    this.writeUserTurn(inst, text, images)
  }

  /** Internal: push a fresh user turn to the subprocess + slice. The
   *  busy/queue gate above this is the only place that should decide
   *  whether a message goes through here vs. the mid-turn injection
   *  path. */
  private writeUserTurn(
    inst: JsonClaudeInstance,
    text: string,
    images?: Array<{ mediaType: string; data: string; path: string }>
  ): void {
    this.appendUserEntry(inst, text, images, {
      entryId: this.nextEntryId(inst.sessionId, 'u')
    })
    this.dispatchBusy(inst.sessionId, true)
    this.writeUserStdin(inst, text, images)
  }

  /** Append a user entry to the slice. Path-only image refs (no bytes)
   *  so the renderer can fetch each for thumbnail rendering without
   *  bloating the state event. */
  private appendUserEntry(
    inst: JsonClaudeInstance,
    text: string,
    images:
      | Array<{ mediaType: string; data: string; path: string }>
      | undefined,
    extra: { entryId: string; isQueued?: boolean }
  ): void {
    const hasImages = !!images && images.length > 0
    // The sentinel is for claude's benefit on the wire; the slice keeps the
    // stripped body plus a flag so the renderer can style the bubble.
    const automated = parseAutomatedMessage(text)
    this.appendEntry(inst, {
      kind: 'user',
      text: automated ? automated.body : text,
      timestamp: Date.now(),
      entryId: extra.entryId,
      ...(automated ? { automation: automated.source } : {}),
      ...(automated?.from ? { automationFrom: automated.from } : {}),
      ...(extra.isQueued ? { isQueued: true } : {}),
      ...(hasImages
        ? {
            images: images!
              .filter((img) => img.path.length > 0)
              .map((img) => ({ path: img.path, mediaType: img.mediaType }))
          }
        : {})
    })
  }

  /** Write a `{type:'user', message:{role,content}}` frame to claude's
   *  stdin, building a multi-block content array when images are
   *  attached. The Anthropic Messages API (which claude -p stream-json
   *  proxies) expects:
   *    [{type:'text', text}, {type:'image', source:{type:'base64',
   *      media_type, data}}]
   *  String content stays the wire shape when there are no images so
   *  we don't change the format for the most common path. We also
   *  annotate the text block with a "(image attached at <path>)" line
   *  per image so Claude has both the inline pixels (for instant
   *  recognition) and an on-disk path (for Read/Bash/Write tool calls
   *  — moving, transforming, copying). */
  private writeUserStdin(
    inst: JsonClaudeInstance,
    text: string,
    images?: Array<{ mediaType: string; data: string; path: string }>
  ): void {
    const hasImages = !!images && images.length > 0
    const annotatedText = hasImages
      ? [
          text,
          ...images!
            .filter((img) => img.path.length > 0)
            .map((img) => `(image attached at ${img.path})`)
        ]
          .filter((s) => s.length > 0)
          .join('\n')
      : text
    const content: unknown = hasImages
      ? [
          ...(annotatedText ? [{ type: 'text', text: annotatedText }] : []),
          ...images!.map((img) => ({
            type: 'image',
            source: {
              type: 'base64',
              media_type: img.mediaType,
              data: img.data
            }
          }))
        ]
      : text
    const payload = {
      type: 'user',
      message: { role: 'user', content }
    }
    try {
      inst.proc.stdin.write(JSON.stringify(payload) + '\n')
    } catch (err) {
      log(
        'json-claude',
        `stdin write failed sessionId=${inst.sessionId}`,
        err instanceof Error ? err.message : String(err)
      )
    }
  }

  /** Clear the dashed/queued styling on every in-flight queued entry of
   *  a session. Guarded on there actually being one: the reducer no-ops
   *  when nothing is queued, but the dispatch would still fan out an
   *  IPC broadcast to every renderer, and the caller on the hot path
   *  (`system/status: requesting`) fires on every API request. */
  private unqueueUserEntries(sessionId: string): void {
    const session = this.store.getSnapshot().state.jsonClaude.sessions[sessionId]
    if (!session?.entries.some((e) => e.isQueued)) return
    this.store.dispatch({
      type: 'jsonClaude/userEntriesUnqueued',
      payload: { sessionId }
    })
  }

  /** Remove a queued user entry from the renderer view. NOTE: the
   *  message text is already in claude's stdin buffer by the time the
   *  user clicks cancel, so this is UI-only — claude will still
   *  process the message on the next agent-loop step. The promoted
   *  entry never gets re-added because unqueuing only touches entries
   *  still in the list. On reload, however, the message comes back:
   *  claude logged it to session.jsonl as a queued_command attachment,
   *  which parseTranscriptEntries seeds. */
  cancelQueued(sessionId: string, entryId: string): void {
    this.store.dispatch({
      type: 'jsonClaude/entryRemoved',
      payload: { sessionId, entryId }
    })
  }

  /** Send a stdin control_request that aborts the current turn while
   *  keeping the subprocess alive. SIGINT was the spike's first guess
   *  but it tears the whole session down; the actual protocol — found
   *  by reading the binary — is:
   *    {type: "control_request", request_id: <uuid>,
   *     request: {subtype: "interrupt"}}
   *  Claude's handler hits b.abortController.abort() on receipt, which
   *  cancels mid-turn without exiting. The partial turn is still
   *  captured in the session jsonl, so --resume picks up cleanly. */
  interrupt(sessionId: string): void {
    const inst = this.instances.get(sessionId)
    if (!inst) return
    log('json-claude', `interrupt sessionId=${sessionId}`)
    const frame = {
      type: 'control_request',
      request_id: randomUUID(),
      request: { subtype: 'interrupt' }
    }
    try {
      inst.proc.stdin.write(JSON.stringify(frame) + '\n')
    } catch (err) {
      log(
        'json-claude',
        `interrupt write failed sessionId=${sessionId}`,
        err instanceof Error ? err.message : String(err)
      )
    }
    // Drop the dashed/queued styling on any in-flight queued entries —
    // the user is bailing on the current turn. NOTE: those messages are
    // already in claude's stdin buffer; we don't have a flush mechanism,
    // so claude will still process them on the next agent-loop pass
    // unless the interrupt itself drains the buffer (TBD — observe
    // behavior in test).
    this.unqueueUserEntries(sessionId)
    // Flip busy off optimistically; the result event (when the abort
    // resolves into a turn boundary) will also clear it.
    this.dispatchBusy(sessionId, false)
  }

  kill(sessionId: string): void {
    const inst = this.instances.get(sessionId)
    if (!inst) return
    log('json-claude', `kill sessionId=${sessionId}`)
    this.clearPartial(inst)
    this.instances.delete(sessionId)
    try {
      inst.proc.stdin.end()
    } catch {
      /* ignore */
    }
    try {
      inst.proc.kill('SIGTERM')
    } catch {
      /* ignore */
    }
    this.opts.closeApprovalSession(sessionId)
    // Leave the session entry in the store so the renderer can still show
    // the transcript if the user re-opens it; it'll be replaced on next
    // create(). Dispatch exited so the UI stops showing "running".
    this.dispatchState(sessionId, 'exited', {
      exitReason: 'killed by user'
    })
  }

  killAll(): void {
    for (const id of Array.from(this.instances.keys())) this.kill(id)
  }

  /** Keeps the assistant message at `fromEntryId` and drops every
   *  entry sequenced after it — "rewind to this message being the last
   *  thing the agent said." The cut is keyed by the entry's
   *  `apiMessageId` (the Anthropic Messages-API id), not by slice
   *  position: one assistant turn can be one slice entry but several
   *  on-disk jsonl lines (one per content block), so a position-based
   *  cut would land too early. We find the LAST jsonl line carrying
   *  the matching id and truncate everything after it.
   *
   *  The slice is then force-reseeded from the truncated transcript
   *  so the in-memory view matches the canonical jsonl exactly.
   *
   *  Pre-cancellation (interrupt in-flight stream, deny pending
   *  approvals) lives in the IPC handler — it needs to coordinate
   *  with ApprovalBridge which the manager doesn't reach. By the time
   *  we get here, busy must be false and pending approvals for this
   *  session must be cleared.
   *
   *  Only callable on assistant entries; the renderer enforces this at
   *  the menu level. */
  rewindTo(sessionId: string, fromEntryId: string): RewindOutcome {
    const session =
      this.store.getSnapshot().state.jsonClaude.sessions[sessionId]
    if (!session) return { ok: false, reason: 'unknown session' }
    const entries = session.entries
    const idx = entries.findIndex((e) => e.entryId === fromEntryId)
    if (idx === -1) return { ok: false, reason: 'entry not in slice' }
    const target = entries[idx]
    if (target.kind !== 'assistant') {
      return { ok: false, reason: 'rewind targets an assistant message' }
    }
    if (!target.apiMessageId) {
      // Older entries from before this field was wired won't have it.
      // Surface the failure rather than fall back to a position-based
      // cut that would silently mis-truncate.
      return { ok: false, reason: 'message lacks an API id' }
    }
    if (idx >= entries.length - 1) {
      return { ok: false, reason: 'nothing after this message to drop' }
    }

    // Kill the subprocess first so it doesn't keep writing to the jsonl
    // while we truncate. kill() removes from the instance map BEFORE
    // SIGTERM so the exit handler's stale-instance guard bails on the
    // delayed exit event — no synthetic subprocess-exit entry fires.
    if (this.instances.has(sessionId)) this.kill(sessionId)

    const truncResult = this.truncateTranscriptAfterMessage(
      sessionId,
      session.worktreePath,
      target.apiMessageId
    )
    if (!truncResult.ok) {
      return { ok: false, reason: truncResult.reason }
    }

    // Force-reseed the slice from the truncated transcript. The
    // entriesSeeded event replaces entries wholesale, which is the
    // right semantic here — the live slice may have grouped multi-block
    // turns into single entries while the jsonl has separate lines, so
    // a positional prune would leave the slice and the jsonl out of
    // sync. Reseeding makes them agree.
    const freshEntries = this.parseTranscriptEntries(
      sessionId,
      session.worktreePath
    )
    this.store.dispatch({
      type: 'jsonClaude/entriesSeeded',
      payload: { sessionId, entries: freshEntries }
    })

    return { ok: true }
  }

  /** Fork the source session in place, keeping history up to and
   *  including the clicked assistant message. Resolves the clicked
   *  entry to its API message id and delegates to `forkTranscript`. */
  forkAt(sourceSessionId: string, fromEntryId: string): ForkOutcome {
    const source =
      this.store.getSnapshot().state.jsonClaude.sessions[sourceSessionId]
    if (!source) return { ok: false, reason: 'unknown session' }
    const entries = source.entries
    const idx = entries.findIndex((e) => e.entryId === fromEntryId)
    if (idx === -1) return { ok: false, reason: 'entry not in slice' }
    const target = entries[idx]
    if (target.kind !== 'assistant') {
      return { ok: false, reason: 'fork targets an assistant message' }
    }
    if (!target.apiMessageId) {
      return { ok: false, reason: 'message lacks an API id' }
    }

    return forkTranscript({
      sourceSessionId,
      sourceWorktreePath: source.worktreePath,
      destWorktreePath: source.worktreePath,
      throughApiMessageId: target.apiMessageId
    })
  }

  /** Truncate the jsonl so it ends with the LAST line carrying
   *  `apiMessageId` in its inner `message.id`. Everything sequenced
   *  after that line is dropped. The original file is moved aside as
   *  `<sessionId>.jsonl.rewind-<ts>.bak` (foundation for Phase 2 Undo)
   *  and the kept prefix is written through a `.tmp` + rename so the
   *  replacement is atomic from the subprocess's perspective. */
  private truncateTranscriptAfterMessage(
    sessionId: string,
    worktreePath: string,
    apiMessageId: string
  ): { ok: boolean; reason?: string } {
    const transcriptPath = transcriptPathFor(sessionId, worktreePath)
    if (!existsSync(transcriptPath)) {
      // No on-disk session yet — caller still re-seeds the (empty) slice.
      return { ok: true }
    }

    let raw: string
    try {
      raw = readFileSync(transcriptPath, 'utf8')
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      log('json-claude', `rewind read failed sessionId=${sessionId}`, reason)
      return { ok: false, reason }
    }

    const lines = raw.split('\n')
    // Find the LAST line whose inner message.id matches. "Last" because
    // a single assistant API turn can split into several jsonl lines
    // (thinking, tool_use, text), all carrying the same message.id —
    // we want to keep all of them, so we cut after the final one.
    let lastMatchIdx = -1
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (parsed['type'] !== 'assistant') continue
      const inner = parsed['message'] as { id?: unknown } | undefined
      if (typeof inner?.id === 'string' && inner.id === apiMessageId) {
        lastMatchIdx = i
      }
    }

    if (lastMatchIdx === -1) {
      log(
        'json-claude',
        `rewind: no jsonl line matched apiMessageId=${apiMessageId} sessionId=${sessionId}`
      )
      return { ok: false, reason: 'no matching jsonl record' }
    }

    // Keep lines [0..lastMatchIdx] inclusive; drop everything after.
    const keptLines = lines.slice(0, lastMatchIdx + 1)
    const keptBody = keptLines.length > 0 ? keptLines.join('\n') + '\n' : ''

    const ts = Date.now()
    const backupPath = `${transcriptPath}.rewind-${ts}.bak`
    const tmpPath = `${transcriptPath}.rewind-${ts}.tmp`
    try {
      writeFileSync(tmpPath, keptBody, 'utf8')
      renameSync(transcriptPath, backupPath)
      renameSync(tmpPath, transcriptPath)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      log('json-claude', `rewind write failed sessionId=${sessionId}`, reason)
      return { ok: false, reason }
    }
    log(
      'json-claude',
      `rewind truncated sessionId=${sessionId} keptLines=${keptLines.length} backup=${backupPath}`
    )
    return { ok: true }
  }

  /** Change --permission-mode mid-session via the SDK control_request
   *  protocol (subtype: 'set_permission_mode'). Same plumbing the TUI
   *  uses for shift+tab; works mid-turn so an in-flight tool chain
   *  keeps running with the new mode applied. No kill, no respawn.
   *  Subprocess emits a control_response with subtype 'success' (with
   *  the applied mode echoed back) or 'error' — we log either way in
   *  handleStreamLine but optimistically reflect the change in the
   *  slice up front. Noop if the session isn't currently running;
   *  the persisted slice mode still gets passed to --permission-mode
   *  on the next spawn. */
  setPermissionMode(sessionId: string, mode: JsonClaudePermissionMode): void {
    const inst = this.instances.get(sessionId)
    if (!inst) return
    log(
      'json-claude',
      `permissionMode change sessionId=${sessionId} mode=${mode} — control_request`
    )
    const frame = {
      type: 'control_request',
      request_id: `set-mode-${randomUUID()}`,
      request: { subtype: 'set_permission_mode', mode }
    }
    try {
      inst.proc.stdin.write(JSON.stringify(frame) + '\n')
    } catch (err) {
      log(
        'json-claude',
        `set_permission_mode write failed sessionId=${sessionId}`,
        err instanceof Error ? err.message : String(err)
      )
    }
  }

  /** Spawn a one-shot `claude -p` probe to harvest the system/init event's
   *  slash_commands list. We need this because claude in stream-json input
   *  mode never emits init until a real user message arrives — so the
   *  popover would be empty for the user's first turn. The probe sends a
   *  trivial user message immediately followed by an interrupt, which
   *  fires init then aborts before any model tokens are spent ($0 cost,
   *  verified by spike). Result is cached per-cwd so subsequent sessions
   *  in the same worktree get it instantly. */
  private probeSlashCommands(cwd: string): Promise<string[]> {
    return new Promise((resolve) => {
      // Pre-flight cwd check — same rationale as create(). The probe is
      // best-effort (empty result → autocomplete just misses a bit of
      // context), so a missing cwd is a hard skip, no card, no dispatch.
      if (!existsSync(cwd)) {
        log('json-claude', `probe skipped — cwd missing cwd=${cwd}`)
        resolve([])
        return
      }
      const useSystemClaude = this.opts.getUseSystemClaude()
      const claudeCommand = this.opts.getClaudeCommand() || 'claude'
      const args = [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose'
      ]
      const envVars = this.opts.getClaudeEnvVars() || {}
      const childEnv: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === 'string') childEnv[k] = v
      }
      delete childEnv.CLAUDE_HARNESS_ID
      delete childEnv.HARNESS_TERMINAL_ID
      const spawnEnv = {
        ...childEnv,
        ...envVars,
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1'
      }
      log('json-claude', `probe spawn cwd=${cwd} bundled=${!useSystemClaude}`)
      let proc: ChildProcessWithoutNullStreams
      try {
        if (useSystemClaude) {
          const quoted = args.map((a) => JSON.stringify(a)).join(' ')
          const cmdLine = `${claudeCommand} ${quoted}`
          proc = spawn(resolveUserShell(), loginShellCommandArgs(cmdLine), {
            cwd,
            env: spawnEnv,
            stdio: ['pipe', 'pipe', 'pipe']
          })
        } else {
          proc = spawn(bundledClaudeBinPath(), args, {
            cwd,
            env: spawnEnv,
            stdio: ['pipe', 'pipe', 'pipe']
          })
        }
      } catch (err) {
        log(
          'json-claude',
          `probe spawn failed cwd=${cwd}`,
          err instanceof Error ? err.message : String(err)
        )
        resolve([])
        return
      }
      let buf = ''
      let resolved = false
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          log('json-claude', `probe timeout cwd=${cwd}`)
          try {
            proc.kill('SIGTERM')
          } catch {
            /* ignore */
          }
          resolve([])
        }
      }, 15_000)
      proc.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8')
        let idx: number
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim()
          buf = buf.slice(idx + 1)
          if (!line || resolved) continue
          let parsed: Record<string, unknown>
          try {
            parsed = JSON.parse(line)
          } catch {
            continue
          }
          if (parsed['type'] === 'system' && parsed['subtype'] === 'init') {
            const slashCommands = parsed['slash_commands']
            const filtered = Array.isArray(slashCommands)
              ? slashCommands.filter((s): s is string => typeof s === 'string')
              : []
            log(
              'json-claude',
              `probe init received cwd=${cwd} count=${filtered.length}`
            )
            resolved = true
            clearTimeout(timeout)
            try {
              proc.kill('SIGTERM')
            } catch {
              /* ignore */
            }
            resolve(filtered)
            return
          }
        }
      })
      proc.on('exit', () => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          log('json-claude', `probe exited before init cwd=${cwd}`)
          resolve([])
        }
      })
      // Async spawn errors (ENOENT etc.) land here. Without a listener,
      // Node re-emits the error at the process level and takes down the
      // main process — the same crash chain issue #185 traces.
      proc.on('error', (err) => {
        if (resolved) return
        resolved = true
        clearTimeout(timeout)
        log(
          'json-claude',
          `probe spawn error cwd=${cwd}`,
          err instanceof Error ? err.message : String(err)
        )
        try { proc.stdin.destroy() } catch { /* ignore */ }
        try { proc.stdout.destroy() } catch { /* ignore */ }
        try { proc.stderr.destroy() } catch { /* ignore */ }
        resolve([])
      })
      // Pump the message + interrupt. Send-then-interrupt makes claude emit
      // init (which is what we want) then abort the turn at $0 cost.
      try {
        proc.stdin.write(
          JSON.stringify({
            type: 'user',
            message: { role: 'user', content: '.' }
          }) + '\n'
        )
        proc.stdin.write(
          JSON.stringify({
            type: 'control_request',
            request_id: randomUUID(),
            request: { subtype: 'interrupt' }
          }) + '\n'
        )
      } catch (err) {
        log(
          'json-claude',
          `probe stdin write failed cwd=${cwd}`,
          err instanceof Error ? err.message : String(err)
        )
      }
    })
  }

  private ensureSlashCommandsForCwd(cwd: string): Promise<string[]> {
    const cached = this.slashCommandsByCwd.get(cwd)
    if (cached) return Promise.resolve(cached)
    const inflight = this.probeInflightByCwd.get(cwd)
    if (inflight) return inflight
    const p = this.probeSlashCommands(cwd).then((list) => {
      if (list.length > 0) this.slashCommandsByCwd.set(cwd, list)
      this.probeInflightByCwd.delete(cwd)
      return list
    })
    this.probeInflightByCwd.set(cwd, p)
    return p
  }

  private handleStreamLine(instance: JsonClaudeInstance, line: string): void {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line)
    } catch (err) {
      log(
        'json-claude',
        `parse error sessionId=${instance.sessionId}`,
        err instanceof Error ? err.message : String(err)
      )
      return
    }
    const type = parsed['type']
    const subtype = parsed['subtype']
    if (type === 'system' && subtype === 'compact_boundary') {
      // Wire format note: the live stream and the on-disk session jsonl
      // disagree on case. Live emits snake_case
      //   { compact_metadata: { trigger, pre_tokens, post_tokens,
      //                          duration_ms } }
      // while the on-disk record (which seedFromTranscript replays) is
      // camelCase
      //   { compactMetadata:  { trigger, preTokens, postTokens,
      //                          durationMs, preCompactDiscoveredTools } }
      // Read both — we go through the same dispatch either way.
      // Don't toggle busy: compaction happens transparently between
      // turns; surrounding `result` boundaries are what flip the spinner.
      const metaRaw =
        (parsed['compact_metadata'] as Record<string, unknown> | undefined) ??
        (parsed['compactMetadata'] as Record<string, unknown> | undefined)
      const trigger =
        metaRaw?.['trigger'] === 'auto' || metaRaw?.['trigger'] === 'manual'
          ? (metaRaw['trigger'] as 'auto' | 'manual')
          : undefined
      const preRaw = metaRaw?.['pre_tokens'] ?? metaRaw?.['preTokens']
      const postRaw = metaRaw?.['post_tokens'] ?? metaRaw?.['postTokens']
      const preTokens = typeof preRaw === 'number' ? preRaw : undefined
      const postTokens = typeof postRaw === 'number' ? postRaw : undefined
      const uuid = typeof parsed['uuid'] === 'string' ? parsed['uuid'] : null
      this.store.dispatch({
        type: 'jsonClaude/compactBoundaryReceived',
        payload: {
          sessionId: instance.sessionId,
          entryId: uuid
            ? `${instance.sessionId}-c-${uuid}`
            : this.nextEntryId(instance.sessionId, 'c'),
          trigger,
          preTokens,
          postTokens,
          timestamp: Date.now()
        }
      })
      return
    }
    // A detached (run_in_background) Agent resolves its tool_result
    // immediately with a launch stub, so the Task card can't use "result
    // arrived" to mean "finished" the way it does for a synchronous
    // sub-agent. These two events are the real lifecycle. The agent's
    // actual work streams inline on this same stdout carrying
    // parent_tool_use_id, so nesting already works — only the card's
    // running/settled status needs wiring.
    if (type === 'system' && subtype === 'task_started') {
      const toolUseId = parsed['tool_use_id']
      const agentId = parsed['task_id']
      if (typeof toolUseId !== 'string' || typeof agentId !== 'string') return
      this.store.dispatch({
        type: 'jsonClaude/backgroundAgentLaunched',
        payload: {
          sessionId: instance.sessionId,
          toolUseId,
          agentId,
          description:
            typeof parsed['description'] === 'string'
              ? (parsed['description'] as string)
              : '',
          timestamp: Date.now()
        }
      })
      return
    }
    if (type === 'system' && subtype === 'task_notification') {
      const toolUseId = parsed['tool_use_id']
      if (typeof toolUseId !== 'string') return
      const failed = parsed['status'] !== 'completed'
      const rawUsage = parsed['usage'] as Record<string, unknown> | undefined
      const num = (v: unknown): number | undefined =>
        typeof v === 'number' ? v : undefined
      const usage = rawUsage
        ? {
            totalTokens: num(rawUsage['total_tokens']),
            toolUses: num(rawUsage['tool_uses']),
            durationMs: num(rawUsage['duration_ms'])
          }
        : undefined
      this.store.dispatch({
        type: 'jsonClaude/backgroundAgentSettled',
        payload: {
          sessionId: instance.sessionId,
          toolUseId,
          status: failed ? 'failed' : 'completed',
          timestamp: Date.now(),
          ...(usage ? { usage } : {})
        }
      })
      // Supersede the launch stub with the agent's actual answer. The
      // renderer keys results by tool_use id and takes the last one.
      const summary = parsed['summary']
      if (typeof summary === 'string' && summary.length > 0) {
        this.store.dispatch({
          type: 'jsonClaude/toolResultAttached',
          payload: {
            sessionId: instance.sessionId,
            toolUseId,
            content: summary,
            isError: failed
          }
        })
      }
      return
    }
    if (type === 'system' && subtype === 'status' && parsed['status'] === 'requesting') {
      // Claude drains its pending-input queue immediately before it
      // builds the next API request, then emits this status. So this is
      // the earliest point at which a mid-turn message we injected is
      // genuinely part of the conversation — verified against the
      // session transcript, where the `queue-operation: remove` record
      // lands ~1ms before this event. Unqueue here rather than waiting
      // for `result`, which only fires at the end of the whole turn and
      // left the bubble dashed for minutes while claude was already
      // acting on it. The `result` handler keeps its own unqueue as the
      // backstop for messages that land after the last request.
      this.unqueueUserEntries(instance.sessionId)
      return
    }
    if (type === 'system' && subtype === 'init') {
      // Session id is already known (we pinned it via --session-id), but
      // the init payload includes the canonical slash_commands list — keep
      // it as a freshness signal in case anything's been installed since
      // the per-cwd probe ran. (Init only fires once a real user message
      // arrives — see probeSlashCommands for why we also probe up-front.)
      const slashCommands = parsed['slash_commands']
      if (Array.isArray(slashCommands)) {
        const filtered = slashCommands.filter(
          (s): s is string => typeof s === 'string'
        )
        this.slashCommandsByCwd.set(instance.worktreePath, filtered)
        this.store.dispatch({
          type: 'jsonClaude/slashCommandsChanged',
          payload: { sessionId: instance.sessionId, slashCommands: filtered }
        })
      }
      // Ground-truth model id, as reported by the CLI itself. Lets the
      // `/model` popover show what claude *actually* resolved to (bundle
      // default when we passed no `--model`, or the exact id we passed
      // otherwise).
      const initModel = parsed['model']
      if (typeof initModel === 'string' && initModel.length > 0) {
        this.store.dispatch({
          type: 'jsonClaude/currentModelChanged',
          payload: { sessionId: instance.sessionId, model: initModel }
        })
      }
      return
    }
    if (type === 'stream_event') {
      this.handleStreamEvent(instance, parsed)
      return
    }
    if (type === 'assistant') {
      const blocks = extractAssistantBlocks(parsed)
      if (blocks.length === 0) {
        // No content (e.g. stop-only turn). Still clear any in-flight
        // partial so the cursor disappears.
        this.clearPartial(instance)
        return
      }
      // Drain any pending coalesced deltas before reconciling.
      this.flushPartialDeltas(instance)
      const message = parsed['message'] as { id?: string } | undefined
      const messageId = message?.id
      // parent_tool_use_id is on the assistant event envelope, not on
      // the inner message. See note in handleStreamEvent above.
      const parentToolUseId =
        typeof parsed['parent_tool_use_id'] === 'string'
          ? (parsed['parent_tool_use_id'] as string)
          : undefined
      if (
        instance.partial &&
        messageId &&
        instance.partial.messageId === messageId
      ) {
        const entryId = instance.partial.entryId
        const placeholderCreated = instance.partial.placeholderCreated
        this.clearPartial(instance)
        if (placeholderCreated) {
          // The placeholder entry already carries parentToolUseId from
          // message_start; the reducer's spread preserves it across the
          // finalize replacement.
          this.store.dispatch({
            type: 'jsonClaude/assistantEntryFinalized',
            payload: { sessionId: instance.sessionId, entryId, blocks }
          })
        } else {
          // No placeholder ever materialized (e.g. message was tool_use
          // only, no text deltas). Append normally with the message-
          // derived id so future deltas for the same id reconcile.
          this.appendEntry(instance, {
            kind: 'assistant',
            blocks,
            timestamp: Date.now(),
            entryId,
            ...(messageId ? { apiMessageId: messageId } : {}),
            ...(parentToolUseId ? { parentToolUseId } : {})
          })
        }
        return
      }
      this.appendEntry(instance, {
        kind: 'assistant',
        blocks,
        timestamp: Date.now(),
        entryId: this.nextEntryId(instance.sessionId, 'a'),
        ...(messageId ? { apiMessageId: messageId } : {}),
        ...(parentToolUseId ? { parentToolUseId } : {})
      })
      return
    }
    if (type === 'user') {
      const results = extractToolResults(parsed)
      for (const r of results) {
        this.store.dispatch({
          type: 'jsonClaude/toolResultAttached',
          payload: {
            sessionId: instance.sessionId,
            toolUseId: r.toolUseId,
            content: r.content,
            isError: r.isError,
            ...(r.images ? { images: r.images } : {})
          }
        })
      }
      return
    }
    if (type === 'result') {
      this.dispatchBusy(instance.sessionId, false)
      this.unqueueUserEntries(instance.sessionId)
      const authMessage = detectAuthFailureFromResult(parsed)
      if (
        parsed['is_error'] === true ||
        (typeof parsed['subtype'] === 'string' &&
          (parsed['subtype'] as string).startsWith('error_'))
      ) {
        log(
          'json-claude',
          `result error sessionId=${instance.sessionId} subtype=${String(parsed['subtype'])} matched=${authMessage !== null} payload=${JSON.stringify(parsed).slice(0, 500)}`
        )
      }
      if (authMessage !== null) {
        this.appendEntry(instance, {
          entryId: `${instance.sessionId}-auth-${Date.now()}`,
          kind: 'error',
          errorKind: 'auth-failure',
          errorMessage: authMessage,
          timestamp: Date.now()
        })
      }
      this.maybeDispatchRateLimitError(instance, parsed)
      return
    }
    if (type === 'control_response') {
      // Replies to control_requests we send (interrupt, set_permission_mode).
      // We dispatch slice updates optimistically so success is silent;
      // an error response means the subprocess rejected the request
      // (e.g. callback not registered for this context) — surface it
      // to the debug log so we don't silently lose mode changes.
      const response = parsed['response'] as Record<string, unknown> | undefined
      if (response && response['subtype'] === 'error') {
        log(
          'json-claude',
          `control_response error sessionId=${instance.sessionId} request_id=${String(response['request_id'])} error=${String(response['error'])}`
        )
      }
      return
    }
    if (type === 'rate_limit_event') {
      this.maybeDispatchRateLimitWarning(instance, parsed)
      return
    }
    // Unknown types fall through silently — the SDK adds new envelope
    // shapes occasionally and we don't want to spam logs.
  }

  /** Threshold (0–1) above which rate_limit_event utilization triggers a
   *  warning card. Mirrors the SDK's own ~80% surfacing heuristic; we
   *  also honor the SDK's `surpassedThreshold` boolean when present so
   *  per-tier server thresholds win over our local guess. */
  private static readonly RATE_LIMIT_WARN_UTILIZATION = 0.8

  private maybeDispatchRateLimitWarning(
    instance: JsonClaudeInstance,
    parsed: Record<string, unknown>
  ): void {
    const info = parsed['rate_limit_info'] as
      | Record<string, unknown>
      | undefined
    if (!info) return
    const detail = parseRateLimitInfo(info)
    const utilization = detail.utilization
    const surpassed = info['surpassedThreshold']
    const overThreshold =
      surpassed === true ||
      (typeof utilization === 'number' &&
        utilization >= JsonClaudeManager.RATE_LIMIT_WARN_UTILIZATION)
    if (!overThreshold) {
      // Drop back below the threshold — clear dedup so the next breach
      // emits a fresh card instead of being suppressed.
      instance.lastRateLimitWarning = { overThreshold: false }
      return
    }
    const wasOver = instance.lastRateLimitWarning.overThreshold
    const lastReset = instance.lastRateLimitWarning.resetAt
    // Suppress when we're already showing a warning for the same reset
    // window — the underlying state hasn't materially changed. Emit a
    // fresh card on first breach OR when the reset window slides forward.
    if (wasOver && lastReset === detail.resetAt) return
    instance.lastRateLimitWarning = {
      overThreshold: true,
      ...(detail.resetAt !== undefined ? { resetAt: detail.resetAt } : {})
    }
    const ts = Date.now()
    this.store.dispatch({
      type: 'jsonClaude/entryAppended',
      payload: {
        sessionId: instance.sessionId,
        entry: {
          entryId: `${instance.sessionId}-ratelimit-warn-${ts}`,
          kind: 'system',
          timestamp: ts,
          errorKind: 'rate-limit-warning',
          errorMessage: 'Approaching rate limit',
          ...(Object.keys(detail).length > 0
            ? { rateLimitDetail: detail }
            : {})
        }
      }
    })
  }

  private maybeDispatchRateLimitError(
    instance: JsonClaudeInstance,
    parsed: Record<string, unknown>
  ): void {
    const terminalReason = parsed['terminal_reason']
    const errorsRaw = parsed['errors']
    const errorsArr = Array.isArray(errorsRaw)
      ? errorsRaw.filter((s): s is string => typeof s === 'string')
      : []
    const apiErrorStatus = parsed['api_error_status']
    // Three independent signals — any one is enough to call this a
    // rate-limit boundary. terminal_reason is the SDK's own
    // categorization (cleanest, only present on error_during_execution
    // results), errors[] catches generic 429 messages on
    // error_during_execution, and api_error_status===429 covers the
    // success-result-with-trailing-429 case.
    const isRateLimitTerminal =
      terminalReason === 'blocking_limit' ||
      terminalReason === 'rapid_refill_breaker'
    const errorsLooksRateLimit = errorsArr.some(looksLikeRateLimit)
    const apiStatusIs429 = apiErrorStatus === 429
    if (!isRateLimitTerminal && !errorsLooksRateLimit && !apiStatusIs429) return
    const human =
      errorsArr.find(looksLikeRateLimit) ??
      (terminalReason === 'rapid_refill_breaker'
        ? 'Server is temporarily limiting requests'
        : 'Rate limit reached')
    const ts = Date.now()
    this.store.dispatch({
      type: 'jsonClaude/entryAppended',
      payload: {
        sessionId: instance.sessionId,
        entry: {
          entryId: `${instance.sessionId}-ratelimit-error-${ts}`,
          kind: 'error',
          timestamp: ts,
          errorKind: 'rate-limit-error',
          errorMessage: human
        }
      }
    })
  }

  /** Stream-event handler for the SDK delta events claude emits when
   *  --include-partial-messages is on. Mirrors the Anthropic Messages
   *  SDK shapes: message_start declares the message id, content_block_*
   *  brackets each block, content_block_delta carries text_delta or
   *  input_json_delta. We only render text deltas progressively today;
   *  input_json_delta is on the backlog (see plans/json-mode-native-chat.md).
   *  Text deltas are coalesced (~30ms) before dispatch so a fast model
   *  doesn't trigger a re-render per token. */
  private handleStreamEvent(
    instance: JsonClaudeInstance,
    parsed: Record<string, unknown>
  ): void {
    const event = parsed['event'] as Record<string, unknown> | undefined
    if (!event) return
    const eventType = event['type']
    if (eventType === 'message_start') {
      const message = event['message'] as { id?: string } | undefined
      const messageId = message?.id
      if (!messageId) return
      // Drop any prior in-flight partial defensively (shouldn't happen
      // unless the consolidated event was missed).
      this.clearPartial(instance)
      // parent_tool_use_id is on the stream_event envelope (top level
      // of `parsed`), not nested inside `message`. Verified against
      // Claude Code 2.1.126 — schema is
      //   { type: 'stream_event', event: ..., parent_tool_use_id: ... }
      const parentToolUseId =
        typeof parsed['parent_tool_use_id'] === 'string'
          ? (parsed['parent_tool_use_id'] as string)
          : undefined
      instance.partial = {
        messageId,
        entryId: `${instance.sessionId}-a-${messageId}`,
        pendingText: '',
        pendingThinking: '',
        textFlushTimer: null,
        thinkingFlushTimer: null,
        placeholderCreated: false,
        ...(parentToolUseId ? { parentToolUseId } : {})
      }
      return
    }
    if (!instance.partial) return
    if (eventType === 'content_block_start') {
      const rawBlock = event['content_block'] as Record<string, unknown> | undefined
      const newBlock = streamEventBlockToMessageBlock(rawBlock)
      if (!newBlock) return
      // Make sure any pending deltas land in the previous block before
      // we introduce a new block.
      this.flushPartialDeltas(instance)
      if (!instance.partial.placeholderCreated) {
        this.appendStoreEntry(instance.sessionId, {
          kind: 'assistant',
          blocks: [newBlock],
          timestamp: Date.now(),
          entryId: instance.partial.entryId,
          apiMessageId: instance.partial.messageId,
          isPartial: true,
          ...(instance.partial.parentToolUseId
            ? { parentToolUseId: instance.partial.parentToolUseId }
            : {})
        })
        instance.partial.placeholderCreated = true
      } else {
        this.store.dispatch({
          type: 'jsonClaude/assistantBlockAppended',
          payload: {
            sessionId: instance.sessionId,
            entryId: instance.partial.entryId,
            block: newBlock
          }
        })
      }
      return
    }
    if (eventType === 'content_block_delta') {
      const delta = event['delta'] as
        | { type?: string; text?: string; thinking?: string }
        | undefined
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        if (delta.text.length === 0) return
        instance.partial.pendingText += delta.text
        this.scheduleTextFlush(instance)
      } else if (
        delta?.type === 'thinking_delta' &&
        typeof delta.thinking === 'string'
      ) {
        if (delta.thinking.length === 0) return
        instance.partial.pendingThinking += delta.thinking
        this.scheduleThinkingFlush(instance)
      }
      // input_json_delta is intentionally dropped — see backlog.
      // signature_delta carries the cryptographic signature for a
      // thinking block; nothing to render in the UI.
      return
    }
    if (eventType === 'content_block_stop' || eventType === 'message_stop') {
      this.flushPartialDeltas(instance)
      return
    }
    // message_delta carries stop_reason + usage; we don't render either
    // here. Cost meter / rate-limit work can pick those up later.
  }

  private ensurePlaceholderEntry(instance: JsonClaudeInstance): void {
    if (!instance.partial || instance.partial.placeholderCreated) return
    this.appendStoreEntry(instance.sessionId, {
      kind: 'assistant',
      blocks: [{ type: 'text', text: '' }],
      timestamp: Date.now(),
      entryId: instance.partial.entryId,
      apiMessageId: instance.partial.messageId,
      isPartial: true,
      ...(instance.partial.parentToolUseId
        ? { parentToolUseId: instance.partial.parentToolUseId }
        : {})
    })
    instance.partial.placeholderCreated = true
  }

  private scheduleTextFlush(instance: JsonClaudeInstance): void {
    if (!instance.partial || instance.partial.textFlushTimer) return
    instance.partial.textFlushTimer = setTimeout(() => {
      // Re-fetch instance state under timer — the instance object may
      // have been torn down between schedule and fire.
      const live = this.instances.get(instance.sessionId)
      if (!live || !live.partial) return
      live.partial.textFlushTimer = null
      this.flushPartialText(live)
    }, PARTIAL_TEXT_FLUSH_MS)
  }

  private scheduleThinkingFlush(instance: JsonClaudeInstance): void {
    if (!instance.partial || instance.partial.thinkingFlushTimer) return
    instance.partial.thinkingFlushTimer = setTimeout(() => {
      const live = this.instances.get(instance.sessionId)
      if (!live || !live.partial) return
      live.partial.thinkingFlushTimer = null
      this.flushPartialThinking(live)
    }, PARTIAL_THINKING_FLUSH_MS)
  }

  /** Drain both delta buffers immediately. Called at boundaries
   *  (content_block_stop, message_stop, consolidated assistant event)
   *  where we want pending content to land before the next dispatch. */
  private flushPartialDeltas(instance: JsonClaudeInstance): void {
    if (!instance.partial) return
    if (instance.partial.textFlushTimer) {
      clearTimeout(instance.partial.textFlushTimer)
      instance.partial.textFlushTimer = null
    }
    if (instance.partial.thinkingFlushTimer) {
      clearTimeout(instance.partial.thinkingFlushTimer)
      instance.partial.thinkingFlushTimer = null
    }
    this.flushPartialText(instance)
    this.flushPartialThinking(instance)
  }

  private flushPartialText(instance: JsonClaudeInstance): void {
    if (!instance.partial) return
    if (!instance.partial.pendingText) return
    const text = instance.partial.pendingText
    instance.partial.pendingText = ''
    this.ensurePlaceholderEntry(instance)
    this.store.dispatch({
      type: 'jsonClaude/assistantTextDelta',
      payload: {
        sessionId: instance.sessionId,
        entryId: instance.partial.entryId,
        textDelta: text
      }
    })
  }

  private flushPartialThinking(instance: JsonClaudeInstance): void {
    if (!instance.partial) return
    if (!instance.partial.pendingThinking) return
    const text = instance.partial.pendingThinking
    instance.partial.pendingThinking = ''
    this.ensurePlaceholderEntry(instance)
    this.store.dispatch({
      type: 'jsonClaude/assistantThinkingDelta',
      payload: {
        sessionId: instance.sessionId,
        entryId: instance.partial.entryId,
        textDelta: text
      }
    })
  }

  private clearPartial(instance: JsonClaudeInstance): void {
    if (!instance.partial) return
    if (instance.partial.textFlushTimer) {
      clearTimeout(instance.partial.textFlushTimer)
      instance.partial.textFlushTimer = null
    }
    if (instance.partial.thinkingFlushTimer) {
      clearTimeout(instance.partial.thinkingFlushTimer)
      instance.partial.thinkingFlushTimer = null
    }
    instance.partial.pendingText = ''
    instance.partial.pendingThinking = ''
    instance.partial = null
  }

  private appendEntry(
    instance: JsonClaudeInstance,
    entry: JsonClaudeChatEntry
  ): void {
    this.appendStoreEntry(instance.sessionId, entry)
  }

  private appendStoreEntry(sessionId: string, entry: JsonClaudeChatEntry): void {
    this.store.dispatch({
      type: 'jsonClaude/entryAppended',
      payload: { sessionId, entry }
    })
  }

  private dispatchState(
    sessionId: string,
    state: JsonClaudeSessionState,
    extra?: { exitCode?: number | null; exitReason?: string | null }
  ): void {
    this.store.dispatch({
      type: 'jsonClaude/sessionStateChanged',
      payload: { sessionId, state, ...extra }
    })
  }

  private dispatchBusy(sessionId: string, busy: boolean): void {
    this.store.dispatch({
      type: 'jsonClaude/busyChanged',
      payload: { sessionId, busy }
    })
  }

  // Only fires on unexpected exits — user-initiated kill() clears the
  // instance map before SIGTERM lands, so the stale-instance guard in
  // proc.on('exit') bails before reaching this. Spawn failures count as
  // unexpected too.
  private dispatchSubprocessExitEntry(
    sessionId: string,
    exitReason: string
  ): void {
    this.store.dispatch({
      type: 'jsonClaude/entryAppended',
      payload: {
        sessionId,
        entry: {
          entryId: `${sessionId}-error-${Date.now()}`,
          kind: 'error',
          timestamp: Date.now(),
          errorKind: 'subprocess-exit',
          errorMessage: exitReason || 'Session ended unexpectedly',
          exitWasClean: false
        }
      }
    })
  }

  // Fires when the child process couldn't be spawned at all — either the
  // sync spawn() throw, the async 'error' event (ENOENT etc.), or the
  // pre-flight cwd-missing guard. Distinct errorKind from subprocess-exit
  // so the renderer can surface a targeted "couldn't launch" message
  // rather than the generic "session ended" card. Restart still uses the
  // same recovery button — that path is worth trying after the user
  // prunes a stale worktree.
  private dispatchSpawnFailedEntry(
    sessionId: string,
    reason: string
  ): void {
    this.store.dispatch({
      type: 'jsonClaude/entryAppended',
      payload: {
        sessionId,
        entry: {
          entryId: `${sessionId}-spawn-fail-${Date.now()}`,
          kind: 'error',
          timestamp: Date.now(),
          errorKind: 'spawn-failed',
          errorMessage: reason || "Couldn't launch Claude",
          exitWasClean: false
        }
      }
    })
  }
}

const RATE_LIMIT_TEXT_RE =
  /(\b429\b|rate[\s_-]?limit|usage limit|too many requests)/i

function looksLikeRateLimit(s: string): boolean {
  return RATE_LIMIT_TEXT_RE.test(s)
}

/** Extract the displayable subset of the SDK's `rate_limit_info` object
 *  into the slice's `rateLimitDetail` shape. Wire schema (verified
 *  against @anthropic-ai/claude-code-darwin-arm64 binary):
 *    { status, resetsAt?, rateLimitType?, utilization?,
 *      overageStatus?, overageResetsAt?, overageDisabledReason?,
 *      isUsingOverage?, surpassedThreshold? }
 *  resetsAt may be a number (unix ms) or an ISO string depending on
 *  tier — coerce to ms either way for the renderer. */
function parseRateLimitInfo(info: Record<string, unknown>): {
  utilization?: number
  resetAt?: number
  tier?: string
  isUsingOverage?: boolean
} {
  const out: {
    utilization?: number
    resetAt?: number
    tier?: string
    isUsingOverage?: boolean
  } = {}
  const utilization = info['utilization']
  if (typeof utilization === 'number' && isFinite(utilization)) {
    out.utilization = utilization
  }
  const resetsAt = info['resetsAt']
  if (typeof resetsAt === 'number' && isFinite(resetsAt)) {
    // SDK numbers are unix seconds in some tiers and ms in others.
    // Heuristic: anything below year 2100 in seconds is < 4.1e9, so
    // anything < 1e12 is seconds, otherwise ms.
    out.resetAt = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt
  } else if (typeof resetsAt === 'string') {
    const t = Date.parse(resetsAt)
    if (!isNaN(t)) out.resetAt = t
  }
  const tier = info['rateLimitType']
  if (typeof tier === 'string') out.tier = tier
  const isUsingOverage = info['isUsingOverage']
  if (typeof isUsingOverage === 'boolean') out.isUsingOverage = isUsingOverage
  return out
}

function streamEventBlockToMessageBlock(
  block: Record<string, unknown> | undefined
): JsonClaudeMessageBlock | null {
  if (!block) return null
  const t = block['type']
  if (t === 'text') {
    return {
      type: 'text',
      text: typeof block['text'] === 'string' ? (block['text'] as string) : ''
    }
  }
  if (t === 'thinking') {
    return {
      type: 'thinking',
      text:
        typeof block['thinking'] === 'string'
          ? (block['thinking'] as string)
          : ''
    }
  }
  if (t === 'tool_use') {
    return {
      type: 'tool_use',
      id: typeof block['id'] === 'string' ? (block['id'] as string) : undefined,
      name:
        typeof block['name'] === 'string' ? (block['name'] as string) : undefined,
      // Input arrives via input_json_delta — we don't accumulate those
      // today, so the placeholder card renders the tool name only until
      // the consolidated assistant event reconciles with the full
      // input. See "Backlog follow-ups from partial-message streaming"
      // in plans/json-mode-native-chat.md.
      input: {}
    }
  }
  return null
}

function extractAssistantBlocks(ev: Record<string, unknown>): JsonClaudeMessageBlock[] {
  const message = ev['message'] as { content?: unknown } | undefined
  const content = message?.content
  if (!Array.isArray(content)) return []
  const out: JsonClaudeMessageBlock[] = []
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue
    const block = raw as Record<string, unknown>
    const t = block['type']
    if (t === 'text' && typeof block['text'] === 'string') {
      out.push({ type: 'text', text: block['text'] as string })
    } else if (t === 'thinking') {
      out.push({
        type: 'thinking',
        text:
          typeof block['thinking'] === 'string'
            ? (block['thinking'] as string)
            : ''
      })
    } else if (t === 'tool_use') {
      out.push({
        type: 'tool_use',
        id: typeof block['id'] === 'string' ? (block['id'] as string) : undefined,
        name: typeof block['name'] === 'string' ? (block['name'] as string) : undefined,
        input:
          block['input'] && typeof block['input'] === 'object' && !Array.isArray(block['input'])
            ? (block['input'] as Record<string, unknown>)
            : undefined
      })
    }
  }
  return out
}

interface ExtractedToolResult {
  toolUseId: string
  content: string
  isError: boolean
  images?: JsonClaudeImageRef[]
}

function extractToolResults(ev: Record<string, unknown>): ExtractedToolResult[] {
  const message = ev['message'] as { content?: unknown } | undefined
  const content = message?.content
  if (!Array.isArray(content)) return []
  return extractToolResultsFromArray(content)
}

/** MCP tools that return images (browser screenshots) surface them as
 *  Anthropic-shaped blocks: {type:'image', source:{type:'base64',
 *  media_type, data}}. Spill the bytes to a temp file and keep only the
 *  path — a PNG screenshot is megabytes of base64, and everything in a
 *  state event gets re-broadcast to every connected client. */
function extractResultImage(part: Record<string, unknown>): JsonClaudeImageRef | null {
  if (part['type'] !== 'image') return null
  const source = part['source']
  if (!source || typeof source !== 'object') return null
  const s = source as Record<string, unknown>
  const data = s['data']
  const mediaType = s['media_type']
  if (typeof data !== 'string' || !data) return null
  if (typeof mediaType !== 'string' || !mediaType.startsWith('image/')) return null
  try {
    return { path: writeResultImage(data, mediaType), mediaType }
  } catch {
    return null
  }
}

function extractToolResultsFromArray(content: unknown[]): ExtractedToolResult[] {
  const out: ExtractedToolResult[] = []
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue
    const b = raw as Record<string, unknown>
    if (b['type'] !== 'tool_result') continue
    const id = typeof b['tool_use_id'] === 'string' ? (b['tool_use_id'] as string) : ''
    if (!id) continue
    const rawContent = b['content']
    const images: JsonClaudeImageRef[] = []
    const text =
      typeof rawContent === 'string'
        ? rawContent
        : Array.isArray(rawContent)
          ? rawContent
              .map((p) => {
                if (!p || typeof p !== 'object') return ''
                const part = p as Record<string, unknown>
                const img = extractResultImage(part)
                if (img) {
                  images.push(img)
                  return ''
                }
                if ('text' in part) return String(part['text'])
                return ''
              })
              .filter((s) => s !== '')
              .join('\n')
          : JSON.stringify(rawContent)
    out.push({
      toolUseId: id,
      content: text,
      isError: Boolean(b['is_error']),
      ...(images.length > 0 ? { images } : {})
    })
  }
  return out
}

/** Heuristic detector for auth failures surfaced via stream-json `result`
 *  events. Two-tier match: structured `subtype === 'error_auth'` always
 *  wins; otherwise we only try the regex when the turn is actually
 *  flagged as an error (`is_error: true` or `subtype` starting with
 *  `error_`). Without that gate, the regex was matching the assistant's
 *  reply content on normal turns whenever the user happened to discuss
 *  auth/credentials/401 — false-positive city. */
const AUTH_PATTERN = /\b(authentication|authoriz|credential|unauthorized|401|expired token|please run \/login|invalid api key)\b/i
function detectAuthFailureFromResult(parsed: Record<string, unknown>): string | null {
  const subtype = parsed['subtype']
  if (subtype === 'error_auth') {
    const err = pickErrorString(parsed)
    return err ?? 'Authentication failed.'
  }
  const isError =
    parsed['is_error'] === true ||
    (typeof subtype === 'string' && subtype.startsWith('error_'))
  if (!isError) return null
  // Strict structural fields (error / error.message) first. When the turn
  // is flagged is_error:true but the message lives in result/message
  // (claude sometimes puts the user-facing failure there), broaden to
  // those fields too — the is_error gate already eliminates the
  // false-positive case the original AUTH_PATTERN scrub was about.
  const err =
    pickErrorString(parsed) ??
    (typeof parsed['result'] === 'string' && parsed['result'].trim() ? (parsed['result'] as string) : null) ??
    (typeof parsed['message'] === 'string' && parsed['message'].trim() ? (parsed['message'] as string) : null)
  if (err && AUTH_PATTERN.test(err)) return err
  return null
}

/** Pull a human-readable error string out of a stream-json result event.
 *  Only looks at `error` / `error.message` — NOT `result` or `message`,
 *  which are the assistant's reply content on success turns and would
 *  cause auth-pattern false positives if treated as errors. */
function pickErrorString(parsed: Record<string, unknown>): string | null {
  const direct = parsed['error']
  if (typeof direct === 'string' && direct.trim()) return direct
  if (direct && typeof direct === 'object') {
    const m = (direct as Record<string, unknown>)['message']
    if (typeof m === 'string' && m.trim()) return m
  }
  return null
}
