// Opt-in LLM-based auto-approver for json-claude tool permission requests.
//
// Productivity feature, not a security boundary. Two layers of defense
// before a tool call is auto-approved:
//   1. A hardcoded "must ask human" deny list — patterns we never even
//      send to the reviewer because they're high-blast-radius (rm -rf,
//      git push, web fetch, gh pr merge, etc.).
//   2. Otherwise, spawn a Haiku oneshot via `claude -p --model
//      claude-haiku-4-5` with --allowedTools '' so the reviewer can
//      think + reply but cannot itself execute any tools. The reply
//      must parse as `{decision: 'approve'|'ask', reason: string}`.
//
// Any error/timeout/parse-failure → returns 'ask'. We never default to
// approve when the reviewer doesn't comply — wrong-direction failures
// would silently bypass the user.

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { homedir } from 'os'
import { log } from './debug'
import { shellQuote } from './shell-quote'
import { resolveUserShell, loginShellCommandArgs } from './user-shell'

export type AutoApproveDecision =
  | { kind: 'approve'; model: string; reason: string }
  | { kind: 'ask'; reason: string }

interface AutoReviewOpts {
  claudeCommand: string
  timeoutMs?: number
  /** Optional project-specific guidance appended after the hardcoded
   *  policy preamble. Lets the user steer Haiku ("approve `npm install`",
   *  "be strict about Bash that writes outside src/") without losing the
   *  baked-in safety bullets. Empty string == no addendum. */
  steerInstructions?: string
}

const REVIEWER_MODEL = 'claude-haiku-4-5'
// Cold-start `claude -p` spawns are not fast — a login-shell-wrapped
// claude has to boot, init MCP, load project context, and handshake
// the model before Haiku produces a single token. Anything under ~10s
// times out reliably. 30s gives a generous buffer for slow machines /
// large project trees while still bounding total review time.
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_INPUT_BYTES = 4096

// Tools that we never auto-approve. Match against the literal MCP tool
// name as Claude Code reports it through the permission-prompt request.
const DENY_TOOL_NAMES = new Set<string>([
  'WebFetch',
  'WebSearch',
  // Arbitrary script in a browser tab, with that tab's cookies and logged-in
  // sessions — a reviewer reading the code can't bound what it reaches.
  'mcp__ness-control__eval_tab'
])

// Tools whose inputs always need a human's eyes regardless of arguments.
// Matched by prefix — covers every variant under the namespace (e.g.
// slack_send_message, slack_send_message_draft).
const DENY_TOOL_PREFIXES = [
  'mcp__claude_ai_Slack__slack_send_',
  'mcp__claude_ai_Gmail__create_draft',
  'mcp__claude_ai_Google_Calendar__create_event',
  'mcp__claude_ai_Google_Calendar__delete_event',
  'mcp__claude_ai_Google_Calendar__update_event',
  'mcp__claude_ai_Google_Drive__create_file'
]

// Bash command patterns that get a human in the loop. Tested as regexes
// against the `command` field of a Bash tool call. The list is small
// and intentionally narrow — we only catch the obviously-destructive
// ones; everything else falls through to the LLM reviewer (which has
// its own "ask when in doubt" instruction).
const DENY_BASH_PATTERNS: RegExp[] = [
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\b/i, // rm -rf, rm -fr, rm -Rf, etc.
  /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\b/i,
  /\bgit\s+push\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+branch\s+-D\b/,
  /\bgh\s+pr\s+(create|merge|close)\b/,
  /\bgh\s+release\b/,
  /\bnpm\s+publish\b/,
  /\byarn\s+publish\b/,
  /\bpnpm\s+publish\b/,
  /\bsudo\b/,
  /(^|\s)>\s*\/etc\//,
  /(^|\s)>>\s*\/etc\//,
  // Touching shell-sensitive dirs in any reasonable form.
  /~\/\.aws(\/|\b)/,
  /~\/\.ssh(\/|\b)/,
  /~\/\.claude(\/|\b)/,
  /~\/\.gitconfig\b/,
  /\$HOME\/\.aws(\/|\b)/,
  /\$HOME\/\.ssh(\/|\b)/,
  /\$HOME\/\.claude(\/|\b)/,
  /\$HOME\/\.gitconfig\b/
]

// Path substrings inside any tool input that disqualify auto-approval.
// Checked against the JSON-stringified input. Catches Read/Edit/Write
// pointed at home-dir secrets even though those tools aren't on the
// deny-tool list.
const DENY_PATH_SUBSTRINGS = [
  '/.aws/',
  '/.ssh/',
  '/.claude/secrets',
  '/.gitconfig'
]

/** Public for tests. Returns null when nothing matched, or a short reason
 *  string when the request should bypass Haiku and go straight to the
 *  user. */
