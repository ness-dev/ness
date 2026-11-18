#!/usr/bin/env node
// Evidence reviewer: an agent loop that drives a running web app with
// Playwright and gathers screenshot evidence for (or against) the claims a
// PR makes.
//
// Deliberately app-agnostic. It only knows:
//   - one or two URLs ("after" = PR head, optionally "before" = PR base)
//   - a markdown instructions file describing how to use the app
//   - a PR context file (title, body, per-file diffs)
//   - optionally, a checkout of the PR head it may read and grep
// Booting the app, seeding fixtures and publishing the report are the
// caller's job, so another repo can reuse this by swapping those pieces.
//
// Usage:
//   node run.mjs --after <url> [--before <url>] --instructions <md>
//                --pr <json> --out <dir>
//                [--repo-dir <dir>]      PR head checkout (default: cwd)
//                [--ui-paths a/,b/]      path prefixes whose diffs go first
// Env:
//   OPENROUTER_API_KEY   required
//   EVIDENCE_MODEL       default anthropic/claude-haiku-5.5
//   EVIDENCE_MAX_STEPS   default 40
//   EVIDENCE_RUN_BUDGET_USD  default 1. Stop the run (and refuse agent
//                        proxy calls) once the reviewer plus agents in the
//                        app have spent this much.
//
// Agents running INSIDE the app under test never see the OpenRouter key.
// They're configured (by the boot script) to call http://127.0.0.1:<port>
// with a dummy token, and this process forwards those requests to
// OpenRouter's Anthropic-compatible endpoint with the real key added. A
// prompt-injected agent that dumps its own config or env therefore has
// nothing to leak into a screenshot. Captures and reports are also
// scrubbed for anything key-shaped as a backstop.

import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const require = createRequire(resolve(process.cwd(), 'package.json'))
const { chromium } = require('playwright-core')

const args = parseArgs(process.argv.slice(2))
const OUT = resolve(args.out || 'evidence-out')
const MODEL = process.env.EVIDENCE_MODEL || 'anthropic/claude-haiku-5.5'
const MAX_STEPS = Number(process.env.EVIDENCE_MAX_STEPS || 40)
const API_KEY = process.env.OPENROUTER_API_KEY
const VIEWPORT = { width: 1440, height: 900 }
const KEEP_IMAGES = 3
const KEEP_FULL_TOOL_TEXT = 4
const DIFF_BUDGET = 60000
const PER_FILE_DIFF = 12000
// Below this share of the step budget, a finish that leaves claims
// inconclusive is bounced back once or twice with a nudge to dig deeper.
// Cheap models otherwise give up after a handful of turns.
const MIN_EFFORT = 0.5
const MAX_FINISH_REJECTIONS = 2
const RUN_BUDGET = Number(process.env.EVIDENCE_RUN_BUDGET_USD || 1)
const AGENT_PROXY_PORT = Number(args['agent-proxy-port'] || 37700)
const SECRET_RE = /sk-or-v1-[A-Za-z0-9]{16,}/g
const REPO_DIR = resolve(args['repo-dir'] || process.cwd())
const UI_PATHS = (args['ui-paths'] || '').split(',').map((s) => s.trim()).filter(Boolean)

if (!API_KEY) fail('OPENROUTER_API_KEY is not set')
if (!args.after) fail('--after <url> is required')
mkdirSync(OUT, { recursive: true })

const instructions = args.instructions ? readFileSync(args.instructions, 'utf8') : ''
let agentProxyRequests = 0
let agentCost = 0
const agentProxy = startAgentProxy()
const pr = JSON.parse(readFileSync(args.pr, 'utf8'))

const browser = await chromium.launch({
  channel: process.env.HARNESS_PLAYWRIGHT_BROWSER ? undefined : 'chrome',
  executablePath: process.env.HARNESS_PLAYWRIGHT_BROWSER || undefined
})

const apps = {}
for (const name of ['after', 'before']) {
  if (!args[name]) continue
  const page = await browser.newPage({ viewport: VIEWPORT })
  const consoleErrors = []
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text().slice(0, 300)))
  page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 300)))
  await page.goto(args[name], { waitUntil: 'load' })
  await page.waitForTimeout(2500)
  apps[name] = { page, consoleErrors, url: args[name] }
}
const appNames = Object.keys(apps)

