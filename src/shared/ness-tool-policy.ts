// Which of Ness's own ness-control MCP tools run without an approval prompt.
//
// Ness asks agents to call these as plumbing: report_progress at every
// milestone, set_tab_name on the first turn, list_tabs before a
// send_message. Routing each of those to the user made the onboarding's
// very first task stop three times to approve Ness talking to itself.
//
// Both lists are explicit, and the test fails when a tool defined in
// resources/mcp-bridge.js is in neither, so adding a tool forces someone to
// decide which side it belongs on instead of silently inheriting one.
//
// What is deliberately trusted, and what isn't:
// - ASK holds tools that run arbitrary code: create_shell runs any command
//   through a login shell (as dangerous as Bash), and eval_tab runs any
//   script with the tab's cookies and logged-in sessions. add_repo is there
//   too: registering a clone trusts its .ness.json, whose setupCommand
//   create_worktree would then run.
// - Browser driving (click_tab, type_tab, get_tab_dom, …) is trusted because
//   it acts on whatever page the tab is already on. Getting a tab onto a
//   page is the part that isn't: a file: URL plus get_tab_dom reads any
//   local file, and a request to any other host is an outbound channel
//   that WebFetch would prompt for. So navigate_tab and create_browser_tab
//   are only auto-allowed for loopback http(s) dev servers and about:blank
//   (see URL_GATED_TOOLS). Everything else goes down the normal path.
//   This narrows those channels; it doesn't close them. Loopback also
//   covers any other local service (Jupyter, a DB admin UI, CUPS, a Docker
//   or Ollama API), and a loopback page can still send the tab off-host via
//   a click_tab on an external link or a server redirect. Gating every
//   click would undo the point, so don't treat this as a hard boundary.
// - create_worktree can run code the user hasn't vetted, three ways:
//   the repo's committed .ness.json setupCommand (an agent that can Write
//   could have put `curl … | sh` there), a prNumber checkout (a fork's
//   .claude/settings.json hooks and .mcp.json load in the new session),
//   and an explicit repoRoot that isn't open in Ness (the same as add_repo,
//   which asks). It is auto-allowed only with no prNumber, a repoRoot that
//   is omitted or already open, and no repo setupCommand; otherwise it asks.
//   The global setup command from Settings isn't gated: the user typed it,
//   and gating it would prompt on every worktree for anyone who set one.
// - create_worktree and send_message start or message other agents with
//   text the calling agent wrote. They are auto-allowed because
//   orchestration is the point of them (onboarding's Getting Started flow
//   calls create_worktree). The trade-off: a session is only as careful as
//   the loosest tab it can start or message. The receiving agent's own
//   approvals still apply to whatever it then does.
// Anything not auto-allowed keeps going through the normal grant /
// auto-reviewer / human path.

import { normalizeBrowserUrl } from './browser-url'

const NESS_CONTROL_PREFIX = 'mcp__ness-control__'

export const NESS_AUTO_ALLOWED_TOOLS: readonly string[] = [
  // Worktrees, repos and naming
  'create_worktree',
  'list_worktrees',
  'list_repos',
  'create_project',
  'set_worktree_alias',
  'rename_worktree',
  'clear_worktree_alias',
  'set_tab_name',
  'get_worktree_status',
  // Agent-to-agent
  'send_message',
  'list_tabs',
  'subscribe_to_worktree',
  'unsubscribe_from_worktree',
  'list_subscriptions',
  'report_progress',
  // Reviews
  'request_review',
  'list_review_comments',
  'add_review_comment',
  'reply_to_comment',
  'resolve_comment',
  'submit_review',
  // Browser tabs (everything except eval_tab)
  'list_browser_tabs',
  'create_browser_tab',
  'screenshot_tab',
  'get_tab_dom',
  'get_tab_url',
  'get_tab_console_logs',
  'navigate_tab',
  'back_tab',
  'forward_tab',
  'reload_tab',
  'get_tab_clickables',
  'click_tab',
  'type_tab',
  'scroll_tab',
  'show_cursor',
  'set_tab_viewport',
  // Shell tabs (reading and stopping; starting one is create_shell)
  'list_shells',
  'read_shell_output',
  'kill_shell',
  // Asking the user: the tool's whole job is to put a draft in front of a
  // human, so approving it first would ask them twice.
  'edit_copy'
]

