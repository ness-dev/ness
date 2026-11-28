// Scripted chat turns, as plain lists of timed steps. Each step carries the
// same events JsonClaudeManager dispatches for a live turn (user entry,
// busy, a partial assistant entry fed by text deltas, finalize, tool
// results), so the phone renders it through its ordinary streaming path.
// Pure: DemoTransport plays the steps; the tests read them.
import type { StateEvent } from '../../../src/shared/state'
import type { JsonClaudeMessageBlock } from '../../../src/shared/state/json-claude'
import { DARK_RUNNING_TOOL_USE_ID, TAB, UNITS_EDIT_TOOL_USE_ID, UNITS_REQUEST_ID, text, tool } from './conversations'
import { UNITS_TS_FIXED, WT } from './project'

export interface Step {
  /** Milliseconds after the previous step. */
  delay: number
  events: StateEvent[]
  /** A working-tree write, applied before this step's events. */
  write?: { worktreePath: string; file: string; contents: string }
}

/** Token-ish chunks: a word plus its trailing space, so streamed markdown
 *  never splits mid-word. */
export function tokenize(s: string): string[] {
  return s.match(/\S+\s*|\s+/g) ?? []
}

const TOKEN_MS = 28

let seq = 0
const nextId = (sessionId: string) => `${sessionId}-demo${Date.now().toString(36)}${seq++}`

/** One assistant message: text blocks stream token by token, tool_use
 *  blocks appear whole, then the entry is finalized. */
function assistantMessage(sessionId: string, blocks: JsonClaudeMessageBlock[], now: () => number, firstDelay = 450): Step[] {
  const entryId = nextId(sessionId)
  const steps: Step[] = [
    {
      delay: firstDelay,
      events: [{ type: 'jsonClaude/entryAppended', payload: { sessionId, entry: { entryId, kind: 'assistant', timestamp: now(), isPartial: true, blocks: [] } } }]
    }
  ]
  for (const block of blocks) {
    if (block.type === 'text' || block.type === 'thinking') {
      steps.push({ delay: 0, events: [{ type: 'jsonClaude/assistantBlockAppended', payload: { sessionId, entryId, block: { type: block.type, text: '' } } }] })
      const kind = block.type === 'text' ? 'jsonClaude/assistantTextDelta' : 'jsonClaude/assistantThinkingDelta'
      for (const tok of tokenize(block.text ?? '')) {
        steps.push({ delay: TOKEN_MS, events: [{ type: kind, payload: { sessionId, entryId, textDelta: tok } }] })
      }
    } else {
      steps.push({ delay: 250, events: [{ type: 'jsonClaude/assistantBlockAppended', payload: { sessionId, entryId, block } }] })
    }
  }
  steps.push({ delay: 0, events: [{ type: 'jsonClaude/assistantEntryFinalized', payload: { sessionId, entryId, blocks } }] })
  return steps
}

const busy = (sessionId: string, on: boolean, now: number): StateEvent => ({
  type: 'jsonClaude/busyChanged',
  payload: on ? { sessionId, busy: true, turnStartedAt: now } : { sessionId, busy: false }
})

// ── replies to anything the user sends ─────────────────────────────────

const REPLIES = [
  `This is the **Ness demo**, so you're talking to a scripted reply rather than a real Claude session. Nothing you type leaves your phone.

With your own setup, this app connects to **Ness on your computer** (the desktop app or \`harness-server\`), and from here you can:

- **Chat with Claude Code** in any worktree, streaming like this
- **Approve or deny tool calls** when an agent needs you (try *fix/unit-toggle*)
- **Review the work**: changed files, branch commits and side-by-side diffs
- **Watch PRs and CI** for every branch
- **Open a terminal** on the machine running your agents

To connect your own, open **Backends** from the worktree list and scan the QR code in Ness → Settings → Web & mobile.`,
  `Still the demo here. A few things worth trying:

1. Open the **worktree list** (tap the branch name at the top) to see every agent's status at a glance
2. Open **Worktree details** (the panel button, top right) for PR status, commits, changed files, cost and context
3. Tap a changed file to see its **diff**
4. Try the **Shell** tab: \`ls\`, \`git status\`, \`npm test\`

When you're ready, **Backends** is where you pair the app with your own Ness.`
]

