// Guards for evaluating JavaScript inside a browser tab. Shared by both
// BrowserManagerLike implementations (Electron WebContentsView and
// Playwright), so it deliberately imports nothing runtime-specific.

import { Script } from 'vm'

/** Long enough for a slow real page's eval, far shorter than the patience of
 * whoever is waiting on the MCP tool call. */
export const EVAL_TIMEOUT_MS = 5_000

export interface TabEvalState {
  /** True once any document has committed in the main frame. */
  hasDocument: boolean
  /** Description of the last main-frame load failure, cleared on commit. */
  lastLoadError: string | null
  /** True while the tab's renderer process is gone. */
  crashed: boolean
  /** Why the renderer died, from `render-process-gone`. */
  crashReason: string | null
}

/** `webContents.executeJavaScript` on a view with no live renderer — one whose
 * main frame never committed, or whose renderer process died — neither
 * resolves nor rejects. It queues for a frame that never arrives, so a
 * try/catch around it can't rescue the caller. Race it against a timer. */
export async function evalWithTimeout<T>(
  run: () => Promise<T>,
  what: string,
  timeoutMs: number = EVAL_TIMEOUT_MS
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} timed out after ${timeoutMs}ms`)),
          timeoutMs
        )
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** The actionable reason a tab can never be evaluated, or null when evaluating
 * is worth attempting. Beats waiting out the timeout: it names the fix
 * (reload the tab / the URL was dead) instead of just the symptom.
 *
 * A tab mid-first-load has no document yet but no error either — its eval
 * queues until the frame commits, which is the behaviour callers want. */
export function evalBlockedReason(state: TabEvalState): string | null {
  if (state.crashed) {
    const why = state.crashReason ? ` (reason: ${state.crashReason})` : ''
    return `tab renderer crashed${why} — reload the tab`
  }
  if (!state.hasDocument && state.lastLoadError) {
    return `tab has no document loaded (last load failed: ${state.lastLoadError})`
  }
  return null
}

/** What `eval_tab` hands back. `value` is JSON text, or the literal
 * `undefined` — JSON has no spelling for it, and "your expression produced
 * nothing" is worth telling apart from `null`. */
export type TabEvalResult =
  | { ok: true; value: string; error?: undefined }
  | { ok: false; error: string; value?: undefined }

export const EVAL_MAX_TIMEOUT_MS = 60_000

function compiles(source: string): string | null {
  try {
    new Script(source)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** The four shapes an agent's code is tried as, most specific first: a bare
 * expression (`document.title`), one using `await`, a statement block that
 * `return`s, and one that also awaits. Deciding here, by compiling in main,
 * rather than in the page with `new Function` keeps eval working on pages
 * whose CSP forbids `unsafe-eval` — the injected script itself bypasses CSP,
 * but a Function constructor running inside it would not. */
export function wrapEvalCode(code: string): { fn: string } | { error: string } {
  // `document.title;` is an expression to anyone typing it, but `(x;)` isn't.
  const expr = code.trim().replace(/;+\s*$/, '')
  // The newline keeps a trailing `// comment` from swallowing the paren.
  const candidates = [
    `() => (${expr}\n)`,
    `async () => (${expr}\n)`,
    `function () {\n${code}\n}`,
    `async function () {\n${code}\n}`
  ]
  let lastError = ''
  for (const fn of candidates) {
    const err = compiles(`(${fn})`)
    if (err === null) return { fn }
    lastError = err
  }
  return { error: `SyntaxError: ${lastError}` }
}

/** Page-side encoder. JSON.stringify alone throws on cycles and BigInt,
 * silently drops undefined/functions, and walks a DOM node's entire
 * reachable graph — exactly what layout debugging returns most. */
