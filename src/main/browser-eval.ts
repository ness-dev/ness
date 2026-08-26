// Guards for evaluating JavaScript inside a browser tab. Shared by both
// BrowserManagerLike implementations (Electron WebContentsView and
// Playwright), so it deliberately imports nothing runtime-specific.

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
