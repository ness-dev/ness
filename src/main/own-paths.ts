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