const evidence = []
const transcript = []
let usage = { prompt: 0, completion: 0, cost: 0 }
let result = null
let plan = null
let finishRejections = 0
let currentStep = 0

const tools = [
  tool('plan', 'Record your test plan before touching the app. One entry per user-visible claim.', {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string', description: 'What the PR says a user will see or be able to do.' },
          code: { type: 'string', description: 'Files/components that implement it, from the diff.' },
          how_to_reach: { type: 'string', description: 'Concrete UI path to the state that proves it: what to click, which menu, which tab type, which setting.' },
          proof: { type: 'string', description: 'What the before and after screenshots should each show.' }
        },
        required: ['claim', 'how_to_reach', 'proof']
      }
    }
  }, ['claims']),
  tool('read_diff', 'Read the full diff of one changed file. Use this for any file whose diff was omitted or truncated in the prompt.', {
    path: { type: 'string' }
  }, ['path']),
  tool('read_file', 'Read a file from the PR head checkout (the "after" code), e.g. to see where a component is mounted or what gates it.', {
    path: { type: 'string' },
    start_line: { type: 'integer', description: '1-based, default 1' }
  }, ['path']),
  tool('search_code', 'git grep the PR head checkout. Use it to find where a component is rendered, which setting/flag/menu shows it, or the exact UI label text.', {
    query: { type: 'string', description: 'Fixed string, case-insensitive.' }
  }, ['query']),
  tool('observe', 'Take a screenshot of an app and list its visible interactive elements with numeric ids.', {
    app: appEnum()
  }, ['app']),
  tool('click', 'Click an element by the id from the latest observe of that app, or at raw x/y coordinates.', {
    app: appEnum(),
    id: { type: 'integer' },
    x: { type: 'number' },
    y: { type: 'number' },
    button: { type: 'string', enum: ['left', 'right', 'middle'] },
    double: { type: 'boolean' },
    modifiers: { type: 'array', items: { type: 'string', enum: ['Shift', 'Alt', 'Control', 'Meta'] } }
  }, ['app']),
  tool('hover', 'Move the mouse over an element by id.', { app: appEnum(), id: { type: 'integer' } }, ['app', 'id']),
  tool('type', 'Type text. If id is given, that element is focused first.', {
    app: appEnum(),
    text: { type: 'string' },
    id: { type: 'integer' }
  }, ['app', 'text']),
  tool('press', 'Press a key or chord, e.g. "Enter", "Escape", "Meta+k", "Control+Shift+P".', {
    app: appEnum(),
    key: { type: 'string' }
  }, ['app', 'key']),
  tool('scroll', 'Scroll the page (or the element under id) by dy pixels.', {
    app: appEnum(),
    dy: { type: 'number' },
    id: { type: 'integer' }
  }, ['app', 'dy']),
  tool('wait_for_text', 'Wait until NEW occurrences of text appear in an app (case-insensitive), e.g. an agent reply. Counts occurrences already on screen when called and waits for the count to rise, so a prompt that contains the word doesn\'t count. Call it right after sending. Returns as soon as it rises, or after timeout_s, then observes.', {
    app: appEnum(),
    text: { type: 'string' },
    timeout_s: { type: 'number', description: 'Default 30, max 120.' }
  }, ['app', 'text']),
  tool('find_text', 'Search the visible DOM text of an app for a string (case-insensitive). Returns matching snippets.', {
    app: appEnum(),
    query: { type: 'string' }
  }, ['app', 'query']),
  tool('capture_evidence', 'Save the current screenshot as evidence for the report. With app "both" it saves a before/after pair shown side by side. Call this whenever the screen proves or disproves a claim. Returns an evidence id.', {
    app: appEnum(),
    caption: { type: 'string', description: 'What this screenshot shows and why it matters, one sentence.' }
  }, ['app', 'caption']),
  tool('finish', 'End the review with a verdict. Must cite evidence ids.', {
    verdict: { type: 'string', enum: ['verified', 'partially_verified', 'refuted', 'inconclusive', 'not_visual'] },
    summary: { type: 'string', description: '2-4 sentences for the PR author.' },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          status: { type: 'string', enum: ['verified', 'refuted', 'inconclusive', 'not_testable'] },
          evidence: { type: 'array', items: { type: 'string' } },
          notes: { type: 'string' }
        },
        required: ['claim', 'status']
      }
    }
  }, ['verdict', 'summary', 'claims'])
]

const messages = [
  { role: 'system', content: systemPrompt() },
  { role: 'user', content: prPrompt() }
]

