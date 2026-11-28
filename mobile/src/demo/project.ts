// The demo's fictional project: a small "acme-weather" web app, its
// worktrees and their git history. Everything is made up; no real user,
// repo or org appears anywhere in the demo.
//
// Each worktree's files are three snapshots layered on the shared base
// (the main branch): HEAD (base + the branch's commits), the index (HEAD +
// staged edits) and the working tree (index + unstaged edits). git.ts
// derives changed files and diff sides from them the way git would.

export const HOME = '/Users/demo'
export const REPO = `${HOME}/code/acme-weather`
const WT_DIR = `${HOME}/code/acme-weather-worktrees`

export const WT = {
  main: REPO,
  hourly: `${WT_DIR}/hourly-forecast`,
  units: `${WT_DIR}/fix-unit-toggle`,
  dark: `${WT_DIR}/dark-mode`,
  air: `${WT_DIR}/air-quality`
} as const

export type Files = Record<string, string>

export const AUTHOR = { name: 'Riley Chen', email: 'riley@acme-weather.example' }

// ── base files (main) ──────────────────────────────────────────────────

const PACKAGE_JSON = `{
  "name": "acme-weather",
  "version": "0.4.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "test": "vitest run",
    "lint": "eslint src"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^5.0.0",
    "typescript": "^5.8.0",
    "vite": "^7.0.0",
    "vitest": "^3.2.0"
  }
}
`

const README = `# acme-weather

A tiny weather dashboard: current conditions and a 5-day forecast for any
city, powered by the Acme Weather API.

## Getting started

\`\`\`sh
npm install
npm run dev
\`\`\`

Set \`VITE_WEATHER_KEY\` in \`.env.local\` to your API key.

## Scripts

| Command | What it does |
|---|---|
| \`npm run dev\` | Start the dev server |
| \`npm test\` | Run the unit tests |
| \`npm run build\` | Type-check and build for production |
`

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Acme Weather</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`

const VITE_CONFIG = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 }
})
`

const MAIN_TSX = `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
`

const APP_TSX = `import { useState } from 'react'
import { useForecast } from './api/forecast'
import { CurrentConditions } from './components/CurrentConditions'
import { ForecastCard } from './components/ForecastCard'
import { type Unit } from './units'

export function App() {
  const [city, setCity] = useState('Portland')
  const [unit, setUnit] = useState<Unit>('C')
  const { data, error, loading } = useForecast(city)

  return (
    <main className="app">
      <header>
        <input value={city} onChange={(e) => setCity(e.target.value)} aria-label="City" />
        <button onClick={() => setUnit(unit === 'C' ? 'F' : 'C')}>°{unit}</button>
      </header>
      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error">{error}</p>}
      {data && (
        <>
          <CurrentConditions now={data.now} unit={unit} />
          <section className="days">
            {data.daily.map((d) => (
              <ForecastCard key={d.date} day={d} unit={unit} />
            ))}
          </section>
        </>
      )}
    </main>
  )
}
`

const APP_TSX_HOURLY = APP_TSX.replace(
  "import { ForecastCard } from './components/ForecastCard'\n",
  "import { ForecastCard } from './components/ForecastCard'\nimport { HourlyForecast } from './components/HourlyForecast'\n"
).replace(
  '          <CurrentConditions now={data.now} unit={unit} />\n',
  '          <CurrentConditions now={data.now} unit={unit} />\n          <HourlyForecast hours={data.hourly.slice(0, 12)} unit={unit} />\n'
)

const CLIENT_TS = `const BASE_URL = 'https://api.acme-weather.example/v2'

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export async function getJson<T>(path: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams({ ...params, key: import.meta.env.VITE_WEATHER_KEY })
  const res = await fetch(\`\${BASE_URL}\${path}?\${qs}\`)
  if (!res.ok) throw new ApiError(res.status, \`Weather API returned \${res.status}\`)
  return (await res.json()) as T
}
`

const FORECAST_TS = `import { useEffect, useState } from 'react'
import { getJson } from './client'

export interface Conditions {
  tempC: number
  feelsLikeC: number
  summary: string
  icon: string
}

export interface Day {
  date: string
  highC: number
  lowC: number
  icon: string
}

export interface Forecast {
  now: Conditions
  daily: Day[]
}

export function fetchDaily(city: string): Promise<Forecast> {
  return getJson<Forecast>('/forecast', { city, days: '5' })
}

export function useForecast(city: string) {
  const [data, setData] = useState<Forecast | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let live = true
    setLoading(true)
    fetchDaily(city)
      .then((f) => live && setData(f))
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [city])

  return { data, error, loading }
}
`