export function checkDenyList(
  toolName: string,
  input: Record<string, unknown>
): string | null {
  if (DENY_TOOL_NAMES.has(toolName)) {
    return `tool ${toolName} is on the deny list`
  }
  for (const prefix of DENY_TOOL_PREFIXES) {
    if (toolName.startsWith(prefix)) {
      return `tool ${toolName} is on the deny list`
    }
  }
  if (toolName === 'Bash') {
    const cmd = typeof input['command'] === 'string' ? input['command'] : ''
    for (const re of DENY_BASH_PATTERNS) {
      if (re.test(cmd)) return `Bash command matches deny pattern ${re}`
    }
  }
  // Path checks across every tool input. Stringify once and substring-test.
  const inputStr = safeStringify(input)
  for (const sub of DENY_PATH_SUBSTRINGS) {
    if (inputStr.includes(sub)) {
      return `input references protected path ${sub}`
    }
  }
  // Absolute paths outside the user's home are suspicious — the worktree
  // lives under home, so a reference to /etc, /var, /usr, /private, etc.
  // gets routed to the human. Skip / itself (very common as a separator
  // inside relative-looking strings) and tolerate /tmp (frequent and
  // ephemeral).
  //
  // Prose fields are skipped: scanning them sent every URL route in a
  // sentence ("curl /health" in a Bash description, "/health is added" in a
  // progress message) to the human. Everything else is scanned, including
  // unknown keys, so an unfamiliar MCP schema fails closed.
  const home = homedir()
  const absPathRe = /(^|["\s'])(\/[A-Za-z][^\s"']*)/g
  const pathText = pathBearingStrings(input).join('\n')
  let m: RegExpExecArray | null
  while ((m = absPathRe.exec(pathText)) !== null) {
    const p = m[2]
    if (p.startsWith(home)) continue
    if (p.startsWith('/tmp/') || p === '/tmp') continue
    // Allow common project locations + macOS readonly bits we shouldn't
    // care about.
    if (p.startsWith('/Volumes/')) continue
    return `input references absolute path outside home: ${p}`
  }
  return null
}

// Keys whose values are free text written for a human or a model, not
// locations. Matched against the whole key, case-insensitively.
const PROSE_KEY_RE =
  /^(?:description|message|messages|prompt|initial_?prompt|system_?prompt|body|content|text|title|summary|briefing|query|question|reason|comment|note|notes|explanation|caption|label|subject|instructions?)$/i

/** Every string in a tool input that could name a filesystem location:
 *  all string values, nested objects and arrays included, except those
 *  under a prose key. Public for tests. */
export function pathBearingStrings(input: unknown): string[] {
  const out: string[] = []
  const visit = (value: unknown, depth: number): void => {
    if (depth > 20) return
    if (typeof value === 'string') out.push(value)
    else if (Array.isArray(value)) for (const v of value) visit(v, depth + 1)
    else if (value && typeof value === 'object') {
      for (const [key, v] of Object.entries(value)) {
        if (!PROSE_KEY_RE.test(key)) visit(v, depth + 1)
      }
    }
  }
  visit(input, 0)
  return out
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return ''
  }
}

function truncateInput(input: Record<string, unknown>): {
  text: string
  truncated: boolean
} {
  const raw = safeStringify(input)
  if (raw.length <= MAX_INPUT_BYTES) return { text: raw, truncated: false }
  const head = raw.slice(0, MAX_INPUT_BYTES)
  const moreBytes = raw.length - MAX_INPUT_BYTES
  return { text: `${head}...<truncated, ${moreBytes} more bytes>`, truncated: true }
}

const POLICY_PROMPT = `You are a security reviewer for a coding agent's tool call. Decide whether to auto-approve or defer to the human.

Reply with EXACTLY this JSON shape on a single line, nothing else:
{"decision":"approve","reason":"<one short sentence>"}
or
{"decision":"ask","reason":"<one short sentence>"}

Approve only if ALL of these are true:
- The action is contained to the user's worktree
- The action is reversible (file edit, file create) or read-only (Read, Grep, Glob, ls, git status, git log, git diff)
- The input contains no shell injection, command substitution, or piped curl/wget
- The input contains no credentials, tokens, or .env/.aws/.ssh paths

Ask (don't approve) when ANY of these are true:
- Network calls beyond reading well-known docs
- Anything destructive: rm, git push, delete, drop, clear
- Privilege escalation: sudo, su, chmod 777
- Anything you're not sure about — when in doubt, ask
`

export function buildPrompt(
  toolName: string,
  input: Record<string, unknown>,
  steerInstructions?: string
): string {
  const { text, truncated } = truncateInput(input)
  const steer = (steerInstructions || '').trim()
  const steerBlock = steer
    ? `\n## Project-specific guidance (additive — does not override the rules above):\n${steer}\n`
    : ''
  return `${POLICY_PROMPT}${steerBlock}
Tool: ${toolName}
Input${truncated ? ' (truncated)' : ''}: ${text}
`
}

/** Public for tests. Pull the first JSON object out of a stdout blob and
 *  validate it has the expected shape. Returns null when nothing parses
 *  or the shape is wrong. */
export function parseDecision(stdout: string): AutoApproveDecision | null {
  const start = stdout.indexOf('{')
  if (start < 0) return null
  // Walk the string with a tiny brace-balanced scanner so we don't
  // mis-handle stray braces inside string contents.
  let depth = 0
  let end = -1
  let inString = false
  let escape = false
  for (let i = start; i < stdout.length; i++) {
    const c = stdout[i]
    if (escape) {
      escape = false
      continue
    }
    if (c === '\\') {
      escape = true
      continue
    }
    if (c === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end < 0) return null
  const slice = stdout.slice(start, end + 1)
  let parsed: unknown
  try {
    parsed = JSON.parse(slice)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  const decision = obj['decision']
  const reason = typeof obj['reason'] === 'string' ? obj['reason'] : ''
  if (decision === 'approve') {
    return { kind: 'approve', model: REVIEWER_MODEL, reason: reason || 'reviewer approved' }
  }
  if (decision === 'ask') {
    return { kind: 'ask', reason: reason || 'reviewer asked for human' }
  }
  return null
}

export async function autoReview(
  toolName: string,
  input: Record<string, unknown>,
  opts: AutoReviewOpts
): Promise<AutoApproveDecision> {
  const startedAt = Date.now()
  const denyReason = checkDenyList(toolName, input)
  if (denyReason) {
    log(
      'auto-approver',
      `deny-list match tool=${toolName} reason="${denyReason}" latency=0ms`
    )
    return { kind: 'ask', reason: denyReason }
  }

  const claudeCommand = (opts.claudeCommand || 'claude').trim() || 'claude'
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // --permission-mode plan keeps the reviewer in plan mode, where it
  // cannot execute any tool — matches what we want (it should think +
  // reply, nothing else). Avoids relying on undocumented behavior of
  // --allowedTools '', which some claude versions reject as invalid.
  const args = [
    '-p',
    '--model',
    REVIEWER_MODEL,
    '--permission-mode',
    'plan'
  ]

  // Reuse the same login-shell + POSIX-quote pattern json-claude-manager
  // uses, so PATH (Homebrew, nvm, …) is loaded the same way.
  const cmdLine = `${claudeCommand} ${args.map(shellQuote).join(' ')}`
  const prompt = buildPrompt(toolName, input, opts.steerInstructions)

  return await new Promise<AutoApproveDecision>((resolve) => {
    let proc: ChildProcessWithoutNullStreams
    try {
      proc = spawn(resolveUserShell(), loginShellCommandArgs(cmdLine), {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }
      })
    } catch (err) {
      const reason = `spawn failed: ${err instanceof Error ? err.message : String(err)}`
      log(
        'auto-approver',
        `tool=${toolName} decision=ask reason="${reason}" latency=${Date.now() - startedAt}ms`
      )
      resolve({ kind: 'ask', reason })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (decision: AutoApproveDecision): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        proc.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      log(
        'auto-approver',
        `tool=${toolName} decision=${decision.kind} reason="${decision.reason}" latency=${Date.now() - startedAt}ms`
      )
      resolve(decision)
    }

    const timer = setTimeout(() => {
      finish({
        kind: 'ask',
        reason: `auto-review timed out after ${Math.round(timeoutMs / 1000)}s`
      })
    }, timeoutMs)

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    proc.on('error', (err) => {
      const msg = err instanceof Error ? err.message : String(err)
      finish({ kind: 'ask', reason: `auto-reviewer process error: ${msg}` })
    })
    proc.on('close', (code, signal) => {
      // Suppress the noisy "non-zero exit code=143" log when our own
      // SIGTERM (from the timeout path) is what made the process exit.
      if (settled) return
      if (code !== 0) {
        const tail = stderr.trim().slice(-200) || '(empty)'
        finish({
          kind: 'ask',
          reason: `auto-reviewer exited code=${code}${signal ? ` signal=${signal}` : ''} stderr="${tail}"`
        })
        return
      }
      const parsed = parseDecision(stdout)
      if (!parsed) {
        const tail = stdout.trim().slice(-200) || '(empty)'
        finish({
          kind: 'ask',
          reason: `auto-reviewer reply was not valid decision JSON: "${tail}"`
        })
        return
      }
      finish(parsed)
    })

    try {
      proc.stdin.write(prompt)
      proc.stdin.end()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      finish({ kind: 'ask', reason: `auto-reviewer stdin write failed: ${msg}` })
    }
  })
}
