#!/usr/bin/env node
// Throwaway proof of concept: a harness-server in an E2B sandbox, reachable
// from a local Ness as a remote backend, running on the user's Claude
// subscription.
//
//   node poc.mjs up [--auth keychain|token]   create + install + auth + start
//   node poc.mjs proxy [port]                 local proxy adding E2B's traffic token; prints the Add Backend URL
//   node poc.mjs url                          sandbox id + host
//   node poc.mjs auth-check                   claude auth status + claude -p inside
//   node poc.mjs pause-bench [n]              pause/resume latency + what survives
//   node poc.mjs stream-test                  pause in the middle of a model stream
//   node poc.mjs down                         kill the sandbox (stops billing)
//
// Needs E2B_API_KEY in the environment. --auth token also needs
// CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`). Neither is ever printed.
//
// The server binds 0.0.0.0 behind E2B's public per-port URL, guarded only by
// the Ness token. Fine for a POC on a throwaway sandbox, not for shipping.

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Sandbox } from 'e2b'
import { WebSocket } from 'ws'

const HERE = dirname(fileURLToPath(import.meta.url))
const STATE_FILE = join(HERE, '.state.json')
const INSTALLER = join(HERE, '..', 'install-headless.sh')
const VERSION = '2.19.0'
const PORT = 37291
const HOME = '/home/user'
const SERVER_DIR = `${HOME}/.harness-server`
const SERVER_LOG = `${HOME}/server.log`
const DATA_DIR = `${HOME}/.ness-data`
const REPO = `${HOME}/workspace/sample-app`
const BUNDLED_CLAUDE = `${SERVER_DIR}/lib/node_modules/@anthropic-ai/claude-code-linux-x64/claude`

if (!process.env.E2B_API_KEY) {
  console.error('E2B_API_KEY is not set. Export it in your shell (not in chat) and re-run.')
  process.exit(1)
}

const [cmd = 'help', ...rest] = process.argv.slice(2)
const flag = (name, def) => {
  const i = rest.indexOf(name)
  return i >= 0 ? rest[i + 1] : def
}
const now = () => performance.now()
const ms = (t0) => `${Math.round(now() - t0)}ms`

function loadState() {
  if (!existsSync(STATE_FILE)) throw new Error('no sandbox yet; run `up` first')
  return JSON.parse(readFileSync(STATE_FILE, 'utf-8'))
}
function saveState(s) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2))
  chmodSync(STATE_FILE, 0o600)
}

/** Run in the sandbox; throw with output on failure unless allowFail. */
async function sh(sbx, script, { root = false, envs, timeoutMs = 300_000, allowFail = false } = {}) {
  try {
    const r = await sbx.commands.run(script, { user: root ? 'root' : 'user', envs, timeoutMs })
    return r
  } catch (e) {
    if (allowFail) return { exitCode: e.exitCode ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(e) }
    throw new Error(`sandbox command failed: ${script.split('\n')[0]}\n${e.stderr ?? ''}${e.stdout ?? ''}${e.message ?? ''}`)
  }
}

function readKeychainCredentials() {
  const raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
    encoding: 'utf-8'
  }).trim()
  const parsed = JSON.parse(raw)
  if (!parsed.claudeAiOauth?.accessToken) throw new Error('keychain item has no claudeAiOauth.accessToken')
  return { raw, expiresAt: parsed.claudeAiOauth.expiresAt, subscriptionType: parsed.claudeAiOauth.subscriptionType }
}

/** Env every claude process in the sandbox gets: the token for --auth token. */
function authEnvs(state) {
  return state.auth === 'token' ? { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '' } : {}
}

async function startServer(sbx, state) {
  // nohup + redirected fds so the server outlives the envd command that
  // launched it, same as ssh-bootstrap's startServerDetached.
  await sh(
    sbx,
    `nohup env HARNESS_AUTH_TOKEN=${state.serverToken} HARNESS_DATA_DIR=${DATA_DIR} ` +
      `${SERVER_DIR}/bin/harness-server --host 0.0.0.0 --port ${PORT} > ${SERVER_LOG} 2>&1 < /dev/null &\necho $! > ${HOME}/server.pid`,
    { envs: authEnvs(state) }
  )
  const t0 = now()
  while (now() - t0 < 30_000) {
    const r = await sh(
      sbx,
      `curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:${PORT}/?token=${state.serverToken}'`,
      { allowFail: true }
    )
    if (r.stdout.trim() === '200') return ms(t0)
    await new Promise((res) => setTimeout(res, 500))
  }
  const log = await sh(sbx, `tail -n 40 ${SERVER_LOG}`, { allowFail: true })
  throw new Error(`harness-server did not answer within 30s:\n${log.stdout}`)
}