let overBudget = false
for (let step = 0; step < MAX_STEPS && !result; step++) {
  const remaining = MAX_STEPS - step
  if (!overBudget && runSpend() > RUN_BUDGET) {
    overBudget = true
    messages.push({ role: 'user', content: `The run's $${RUN_BUDGET} budget is used up. Call finish now with what you have.` })
  }
  if (remaining === 3) {
    messages.push({ role: 'user', content: 'You have 3 steps left. Capture any final evidence and call finish.' })
  }
  currentStep = step
  const forced = step === 0 ? 'plan' : remaining === 1 || overBudget ? 'finish' : null
  const reply = await chat(messages, forced ? { type: 'function', function: { name: forced } } : 'auto')
  const msg = reply.choices?.[0]?.message
  if (!msg) fail(`no message in response: ${JSON.stringify(reply).slice(0, 500)}`)
  messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls })
  if (msg.content) log(`think: ${msg.content.slice(0, 400)}`)

  if (!msg.tool_calls?.length) {
    messages.push({ role: 'user', content: 'Use a tool. Call finish when you are done.' })
    continue
  }

  const images = []
  for (const call of msg.tool_calls) {
    let input = {}
    try {
      input = JSON.parse(call.function.arguments || '{}')
    } catch {}
    log(`tool: ${call.function.name} ${JSON.stringify(input).slice(0, 200)}`)
    let out
    try {
      out = await runTool(call.function.name, input)
    } catch (e) {
      out = { text: `error: ${e.message.split('\n')[0]}` }
    }
    transcript.push({ step, tool: call.function.name, input, result: out.text.slice(0, 500) })
    messages.push({ role: 'tool', tool_call_id: call.id, content: out.text })
    images.push(...(out.images || []))
  }
  pruneOldToolText()
  if (images.length) {
    pruneOldImages()
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: 'Screenshot(s) from the tool call(s) above:' },
        ...images.flatMap(({ label, b64 }) => [
          { type: 'text', text: `${label}:` },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }
        ])
      ]
    })
  }
}

if (!result) {
  result = { verdict: 'inconclusive', summary: `Agent ran out of steps (${MAX_STEPS}) without finishing.`, claims: [] }
}

await browser.close()
agentProxy.closeAllConnections?.()
agentProxy.close()
const runCost = runSpend()

writeFileSync(join(OUT, 'result.json'), redact(JSON.stringify({ model: MODEL, usage, runCost, agentCost, agentProxyRequests, plan, result, evidence, transcript }, null, 2)))
writeFileSync(join(OUT, 'report.md'), redact(renderReport()))
log(`done: ${result.verdict} (${evidence.length} screenshots, $${usage.cost.toFixed(4)})`)

