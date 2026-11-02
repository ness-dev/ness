import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer } from 'http'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdtempSync, writeFileSync, statSync, rmSync } from 'fs'
import { tmpdir } from 'os'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const BRIDGE = join(__dirname, 'mcp-bridge.js')

function startStub(handler) {
  return new Promise((resolve) => {
    const captured = []
    const server = createServer((req, res) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : {}
        captured.push({
          method: req.method,
          url: req.url,
          auth: req.headers.authorization,
          terminalId: req.headers['x-harness-terminal-id'],
          body
        })
        try {
          handler(req, body, res, captured)
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: String(e) }))
        }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({ port, captured, close: () => new Promise((r) => server.close(() => r())) })
    })
  })
}

function spawnBridge(port, token, extraEnv) {
  const proc = spawn(process.execPath, [BRIDGE], {
    env: {
      ...process.env,
      HARNESS_PORT: String(port),
      HARNESS_TOKEN: token,
      HARNESS_TERMINAL_ID: 'test-terminal',
      ...extraEnv
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let stdoutBuf = ''
  const responses = []
  const pending = []
  proc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString()
    let idx
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx)
      stdoutBuf = stdoutBuf.slice(idx + 1)
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (pending.length) {
          pending.shift()(msg)
        } else {
          responses.push(msg)
        }
      } catch {
        /* ignore non-JSON */
      }
    }
  })
  proc.stderr.on('data', () => {
    /* swallow */
  })
  function send(msg) {
    proc.stdin.write(JSON.stringify(msg) + '\n')
  }
  function next() {
    return new Promise((resolve) => {
      if (responses.length) resolve(responses.shift())
      else pending.push(resolve)
    })
  }
  function kill() {
    proc.kill()
    return new Promise((resolve) => proc.once('exit', () => resolve()))
  }
  return { send, next, kill, proc }
}

describe('mcp-bridge create_worktree', () => {
  let stub
  let bridge

  afterEach(async () => {
    if (bridge) await bridge.kill()
    if (stub) await stub.close()
  })

  it('forwards prNumber to POST /worktrees and reports PR # in result text', async () => {
    stub = await startStub((req, body, res) => {
      if (req.url === '/scope') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ scope: null, browser: { enabled: true, mode: 'full' } }))
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ path: '/tmp/wt', branch: 'feature/pr-head' }))
    })
    bridge = spawnBridge(stub.port, 'secret-token')

    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    await bridge.next()
    bridge.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'create_worktree',
        arguments: { prNumber: 47, initialPrompt: 'review please' }
      }
    })
    const response = await bridge.next()

    expect(response.result.isError).toBeFalsy()
    expect(response.result.content[0].text).toContain('PR #47')
    expect(response.result.content[0].text).toContain('/tmp/wt')
    expect(response.result.content[0].text).toContain('feature/pr-head')

    const postCall = stub.captured.find((c) => c.method === 'POST' && c.url === '/worktrees')
    expect(postCall).toBeDefined()
    expect(postCall.auth).toBe('Bearer secret-token')
    expect(postCall.terminalId).toBe('test-terminal')
    expect(postCall.body.prNumber).toBe(47)
    expect(postCall.body.initialPrompt).toBe('review please')
  })

  it('still supports the new-branch flow when prNumber is absent', async () => {
    stub = await startStub((req, body, res) => {
      if (req.url === '/scope') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ scope: null, browser: { enabled: true, mode: 'full' } }))
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ path: '/tmp/wt-new', branch: 'mybranch' }))
    })
    bridge = spawnBridge(stub.port, 'tok')

    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    await bridge.next()
    bridge.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'create_worktree',
        arguments: { branchName: 'mybranch' }
      }
    })
    const response = await bridge.next()

    expect(response.result.isError).toBeFalsy()
    const text = response.result.content[0].text
    expect(text).toContain('/tmp/wt-new')
    expect(text).toContain('mybranch')
    expect(text).not.toContain('PR #')

    const postCall = stub.captured.find((c) => c.method === 'POST' && c.url === '/worktrees')
    expect(postCall.body.branchName).toBe('mybranch')
    expect(postCall.body.prNumber).toBeUndefined()
  })

  it('returns an error when neither branchName nor prNumber is provided', async () => {
    stub = await startStub((req, body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ scope: null, browser: { enabled: true, mode: 'full' } }))
    })
    bridge = spawnBridge(stub.port, 'tok')

    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    await bridge.next()
    bridge.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'create_worktree', arguments: {} }
    })
    const response = await bridge.next()

    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toMatch(/branchName or prNumber/)
  })

  it('rejects non-integer prNumber locally without hitting the server', async () => {
    stub = await startStub((req, body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ scope: null, browser: { enabled: true, mode: 'full' } }))
    })
    bridge = spawnBridge(stub.port, 'tok')

    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    await bridge.next()
    bridge.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'create_worktree', arguments: { prNumber: -3 } }
    })
    const response = await bridge.next()

    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toMatch(/positive integer/)
    const postCall = stub.captured.find((c) => c.method === 'POST' && c.url === '/worktrees')
    expect(postCall).toBeUndefined()
  })

  it('forwards agentKind + model to POST /worktrees and reports them in result text', async () => {
    stub = await startStub((req, body, res) => {
      if (req.url === '/scope') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ scope: null, browser: { enabled: true, mode: 'full' } }))
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ path: '/tmp/wt-codex', branch: 'feat' }))
    })
    bridge = spawnBridge(stub.port, 'tok')

    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    await bridge.next()
    bridge.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'create_worktree',
        arguments: { branchName: 'feat', agentKind: 'codex', model: 'gpt-5' }
      }
    })
    const response = await bridge.next()

    expect(response.result.isError).toBeFalsy()
    const text = response.result.content[0].text
    expect(text).toContain('Codex')
    expect(text).toContain('gpt-5')

    const postCall = stub.captured.find((c) => c.method === 'POST' && c.url === '/worktrees')
    expect(postCall).toBeDefined()
    expect(postCall.body.agentKind).toBe('codex')
    expect(postCall.body.model).toBe('gpt-5')
  })

  it('rejects unknown agentKind locally without hitting the server', async () => {
    stub = await startStub((req, body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ scope: null, browser: { enabled: true, mode: 'full' } }))
    })
    bridge = spawnBridge(stub.port, 'tok')

    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    await bridge.next()
    bridge.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'create_worktree',
        arguments: { branchName: 'feat', agentKind: 'gemini' }
      }
    })
    const response = await bridge.next()

    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toMatch(/claude.*codex/i)
    const postCall = stub.captured.find((c) => c.method === 'POST' && c.url === '/worktrees')
    expect(postCall).toBeUndefined()
  })

  it('surfaces server-side PR failures back to the caller', async () => {
    stub = await startStub((req, body, res) => {
      if (req.url === '/scope') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ scope: null, browser: { enabled: true, mode: 'full' } }))
      }
      res.writeHead(422, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: "Couldn't fetch PR #99999 from GitHub" }))
    })
    bridge = spawnBridge(stub.port, 'tok')

    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    await bridge.next()
    bridge.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'create_worktree',
        arguments: { prNumber: 99999 }
      }
    })
    const response = await bridge.next()

    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toMatch(/HTTP 422/)
    expect(response.result.content[0].text).toMatch(/99999/)
  })
})