const FORECAST_TS_HOURLY = FORECAST_TS.replace(
  `export interface Forecast {
  now: Conditions
  daily: Day[]
}

export function fetchDaily(city: string): Promise<Forecast> {
  return getJson<Forecast>('/forecast', { city, days: '5' })
}
`,
  `export interface Hour {
  time: string
  tempC: number
  icon: string
  precipChance: number
}

export interface Forecast {
  now: Conditions
  daily: Day[]
  hourly: Hour[]
}

export function fetchDaily(city: string): Promise<Omit<Forecast, 'hourly'>> {
  return getJson('/forecast', { city, days: '5' })
}

export function fetchHourly(city: string): Promise<Hour[]> {
  return getJson<{ hours: Hour[] }>('/hourly', { city, hours: '24' }).then((r) => r.hours)
}

export async function fetchForecast(city: string): Promise<Forecast> {
  const [daily, hourly] = await Promise.all([fetchDaily(city), fetchHourly(city)])
  return { ...daily, hourly }
}
`
).replace('    fetchDaily(city)\n', '    fetchForecast(city)\n')

const CURRENT_TSX = `import type { Conditions } from '../api/forecast'
import { formatTemp, type Unit } from '../units'

export function CurrentConditions({ now, unit }: { now: Conditions; unit: Unit }) {
  return (
    <section className="now">
      <span className="icon">{now.icon}</span>
      <strong>{formatTemp(now.tempC, unit)}</strong>
      <span className="muted">
        {now.summary} · feels like {formatTemp(now.feelsLikeC, unit)}
      </span>
    </section>
  )
}
`

const CARD_TSX = `import type { Day } from '../api/forecast'
import { formatTemp, type Unit } from '../units'

export function ForecastCard({ day, unit }: { day: Day; unit: Unit }) {
  const weekday = new Date(day.date).toLocaleDateString(undefined, { weekday: 'short' })
  return (
    <article className="card">
      <h3>{weekday}</h3>
      <span className="icon">{day.icon}</span>
      <p>
        {formatTemp(day.highC, unit)} <span className="muted">{formatTemp(day.lowC, unit)}</span>
      </p>
    </article>
  )
}
`

const HOURLY_TSX = `import type { Hour } from '../api/forecast'
import { formatTemp, type Unit } from '../units'

export function HourlyForecast({ hours, unit }: { hours: Hour[]; unit: Unit }) {
  return (
    <section className="hourly">
      {hours.map((h) => (
        <div key={h.time} className="hour">
          <time>{new Date(h.time).toLocaleTimeString(undefined, { hour: 'numeric' })}</time>
          <span className="icon">{h.icon}</span>
          <strong>{formatTemp(h.tempC, unit)}</strong>
          {h.precipChance >= 20 && <span className="rain">{h.precipChance}%</span>}
        </div>
      ))}
    </section>
  )
}
`

const HOURLY_TSX_A11Y = HOURLY_TSX.replace(
  '    <section className="hourly">\n',
  '    <section className="hourly" aria-label="Next 12 hours">\n'
).replace(
  '        <div key={h.time} className="hour">\n',
  '        <div key={h.time} className="hour" role="group" aria-label={describeHour(h, unit)}>\n'
) +
  `
function describeHour(h: Hour, unit: Unit): string {
  const time = new Date(h.time).toLocaleTimeString(undefined, { hour: 'numeric' })
  return \`\${time}, \${formatTemp(h.tempC, unit)}, \${h.precipChance}% chance of rain\`
}
`

export const UNITS_TS_BASE = `export type Unit = 'C' | 'F'

export function toFahrenheit(c: number): number {
  return (c * 9) / 5 + 32
}

export function formatTemp(c: number, unit: Unit): string {
  const value = unit === 'C' ? c : toFahrenheit(c)
  return \`\${Math.round(value)}°\`
}
`

/** The bug fix-unit-toggle's chat is about to fix: the refactor that
 *  added the saved unit swapped 9/5 for 5/9. */
