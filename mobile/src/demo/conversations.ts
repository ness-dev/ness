// Canned chat transcripts, in the slice's own entry shape: one assistant
// entry per API message (thinking / text / tool_use blocks) followed by a
// tool_result entry per call, which is what JsonClaudeManager produces.
import type { JsonClaudeChatEntry, JsonClaudeMessageBlock, JsonClaudePendingApproval } from '../../../src/shared/state/json-claude'
import { UNITS_FIX, WT } from './project'

export const TAB = {
  mainShell: 'demo-shell-main',
  hourlyChat: 'demo-chat-hourly',
  hourlyShell: 'demo-shell-hourly',
  unitsChat: 'demo-chat-units',
  unitsShell: 'demo-shell-units',
  darkChat: 'demo-chat-dark',
  airChat: 'demo-chat-air'
} as const

export const MODEL = 'claude-opus-5-5'

/** Builds entries with ids and timestamps that count up from `start`. */
class Transcript {
  readonly entries: JsonClaudeChatEntry[] = []
  private n = 0
  constructor(
    private readonly sessionId: string,
    private t: number
  ) {}

  private next(stepSec: number): { entryId: string; timestamp: number } {
    this.t += stepSec * 1000
    return { entryId: `${this.sessionId}-e${this.n++}`, timestamp: this.t }
  }

  user(text: string, extra: Partial<JsonClaudeChatEntry> = {}): this {
    this.entries.push({ ...this.next(30), kind: 'user', text, ...extra })
    return this
  }

  assistant(...blocks: JsonClaudeMessageBlock[]): this {
    this.entries.push({ ...this.next(6), kind: 'assistant', blocks, apiMessageId: `msg_${this.sessionId}_${this.n}` })
    return this
  }

  result(toolUseId: string, content: string, isError = false): this {
    this.entries.push({ ...this.next(2), kind: 'tool_result', blocks: [{ type: 'tool_result', toolUseId, content, isError }] })
    return this
  }

  get time(): number {
    return this.t
  }
}

export const text = (t: string): JsonClaudeMessageBlock => ({ type: 'text', text: t })
export const thinking = (t: string): JsonClaudeMessageBlock => ({ type: 'thinking', text: t })
export const tool = (id: string, name: string, input: Record<string, unknown>, intent?: string): JsonClaudeMessageBlock => ({
  type: 'tool_use',
  id,
  name,
  input,
  ...(intent ? { intent } : {})
})

const file = (wt: string, p: string) => `${wt}/${p}`

// ── hourly-forecast: a finished, feature-rich conversation ─────────────

const HOURLY_SUMMARY = `## Hourly forecast is in

The strip sits under current conditions and shows the next **12 hours**, with rain chances once they reach 20%.

### What changed

| File | Change |
|---|---|
| \`src/api/forecast.ts\` | \`fetchHourly\` + \`fetchForecast\` load both endpoints in parallel |
| \`src/components/HourlyForecast.tsx\` | New horizontally scrolling strip |
| \`src/App.tsx\` | Renders the strip under \`CurrentConditions\` |
| \`tests/forecast.test.ts\` | Covers the \`/hourly\` response shape |

### How the data flows

\`\`\`mermaid
flowchart LR
  App --> useForecast
  useForecast --> fetchForecast
  fetchForecast --> D["/forecast"]
  fetchForecast --> H["/hourly"]
  useForecast --> Strip[HourlyForecast]
\`\`\`

The two requests run side by side, so the page doesn't wait any longer than it did before:

\`\`\`ts
export async function fetchForecast(city: string): Promise<Forecast> {
  const [daily, hourly] = await Promise.all([fetchDaily(city), fetchHourly(city)])
  return { ...daily, hourly }
}
\`\`\`

All **7 tests pass**. Next steps, if you want them:

1. Label each hour for screen readers
2. Add a short note to \`docs/\` about the 20% threshold
3. Hide the strip when the API has no hourly data for a city`

const TEST_PASS = `
 RUN  v3.2.4 /Users/demo/code/acme-weather-worktrees/hourly-forecast

 ✓ tests/units.test.ts (5 tests) 3ms
 ✓ tests/forecast.test.ts (2 tests) 9ms

 Test Files  2 passed (2)
      Tests  7 passed (7)
   Duration  412ms`

