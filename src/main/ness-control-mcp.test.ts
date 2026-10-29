import { describe, it, expect } from 'vitest'
import { nessControlMcpServer } from './ness-control-mcp'

describe('nessControlMcpServer', () => {
  it('runs the bridge on the Electron binary, keyed by the chat session id', () => {
    const server = nessControlMcpServer({
      sessionId: 's1',
      controlServer: { port: 4242, token: 'tok' },
      bridgeScriptPath: '/res/mcp-bridge.js',
      scope: { worktreePath: '/wt', repoRoot: '/repo', isMain: true }
    })
    expect(server.command).toBe(process.execPath)
    expect(server.args).toEqual(['/res/mcp-bridge.js'])
    expect(server.env).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      HARNESS_PORT: '4242',
      HARNESS_TOKEN: 'tok',
      HARNESS_TERMINAL_ID: 's1',
      HARNESS_SESSION_ID: 's1',
      HARNESS_WORKTREE_ID: '/wt',
      HARNESS_REPO_ROOT: '/repo',
      HARNESS_IS_MAIN: '1'
    })
  })

  it('omits the scope vars when the caller has no known worktree', () => {
    const server = nessControlMcpServer({
      sessionId: 's1',
      controlServer: { port: 1, token: 't' },
      bridgeScriptPath: '/b.js',
      scope: null
    })
    expect(Object.keys(server.env)).not.toContain('HARNESS_WORKTREE_ID')
    expect(Object.keys(server.env)).not.toContain('HARNESS_IS_MAIN')
  })
})
