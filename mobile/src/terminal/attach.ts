// The attach sequence for one page load of a terminal tab, kept free of
// React so its ordering is testable (test/terminal.test.ts). Mirrors
// XTerminal's mount: replay scrollback, wait for the page to finish parsing
// it, then spawn or attach.
//
// Two modes:
//   spawn     first mount: pty:create at the fitted size. Main treats a
//             create for a live PTY as an attach, so this is also how a
//             running agent is joined.
//   reattach  a reload of the page after a reconnect or a WebView crash.
//             Never sends pty:create, because the PTY may have exited
//             meanwhile, and a create would quietly spawn a new process
//             behind the phone's back. Sends the current size instead.

export const RESET_MODES = '\x1b[?1004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l'
export const RESTORED = '\r\n\x1b[2m── session restored ──\x1b[0m\r\n'

export interface AttachDeps {
  getHistory(): Promise<string>
  /** Spawn args for pty:create (spawn mode only). */
  buildArgs(): Promise<string[]>
  /** Subscribe to this terminal's live output. */
  onData(cb: (data: string) => void): () => void
  create(args: string[]): void
  resize(): void
  queue: { push(data: string): void; drained(): Promise<void> }
  /** False once this page load is superseded (reload, unmount): every step
   *  after an await bails, so a stale load can't touch the new page. */
  isCurrent(): boolean
}

export interface Attached {
  /** The PTY was created or attached; input and resizes may flow. */
  live: boolean
  stop(): void
}

const NOT_LIVE: Attached = { live: false, stop: () => {} }

export async function attachTerminal(deps: AttachDeps, mode: 'spawn' | 'reattach'): Promise<Attached> {
  const history = await deps.getHistory().catch(() => '')
  if (!deps.isCurrent()) return NOT_LIVE

  // Subscribe now, not after the replay: anything the PTY prints while the
  // page parses up to 1 MB of history would otherwise never reach the
  // screen. The history response and later data share one socket, so
  // nothing is duplicated or skipped. Held back until the replay is in.
  let held: string[] | null = []
  const off = deps.onData((data) => {
    if (held) held.push(data)
    else deps.queue.push(data)
  })
  const bail = (): Attached => {
    off()
    return NOT_LIVE
  }

  // Everything from here can throw (a request rejected by a dropped
  // socket, most likely mid-buildArgs); the listener must not outlive it.
  try {
    if (history) deps.queue.push(history + RESET_MODES + RESTORED)
    // Also keeps xterm's replies to the replayed bytes (focus reports, DSR)
    // away from the PTY: the caller forwards them only once `live`.
    await deps.queue.drained()
    if (!deps.isCurrent()) return bail()
    for (const data of held) deps.queue.push(data)
    held = null

    if (mode === 'spawn') {
      const args = await deps.buildArgs()
      if (!deps.isCurrent()) return bail()
      deps.create(args)
    } else {
      deps.resize()
    }
  } catch (e) {
    off()
    throw e
  }
  return { live: true, stop: off }
}