export function hourlyTranscript(start: number): JsonClaudeChatEntry[] {
  const wt = WT.hourly
  const t = new Transcript(TAB.hourlyChat, start)
  t.user('Add an hourly forecast under the current conditions. Use the /hourly endpoint and show the next 12 hours.')
    .assistant(
      thinking(
        'The user wants an hourly strip. First I should see how the daily forecast is fetched and how App lays out the current conditions, so the new data comes through the same hook instead of a second loading state.'
      ),
      text("I'll start by looking at how the existing forecast is fetched and rendered."),
      tool('tu_h1', 'Read', { file_path: file(wt, 'src/api/forecast.ts') }),
      tool('tu_h2', 'Grep', { pattern: 'useForecast', path: wt, output_mode: 'files_with_matches' }),
      tool('tu_h3', 'Read', { file_path: file(wt, 'src/App.tsx') })
    )
    .result('tu_h1', '     1\timport { useEffect, useState } from \'react\'\n     2\timport { getJson } from \'./client\'\n…')
    .result('tu_h2', 'src/App.tsx\nsrc/api/forecast.ts')
    .result('tu_h3', '     1\timport { useState } from \'react\'\n     2\timport { useForecast } from \'./api/forecast\'\n…')
    .assistant(
      tool('tu_h4', 'Task', {
        description: 'Check the hourly API shape',
        prompt: 'Find how /v2/hourly responds in the API docs under docs/ and the client, and report the fields.',
        subagent_type: 'Explore'
      })
    )
  t.entries.push({
    entryId: `${TAB.hourlyChat}-sub0`,
    kind: 'assistant',
    timestamp: t.time + 2000,
    parentToolUseId: 'tu_h4',
    blocks: [tool('tu_h4a', 'Grep', { pattern: 'hourly', path: wt }), text('`/v2/hourly` returns `{ hours: Hour[] }` with time, tempC, icon and precipChance.')]
  })
  t.result('tu_h4a', 'No matches in src/. The API reference lists GET /v2/hourly?city=&hours=')
    .result('tu_h4', '`GET /v2/hourly?city=…&hours=24` → `{ hours: [{ time, tempC, icon, precipChance }] }`. Nothing in the app calls it yet.')
    .assistant(
      text('Here is the plan:'),
      tool('tu_h5', 'TodoWrite', {
        todos: [
          { content: 'Add fetchHourly and load it with the daily forecast', status: 'completed', activeForm: 'Adding fetchHourly' },
          { content: 'Build the HourlyForecast strip', status: 'completed', activeForm: 'Building the strip' },
          { content: 'Render it under current conditions', status: 'completed', activeForm: 'Wiring it into App' },
          { content: 'Cover /hourly in the tests', status: 'completed', activeForm: 'Adding tests' },
          { content: 'Label each hour for screen readers', status: 'pending', activeForm: 'Adding accessibility labels' }
        ]
      })
    )
    .result('tu_h5', 'Todos have been modified successfully.')
    .assistant(
      tool('tu_h6', 'Edit', {
        file_path: file(wt, 'src/api/forecast.ts'),
        old_string: 'export interface Forecast {\n  now: Conditions\n  daily: Day[]\n}',
        new_string: 'export interface Forecast {\n  now: Conditions\n  daily: Day[]\n  hourly: Hour[]\n}'
      }),
      tool('tu_h7', 'Write', { file_path: file(wt, 'src/components/HourlyForecast.tsx'), content: '…' }),
      tool('tu_h8', 'Edit', {
        file_path: file(wt, 'src/App.tsx'),
        old_string: '<CurrentConditions now={data.now} unit={unit} />',
        new_string: '<CurrentConditions now={data.now} unit={unit} />\n<HourlyForecast hours={data.hourly.slice(0, 12)} unit={unit} />'
      }),
      tool('tu_h9', 'Bash', { command: 'npm test', description: 'Run the unit tests' }, 'Run the unit tests')
    )
    .result('tu_h6', `The file ${file(wt, 'src/api/forecast.ts')} has been updated.`)
    .result('tu_h7', `File created successfully at: ${file(wt, 'src/components/HourlyForecast.tsx')}`)
    .result('tu_h8', `The file ${file(wt, 'src/App.tsx')} has been updated.`)
    .result('tu_h9', TEST_PASS)
    .assistant(text(HOURLY_SUMMARY))
  return t.entries
}

// ── fix-unit-toggle: CI failed, the fix is waiting for approval ────────