async function runTool(name, input) {
  switch (name) {
    case 'finish':
      return tryFinish(input)
    case 'plan':
      plan = input.claims || []
      return { text: `Plan recorded (${plan.length} claims). Now work through it. Read code with search_code/read_file whenever you don't know how to reach a state.` }
    case 'read_diff': {
      const d = pr.fileDiffs[input.path]
      if (!d) return { text: `No diff for "${input.path}". Changed files:\n${changedPaths().join('\n')}` }
      return { text: d.length > 40000 ? d.slice(0, 40000) + '\n…[truncated]' : d }
    }
    case 'read_file':
      return readRepoFile(input.path, input.start_line || 1)
    case 'search_code':
      return searchCode(input.query)
  }
  if (input.app === 'both') return runOnBoth(name, input)
  const app = apps[input.app]
  if (!app) return { text: `unknown app "${input.app}". Available: ${appSelectors().join(', ')}` }
  const { page } = app

  switch (name) {
    case 'observe':
      return observe(app)
    case 'click': {
      if (input.id != null) {
        const loc = page.locator(`[data-ev-id="${input.id}"]`).first()
        const opts = { button: input.button || 'left', timeout: 3000, modifiers: input.modifiers }
        input.double ? await loc.dblclick(opts) : await loc.click(opts)
      } else if (input.x != null && input.y != null) {
        try {
          for (const m of input.modifiers || []) await page.keyboard.down(m)
          await page.mouse.click(input.x, input.y, { button: input.button || 'left', clickCount: input.double ? 2 : 1 })
        } finally {
          for (const m of input.modifiers || []) await page.keyboard.up(m)
        }
      } else return { text: 'click needs id or x+y' }
      return settleAndObserve(app)
    }
    case 'hover':
      await page.locator(`[data-ev-id="${input.id}"]`).first().hover({ timeout: 3000 })
      return settleAndObserve(app)
    case 'type':
      if (input.id != null) await page.locator(`[data-ev-id="${input.id}"]`).first().click({ timeout: 3000 })
      await page.keyboard.type(input.text, { delay: 10 })
      return settleAndObserve(app)
    case 'press':
      await page.keyboard.press(input.key)
      return settleAndObserve(app)
    case 'scroll':
      if (input.id != null) await page.locator(`[data-ev-id="${input.id}"]`).first().hover({ timeout: 3000 })
      await page.mouse.wheel(0, input.dy)
      return settleAndObserve(app)
    case 'wait_for_text': {
      const timeout = Math.min(120, input.timeout_s || 30) * 1000
      const occurrences = (t) => document.body.innerText.toLowerCase().split(t.toLowerCase()).length - 1
      const baseline = await page.evaluate(occurrences, input.text)
      const found = await page
        .waitForFunction(
          ([t, n]) => document.body.innerText.toLowerCase().split(t.toLowerCase()).length - 1 > n,
          [input.text, baseline],
          { timeout, polling: 500 }
        )
        .then(() => true, () => false)
      const out = await settleAndObserve(app)
      return { ...out, text: `${found ? 'appeared' : `not seen after ${timeout / 1000}s`}: "${input.text}"\n${out.text}` }
    }
    case 'find_text': {
      const snippets = await page.evaluate((q) => {
        const text = document.body.innerText
        const lower = text.toLowerCase()
        const needle = q.toLowerCase()
        const hits = []
        let i = lower.indexOf(needle)
        while (i !== -1 && hits.length < 10) {
          hits.push(text.slice(Math.max(0, i - 60), i + needle.length + 60).replace(/\s+/g, ' '))
          i = lower.indexOf(needle, i + needle.length)
        }
        return hits
      }, input.query)
      return { text: snippets.length ? snippets.map((s) => `… ${s} …`).join('\n') : 'no matches' }
    }
    case 'capture_evidence': {
      if (await showsSecret(page)) return { text: 'refused: the screen contains an API key. Clear or close it, then capture again.' }
      const id = `E${evidence.length + 1}`
      const file = `${id}-${input.app}.png`
      await page.screenshot({ path: join(OUT, file) })
      evidence.push({ id, app: input.app, caption: input.caption, files: { [input.app]: file } })
      return { text: `saved as ${id}` }
    }
    default:
      return { text: `unknown tool ${name}` }
  }
}

// "both" runs the same action on before and after so the two stay in the
// same UI state, which is what makes a captured pair a fair comparison.
// Element ids come from the after app's last observe; the before app
// clicks whichever of its own elements has the same role + name (and the
// same rank among duplicates), since ids are assigned per page.
async function runOnBoth(name, input) {
  if (name === 'capture_evidence') {
    for (const appName of ['before', 'after']) {
      if (await showsSecret(apps[appName].page)) return { text: `refused: the ${appName} screen contains an API key. Clear or close it, then capture again.` }
    }
    const id = `E${evidence.length + 1}`
    const files = {}
    for (const appName of ['before', 'after']) {
      files[appName] = `${id}-${appName}.png`
      await apps[appName].page.screenshot({ path: join(OUT, files[appName]) })
    }
    evidence.push({ id, app: 'both', caption: input.caption, files })
    return { text: `saved before/after pair as ${id}` }
  }
  const texts = {}
  const images = []
  for (const appName of ['before', 'after']) {
    let mapped = { ...input, app: appName }
    if (appName === 'before' && input.id != null) {
      const beforeId = translateId(input.id)
      if (beforeId == null) {
        texts.before = `[before] no element matching after's [${input.id}]; action skipped. Act on "before" directly with its own ids.`
        continue
      }
      mapped.id = beforeId
    }
    try {
      const out = await runTool(name, mapped)
      texts[appName] = `[${appName}] ${out.text}`
      images.push(...(out.images || []))
    } catch (e) {
      texts[appName] = `[${appName}] error: ${e.message.split('\n')[0]}`
    }
  }
  if (texts.before?.includes('interactive elements:') && texts.after?.includes('interactive elements:')) {
    texts.before = texts.before.split('interactive elements:')[0] + elementDiff()
  }
  return { text: [texts.after, texts.before].filter(Boolean).join('\n\n'), images }
}

