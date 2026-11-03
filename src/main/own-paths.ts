// Whether a path belongs to this backend: equal to, or inside, one of its
// worktrees or repo roots.
//
// A client that routes a worktree request to the wrong backend sends a
// path that doesn't exist on this machine. Running git there isn't just a
// wasted call: spawn blocks the main thread until the child has entered
// its cwd, and on macOS `/home` is an autofs mount, so a Linux remote's
// `/home/<user>/…` path costs about a second of frozen main per spawn
// while the automounter gives up. A panel polling a remote worktree
// against the local backend beach-balled the app that way. This check is
// pure string work — it must never touch the filesystem, or it would hit
// the same automounter it exists to avoid.
export function isWithinRoots(path: string, roots: Iterable<string>): boolean {
  if (!path) return false
  for (const root of roots) {
    if (!root) continue
    if (path === root) return true
    const prefix = root.endsWith('/') ? root : `${root}/`
    if (path.startsWith(prefix)) return true
  }
  return false
}

/** Wraps a handler whose first argument after the context is a worktree
 *  path so it only runs for paths `isOwn` accepts. A request handler
 *  rejects a foreign path; a signal handler (`mode: 'drop'`) ignores it,
 *  since a signal has no caller to report to. Every worktree handler that
 *  reaches git or the disk registers through this, so a new one can't
 *  forget the check. */
export function ownedPathsOnly<C, R>(
  isOwn: (path: string) => boolean,
  handler: (ctx: C, path: string, ...rest: any[]) => R, // eslint-disable-line @typescript-eslint/no-explicit-any
  mode: 'reject' | 'drop' = 'reject'
): (ctx: C, path: string, ...rest: any[]) => R | undefined { // eslint-disable-line @typescript-eslint/no-explicit-any
  return (ctx, path, ...rest) => {
    if (!isOwn(path)) {
      if (mode === 'drop') return undefined
      throw new Error(`Not a worktree on this host: ${path}`)
    }
    return handler(ctx, path, ...rest)
  }
}