const TEST_FAIL = `
 RUN  v3.2.4 /Users/demo/code/acme-weather-worktrees/fix-unit-toggle

 ❯ tests/units.test.ts (5 tests | 3 failed) 6ms
   × toFahrenheit > converts 0°C to 32°F
   × toFahrenheit > converts 100°C to 212°F
     → expected 87.55555555555556 to be 212
   × formatTemp > formats Fahrenheit

 Test Files  1 failed (1)
      Tests  3 failed | 2 passed (5)`

export const UNITS_EDIT_TOOL_USE_ID = 'tu_u4'
export const UNITS_REQUEST_ID = 'demo-approval-units'

export function unitsEditInput(): Record<string, unknown> {
  return { file_path: file(WT.units, 'src/units.ts'), old_string: UNITS_FIX.old, new_string: UNITS_FIX.new }
}

export function unitsTranscript(start: number): JsonClaudeChatEntry[] {
  const wt = WT.units
  const t = new Transcript(TAB.unitsChat, start)
  t.user(
    'CI failed on PR #44 (Remember the °C/°F choice): `test` — 3 tests failed in tests/units.test.ts.\n\n```\n× toFahrenheit > converts 100°C to 212°F\n  → expected 87.55555555555556 to be 212\n```',
    { automation: 'ci-failure' }
  )
    .assistant(
      text("CI is failing on the unit conversion. Let me reproduce it locally and look at the converter."),
      tool('tu_u1', 'Bash', { command: 'npx vitest run tests/units.test.ts', description: 'Run the failing tests' }, 'Run the failing tests'),
      tool('tu_u2', 'Read', { file_path: file(wt, 'src/units.ts') })
    )
    .result('tu_u1', TEST_FAIL, true)
    .result('tu_u2', '     1\texport type Unit = \'C\' | \'F\'\n     2\t\n     3\tconst STORAGE_KEY = \'acme-weather:unit\'\n     4\t\n     5\texport function toFahrenheit(c: number): number {\n     6\t  return (c * 5) / 9 + 32\n     7\t}')
    .assistant(
      thinking('100°C → 87.6 means the factor is inverted: 100 × 5/9 + 32 = 87.56. The refactor that added STORAGE_KEY swapped 9/5 for 5/9.'),
      text('Found it: the last commit flipped the conversion factor in `toFahrenheit`, so 100°C comes out as 87.6°F. Swapping it back to **9/5** fixes all three failures.'),
      tool(UNITS_EDIT_TOOL_USE_ID, 'Edit', unitsEditInput())
    )
  return t.entries
}

export function unitsApproval(now: number): JsonClaudePendingApproval {
  return {
    requestId: UNITS_REQUEST_ID,
    sessionId: TAB.unitsChat,
    toolName: 'Edit',
    input: unitsEditInput(),
    toolUseId: UNITS_EDIT_TOOL_USE_ID,
    timestamp: now - 40_000
  }
}

// ── dark-mode: a turn still running ────────────────────────────────────

export const DARK_RUNNING_TOOL_USE_ID = 'tu_d2'

export function darkTranscript(start: number): JsonClaudeChatEntry[] {
  const wt = WT.dark
  const t = new Transcript(TAB.darkChat, start)
  t.user('Add a dark theme that follows the system setting.')
    .assistant(
      text("I'll move the colours into CSS variables and override them under `prefers-color-scheme: dark`."),
      tool('tu_d1', 'Edit', {
        file_path: file(wt, 'src/styles.css'),
        old_string: '  color: #1d2430;\n  background: #f5f7fb;',
        new_string: '  --fg: #1d2430;\n  --bg: #f5f7fb;\n  color: var(--fg);\n  background: var(--bg);'
      })
    )
    .result('tu_d1', `The file ${file(wt, 'src/styles.css')} has been updated.`)
    .assistant(tool(DARK_RUNNING_TOOL_USE_ID, 'Bash', { command: 'npm run build', description: 'Build to check the CSS' }, 'Build to check the CSS'))
  return t.entries
}

// ── air-quality: merged, nothing left to do ────────────────────────────

export function airTranscript(start: number): JsonClaudeChatEntry[] {
  const t = new Transcript(TAB.airChat, start)
  t.user('PR #39 is merged — anything left to clean up?').assistant(
    text('Nothing left: the branch is merged and the badge shipped in **v0.4.0**. You can delete this worktree whenever you like.')
  )
  return t.entries
}