function printConnect(sbx, state) {
  console.log(`\nsandbox ${state.sandboxId} at ${sbx.getHost(PORT)}`)
  console.log('public traffic is off: run `node poc.mjs proxy` and add the URL it prints to Ness\n')
}

async function up() {
  const auth = flag('--auth', 'keychain')
  if (auth === 'token' && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new Error('--auth token needs CLAUDE_CODE_OAUTH_TOKEN in your env (run `claude setup-token` locally)')
  }
  const timings = {}
  let t0 = now()
  let sbx
  try {
    sbx = await Sandbox.create('base', {
      cpuCount: 2,
      memoryMB: 4096,
      timeoutMs: 60 * 60_000,
      lifecycle: { onTimeout: 'pause' }
    })
  } catch (e) {
    // The base template may be fixed-size; take what it offers rather than fail.
    console.log(`create with 2 vCPU / 4 GiB refused (${e.message}); falling back to template defaults`)
    sbx = await Sandbox.create('base', { timeoutMs: 60 * 60_000, lifecycle: { onTimeout: 'pause' } })
  }
  timings.create = ms(t0)
  const state = { sandboxId: sbx.sandboxId, serverToken: randomBytes(32).toString('hex'), auth }
  saveState(state)
  const info = await sbx.getInfo()
  console.log(`created ${sbx.sandboxId} (${info.cpuCount} vCPU, ${info.memoryMB} MiB) in ${timings.create}`)

  t0 = now()
  await sh(
    sbx,
    'DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq zsh git ripgrep curl ca-certificates >/dev/null',
    { root: true }
  )
  timings.apt = ms(t0)

  t0 = now()
  await sbx.files.write(`${HOME}/install-headless.sh`, readFileSync(INSTALLER, 'utf-8'))
  await sh(sbx, `HARNESS_SERVER_VERSION=${VERSION} sh ${HOME}/install-headless.sh`, { timeoutMs: 600_000 })
  // Terminal tabs run PATH `claude`; point it at the bundled one.
  await sh(sbx, `ln -sf ${BUNDLED_CLAUDE} /usr/local/bin/claude`, { root: true })
  timings.installServer = ms(t0)

  // A repo to manage, registered the same way docker/entrypoint.sh does.
  await sh(
    sbx,
    [
      'git config --global user.email ness-e2b@invalid.local',
      'git config --global user.name "Ness E2B"',
      `mkdir -p ${REPO} ${DATA_DIR}`,
      `cd ${REPO} && git init -q -b main && printf '# sample-app\\n' > README.md && printf 'export const greet = (n) => \`Hello, \${n}!\`\\n' > greet.js && git add -A && git commit -qm "Initial commit"`,
      `printf '{"repoRoots":["${REPO}"]}' > ${DATA_DIR}/config.json`
    ].join('\n')
  )

  if (auth === 'keychain') {
    const creds = readKeychainCredentials()
    await sh(sbx, `mkdir -p ${HOME}/.claude && chmod 700 ${HOME}/.claude`)
    await sbx.files.write(`${HOME}/.claude/.credentials.json`, creds.raw)
    await sh(sbx, `chmod 600 ${HOME}/.claude/.credentials.json`)
    state.copiedExpiresAt = creds.expiresAt
    saveState(state)
    console.log(
      `copied keychain login (${creds.subscriptionType ?? 'unknown'} plan; access token expires ${new Date(creds.expiresAt).toISOString()})`
    )
  }
  // Skips claude's first-run onboarding in terminal tabs.
  await sbx.files.write(`${HOME}/.claude.json`, JSON.stringify({ hasCompletedOnboarding: true }))

  timings.serverReady = await startServer(sbx, state)
  console.log('timings:', timings)
  printConnect(sbx, state)
  await authCheck(sbx, state)
}

async function connect() {
  const state = loadState()
  const sbx = await Sandbox.connect(state.sandboxId)
  return { sbx, state }
}

async function authCheck(sbx, state) {
  const envs = authEnvs(state)
  const status = await sh(sbx, 'claude auth status 2>&1', { envs, allowFail: true })
  console.log(`claude auth status (exit ${status.exitCode}):\n${status.stdout}${status.stderr}`)
  const t0 = now()
  const hi = await sh(sbx, `cd ${REPO} && claude -p "say hi in five words" --output-format json 2>&1`, {
    envs,
    allowFail: true,
    timeoutMs: 120_000
  })
  console.log(`claude -p (exit ${hi.exitCode}, ${ms(t0)}):`)
  try {
    const r = JSON.parse(hi.stdout)
    // apiKeySource reports where auth came from; "none" plus a result means
    // OAuth (subscription). total_cost_usd is computed either way, so it
    // doesn't prove API billing on its own.
    console.log({ result: r.result, is_error: r.is_error, total_cost_usd: r.total_cost_usd, model: Object.keys(r.modelUsage ?? {}) })
  } catch {
    console.log(hi.stdout.slice(0, 2000), hi.stderr?.slice(0, 2000))
  }
  const init = await sh(
    sbx,
    `cd ${REPO} && claude -p "ok" --output-format stream-json --verbose 2>&1 | head -1`,
    { envs, allowFail: true, timeoutMs: 120_000 }
  )
  try {
    const first = JSON.parse(init.stdout)
    console.log('auth source from init event:', { apiKeySource: first.apiKeySource, model: first.model })
  } catch {
    console.log('init line:', init.stdout.slice(0, 500))
  }
}

