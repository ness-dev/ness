/** Collapses concurrent calls with the same key onto one in-flight promise.
 *  The entry is dropped as soon as that promise settles, either way, so a
 *  call made afterwards always runs fresh — this dedupes a burst, it never
 *  caches an answer. */
export function createSingleFlight<T>(): (key: string, fn: () => Promise<T>) => Promise<T> {
  const inflight = new Map<string, Promise<T>>()
  return (key, fn) => {
    const pending = inflight.get(key)
    if (pending) return pending
    const started = fn().finally(() => inflight.delete(key))
    inflight.set(key, started)
    return started
  }
}
