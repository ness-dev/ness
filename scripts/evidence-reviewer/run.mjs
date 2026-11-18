#!/usr/bin/env node
// Evidence reviewer: an agent loop that drives a running web app with
// Playwright and gathers screenshot evidence for (or against) the claims a
// PR makes.
//
// Deliberately app-agnostic. It only knows:
//   - one or two URLs ("after" = PR head, optionally "before" = PR base)
//   - a markdown instructions file describing how to use the app
//   - a PR context file (title, body, diff)
// Booting the app, seeding fixtures and publishing the report are the
// caller's job, so another repo can reuse this by swapping those pieces.
//
// Usage:
//   node run.mjs --after <url> [--before <url>] --instructions <md>
//                --pr <json> --out <dir>
// Env:
//   OPENROUTER_API_KEY   required
//   EVIDENCE_MODEL       default anthropic/claude-haiku-5.5
//   EVIDENCE_MAX_STEPS   default 40

import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const require = createRequire(resolve(process.cwd(), 'package.json'))
const { chromium } = require('playwright-core')

const args = parseArgs(process.argv.slice(2))
const OUT = resolve(args.out || 'evidence-out')
const MODEL = process.env.EVIDENCE_MODEL || 'anthropic/claude-haiku-5.5'
const MAX_STEPS = Number(process.env.EVIDENCE_MAX_STEPS || 40)
const API_KEY = process.env.OPENROUTER_API_KEY
const VIEWPORT = { width: 1440, height: 900 }
const KEEP_IMAGES = 3

if (!API_KEY) fail('OPENROUTER_API_KEY is not set')
if (!args.after) fail('--after <url> is required')
mkdirSync(OUT, { recursive: true })

const instructions = args.instructions ? readFileSync(args.instructions, 'utf8') : ''
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

const tools = [
  tool('observe', 'Take a screenshot of an app and list its visible interactive elements with numeric ids.', {
    app: appEnum()
  }, ['app']),
  tool('click', 'Click an element by the id from the latest observe of that app, or at raw x/y coordinates.', {
    app: appEnum(),
    id: { type: 'integer' },
    x: { type: 'number' },
    y: { type: 'number' },
    button: { type: 'string', enum: ['left', 'right', 'middle'] },
    double: { type: 'boolean' }
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

for (let step = 0; step < MAX_STEPS && !result; step++) {
  const remaining = MAX_STEPS - step
  if (remaining === 3) {
    messages.push({ role: 'user', content: 'You have 3 steps left. Capture any final evidence and call finish.' })
  }
  const reply = await chat(messages, remaining === 1 ? { type: 'function', function: { name: 'finish' } } : 'auto')
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

writeFileSync(join(OUT, 'result.json'), JSON.stringify({ model: MODEL, usage, result, evidence, transcript }, null, 2))
writeFileSync(join(OUT, 'report.md'), renderReport())
log(`done: ${result.verdict} (${evidence.length} screenshots, $${usage.cost.toFixed(4)})`)

async function runTool(name, input) {
  if (name === 'finish') {
    result = input
    return { text: 'ok' }
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
        const opts = { button: input.button || 'left', timeout: 3000 }
        input.double ? await loc.dblclick(opts) : await loc.click(opts)
      } else if (input.x != null && input.y != null) {
        await page.mouse.click(input.x, input.y, { button: input.button || 'left', clickCount: input.double ? 2 : 1 })
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
    const id = `E${evidence.length + 1}`
    const files = {}
    for (const appName of ['before', 'after']) {
      files[appName] = `${id}-${appName}.png`
      await apps[appName].page.screenshot({ path: join(OUT, files[appName]) })
    }
    evidence.push({ id, app: 'both', caption: input.caption, files })
    return { text: `saved before/after pair as ${id}` }
  }
  const texts = []
  const images = []
  for (const appName of ['before', 'after']) {
    let mapped = { ...input, app: appName }
    if (appName === 'before' && input.id != null) {
      const beforeId = translateId(input.id)
      if (beforeId == null) {
        texts.push(`[before] no element matching after's [${input.id}]; action skipped. Act on "before" directly with its own ids.`)
        continue
      }
      mapped.id = beforeId
    }
    try {
      const out = await runTool(name, mapped)
      texts.push(`[${appName}] ${out.text}`)
      images.push(...(out.images || []))
    } catch (e) {
      texts.push(`[${appName}] error: ${e.message.split('\n')[0]}`)
    }
  }
  return { text: texts.join('\n\n'), images }
}

function translateId(afterId) {
  const after = apps.after.elements || []
  const target = after.find((e) => e.id === afterId)
  if (!target) return null
  const rank = after.filter((e) => e.key === target.key && e.id < afterId).length
  const matches = (apps.before.elements || []).filter((e) => e.key === target.key)
  return matches[rank]?.id ?? null
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
  const appsLine = appNames.includes('before')
    ? 'Two copies of the app are running side by side: "before" is built from the PR base branch, "after" is built from the PR head. Both are seeded with identical fixture data.'
    : 'One copy of the app is running: "after", built from the PR head.'
  return `You are an evidence-gathering QA reviewer for a pull request. You do not review code style. Your only job is to PROVE, using screenshots of the running app, whether the user-visible behaviour the PR claims actually works.

${appsLine}

Method:
1. Read the PR description and diff. List the concrete, user-visible claims it makes (what should look or behave differently). If the change has no user-visible surface (pure refactor, CI, docs, tests), say so and finish with verdict "not_visual" after at most a quick sanity check.
2. For each claim, decide what screen state would prove it and drive the app there.${appNames.includes('before') ? `
3. The report's main artifact is BEFORE/AFTER PAIRS. Use app "both" for observe, click, type, press, scroll and hover: the action runs on before and then after, so the two stay in the same state. Ids come from the after app's list (before's matching element is found by role + name). Once both apps show the state that demonstrates a claim, call capture_evidence with app "both" to save a side-by-side pair. If the two apps diverge (for example the new UI only exists in after), act on each app on its own to line them up again, then capture with "both". Capture a single app only when a comparison is meaningless.` : `
3. Call capture_evidence on "after" whenever the screen proves or disproves a claim.`}
4. Be skeptical. If the UI does not show what the PR claims, that is a finding: capture it and mark the claim refuted. If you cannot reach the relevant state, mark it inconclusive and say why. Never mark a claim verified without a capture that shows it.
5. Prefer clicking by element id from observe. Re-observe after anything that changes the screen. Use find_text to confirm text exists.
6. Captions describe the difference specifically ("Before: middle-click leaves the Shell row in place. After: the row is removed"), not generically ("Screenshot of app").
7. Finish with the finish tool. Cite evidence ids (E1, E2, …) per claim.

You have at most ${MAX_STEPS} tool-calling turns. Several tool calls per turn are allowed.

# How to use this app
${instructions}`
}

function prPrompt() {
  const diff = pr.diff.length > 60000 ? pr.diff.slice(0, 60000) + '\n…[diff truncated]' : pr.diff
  return `# PR #${pr.number}: ${pr.title}

${pr.body || '(no description)'}

## Changed files
${pr.files.join('\n')}

## Diff
\`\`\`diff
${diff}
\`\`\`

Start by listing the claims you intend to verify, then observe the app.`
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
  lines.push(
    `<sub>Model \`${MODEL}\` · ${transcript.length} actions · ${usage.prompt + usage.completion} tokens · $${usage.cost.toFixed(4)}</sub>`
  )
  return lines.join('\n')
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