async function serverAlive(sbx, state) {
  const r = await sh(
    sbx,
    `kill -0 $(cat ${HOME}/server.pid) 2>/dev/null && echo alive || echo dead; curl -s -o /dev/null -w '%{http_code}' --max-time 5 'http://127.0.0.1:${PORT}/?token=${state.serverToken}'`,
    { allowFail: true }
  )
  return r.stdout.trim().replace('\n', ' http=')
}

/** Open a Ness WS client against the public URL; resolves once the snapshot arrives. */
function openWs(sbx, state, onClose) {
  return new Promise((resolve, reject) => {
    const t0 = now()
    const ws = new WebSocket(`wss://${sbx.getHost(PORT)}/?token=${encodeURIComponent(state.serverToken)}`, {
      headers: { 'e2b-traffic-access-token': sbx.trafficAccessToken }
    })
    const timer = setTimeout(() => reject(new Error('ws snapshot timeout')), 20_000)
    ws.on('open', () => ws.send(JSON.stringify({ t: 'snapreq', id: '1' })))
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString())
      if (f.t === 'snapres') {
        clearTimeout(timer)
        resolve({ ws, latency: ms(t0) })
      }
    })
    ws.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    ws.on('close', (code) => onClose?.(code))
  })
}

async function pauseBench(n) {
  let { sbx, state } = await connect()
  const rows = []
  for (let i = 0; i < n; i++) {
    let closedAt = null
    let closeCode = null
    const { ws } = await openWs(sbx, state, (code) => {
      closedAt = now()
      closeCode = code
    })
    const t0 = now()
    await sbx.pause()
    const pauseMs = Math.round(now() - t0)
    const wsClosedDuringPause = closedAt !== null
    const t1 = now()
    sbx = await Sandbox.connect(state.sandboxId)
    const resumeMs = Math.round(now() - t1)
    const t2 = now()
    const alive = await serverAlive(sbx, state)
    const firstCmdMs = Math.round(now() - t2)
    // Did the pre-pause socket survive? Give a dead one a moment to report.
    await new Promise((r) => setTimeout(r, 3000))
    const oldWs = ws.readyState === WebSocket.OPEN ? 'still open' : `closed (code ${closeCode})`
    ws.terminate()
    let reconnect
    try {
      reconnect = (await openWs(sbx, state)).latency
    } catch (e) {
      reconnect = `failed: ${e.message}`
    }
    rows.push({ i, pauseMs, resumeMs, firstCmdMs, server: alive, oldWs, wsClosedDuringPause, reconnect })
    console.log(rows[rows.length - 1])
  }
  const med = (k) => rows.map((r) => r[k]).sort((a, b) => a - b)[Math.floor(rows.length / 2)]
  console.log(`median pause ${med('pauseMs')}ms, resume ${med('resumeMs')}ms, first command after resume ${med('firstCmdMs')}ms`)
}

