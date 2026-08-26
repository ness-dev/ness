export interface RepoIndexEntry {
  repoRoot: string
  repoLabel: string
  chatCount: number
  lastActivityMs: number
}

export interface RepoIndexResult {
  repos: RepoIndexEntry[]
  scannedDirs: number
  elapsedMs: number
}