describe('mcp-bridge get_tab_dom', () => {
  let stub
  let bridge

  afterEach(async () => {
    if (bridge) await bridge.kill()
    if (stub) await stub.close()
  })

  async function callGetDom(args, extraEnv) {
    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    await bridge.next()
    bridge.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'get_tab_dom', arguments: args }
    })
    return bridge.next()
  }

  function serveDom(html) {
    return startStub((req, body, res) => {
      if (req.url === '/scope') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ scope: null, browser: { enabled: true, mode: 'full' } }))
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ html }))
    })
  }

  it('passes a small document through untouched', async () => {
    stub = await serveDom('<html><body>hi</body></html>')
    bridge = spawnBridge(stub.port, 'tok')
    const response = await callGetDom({ tab_id: 'tab-1' })
    expect(response.result.content[0].text).toBe('<html><body>hi</body></html>')
  })

  it('caps a heavy page so the markup cannot blow the caller context', async () => {
    stub = await serveDom('<p>' + 'x'.repeat(500_000) + '</p>')
    bridge = spawnBridge(stub.port, 'tok')
    const text = (await callGetDom({ tab_id: 'tab-1' })).result.content[0].text
    expect(text.length).toBeLessThan(101_000)
    expect(text).toMatch(/truncated by Ness: showing the first 100000 of 500007 bytes/)
  })

  it('honours an explicit max_bytes', async () => {
    stub = await serveDom('y'.repeat(5000))
    bridge = spawnBridge(stub.port, 'tok')
    const text = (await callGetDom({ tab_id: 'tab-1', max_bytes: 1000 })).result.content[0].text
    expect(text.startsWith('y'.repeat(1000))).toBe(true)
    expect(text).toMatch(/first 1000 of 5000 bytes/)
  })

  it('reports a timeout instead of hanging when the server never responds', async () => {
    stub = await startStub((req, body, res) => {
      if (req.url === '/scope') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ scope: null, browser: { enabled: true, mode: 'full' } }))
      }
      // Deliberately never respond — the pre-fix hang.
    })
    bridge = spawnBridge(stub.port, 'tok', { HARNESS_CALL_TIMEOUT_MS: '400' })
    const response = await callGetDom({ tab_id: 'tab-1' })
    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toMatch(/did not respond within 400ms/)
  }, 10_000)
})