export const UNITS_TS_BUGGY = `export type Unit = 'C' | 'F'

const STORAGE_KEY = 'acme-weather:unit'

export function toFahrenheit(c: number): number {
  return (c * 5) / 9 + 32
}

export function formatTemp(c: number, unit: Unit): string {
  const value = unit === 'C' ? c : toFahrenheit(c)
  return \`\${Math.round(value)}°\`
}

export function loadUnit(): Unit {
  return localStorage.getItem(STORAGE_KEY) === 'F' ? 'F' : 'C'
}

export function saveUnit(unit: Unit): void {
  localStorage.setItem(STORAGE_KEY, unit)
}
`

export const UNITS_FIX = {
  old: '  return (c * 5) / 9 + 32',
  new: '  return (c * 9) / 5 + 32'
}
export const UNITS_TS_FIXED = UNITS_TS_BUGGY.replace(UNITS_FIX.old, UNITS_FIX.new)

const APP_TSX_UNITS = APP_TSX.replace("import { type Unit } from './units'", "import { loadUnit, saveUnit, type Unit } from './units'")
  .replace("  const [unit, setUnit] = useState<Unit>('C')\n", '  const [unit, setUnitState] = useState<Unit>(loadUnit)\n  const setUnit = (u: Unit) => {\n    setUnitState(u)\n    saveUnit(u)\n  }\n')

const STYLES = `:root {
  font-family: system-ui, sans-serif;
  color: #1d2430;
  background: #f5f7fb;
}

.app {
  max-width: 720px;
  margin: 0 auto;
  padding: 24px;
}

header {
  display: flex;
  gap: 8px;
}

.now {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin: 24px 0;
  font-size: 2rem;
}

.days {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 8px;
}

.card {
  padding: 12px;
  border-radius: 12px;
  background: white;
  text-align: center;
}

.muted {
  color: #6b7485;
}

.error {
  color: #c62f3a;
}
`

const STYLES_HOURLY = STYLES.replace(
  '.card {',
  `.hourly {
  display: flex;
  gap: 12px;
  overflow-x: auto;
  padding-bottom: 8px;
  margin-bottom: 24px;
}

.hour {
  display: grid;
  justify-items: center;
  min-width: 56px;
}

.rain {
  color: #2f7fd8;
  font-size: 0.75rem;
}

.card {`
)

const STYLES_DARK = STYLES.replace(
  `:root {
  font-family: system-ui, sans-serif;
  color: #1d2430;
  background: #f5f7fb;
}`,
  `:root {
  font-family: system-ui, sans-serif;
  --fg: #1d2430;
  --bg: #f5f7fb;
  --card: white;
  --muted: #6b7485;
  color: var(--fg);
  background: var(--bg);
}

@media (prefers-color-scheme: dark) {
  :root {
    --fg: #e6e9ef;
    --bg: #11151c;
    --card: #1b212b;
    --muted: #8b93a3;
  }
}`
)
  .replace('  background: white;', '  background: var(--card);')
  .replace('  color: #6b7485;', '  color: var(--muted);')

const UNITS_TEST = `import { describe, expect, it } from 'vitest'
import { formatTemp, toFahrenheit } from '../src/units'

describe('toFahrenheit', () => {
  it('converts 0°C to 32°F', () => expect(toFahrenheit(0)).toBe(32))
  it('converts 100°C to 212°F', () => expect(toFahrenheit(100)).toBe(212))
  it('converts -40°C to -40°F', () => expect(toFahrenheit(-40)).toBe(-40))
})

describe('formatTemp', () => {
  it('rounds to whole degrees', () => expect(formatTemp(21.6, 'C')).toBe('22°'))
  it('formats Fahrenheit', () => expect(formatTemp(20, 'F')).toBe('68°'))
})
`

const FORECAST_TEST = `import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchDaily } from '../src/api/forecast'

afterEach(() => vi.restoreAllMocks())

describe('fetchDaily', () => {
  it('asks for five days', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ now: {}, daily: [] }))
    )
    await fetchDaily('Portland')
    expect(String(spy.mock.calls[0][0])).toContain('days=5')
  })
})
`

const FORECAST_TEST_HOURLY =
  FORECAST_TEST.replace("import { fetchDaily } from '../src/api/forecast'", "import { fetchDaily, fetchHourly } from '../src/api/forecast'") +
  `
describe('fetchHourly', () => {
  it('unwraps the hours array', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ hours: [{ time: '2026-06-01T09:00', tempC: 14, icon: '⛅', precipChance: 10 }] }))
    )
    expect(await fetchHourly('Portland')).toHaveLength(1)
  })
})
`

