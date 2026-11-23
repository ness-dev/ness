// Integration test for PlaywrightBrowserManager. Drives the public
// surface against a tiny in-process HTTP server so we exercise the
// real Chromium launch path without needing the rest of the harness
// boot. Skipped when no browser is available locally — CI can install
// Chromium ahead of running.

import { describe, it, expect, beforeAll, afterAll, type TestContext } from 'vitest'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import { createRequire } from 'module'
import { PlaywrightBrowserManager } from './browser-manager-playwright'

const HTML = `<!doctype html>
<html><head><title>test page</title></head>
<body style="margin:0;padding:24px;font-family:sans-serif;">
<button id="btn" style="padding:20px;font-size:20px;">Click me</button>
<div id="status">unclicked</div>
<script>
document.getElementById('btn').addEventListener('click', () => {
  document.getElementById('status').textContent = 'clicked';
  document.title = 'clicked';
});
</script>
</body></html>`

// CI runners without a system Chrome would occasionally see `chromium.launch`
// stall in browser discovery for >30s instead of throwing fast, blowing past
// vitest's beforeAll hookTimeout and turning a designed-skip into a hard
// CI failure. Race the launch against a short timer so the no-browser case
// always lands in the skip branch instead.
const PROBE_TIMEOUT_MS = 10_000

async function probeBrowser(): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const dynamicRequire = createRequire(__filename)
    const { chromium } = dynamicRequire('playwright-core') as typeof import('playwright-core')
    const explicit = process.env['HARNESS_PLAYWRIGHT_BROWSER']
    const launchPromise =
      explicit && explicit.trim()
        ? chromium.launch({ headless: true, executablePath: explicit.trim() })
        : chromium.launch({ headless: true, channel: 'chrome' })
    // Defensive: if the launch eventually resolves *after* we've given up,
    // close the orphan so we don't leak a chromium process.
    let abandoned = false
    void launchPromise.then((b) => { if (abandoned) void b.close().catch(() => {}) }).catch(() => {})
    let timer: NodeJS.Timeout | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`probeBrowser timed out after ${PROBE_TIMEOUT_MS}ms`)),
        PROBE_TIMEOUT_MS
      )
    })
    try {
      const browser = await Promise.race([launchPromise, timeoutPromise])
      await browser.close()
      return { ok: true }
    } catch (err) {
      abandoned = true
      throw err
    } finally {
      if (timer) clearTimeout(timer)
    }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

describe('PlaywrightBrowserManager', () => {
  let server: Server | null = null
  let baseUrl = ''
  let mgr: PlaywrightBrowserManager | null = null
  let probeResult: { ok: true } | { ok: false; reason: string } = { ok: false, reason: 'not probed' }

  beforeAll(async () => {
    probeResult = await probeBrowser()
    if (!probeResult.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        '[PlaywrightBrowserManager test] skipping — could not launch a browser. ' +
          'Install Chrome or set HARNESS_PLAYWRIGHT_BROWSER. Error:',
        probeResult.reason
      )
      return
    }
    server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(HTML)
    })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('no addr')
    baseUrl = `http://127.0.0.1:${addr.port}`
    mgr = new PlaywrightBrowserManager()
  }, 30000)

  afterAll(async () => {
    mgr?.destroyAll()
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
    // Give Playwright a moment to drain its child-process teardown so
    // vitest's worker doesn't see "Cannot exit, async work pending".
    await new Promise((r) => setTimeout(r, 250))
  })

  it(
    'creates a tab, navigates, screenshots, clicks via clickables, and tears down',
    async (ctx: TestContext) => {
      if (!probeResult.ok) {
        ctx.skip()
        return
      }
      const m = mgr!
      const tabId = 'test-tab-1'
      m.create(tabId, '/tmp/wt-playwright-test', baseUrl)
      expect(m.hasTab(tabId)).toBe(true)

      // Wait until the page reports the test URL — proves both tab
      // instantiation and the initial goto resolved.
      const navDeadline = Date.now() + 15000
      let url: string | null = null
      while (Date.now() < navDeadline) {
        url = m.getUrl(tabId)
        if (url && url.startsWith('http://')) break
        await new Promise((r) => setTimeout(r, 100))
      }
      expect(url).toMatch(new RegExp(`^${baseUrl}/?$`))

      const shot = await m.capturePage(tabId)
      expect(shot?.error).toBeUndefined()
      expect(shot?.format).toBe('jpeg')
      expect(shot?.data?.length ?? 0).toBeGreaterThan(100)

      const clickables = (await m.getClickables(tabId)) as
        | { items: Array<{ role: string; name: string; cx: number; cy: number }> }
        | null
      expect(clickables).not.toBeNull()
      const btn = clickables!.items.find((i) => i.role === 'button')
      expect(btn).toBeDefined()
      expect(btn!.name.toLowerCase()).toContain('click')

      m.clickTab(tabId, btn!.cx, btn!.cy)

      // Poll the DOM for the click effect — clickTab is fire-and-forget.
      const clickDeadline = Date.now() + 5000
      let domSaw = false
      while (Date.now() < clickDeadline) {
        const dom = await m.getDom(tabId)
        if (dom && dom.includes('>clicked<')) {
          domSaw = true
          break
        }
        await new Promise((r) => setTimeout(r, 100))
      }
      expect(domSaw).toBe(true)

      const measured = await m.evalTab(
        tabId,
        'const b = document.getElementById("btn")\nreturn {el: b, w: b.getBoundingClientRect().width > 0, title: document.title}'
      )
      expect(measured?.ok).toBe(true)
      expect(JSON.parse(measured!.value!)).toEqual({ el: '<button#btn>', w: true, title: 'clicked' })
      const thrown = await m.evalTab(tabId, 'document.querySelector("#nope").click()')
      expect(thrown?.ok).toBe(false)
      expect(thrown?.error).toMatch(/TypeError/)

      m.destroy(tabId)
      expect(m.hasTab(tabId)).toBe(false)
      expect(m.getUrl(tabId)).toBeNull()
    },
    30000
  )
})
