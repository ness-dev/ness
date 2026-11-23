import type { Store } from './store'
import type { Worktree } from '../shared/state/worktrees'
import type { LochRecordingResult } from '../shared/loch'

export interface LochAutoRecorderDeps {
  /** The standing onboarding answer, `settings.lochRecordNewRepos`. */
  recordNewRepos: () => boolean
  /** Currently registered repo roots (config, not the store, so a removal
   *  mid-chain is seen even before its event lands). */
  repoRoots: () => readonly string[]
  isRecording: (repoRoot: string) => boolean
  /** loch present, or downloadable for this platform. */
  canRecord: () => boolean
  /** The same opt-in `loch:setRecording` runs. */
  enable: (repoRoot: string, worktrees: readonly Worktree[]) => Promise<LochRecordingResult>
  log: (msg: string, detail?: unknown) => void
  /** How long a new repo may wait for a usable worktree listing. */
  listTimeoutMs?: number
}

/** Turns loch recording on for repos registered while
 *  `lochRecordNewRepos` is on (the onboarding answer).
 *
 *  Watches the store rather than registerRepoRoot's callers, so every
 *  route in (import, add-repo, MCP add_repo, new project) is covered for
 *  every client. A new repo waits for its first worktree listing, since
 *  installs are per worktree, then goes through the same enable path as
 *  the explicit opt-in. Runs are serialized: an import adds several repos
 *  at once, and each would otherwise start its own loch download.
 *
 *  While a repo is waiting or installing it's in `loch.autoRecording`,
 *  which hides the sidebar prompt. Every exit — success, failure, removal,
 *  answer flipped, or no usable listing within the timeout — takes it out
 *  again; a repo that didn't end up recording then gets the prompt back. */
export class LochAutoRecorder {
  private known: Set<string>
  private awaiting = new Map<string, ReturnType<typeof setTimeout>>()
  private chain: Promise<void> = Promise.resolve()
  private unsubscribe: (() => void) | null = null

  constructor(
    private store: Store,
    private deps: LochAutoRecorderDeps
  ) {
    this.known = new Set(deps.repoRoots())
  }

  start(): void {
    this.unsubscribe = this.store.subscribe((event) => {
      if (event.type === 'worktrees/reposChanged') this.onRepos(event.payload)
      else if (event.type === 'worktrees/listChanged') this.onList(event.payload)
    })
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    for (const timer of this.awaiting.values()) clearTimeout(timer)
    this.awaiting.clear()
  }

  /** Resolves once every queued enable has finished. For tests. */
  idle(): Promise<void> {
    return this.chain
  }

  private onRepos(roots: readonly string[]): void {
    const next = new Set(roots)
    for (const root of next) {
      if (this.known.has(root) || !this.deps.recordNewRepos() || this.deps.isRecording(root)) continue
      if (!this.deps.canRecord()) continue
      // Bounded: if git never lists a usable worktree for it, give the
      // sidebar prompt back rather than hiding it for the session.
      const timer = setTimeout(() => {
        if (!this.awaiting.delete(root)) return
        this.deps.log(`auto-record ${root}: no usable worktree listed, leaving it to the prompt`)
        this.setActive(root, false)
      }, this.deps.listTimeoutMs ?? 60_000)
      // Never hold a headless shutdown open for this.
      timer.unref?.()
      this.awaiting.set(root, timer)
      this.setActive(root, true)
    }
    for (const [root, timer] of this.awaiting) {
      if (next.has(root)) continue
      clearTimeout(timer)
      this.awaiting.delete(root)
      this.setActive(root, false)
    }
    this.known = next
  }

  private onList(list: readonly Worktree[]): void {
    for (const [root, timer] of this.awaiting) {
      const worktrees = list.filter((w) => w.repoRoot === root && !w.prunable)
      if (worktrees.length === 0) continue
      clearTimeout(timer)
      this.awaiting.delete(root)
      this.queue(root, worktrees)
    }
  }

  private queue(root: string, worktrees: readonly Worktree[]): void {
    this.chain = this.chain.then(async () => {
      try {
        // Re-checked: the answer may have flipped, or the repo been
        // removed, while an earlier repo in the chain was installing.
        if (!this.deps.recordNewRepos() || !this.deps.repoRoots().includes(root)) return
        const r = await this.deps.enable(root, worktrees)
        if (!r.ok) this.deps.log(`auto-record ${root} failed: ${r.code}`, r.error)
      } catch (err) {
        this.deps.log(`auto-record ${root} threw`, err instanceof Error ? err.message : err)
      } finally {
        this.setActive(root, false)
      }
    })
  }

  private setActive(repoRoot: string, active: boolean): void {
    this.store.dispatch({ type: 'loch/autoRecordingChanged', payload: { repoRoot, active } })
  }
}
