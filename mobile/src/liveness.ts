// Foreground liveness for every live client: a probe on returning to the
// foreground, and a heartbeat while there. AppState is passed in so the
// wiring is testable in Node (test/liveness.test.ts).

export const HEARTBEAT_MS = 30_000
/** A little under the interval, so timer jitter (or a frame landing just
 *  after a tick) can't make every other tick skip and double the cadence. */
export const HEARTBEAT_IDLE_MS = HEARTBEAT_MS - 5_000

type AppStateStatus = string
export interface AppStateLike {
  currentState: AppStateStatus | null | undefined
  addEventListener(type: 'change', cb: (st: AppStateStatus) => void): { remove(): void }
}
export interface LivenessClient {
  wake(): void
  checkAlive(opts?: { ifIdleMs?: number }): Promise<void>
}

/** Back in the foreground the network may well have changed (home Wi-Fi
 *  again), so wake() skips any backoff started while away and checks that a
 *  socket still reading OPEN really is. While foregrounded, the heartbeat
 *  catches a Wi-Fi change with the app open. It only probes a connection
 *  that's received nothing for HEARTBEAT_IDLE_MS, so it costs at most one
 *  tiny round trip per idle 30s, and it stops in the background. Worst case
 *  to notice a link dying with the app open: ~2 ticks + the probe timeout. */
export function watchLiveness(appState: AppStateLike, clients: () => Iterable<LivenessClient>): () => void {
  let beat: ReturnType<typeof setInterval> | null = null
  const startBeat = () => {
    beat ??= setInterval(() => {
      for (const c of clients()) void c.checkAlive({ ifIdleMs: HEARTBEAT_IDLE_MS })
    }, HEARTBEAT_MS)
  }
  const stopBeat = () => {
    if (beat) clearInterval(beat)
    beat = null
  }
  if (appState.currentState === 'active') startBeat()
  const sub = appState.addEventListener('change', (st) => {
    if (st === 'active') {
      for (const c of clients()) c.wake()
      startBeat()
    } else if (st === 'background') {
      stopBeat()
    }
  })
  return () => {
    sub.remove()
    stopBeat()
  }
}