// The before list is usually near-identical to after's, so only its
// differences are shown. Ids in "both" actions come from after's list.
function elementDiff() {
  const count = (list) => list.reduce((m, e) => m.set(e.key, (m.get(e.key) || 0) + 1), new Map())
  const before = apps.before.elements || []
  const after = apps.after.elements || []
  const afterCounts = count(after)
  const beforeCounts = count(before)
  const onlyBefore = before.filter((e) => (afterCounts.get(e.key) || 0) < (beforeCounts.get(e.key) || 0))
  const onlyAfter = after.filter((e) => (beforeCounts.get(e.key) || 0) < (afterCounts.get(e.key) || 0))
  if (!onlyBefore.length && !onlyAfter.length) return `interactive elements: same ${before.length} as after.`
  return [
    `interactive elements: ${before.length}, same as after except:`,
    ...onlyBefore.slice(0, 30).map((e) => `  only in before: ${e.line}`),
    ...onlyAfter.slice(0, 30).map((e) => `  only in after:  ${e.line.replace(/^\[\d+\] /, '')}`)
  ].join('\n')
}

function translateId(afterId) {
  const after = apps.after.elements || []
  const target = after.find((e) => e.id === afterId)
  if (!target) return null
  const rank = after.filter((e) => e.key === target.key && e.id < afterId).length
  const matches = (apps.before.elements || []).filter((e) => e.key === target.key)
  return matches[rank]?.id ?? null
}

function tryFinish(input) {
  const claims = input.claims || []
  const weak = claims.filter((c) => c.status === 'inconclusive')
  const uiChanged = changedPaths().some(isUi)
  const wronglyNotVisual = input.verdict === 'not_visual' && uiChanged
  const gaveUp = input.verdict === 'inconclusive' || weak.length > 0 || wronglyNotVisual
  const early = currentStep < MAX_STEPS * MIN_EFFORT
  if (gaveUp && early && finishRejections < MAX_FINISH_REJECTIONS) {
    finishRejections++
    const left = MAX_STEPS - currentStep - 1
    const why = wronglyNotVisual
      ? `the PR changes UI files (${changedPaths().filter(isUi).slice(0, 5).join(', ')}), so "not_visual" doesn't fit`
      : weak.length
        ? `${weak.length} claim(s) are still inconclusive:\n${weak.map((c) => `- ${c.claim}`).join('\n')}`
        : 'the verdict is inconclusive'
    return {
      text: `Not finished: you have ${left} turns left and ${why}.
Before giving up on a claim, try a different route:
- search_code for the component or its label to find where it renders and what gates it (settings, menus, panel visibility, tab type, feature flags)
- read_diff / read_file the UI files involved
- look for menus, context menus (right-click), settings sections, or hidden panels that reveal it
- if a state needs data the fixture lacks, show the closest reachable state (the empty state, the toggle, the menu entry) and capture that
Call finish again only when every claim has evidence or you have tried at least two concrete routes for it.`
    }
  }
  result = input
  return { text: 'ok' }
}

function readRepoFile(path, startLine) {
  const full = resolve(REPO_DIR, path)
  const rel = relative(REPO_DIR, full)
  if (rel.startsWith('..') || rel.startsWith('/') || rel.split('/').includes('.git')) return { text: 'path must be inside the repo' }
  let text
  try {
    text = readFileSync(full, 'utf8')
  } catch (e) {
    return { text: `cannot read ${path}: ${e.code || e.message}` }
  }
  const lines = text.split('\n')
  const from = Math.max(1, startLine)
  const chunk = lines.slice(from - 1, from - 1 + 400)
  const body = chunk.map((l, i) => `${from + i}: ${l}`).join('\n')
  const more = from - 1 + 400 < lines.length ? `\n…[${lines.length} lines total; pass start_line=${from + 400} for more]` : ''
  return { text: body.slice(0, 30000) + more }
}

