#!/usr/bin/env node
// How much of an active agent turn is the sandbox actually needed for?
//
// Walks Claude Code transcripts and splits active-turn wall time into:
//   model    — waiting on the model (prompt/tool_result → next assistant block)
//   tool     — executing a tool (tool_use → tool_result), capped at HUMAN_GAP_S
//   human    — tool gaps longer than HUMAN_GAP_S: almost always a permission
//              prompt waiting on the user, not execution
//   subagent — Agent/Task tool spans, which are mostly *model* time inside a
//              nested loop, so they're reported apart rather than as tool time
// Time between turns (last assistant block → next real user prompt) is idle
// and excluded: the sandbox can sleep then in any model.
//
// Then estimates what a split agent/executor model would save: the sandbox
// sleeps during every model gap longer than the per-cycle pause+resume cost.
//
// Usage: node scripts/e2b-poc/turn-timing.mjs [--days 30] [--max-files 400]

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const arg = (name, def) => {
  const i = args.indexOf(name)
  return i >= 0 ? Number(args[i + 1]) : def
}
const DAYS = arg('--days', 30)
const MAX_FILES = arg('--max-files', 400)
const HUMAN_GAP_S = 120
// Any gap past this is a session left alone or resumed days later (seen up
// to ~7 days), not a turn in progress — counting it swamps everything else.
const IDLE_GAP_S = 600
const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])

const root = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
const cutoff = Date.now() - DAYS * 86_400_000
const files = []
for (const dir of readdirSync(root)) {
  let entries
  try {
    entries = readdirSync(join(root, dir))
  } catch {
    continue
  }
  for (const f of entries) {
    if (!f.endsWith('.jsonl')) continue
    const p = join(root, dir, f)
    const st = statSync(p)
    if (st.mtimeMs >= cutoff && st.size > 20_000) files.push({ p, mtime: st.mtimeMs })
  }
}
files.sort((a, b) => b.mtime - a.mtime)
const picked = files.slice(0, MAX_FILES)

const totals = { model: 0, tool: 0, human: 0, subagent: 0 }
const modelGaps = [] // input → end of the model's response: the window a split model could sleep in
const toolRuns = []
let turns = 0
let toolCalls = 0
let idle = 0

function classify(o) {
  const c = o.message?.content
  if (o.type === 'assistant') {
    const uses = Array.isArray(c) ? c.filter((x) => x?.type === 'tool_use') : []
    return { kind: 'assistant', toolNames: uses.map((u) => u.name) }
  }
  if (o.type === 'user') {
    if (Array.isArray(c) && c.some((x) => x?.type === 'tool_result')) return { kind: 'result' }
    return { kind: 'prompt' }
  }
  return null
}

for (const { p } of picked) {
  const events = []
  for (const line of readFileSync(p, 'utf-8').split('\n')) {
    if (!line) continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (o.isSidechain || !o.timestamp) continue
    const k = classify(o)
    if (!k) continue
    events.push({ ...k, t: Date.parse(o.timestamp) })
  }
  let pendingTools = []
  // Start of the current model window: the prompt or tool_result the model
  // is responding to. The window closes at the last assistant block before
  // the next input — a response streams as several lines (thinking, text,
  // tool_use), and the sandbox is idle across all of them.
  let gapStart = events[0]?.t ?? 0
  let gapIdle = false
  const closeGap = (prev) => {
    if (prev.kind === 'assistant' && !gapIdle) modelGaps.push((prev.t - gapStart) / 1000)
    gapIdle = false
  }
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1]
    const cur = events[i]
    const dt = (cur.t - prev.t) / 1000
    if (cur.kind !== 'assistant') {
      closeGap(prev)
      gapStart = cur.t
    }
    if (cur.kind === 'prompt') {
      turns++
      pendingTools = []
      continue
    }
    if (dt < 0) continue
    if (dt > IDLE_GAP_S) {
      idle += dt
      gapIdle = true
      continue
    }
    if (prev.kind === 'assistant' && prev.toolNames.length) pendingTools = prev.toolNames
    if (cur.kind === 'assistant') {
      totals.model += dt
      if (cur.toolNames.length) toolCalls += cur.toolNames.length
    } else if (cur.kind === 'result') {
      if (pendingTools.some((n) => SUBAGENT_TOOLS.has(n))) totals.subagent += dt
      else if (dt > HUMAN_GAP_S) totals.human += dt
      else {
        totals.tool += dt
        toolRuns.push(dt)
      }
    }
  }
  if (events.length) closeGap(events[events.length - 1])
}

const pct = (arr, q) => {
  if (!arr.length) return NaN
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]
}
const f1 = (n) => n.toFixed(1)
const hours = (s) => (s / 3600).toFixed(1)
const machine = totals.model + totals.tool // human + subagent reported apart
const all = machine + totals.human + totals.subagent

console.log(`transcripts: ${picked.length} (last ${DAYS} days), turns: ${turns}, tool calls: ${toolCalls}`)
console.log(`excluded as idle (single gaps > ${IDLE_GAP_S}s): ${hours(idle)} h`)
console.log('')
console.log('active-turn wall time:')
for (const [k, v] of Object.entries(totals)) {
  console.log(`  ${k.padEnd(9)} ${hours(v).padStart(7)} h  ${f1((100 * v) / all).padStart(5)}%`)
}
console.log('')
console.log(`excluding human waits + subagents: model ${f1((100 * totals.model) / machine)}% / tool ${f1((100 * totals.tool) / machine)}%`)
console.log('')
console.log(`tool execution (s):        p50 ${f1(pct(toolRuns, 0.5))}  p90 ${f1(pct(toolRuns, 0.9))}  p99 ${f1(pct(toolRuns, 0.99))}`)
console.log(`model response window (s):   p50 ${f1(pct(modelGaps, 0.5))}  p90 ${f1(pct(modelGaps, 0.9))}  p99 ${f1(pct(modelGaps, 0.99))}`)
console.log('')
console.log('split model: sandbox awake-time saved during active turns, by per-cycle pause+resume cost')
console.log('(sleeps only in model gaps longer than the cost; human waits count as sleepable too)')
for (const cost of [0.5, 1, 2, 3, 5, 10]) {
  const saved = modelGaps.reduce((s, g) => s + Math.max(0, g - cost), 0) + totals.human
  const sleeps = modelGaps.filter((g) => g > cost).length
  console.log(
    `  cost ${String(cost).padStart(4)}s → saves ${f1((100 * saved) / all).padStart(5)}% of active-turn time, ${sleeps} pause/resume cycles (${f1(sleeps / Math.max(1, turns))}/turn)`
  )
}