export function replySteps(sessionId: string, userText: string, turn: number, now: () => number): Step[] {
  const t = now()
  return [
    {
      delay: 0,
      events: [
        { type: 'jsonClaude/entryAppended', payload: { sessionId, entry: { entryId: nextId(sessionId), kind: 'user', text: userText, timestamp: t } } },
        { type: 'jsonClaude/promptSuggestionChanged', payload: { sessionId, suggestion: null } },
        busy(sessionId, true, t)
      ]
    },
    ...assistantMessage(sessionId, [text(REPLIES[turn % REPLIES.length])], now, 700),
    { delay: 0, events: [busy(sessionId, false, now())] }
  ]
}

// ── the fix-unit-toggle approval ───────────────────────────────────────

const RETEST = `
 RUN  v3.2.4 /Users/demo/code/acme-weather-worktrees/fix-unit-toggle

 ✓ tests/units.test.ts (5 tests) 3ms
 ✓ tests/forecast.test.ts (1 test) 8ms

 Test Files  2 passed (2)
      Tests  6 passed (6)`

const resolved: StateEvent = { type: 'jsonClaude/approvalResolved', payload: { requestId: UNITS_REQUEST_ID } }

export function approveSteps(now: () => number): Step[] {
  const sessionId = TAB.unitsChat
  return [
    {
      delay: 0,
      write: { worktreePath: WT.units, file: 'src/units.ts', contents: UNITS_TS_FIXED },
      events: [
        resolved,
        {
          type: 'jsonClaude/toolResultAttached',
          payload: { sessionId, toolUseId: UNITS_EDIT_TOOL_USE_ID, content: `The file ${WT.units}/src/units.ts has been updated.`, isError: false }
        }
      ]
    },
    ...assistantMessage(sessionId, [
      text('Fixed. Re-running the tests to confirm:'),
      tool('tu_u5', 'Bash', { command: 'npm test', description: 'Run the unit tests' }, 'Run the unit tests')
    ], now),
    { delay: 1400, events: [{ type: 'jsonClaude/toolResultAttached', payload: { sessionId, toolUseId: 'tu_u5', content: RETEST, isError: false } }] },
    ...assistantMessage(sessionId, [
      text(
        'All **6 tests pass** again. The edit is in your working tree (see **Changed Files**), so CI will go green once it is committed and pushed. Want me to commit it as `Fix the °F conversion factor`?'
      )
    ], now),
    { delay: 0, events: [busy(sessionId, false, now())] }
  ]
}

export const DENIED_TOOL_RESULT =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."

export function denySteps(now: () => number, message?: string): Step[] {
  const sessionId = TAB.unitsChat
  const reason = message && message !== 'user denied' ? message : undefined
  return [
    {
      delay: 0,
      events: [
        resolved,
        {
          type: 'jsonClaude/toolResultAttached',
          payload: { sessionId, toolUseId: UNITS_EDIT_TOOL_USE_ID, content: reason ? `${DENIED_TOOL_RESULT}\n\nThe user said: ${reason}` : DENIED_TOOL_RESULT, isError: true }
        }
      ]
    },
    ...assistantMessage(sessionId, [
      text("Understood, I've left `src/units.ts` alone. CI will keep failing until the factor is fixed. Tell me how you'd like to handle it.")
    ], now),
    { delay: 0, events: [busy(sessionId, false, now())] }
  ]
}

// ── dark-mode: the running turn finishes once someone watches ──────────

const BUILD_OUT = `
> acme-weather@0.4.0 build
> tsc -b && vite build

vite v7.0.4 building for production...
✓ 34 modules transformed.
dist/index.html                  0.46 kB
dist/assets/index-C4Rk2a1x.css   1.92 kB
dist/assets/index-BQ1nS0aZ.js  146.08 kB
✓ built in 812ms`

export function darkFinishSteps(now: () => number): Step[] {
  const sessionId = TAB.darkChat
  return [
    {
      delay: 3500,
      events: [{ type: 'jsonClaude/toolResultAttached', payload: { sessionId, toolUseId: DARK_RUNNING_TOOL_USE_ID, content: BUILD_OUT, isError: false } }]
    },
    ...assistantMessage(sessionId, [
      text(
        "The build is clean. Colours now come from CSS variables, and a `prefers-color-scheme: dark` block swaps them, so the app follows the system setting with no toggle to maintain. The change is unstaged in `src/styles.css` if you'd like to review it."
      )
    ], now),
    { delay: 0, events: [busy(sessionId, false, now())] }
  ]
}
