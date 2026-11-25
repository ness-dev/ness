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
// ASK holds tools that run arbitrary code: create_shell runs any command
// through a login shell (as dangerous as Bash), and eval_tab runs any script
// with the tab's cookies and logged-in sessions. Those keep going through
// the normal grant / auto-reviewer / human path.

const NESS_CONTROL_PREFIX = 'mcp__ness-control__'
// Grants and transcripts from before the rename still carry the old server
// name, so the Settings cleanup recognises it too.
const LEGACY_NESS_CONTROL_PREFIX = 'mcp__harness-control__'

export const NESS_AUTO_ALLOWED_TOOLS: readonly string[] = [
  // Worktrees, repos and naming
  'create_worktree',
  'list_worktrees',
  'list_repos',
  'create_project',
  'add_repo',
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
  'kill_shell'
]

export const NESS_ASK_TOOLS: readonly string[] = ['eval_tab', 'create_shell']

const AUTO_ALLOWED = new Set(NESS_AUTO_ALLOWED_TOOLS)

/** The bare tool name for a ness-control tool under either server name, or
 *  null for anything else. */
export function nessControlToolName(toolName: string): string | null {
  if (toolName.startsWith(NESS_CONTROL_PREFIX)) return toolName.slice(NESS_CONTROL_PREFIX.length)
  if (toolName.startsWith(LEGACY_NESS_CONTROL_PREFIX)) {
    return toolName.slice(LEGACY_NESS_CONTROL_PREFIX.length)
  }
  return null
}

/** True for a ness-control call that never needs approval. Also true for
 *  the legacy server name, so old "Always allow" grants read as redundant. */
export function isAutoAllowedNessTool(toolName: string): boolean {
  const bare = nessControlToolName(toolName)
  return bare !== null && AUTO_ALLOWED.has(bare)
}

/** Value for Claude's `--allowedTools`, for terminal tabs where Claude
 *  prompts in its own TUI and Ness never sees the request. */
export function nessAllowedToolsFlagValue(): string {
  return NESS_AUTO_ALLOWED_TOOLS.map((t) => `${NESS_CONTROL_PREFIX}${t}`).join(',')
}