describe('mcp-bridge log-size cap on startup', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'harness-mcp-log-'))
  })

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('truncates a log file that starts over 10 MB', async () => {
    const logPath = join(tmpDir, 'bridge.log')
    writeFileSync(logPath, Buffer.alloc(15 * 1024 * 1024, 0x2e))
    expect(statSync(logPath).size).toBe(15 * 1024 * 1024)

    const proc = spawn(process.execPath, [BRIDGE], {
      env: {
        ...process.env,
        HARNESS_CONTROL_BRIDGE_LOG: logPath,
        HARNESS_PORT: '',
        HARNESS_TOKEN: ''
      },
      stdio: ['ignore', 'ignore', 'ignore']
    })
    await new Promise((resolve) => proc.once('exit', resolve))

    expect(statSync(logPath).size).toBeLessThan(1024 * 1024)
  })

  it('leaves a small log file alone', async () => {
    const logPath = join(tmpDir, 'small.log')
    writeFileSync(logPath, 'prior boot line\n')
    const seedSize = statSync(logPath).size

    const proc = spawn(process.execPath, [BRIDGE], {
      env: {
        ...process.env,
        HARNESS_CONTROL_BRIDGE_LOG: logPath,
        HARNESS_PORT: '',
        HARNESS_TOKEN: ''
      },
      stdio: ['ignore', 'ignore', 'ignore']
    })
    await new Promise((resolve) => proc.once('exit', resolve))

    expect(statSync(logPath).size).toBeGreaterThan(seedSize)
  })
})