const HOURLY_DOC = `# Hourly forecast

The strip under current conditions shows the next 12 hours from
\`GET /v2/hourly\`. Rain chances under 20% are hidden to keep it quiet.
`

const AQI_TSX = `import { formatAqi, type AirQuality } from '../api/air'

export function AirQualityBadge({ aq }: { aq: AirQuality }) {
  return <span className={\`aqi aqi-\${aq.band}\`}>{formatAqi(aq)}</span>
}
`

export const BASE: Files = {
  '.gitignore': 'node_modules\ndist\n.env.local\n',
  'README.md': README,
  'index.html': INDEX_HTML,
  'package.json': PACKAGE_JSON,
  'vite.config.ts': VITE_CONFIG,
  'src/main.tsx': MAIN_TSX,
  'src/App.tsx': APP_TSX,
  'src/api/client.ts': CLIENT_TS,
  'src/api/forecast.ts': FORECAST_TS,
  'src/components/CurrentConditions.tsx': CURRENT_TSX,
  'src/components/ForecastCard.tsx': CARD_TSX,
  'src/units.ts': UNITS_TS_BASE,
  'src/styles.css': STYLES,
  'tests/forecast.test.ts': FORECAST_TEST,
  'tests/units.test.ts': UNITS_TEST
}

// ── worktrees ──────────────────────────────────────────────────────────

export interface DemoCommit {
  subject: string
  body?: string
  /** Minutes before the demo starts. */
  agoMin: number
  pushed: boolean
  /** New contents per path; null deletes. */
  changes: Record<string, string | null>
}

export interface DemoWorktreeDef {
  path: string
  branch: string
  isMain: boolean
  /** Minutes before the demo starts. */
  createdAgoMin: number
  commits: DemoCommit[]
  staged: Record<string, string | null>
  unstaged: Record<string, string | null>
}

// Listed showcase-first: home opens the first one.
export const WORKTREES: DemoWorktreeDef[] = [
  {
    path: WT.hourly,
    branch: 'feat/hourly-forecast',
    isMain: false,
    createdAgoMin: 60 * 26,
    commits: [
      {
        subject: 'Add hourly forecast endpoint',
        body: 'fetchForecast now loads /forecast and /hourly in parallel.',
        agoMin: 60 * 20,
        pushed: true,
        changes: { 'src/api/forecast.ts': FORECAST_TS_HOURLY, 'tests/forecast.test.ts': FORECAST_TEST_HOURLY }
      },
      {
        subject: 'Add HourlyForecast strip under current conditions',
        agoMin: 60 * 19,
        pushed: true,
        changes: { 'src/components/HourlyForecast.tsx': HOURLY_TSX, 'src/App.tsx': APP_TSX_HOURLY }
      }
    ],
    staged: { 'src/styles.css': STYLES_HOURLY },
    unstaged: { 'src/components/HourlyForecast.tsx': HOURLY_TSX_A11Y, 'docs/hourly.md': HOURLY_DOC }
  },
  {
    path: WT.units,
    branch: 'fix/unit-toggle',
    isMain: false,
    createdAgoMin: 60 * 5,
    commits: [
      {
        subject: 'Remember the °C/°F choice between visits',
        agoMin: 60 * 3,
        pushed: true,
        changes: { 'src/units.ts': UNITS_TS_BUGGY, 'src/App.tsx': APP_TSX_UNITS }
      }
    ],
    staged: {},
    unstaged: {}
  },
  {
    path: WT.dark,
    branch: 'feat/dark-mode',
    isMain: false,
    createdAgoMin: 45,
    commits: [],
    staged: {},
    unstaged: { 'src/styles.css': STYLES_DARK }
  },
  {
    path: WT.air,
    branch: 'feat/air-quality',
    isMain: false,
    createdAgoMin: 60 * 24 * 6,
    commits: [
      {
        subject: 'Show an air quality badge next to current conditions',
        agoMin: 60 * 24 * 5,
        pushed: true,
        changes: { 'src/components/AirQualityBadge.tsx': AQI_TSX }
      }
    ],
    staged: {},
    unstaged: {}
  },
  {
    path: WT.main,
    branch: 'main',
    isMain: true,
    createdAgoMin: 60 * 24 * 40,
    commits: [],
    staged: {},
    unstaged: {}
  }
]
