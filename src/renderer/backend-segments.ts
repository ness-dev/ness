// Per-backend memoized projection, for views that span every registered
// backend rather than just the active one.
//
// Why this exists: `BackendsRegistry` holds N `(transport, ClientStore)`
// pairs and *switches* between them — every slice hook reads the active
// store. A sidebar that lists local and remote worktrees together needs
// to read all N at once, which `useSyncExternalStore` only tolerates if
// `getSnapshot` is reference-stable for unchanged data. Returning a
// freshly-merged array per read makes React detect perpetual change and
// spin.
//
// The load-bearing detail is the cache key. Keying on the backend's
// `AppState` would be worthless: the store does
// `this.state = rootReducer(this.state, event)`, so a new AppState object
// exists after every event — including the 30-per-second stream of
// terminal status events. The key has to be the *inputs the projection
// actually reads*, which the reducers keep reference-stable when they
// didn't touch them (see CLAUDE.md anti-pattern #3). That turns "did
// anything happen anywhere" into "did this view's inputs change on this
// backend", which is the question we can afford to ask per read.
//
// Same idea as a per-backend `useMemo`, except it can't be a `useMemo`:
// hooks can't be called in a loop whose length changes when the user
// adds or removes a backend.

/** One backend's contribution to a cross-backend view. The wrapper object
 *  is cached alongside the projected value so consumers can compare
 *  segments by reference, not just their contents. */
export interface BackendSegment<T> {
  backendId: string
  value: T
}

/** A backend's current state, as read from the registry at snapshot time. */
export interface SegmentSource<S> {
  id: string
  state: S
}

interface CacheEntry<T> {
  deps: readonly unknown[]
  segment: BackendSegment<T>
}

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** Projects each backend's state into a segment, reusing both the segment
 *  and the containing array when nothing relevant changed.
 *
 *  Stateful by design — one instance per view, held at module scope next
 *  to the hook that reads it, like the memo behind `useSettings`. Not safe
 *  to share between two views with different projections. */
export class SegmentedSelector<S, T> {
  private perBackend = new Map<string, CacheEntry<T>>()
  private last: readonly BackendSegment<T>[] | null = null

  /** @param deps Inputs the projection reads, in stable order. Compared
   *              element-wise by reference against the previous call.
   *  @param project Runs only when `deps` changed for that backend. */
  constructor(
    private readonly deps: (state: S, backendId: string) => readonly unknown[],
    private readonly project: (state: S, backendId: string) => T
  ) {}

  select(sources: readonly SegmentSource<S>[]): readonly BackendSegment<T>[] {
    const next: BackendSegment<T>[] = []
    const seen = new Set<string>()

    for (const source of sources) {
      seen.add(source.id)
      const deps = this.deps(source.state, source.id)
      const cached = this.perBackend.get(source.id)
      if (cached && sameDeps(cached.deps, deps)) {
        next.push(cached.segment)
        continue
      }
      const segment: BackendSegment<T> = {
        backendId: source.id,
        value: this.project(source.state, source.id)
      }
      this.perBackend.set(source.id, { deps, segment })
      next.push(segment)
    }

    // Evict departed backends. Without this the map grows for the life of
    // the session, and a backend that's removed and re-added would hand
    // back a segment projected from its pre-removal state.
    if (this.perBackend.size !== seen.size) {
      for (const id of [...this.perBackend.keys()]) {
        if (!seen.has(id)) this.perBackend.delete(id)
      }
    }

    // Reuse the previous array when every segment matched, so consumers
    // comparing the whole list by reference (useSyncExternalStore, a memo
    // dep array) see no change.
    const prev = this.last
    if (prev && prev.length === next.length) {
      let identical = true
      for (let i = 0; i < prev.length; i++) {
        if (prev[i] !== next[i]) {
          identical = false
          break
        }
      }
      if (identical) return prev
    }
    this.last = next
    return next
  }

  /** Test/diagnostic hook: how many backends are currently cached. */
  cachedCount(): number {
    return this.perBackend.size
  }
}
