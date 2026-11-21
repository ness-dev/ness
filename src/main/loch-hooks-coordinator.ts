// Serializes loch hook installs and removals per worktree, and makes an
// opt-out win over an install that's still in flight. Recording is consent,
// so a stale opt-out — Settings says "off" while some worktree still has
// hooks — is the one failure that matters.
//
// - Every install and removal for a path runs through one per-path queue, so
//   two `loch install`s never read-modify-write the same settings.local.json
//   at once.
// - An install re-checks the opt-in list on both sides of its await. If the
//   repo was opted out meanwhile, it removes what it just wrote.
// - Callers opting out must update the list BEFORE queueing removals, so any
//   install already running sees the change on its post-check.

export interface HookInstallResult {
  ok: boolean
  /** The loch binary the written hook lines name. */
  bin?: string
  viaProject?: boolean
  code?: string
  error?: string
}

export interface LochHooksDeps<R extends HookInstallResult> {
  isRecording: (repoRoot: string) => boolean
  install: (worktreePath: string) => Promise<R>
  /** Throws on failure. */
  remove: (worktreePath: string) => void
  log?: (msg: string, detail?: unknown) => void
}

export class LochHooksCoordinator<R extends HookInstallResult = HookInstallResult> {
  /** Paths this process has installed into, and the binary their hook lines
   *  name, so a sweep skips them until the binary Ness uses changes. Set from
   *  the binary the install actually used, so an install that raced a switch
   *  still reads as stale. */
  readonly hooked = new Map<string, string>()

  /** Whether `path`'s hooks were written this process and name `bin`. */
  isCurrent(path: string, bin: string | null): boolean {
    return bin !== null && this.hooked.get(path) === bin
  }
  private queues = new Map<string, Promise<unknown>>()

  constructor(private deps: LochHooksDeps<R>) {}

  private enqueue<T>(path: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.queues.get(path) ?? Promise.resolve()
    const next = prev.catch(() => undefined).then(fn)
    this.queues.set(path, next)
    void next
      .finally(() => {
        if (this.queues.get(path) === next) this.queues.delete(path)
      })
      .catch(() => undefined)
    return next
  }

  /** Install if the repo is still opted in once the install finishes. Null
   *  when skipped (not opted in) or rolled back (opted out meanwhile). */
  installIfRecording(wt: { path: string; repoRoot: string }): Promise<R | null> {
    return this.enqueue(wt.path, async () => {
      if (!this.deps.isRecording(wt.repoRoot)) return null
      const r = await this.deps.install(wt.path)
      if (!this.deps.isRecording(wt.repoRoot)) {
        this.hooked.delete(wt.path)
        try {
          this.deps.remove(wt.path)
        } catch (err) {
          this.deps.log?.(`rollback after opt-out failed in ${wt.path}`, err)
        }
        return null
      }
      if (r.ok) this.hooked.set(wt.path, r.bin ?? '')
      return r
    })
  }

  /** Remove after anything already queued for the path. True on success. */
  remove(path: string): Promise<boolean> {
    return this.enqueue(path, () => {
      this.hooked.delete(path)
      try {
        this.deps.remove(path)
        return true
      } catch (err) {
        this.deps.log?.(`could not remove hooks from ${path}`, err)
        return false
      }
    })
  }
}