async function streamTest() {
  let { sbx, state } = await connect()
  const out = `${HOME}/stream.out`
  await sh(sbx, `rm -f ${out} ${out}.exit`)
  // A response long enough (~1-2 min) to pause in the middle of. envd waits
  // on the whole process group, so `nohup … &` inside a foreground run still
  // blocks until claude exits; the SDK's background mode doesn't.
  await sbx.commands.run(
    `cd ${REPO} && claude -p "Write the numbers 1 to 600, each on its own line as English words. No other text." --output-format stream-json --verbose --include-partial-messages > ${out} 2>&1; echo $? > ${out}.exit`,
    { background: true, envs: authEnvs(state), timeoutMs: 0 }
  )
  const lines = async () => Number((await sh(sbx, `wc -l < ${out} 2>/dev/null || echo 0`, { allowFail: true })).stdout.trim())
  const done = async () => (await sh(sbx, `cat ${out}.exit 2>/dev/null`, { allowFail: true })).stdout.trim()
  const t0 = now()
  // Wait for text deltas to be flowing, not just the init event.
  while ((await lines()) < 60 && now() - t0 < 90_000) await new Promise((r) => setTimeout(r, 1000))
  const before = await lines()
  if (await done()) throw new Error('response finished before the pause; make the prompt longer')
  console.log(`streaming: ${before} lines after ${ms(t0)}; pausing for 20s`)
  await sbx.pause()
  await new Promise((r) => setTimeout(r, 20_000))
  sbx = await Sandbox.connect(state.sandboxId)
  const after = await lines()
  await new Promise((r) => setTimeout(r, 5000))
  console.log(`resumed; lines right after resume: ${after}, 5s later: ${await lines()}`)
  const t1 = now()
  let exit = ''
  while (now() - t1 < 180_000) {
    exit = (await sh(sbx, `cat ${out}.exit 2>/dev/null`, { allowFail: true })).stdout.trim()
    if (exit) break
    await new Promise((r) => setTimeout(r, 2000))
  }
  const tail = await sh(sbx, `grep '"type":"result"' ${out} | tail -1; echo; tail -n 3 ${out} | cut -c1-400`, { allowFail: true })
  console.log(`claude exit code: ${exit || '(still running after 3 min)'}; total lines ${await lines()}`)
  const result = tail.stdout.split('\n').find((l) => l.startsWith('{') && l.includes('"type":"result"'))
  if (result) {
    const r = JSON.parse(result)
    console.log({ subtype: r.subtype, is_error: r.is_error, duration_ms: r.duration_ms, num_turns: r.num_turns, tail: String(r.result ?? '').slice(-200) })
  } else {
    console.log('no result event; tail:\n', tail.stdout)
  }
}

/** Loopback reverse proxy that adds E2B's traffic token. Sandboxes default to
 *  allowPublicTraffic:false, and a browser-side WebSocket (Ness's renderer
 *  transport) can't set the required header, so something local has to. */
async function proxy(localPort) {
  const { sbx, state } = await connect()
  const host = sbx.getHost(PORT)
  const auth = { 'e2b-traffic-access-token': sbx.trafficAccessToken }
  const { createServer } = await import('node:http')
  const { request } = await import('node:https')
  const forwardHeaders = (h) => ({ ...h, host, ...auth })
  const server = createServer((req, res) => {
    const up = request({ host, path: req.url, method: req.method, headers: forwardHeaders(req.headers) }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers)
      r.pipe(res)
    })
    up.on('error', (e) => {
      res.writeHead(502)
      res.end(String(e))
    })
    req.pipe(up)
  })
  server.on('upgrade', (req, socket, head) => {
    const up = request({ host, path: req.url, method: req.method, headers: forwardHeaders(req.headers) })
    up.on('upgrade', (r, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${r.statusCode} ${r.statusMessage}`]
      for (let i = 0; i < r.rawHeaders.length; i += 2) lines.push(`${r.rawHeaders[i]}: ${r.rawHeaders[i + 1]}`)
      socket.write(lines.join('\r\n') + '\r\n\r\n')
      if (upHead?.length) socket.write(upHead)
      if (head?.length) upSocket.write(head)
      upSocket.pipe(socket).pipe(upSocket)
      const end = () => {
        socket.destroy()
        upSocket.destroy()
      }
      upSocket.on('error', end).on('close', end)
      socket.on('error', end).on('close', end)
    })
    up.on('response', (r) => {
      socket.end(`HTTP/1.1 ${r.statusCode} ${r.statusMessage}\r\n\r\n`)
    })
    up.on('error', () => socket.destroy())
    up.end()
  })
  server.listen(localPort, '127.0.0.1', () => {
    console.log(`proxying 127.0.0.1:${localPort} → ${host}`)
    console.log(`Add Backend URL:\n  http://127.0.0.1:${localPort}/?token=${state.serverToken}`)
  })
}

async function main() {
  switch (cmd) {
    case 'proxy':
      return proxy(Number(rest[0] ?? 47291))
    case 'up':
      return up()
    case 'url': {
      const { sbx, state } = await connect()
      return printConnect(sbx, state)
    }
    case 'auth-check': {
      const { sbx, state } = await connect()
      return authCheck(sbx, state)
    }
    case 'restart-server': {
      const { sbx, state } = await connect()
      await sh(sbx, `kill $(cat ${HOME}/server.pid) 2>/dev/null; sleep 1`, { allowFail: true })
      console.log('ready in', await startServer(sbx, state))
      return printConnect(sbx, state)
    }
    case 'pause-bench':
      return pauseBench(Number(rest[0] ?? 5))
    case 'stream-test':
      return streamTest()
    case 'down': {
      const state = loadState()
      const killed = await Sandbox.kill(state.sandboxId)
      console.log(killed ? `killed ${state.sandboxId}` : `${state.sandboxId} was already gone`)
      return
    }
    default:
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf-8').split('\n').slice(1, 12).join('\n'))
  }
}

main().catch((e) => {
  console.error(e.message ?? e)
  process.exit(1)
})
