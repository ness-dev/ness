// URL normalization shared by both browser managers (Electron + Playwright).
// Kept electron-free so it's importable from unit tests.

const SCHEME_RE = /^[a-z][a-z0-9+\-.]*:/i
// `localhost:5173` matches SCHEME_RE ("localhost:" looks like a scheme) but is
// really host:port — Chromium rejects it as ERR_INVALID_URL.
const HOST_PORT_RE = /^[a-z0-9.-]+:\d+(?:[/?#]|$)/i
const LOOPBACK_RE = /^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\])(?::|[/?#]|$)/i

/**
 * Turn user/agent input into something `loadURL` accepts. A bare host gets a
 * scheme prepended; anything that already carries one is passed through.
 * Loopback hosts get `http://` because dev servers rarely speak TLS.
 * Returns null for empty input so callers can pick their own fallback.
 */
export function normalizeBrowserUrl(input: string): string | null {
  const target = (input ?? '').trim()
  if (!target) return null
  if (SCHEME_RE.test(target) && !HOST_PORT_RE.test(target)) return target
  return `${LOOPBACK_RE.test(target) ? 'http' : 'https'}://${target}`
}