export const NESS_ASK_TOOLS: readonly string[] = ['eval_tab', 'create_shell', 'add_repo']

const AUTO_ALLOWED = new Set(NESS_AUTO_ALLOWED_TOOLS)

// Auto-allowed only when the URL they'd load passes isSafeAgentUrl.
const URL_GATED_TOOLS = new Set(['navigate_tab', 'create_browser_tab'])

const LOOPBACK_HOST_RE = /^(?:localhost|[^.]+(?:\.[^.]+)*\.localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i

/** True when an agent may load `raw` in a tab without asking: about:blank,
 *  or http(s) to a loopback host, after the same normalization the browser
 *  managers apply. */
export function isSafeAgentUrl(raw: string): boolean {
  const normalized = normalizeBrowserUrl(raw)
  if (normalized === null) return false
  if (normalized.toLowerCase() === 'about:blank') return true
  let url: URL
  try {
    url = new URL(normalized)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  return LOOPBACK_HOST_RE.test(url.hostname)
}

export interface NessCallContext {
  /** The repo's own (.ness.json) setup command for `repoRoot` (undefined
   *  means the caller's own repo): '' when none, null when it can't be
   *  determined. Absent means unknown, so create_worktree asks. */
  repoSetupCommandFor?: (repoRoot: string | undefined) => string | null
  /** True when `repoRoot` is a repo already open in Ness. Absent means
   *  unknown, so a create_worktree naming a repoRoot asks. */
  isOpenRepo?: (repoRoot: string) => boolean
}

/** The bare tool name for a ness-control tool, or null for anything else. */
export function nessControlToolName(toolName: string): string | null {
  if (toolName.startsWith(NESS_CONTROL_PREFIX)) return toolName.slice(NESS_CONTROL_PREFIX.length)
  return null
}

/** True for a ness-control call that never needs approval. Input-aware:
 *  the URL-gated tools are judged by their url, create_worktree by whether
 *  a setup script would run. */
export function isAutoAllowedNessCall(
  toolName: string,
  input: Record<string, unknown>,
  ctx: NessCallContext = {}
): boolean {
  const bare = nessControlToolName(toolName)
  if (bare === null || !AUTO_ALLOWED.has(bare)) return false
  if (bare === 'create_worktree') {
    if (input['prNumber'] !== undefined && input['prNumber'] !== null) return false
    const rawRoot = input['repoRoot']
    if (rawRoot !== undefined && typeof rawRoot !== 'string') return false
    const repoRoot = rawRoot === undefined || rawRoot === '' ? undefined : rawRoot
    if (repoRoot !== undefined && ctx.isOpenRepo?.(repoRoot) !== true) return false
    return ctx.repoSetupCommandFor?.(repoRoot) === ''
  }
  if (!URL_GATED_TOOLS.has(bare)) return true
  const url = input['url']
  // create_browser_tab with no url opens about:blank.
  if (url === undefined && bare === 'create_browser_tab') return true
  return typeof url === 'string' && isSafeAgentUrl(url)
}

/** Value for Claude's `--allowedTools`, for terminal tabs where Claude
 *  prompts in its own TUI and Ness never sees the request. The flag can't
 *  look at inputs, so the input-gated tools are left out and prompt there. */
export function nessAllowedToolsFlagValue(): string {
  return NESS_AUTO_ALLOWED_TOOLS.filter((t) => !URL_GATED_TOOLS.has(t) && t !== 'create_worktree')
    .map((t) => `${NESS_CONTROL_PREFIX}${t}`)
    .join(',')
}
