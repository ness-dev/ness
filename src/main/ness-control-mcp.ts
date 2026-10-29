// The stdio MCP server entry that gives a chat agent Ness's own tools
// (worktrees, send_message, browser + shell tabs, …). Every chat provider
// injects the same entry — Claude through --mcp-config, Codex through the
// thread's config overrides — so the env contract lives in one place.

export interface NessControlServerInfo {
  port: number
  token: string
}

export interface NessControlCallerScope {
  worktreePath: string
  repoRoot: string
  isMain: boolean
}

export interface StdioMcpServer {
  command: string
  args: string[]
  env: Record<string, string>
}

export function nessControlMcpServer(params: {
  sessionId: string
  controlServer: NessControlServerInfo
  bridgeScriptPath: string
  scope: NessControlCallerScope | null
}): StdioMcpServer {
  const { sessionId, controlServer, bridgeScriptPath, scope } = params
  const env: Record<string, string> = {
    // Run the bridge on the Electron binary so packaged builds need no Node.
    ELECTRON_RUN_AS_NODE: '1',
    HARNESS_PORT: String(controlServer.port),
    HARNESS_TOKEN: controlServer.token,
    // The bridge keys every control-server call by terminal id — for chat
    // tabs the tab id IS the session id.
    HARNESS_TERMINAL_ID: sessionId,
    HARNESS_SESSION_ID: sessionId
  }
  if (scope) {
    env.HARNESS_WORKTREE_ID = scope.worktreePath
    env.HARNESS_REPO_ROOT = scope.repoRoot
    if (scope.isMain) env.HARNESS_IS_MAIN = '1'
  }
  return { command: process.execPath, args: [bridgeScriptPath], env }
}