function searchCode(query) {
  try {
    const out = execFileSync(
      'git',
      ['grep', '-n', '-I', '-i', '-F', '--max-count', '5', '-e', query, '--', '.', ':!package-lock.json', ':!*.lock', ':!*.test.*'],
      { cwd: REPO_DIR, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
    )
    const lines = out.split('\n').filter(Boolean)
    return { text: lines.slice(0, 60).map((l) => l.slice(0, 240)).join('\n') + (lines.length > 60 ? `\n…[${lines.length - 60} more]` : '') }
  } catch (e) {
    return { text: e.status === 1 ? 'no matches' : `search failed: ${e.message.split('\n')[0]}` }
  }
}

// Element lists dominate the context. Only the most recent few tool results
// keep theirs; older ones shrink to a stub (ids are stale by then anyway).
function pruneOldToolText() {
  let seen = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'tool') continue
    seen++
    if (seen > KEEP_FULL_TOOL_TEXT && typeof m.content === 'string' && m.content.includes('interactive elements:')) {
      m.content = m.content.split('interactive elements:')[0] + '[old element list elided; ids are stale, observe again]'
    }
  }
}

async function settleAndObserve(app) {
  await app.page.waitForTimeout(600)
  return observe(app)
}

async function observe(app) {
  const clickables = await app.page.evaluate(() => {
    const SEL = 'button, a[href], input, textarea, select, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=switch], [role=option], [role=treeitem], [tabindex]:not([tabindex="-1"]), [contenteditable=true], [onclick]'
    document.querySelectorAll('[data-ev-id]').forEach((el) => el.removeAttribute('data-ev-id'))
    const out = []
    let n = 0
    for (const el of document.querySelectorAll(SEL)) {
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) continue
      if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue
      const s = getComputedStyle(el)
      if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) continue
      const name = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || el.getAttribute('placeholder') || el.value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60)
      const role = el.getAttribute('role') || el.tagName.toLowerCase()
      const id = ++n
      el.setAttribute('data-ev-id', String(id))
      out.push({ id, key: `${role}|${name}`, line: `[${id}] ${role} "${name}" @(${Math.round(r.x + r.width / 2)},${Math.round(r.y + r.height / 2)})` })
      if (n >= 150) break
    }
    return out
  })
  app.elements = clickables
  const shot = await app.page.screenshot({ type: 'jpeg', quality: 60 })
  const errors = app.consoleErrors.splice(0)
  const text = [
    `app=${appNameOf(app)} viewport=${VIEWPORT.width}x${VIEWPORT.height}`,
    errors.length ? `console errors since last observe:\n${errors.slice(-5).join('\n')}` : '',
    `interactive elements:\n${clickables.map((c) => c.line).join('\n')}`
  ]
    .filter(Boolean)
    .join('\n')
  return { text, images: [{ label: appNameOf(app), b64: shot.toString('base64') }] }
}

function pruneOldImages() {
  let seen = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user' || !Array.isArray(m.content)) continue
    const hasImage = m.content.some((p) => p.type === 'image_url')
    if (!hasImage) continue
    seen++
    if (seen >= KEEP_IMAGES) m.content = [{ type: 'text', text: '[older screenshot elided to save context]' }]
  }
}

async function chat(msgs, toolChoice) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/ness-dev/ness',
        'X-Title': 'Ness evidence reviewer'
      },
      body: JSON.stringify({ model: MODEL, messages: msgs, tools, tool_choice: toolChoice, usage: { include: true } })
    })
    const body = await res.json().catch(() => ({}))
    if (res.ok && !body.error) {
      usage.prompt += body.usage?.prompt_tokens || 0
      usage.completion += body.usage?.completion_tokens || 0
      usage.cost += body.usage?.cost || 0
      return body
    }
    log(`openrouter error (attempt ${attempt + 1}): ${res.status} ${JSON.stringify(body.error || body).slice(0, 300)}`)
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
  }
  fail('OpenRouter request failed 3 times')
}