const ENCODE_SOURCE = String.raw`function __nessEncode(root) {
  var MAX_DEPTH = 12
  var stack = []
  function describeNode(n) {
    if (n.nodeType === 1) {
      var s = '<' + n.tagName.toLowerCase()
      if (n.id) s += '#' + n.id
      if (typeof n.className === 'string' && n.className.trim()) {
        s += '.' + n.className.trim().split(/\s+/).join('.')
      }
      return s + '>'
    }
    if (n.nodeType === 3) return '#text ' + JSON.stringify((n.textContent || '').slice(0, 80))
    if (n.nodeType === 9) return '#document'
    return '[' + n.nodeName + ']'
  }
  function enc(v, depth) {
    if (v === null) return null
    var t = typeof v
    if (t === 'string' || t === 'boolean') return v
    if (t === 'number') return isFinite(v) ? v : String(v)
    if (t === 'undefined') return undefined
    if (t === 'bigint') return v.toString() + 'n'
    if (t === 'symbol') return v.toString()
    if (t === 'function') return '[Function' + (v.name ? ' ' + v.name : '') + ']'
    if (typeof Node !== 'undefined' && v instanceof Node) return describeNode(v)
    if (typeof Window !== 'undefined' && v instanceof Window) return '[Window]'
    if (stack.indexOf(v) !== -1) return '[Circular]'
    if (depth >= MAX_DEPTH) return Array.isArray(v) ? '[Array(' + v.length + ')]' : '[Object]'
    stack.push(v)
    try {
      if (v instanceof Error) {
        return { name: v.name, message: v.message, stack: v.stack }
      }
      if (typeof v.toJSON === 'function') {
        try { return enc(v.toJSON(), depth + 1) } catch (e) {}
      }
      if (v instanceof Map) {
        return Array.from(v.entries()).map(function (e) { return [enc(e[0], depth + 1), enc(e[1], depth + 1)] })
      }
      if (
        Array.isArray(v) || v instanceof Set || ArrayBuffer.isView(v) ||
        (typeof NodeList !== 'undefined' && v instanceof NodeList) ||
        (typeof HTMLCollection !== 'undefined' && v instanceof HTMLCollection)
      ) {
        return Array.from(v).map(function (x) {
          var e = enc(x, depth + 1)
          return e === undefined ? null : e
        })
      }
      var out = {}
      var keys = Object.keys(v)
      for (var i = 0; i < keys.length; i++) {
        var val
        try { val = v[keys[i]] } catch (e) { val = '[Threw: ' + (e && e.message) + ']' }
        var e2 = enc(val, depth + 1)
        if (e2 !== undefined) out[keys[i]] = e2
      }
      return out
    } finally {
      stack.pop()
    }
  }
  if (root === undefined) return 'undefined'
  var encoded = enc(root, 0)
  return encoded === undefined ? 'undefined' : JSON.stringify(encoded)
}`

/** The script both backends inject. It always resolves (never rejects) with
 * a structured-clone-safe TabEvalResult, so a throw inside the agent's code
 * comes back as a readable error instead of Electron's opaque "Script failed
 * to execute". */
export function buildEvalScript(
  code: string,
  opts: { awaitPromise?: boolean } = {}
): { script: string } | { error: string } {
  const wrapped = wrapEvalCode(code)
  if ('error' in wrapped) return wrapped
  const awaitPromise = opts.awaitPromise !== false
  return {
    script: `(async () => {
  ${ENCODE_SOURCE}
  try {
    let v = (${wrapped.fn})()
    if (v !== null && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function') {
      if (!${awaitPromise}) return { ok: true, value: '"[Promise — not awaited]"' }
      v = await v
    }
    return { ok: true, value: __nessEncode(v) }
  } catch (e) {
    const msg = e instanceof Error ? (e.stack || (e.name + ': ' + e.message)) : 'Uncaught ' + String(e)
    return { ok: false, error: msg }
  }
})()`
  }
}

/** Clamp a caller-supplied timeout: missing/garbage means the default, and
 * nothing waits longer than a minute on a wedged page. */
export function clampEvalTimeout(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return EVAL_TIMEOUT_MS
  return Math.min(Math.round(n), EVAL_MAX_TIMEOUT_MS)
}