describe('mcp-bridge review tools', () => {
  let stub
  let bridge

  afterEach(async () => {
    if (bridge) await bridge.kill()
    if (stub) await stub.close()
  })

  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  async function start(handler) {
    stub = await startStub((req, body, res, captured) => {
      if (req.url === '/scope') {
        return json(res, 200, { scope: null, messaging: { enabled: true } })
      }
      return handler(req, body, res, captured)
    })
    bridge = spawnBridge(stub.port, 'tok')
    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    await bridge.next()
  }

  let nextId = 10
  async function callTool(name, args) {
    bridge.send({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'tools/call',
      params: { name, arguments: args }
    })
    return bridge.next()
  }

  it('advertises the review tools and list_tabs', async () => {
    await start((req, body, res) => json(res, 404, {}))
    bridge.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    const names = (await bridge.next()).result.tools.map((t) => t.name)
    for (const n of [
      'list_review_comments',
      'add_review_comment',
      'reply_to_comment',
      'resolve_comment',
      'submit_review',
      'request_review',
      'list_tabs'
    ]) {
      expect(names).toContain(n)
    }
  })

  it('add_review_comment forwards to POST /reviews/comments', async () => {
    await start((req, body, res) =>
      json(res, 200, { comment: { id: 'c-1', file: body.file, line: body.line, side: 'new' } })
    )
    const r = await callTool('add_review_comment', { file: 'src/a.ts', line: 12, body: 'nit' })
    expect(r.result.isError).toBeFalsy()
    expect(r.result.content[0].text).toBe('Added comment c-1 on src/a.ts:12')
    const post = stub.captured.find((c) => c.url === '/reviews/comments')
    expect(post.method).toBe('POST')
    expect(post.terminalId).toBe('test-terminal')
    expect(post.body).toEqual({ file: 'src/a.ts', line: 12, body: 'nit' })
  })

  it('add_review_comment validates locally and surfaces server range errors', async () => {
    await start((req, body, res) => json(res, 422, { error: 'line 900 is out of range: src/a.ts has 40 lines' }))
    const bad = await callTool('add_review_comment', { file: 'src/a.ts', line: 0, body: 'x' })
    expect(bad.result.isError).toBe(true)
    expect(stub.captured.find((c) => c.url === '/reviews/comments')).toBeUndefined()
    const r = await callTool('add_review_comment', { file: 'src/a.ts', line: 900, body: 'x' })
    expect(r.result.isError).toBe(true)
    expect(r.result.content[0].text).toMatch(/has 40 lines/)
  })

  it('list_review_comments passes filters as query params', async () => {
    await start((req, body, res) => json(res, 200, { comments: [{ id: 'c-1' }] }))
    const r = await callTool('list_review_comments', { status: 'open', file: 'src/a.ts' })
    expect(JSON.parse(r.result.content[0].text)).toEqual([{ id: 'c-1' }])
    expect(stub.captured.some((c) => c.url === '/reviews/comments?status=open&file=src%2Fa.ts')).toBe(true)
  })

  it('reply_to_comment and resolve_comment map comment_id to commentId', async () => {
    await start((req, body, res) =>
      json(res, 200, {
        comment: {
          id: 'c-1',
          file: 'src/a.ts',
          line: 3,
          status: req.url === '/reviews/resolve' && body.resolved ? 'resolved' : 'open'
        }
      })
    )
    const reply = await callTool('reply_to_comment', { comment_id: 'c-1', body: 'fixed' })
    expect(reply.result.content[0].text).toMatch(/Replied to src\/a.ts:3/)
    expect(stub.captured.find((c) => c.url === '/reviews/replies').body).toEqual({
      commentId: 'c-1',
      body: 'fixed'
    })
    const resolved = await callTool('resolve_comment', { comment_id: 'c-1' })
    expect(resolved.result.content[0].text).toMatch(/^Resolved/)
    const reopened = await callTool('resolve_comment', { comment_id: 'c-1', resolved: false })
    expect(reopened.result.content[0].text).toMatch(/^Reopened/)
  })

  it('submit_review explains a held draft, a delivery, and a failed delivery', async () => {
    const responses = [
      { commentCount: 2, state: 'draft', targetTabId: 'author', delivery: null },
      { commentCount: 1, state: 'sent', targetTabId: 'author', delivery: { ok: true, tabId: 'author', woke: true } },
      { commentCount: 0, state: 'failed', targetTabId: 'term', delivery: { ok: false, error: 'not supported yet' } }
    ]
    await start((req, body, res) => json(res, 200, responses.shift()))
    const draft = await callTool('submit_review', { verdict: 'changes-requested', summary: 's' })
    expect(draft.result.content[0].text).toMatch(/held as a draft.*tab author/)
    const sent = await callTool('submit_review', { verdict: 'approve', summary: 's' })
    expect(sent.result.content[0].text).toMatch(/delivered to tab author \(woke it\)/)
    const failed = await callTool('submit_review', { verdict: 'comment', summary: 's', tab: 'term' })
    expect(failed.result.content[0].text).toMatch(/NOT delivered: not supported yet/)
    expect(stub.captured.filter((c) => c.url === '/reviews/submit').at(-1).body).toEqual({
      verdict: 'comment',
      summary: 's',
      tab: 'term'
    })
  })

  it('request_review opens a reviewer and says what happens next', async () => {
    const responses = [
      { reviewerTabId: 'rev-1', reused: false },
      { reviewerTabId: 'rev-1', reused: true }
    ]
    await start((req, body, res) => json(res, 200, responses.shift()))
    const first = await callTool('request_review', { context: 'added div' })
    expect(first.result.isError).toBeFalsy()
    expect(first.result.content[0].text).toMatch(/Opened a reviewer Chat tab \(tab rev-1\)/)
    expect(first.result.content[0].text).toMatch(/comes back to you as a message/)
    expect(stub.captured.find((c) => c.url === '/reviews/request').body).toEqual({
      context: 'added div'
    })
    const second = await callTool('request_review', { context: 'round two' })
    expect(second.result.content[0].text).toMatch(/Asked the existing reviewer/)
  })

  it('request_review requires context and surfaces a refusal', async () => {
    await start((req, body, res) => json(res, 409, { error: 'only a Chat tab can request a review' }))
    const missing = await callTool('request_review', {})
    expect(missing.result.isError).toBe(true)
    expect(stub.captured.find((c) => c.url === '/reviews/request')).toBeUndefined()
    const refused = await callTool('request_review', { context: 'x' })
    expect(refused.result.isError).toBe(true)
    expect(refused.result.content[0].text).toMatch(/only a Chat tab/)
  })

  it('submit_review rejects an unknown verdict locally', async () => {
    await start((req, body, res) => json(res, 200, {}))
    const r = await callTool('submit_review', { verdict: 'lgtm', summary: 's' })
    expect(r.result.isError).toBe(true)
    expect(stub.captured.find((c) => c.url === '/reviews/submit')).toBeUndefined()
  })

  it('send_message accepts a tab without a worktree', async () => {
    await start((req, body, res) =>
      json(res, 200, { delivered: true, worktreePath: '/wt', tab: 'author', from: 'WT · Reviewer', woke: false })
    )
    const r = await callTool('send_message', { tab: 'author', message: 'hi' })
    expect(r.result.isError).toBeFalsy()
    expect(r.result.content[0].text).toBe('Delivered to /wt (tab author), sent as "WT · Reviewer"')
    expect(stub.captured.find((c) => c.url === '/messages').body).toEqual({ tab: 'author', message: 'hi' })
    const missing = await callTool('send_message', { message: 'hi' })
    expect(missing.result.isError).toBe(true)
  })
})