function systemPrompt() {
  const both = appNames.includes('before')
  const appsLine = both
    ? 'Two copies of the app are running side by side: "before" is built from the PR base branch, "after" is built from the PR head. Both are seeded with identical fixture data.'
    : 'One copy of the app is running: "after", built from the PR head.'
  return `You are an evidence-gathering QA reviewer for a pull request. You do not review code style. Your job is to PROVE, using screenshots of the running app, whether the user-visible behaviour the PR claims actually works. The PR author is relying on you to find the feature and show it, so be persistent and resourceful: a reviewer who reports "couldn't find it" after a few clicks has failed.

${appsLine}

You can also read the PR head's code: read_diff (any changed file), read_file and search_code (the whole repo). Use them freely. They are the fastest way to learn where a feature renders and how to reach it.

Method:
1. PLAN FIRST. Your first call is plan. For each user-visible claim, name the component(s) from the diff, the concrete click path to the state that proves it, and what before and after should show. If a component's diff isn't in the prompt, read_diff it. If you don't know how a component is reached (which menu, setting, tab type, panel, flag), search_code for where it is rendered or imported before guessing in the UI.
2. Work through the plan claim by claim. Drive the app to the state, observe, adjust.${both ? `
3. The report's main artifact is BEFORE/AFTER PAIRS. Use app "both" for observe, click, type, press, scroll and hover: the action runs on before and then after, so the two stay in the same state. Ids come from the after app's element list. For before, you see only the elements that differ from after, and "only in after" lines are often the new UI the PR adds. Once both apps show the state that demonstrates a claim, call capture_evidence with app "both". If the apps diverge (the new UI only exists in after), act on each app separately to line them up again, then capture with "both".` : `
3. Call capture_evidence on "after" whenever the screen proves or disproves a claim.`}
4. When a route fails, try another. Things that hide UI: panel-visibility menus, collapsed sections, settings pages that need scrolling, context menus (right-click), hover-only controls, specific tab types, empty states. If the fixture can't produce the full state (it needs a GitHub PR, a Codex session, …), capture the closest reachable state that still shows the change: the new toggle, menu entry, empty panel, or label. That is real evidence.
5. Be skeptical. If the UI does not do what the PR claims, capture it and mark the claim refuted. Mark a claim inconclusive only after at least two concrete routes failed, and say which. Never mark a claim verified without a capture that shows it. find_text only proves the text is in the DOM, so scroll it into view and capture.
6. Captions describe the difference specifically ("Before: middle-click leaves the Shell row in place. After: the row is removed"), not generically.
7. Pure refactors, CI, docs or test-only PRs: verdict "not_visual" after a quick sanity check. If any UI file changed, the PR is visual.
8. Finish with the finish tool, citing evidence ids (E1, E2, …) per claim.

You have ${MAX_STEPS} tool-calling turns; use them. Several tool calls per turn are allowed and encouraged.

# How to use this app
${instructions}`
}

// UI files first (the agent's job is the UI), then other source, then
// tests and docs, each capped so one huge file can't eat the budget.
// Everything that doesn't fit is listed and reachable with read_diff.
function prPrompt() {
  const isAux = (p) => /\.test\.|__tests__|\.md$|^\.github\//.test(p)
  const rank = (p) => (isAux(p) ? 2 : isUi(p) ? 0 : 1)
  const stats = Object.fromEntries(pr.files.map((f) => [f.path, f]))
  const files = changedPaths()
    .map((path) => stats[path] || { path, additions: '?', deletions: '?' })
    .sort((a, b) => rank(a.path) - rank(b.path))
  let used = 0
  const shown = []
  const omitted = []
  for (const f of files) {
    const d = pr.fileDiffs[f.path]
    if (!d) continue
    const clipped = d.length > PER_FILE_DIFF ? d.slice(0, PER_FILE_DIFF) + `\n…[${f.path} truncated, read_diff for the rest]\n` : d
    if (used + clipped.length > DIFF_BUDGET) {
      omitted.push(f)
      continue
    }
    used += clipped.length
    shown.push(clipped)
  }
  const fileLine = (f) => `${f.path} (+${f.additions} -${f.deletions})${isUi(f.path) ? ' [UI]' : ''}`
  return `# PR #${pr.number}: ${pr.title}

${pr.body || '(no description)'}

## Changed files
${files.map(fileLine).join('\n')}

## Diff
\`\`\`diff
${shown.join('')}
\`\`\`
${omitted.length ? `\nNot shown above (use read_diff): ${omitted.map((f) => f.path).join(', ')}\n` : ''}
Start with plan.`
}

