// Canonical form of a git remote URL, so the same repository reached
// three different ways compares equal:
//
//   git@github.com:Org/Repo.git
//   ssh://git@github.com/org/repo
//   https://github.com/org/repo.git/
//
// all become `github.com/org/repo`. This is the cross-host repo identity
// for fleet view: two checkouts on two machines are "the same repo" when
// their origins normalize to the same string. A fork and its upstream
// therefore do NOT merge — different owners — which is the behaviour the
// review settled on after folder-name matching proved too loose.

export function normalizeRemoteUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  let s = raw.trim()
  if (!s) return null

  // scp-like syntax: [user@]host:path — no scheme, single colon before the
  // path. Distinguish from a port by requiring the segment after the colon
  // not to start with a digit followed by `/`.
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\d+\/)(.+)$/.exec(s)
  if (scp && !s.includes('://')) {
    return finish(scp[1], scp[2])
  }

  // URL forms: scheme://[user[:pass]@]host[:port]/path
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(s)
  if (url) {
    return finish(url[1], url[2])
  }

  // Anything else (a bare local path, a malformed string) has no useful
  // identity across machines. Callers fall back to folder name.
  return null
}

function finish(host: string, path: string): string | null {
  let p = path.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/^\/+/, '')
  if (!p) return null
  return `${host.toLowerCase()}/${p.toLowerCase()}`
}