function renderReport() {
  const icon = { verified: '✅', partially_verified: '🟡', refuted: '❌', inconclusive: '❔', not_visual: '➖', not_testable: '➖' }
  const lines = [
    `## ${icon[result.verdict] || '❔'} Evidence review: ${result.verdict.replace('_', ' ')}`,
    '',
    result.summary,
    ''
  ]
  if (result.claims?.length) {
    lines.push('| | Claim | Evidence | Notes |', '|---|---|---|---|')
    for (const c of result.claims) {
      const ev = (c.evidence || []).join(', ')
      lines.push(`| ${icon[c.status] || '❔'} | ${cell(c.claim)} | ${ev} | ${cell(c.notes || '')} |`)
    }
    lines.push('')
  }
  if (plan?.length) {
    lines.push('<details><summary>Test plan</summary>', '')
    for (const p of plan) lines.push(`- **${p.claim}**: ${p.how_to_reach}${p.proof ? ` → ${p.proof}` : ''}`)
    lines.push('', '</details>', '')
  }
  for (const e of evidence) {
    lines.push(`### ${e.id}`, '', e.caption, '')
    if (e.files.before && e.files.after) {
      lines.push(
        '| Before | After |',
        '|---|---|',
        `| ![${e.id} before](./${e.files.before}) | ![${e.id} after](./${e.files.after}) |`,
        ''
      )
    } else {
      const [app, file] = Object.entries(e.files)[0]
      lines.push(`**${app}**`, '', `![${e.id} ${app}](./${file})`, '')
    }
  }
  const uncited = evidence.filter((e) => !(result.claims || []).some((c) => (c.evidence || []).includes(e.id)))
  if (uncited.length) {
    lines.push(`<sub>Uncited screenshots: ${uncited.map((e) => e.id).join(', ')}</sub>`, '')
  }
  const total = `$${runCost.toFixed(4)} total (reviewer $${usage.cost.toFixed(4)}, agents in app $${agentCost.toFixed(4)} over ${agentProxyRequests} calls)`
  lines.push(`<sub>Model \`${MODEL}\` · ${transcript.length} actions · ${usage.prompt + usage.completion} reviewer tokens · ${total}</sub>`)
  return lines.join('\n')
}

function startAgentProxy() {
  const server = createServer(async (req, res) => {
    if (runSpend() > RUN_BUDGET) {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: `evidence run budget of $${RUN_BUDGET} reached` } }))
      return
    }
    const body = []
    for await (const chunk of req) body.push(chunk)
    const headers = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (!['host', 'authorization', 'x-api-key', 'content-length', 'connection', 'accept-encoding'].includes(k)) headers[k] = v
    }
    headers.authorization = `Bearer ${API_KEY}`
    agentProxyRequests++
    try {
      const upstream = await fetch(`https://openrouter.ai/api${req.url}`, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(body)
      })
      const out = {}
      upstream.headers.forEach((v, k) => {
        if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) out[k] = v
      })
      res.writeHead(upstream.status, out)
      // OpenRouter reports each response's cost in its usage block (the
      // final SSE event when streaming); the last one seen is the total.
      let tail = ''
      if (upstream.body) {
        for await (const chunk of upstream.body) {
          res.write(chunk)
          tail = (tail + Buffer.from(chunk).toString('utf8')).slice(-4000)
        }
      }
      res.end()
      const costs = [...tail.matchAll(/"cost":\s*([0-9.eE+-]+)/g)].map((m) => Number(m[1])).filter(Number.isFinite)
      if (costs.length) agentCost += costs[costs.length - 1]
    } catch (e) {
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`evidence agent proxy: ${e.message}`)
    }
  })
  server.listen(AGENT_PROXY_PORT, '127.0.0.1')
  return server
}

function runSpend() {
  return usage.cost + agentCost
}

async function showsSecret(page) {
  const text = await page.evaluate(() => document.body.innerText).catch(() => '')
  return text.includes(API_KEY) || new RegExp(SECRET_RE.source).test(text)
}

function redact(text) {
  return text.split(API_KEY).join('[REDACTED]').replace(SECRET_RE, '[REDACTED]')
}

function isUi(path) {
  return UI_PATHS.some((prefix) => path.startsWith(prefix))
}

// fileDiffs comes from `gh pr diff` and is complete; pr.files is capped at
// 100 by the API, so it's only used for +/- counts.
function changedPaths() {
  return Object.keys(pr.fileDiffs)
}

function cell(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function tool(name, description, properties, required) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } }
}

function appSelectors() {
  return appNames.length > 1 ? ['both', ...appNames] : appNames
}

function appEnum() {
  return { type: 'string', enum: appSelectors() }
}

function appNameOf(app) {
  return Object.keys(apps).find((k) => apps[k] === app)
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[++i]
  }
  return out
}

function log(s) {
  console.log(`[evidence] ${s}`)
}

function fail(s) {
  console.error(`[evidence] ${s}`)
  process.exit(1)
}
