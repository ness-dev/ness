// A git that answers the same questions main's worktree.ts does, over the
// in-memory snapshots in project.ts. Mutable only through `writeWork`, so
// the approval flow's edit lands in Changed Files like a real one.
import { createTwoFilesPatch, diffLines } from 'diff'
import type { BranchCommit, ChangedFile, CommitDiff, CommitMeta, FileDiffSides } from '../../../src/renderer/types'
import { AUTHOR, BASE, WORKTREES, type DemoWorktreeDef, type Files } from './project'

interface CommitRecord {
  hash: string
  subject: string
  body: string
  timestamp: number
  pushed: boolean
  before: Files
  after: Files
}

interface WorktreeGit {
  def: DemoWorktreeDef
  head: Files
  index: Files
  work: Files
  commits: CommitRecord[]
}

function apply(files: Files, changes: Record<string, string | null>): Files {
  const out = { ...files }
  for (const [p, v] of Object.entries(changes)) {
    if (v === null) delete out[p]
    else out[p] = v
  }
  return out
}

/** Stable fake SHA from a string, so hashes don't change between launches. */
function fakeSha(seed: string): string {
  let out = ''
  let h = 2166136261
  while (out.length < 40) {
    for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0
    h = Math.imul(h ^ out.length, 16777619) >>> 0
    out += h.toString(16).padStart(8, '0')
  }
  return out.slice(0, 40)
}

function countLines(a: string, b: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const part of diffLines(a, b)) {
    if (part.added) additions += part.count ?? 0
    else if (part.removed) deletions += part.count ?? 0
  }
  return { additions, deletions }
}

function compare(from: Files, to: Files, staged: boolean, untrackedIfNew?: Files): ChangedFile[] {
  const paths = new Set([...Object.keys(from), ...Object.keys(to)])
  const out: ChangedFile[] = []
  for (const path of [...paths].sort()) {
    const a = from[path]
    const b = to[path]
    if (a === b) continue
    const status: ChangedFile['status'] =
      a === undefined ? (untrackedIfNew && !(path in untrackedIfNew) ? 'untracked' : 'added') : b === undefined ? 'deleted' : 'modified'
    out.push({ path, status, staged, ...countLines(a ?? '', b ?? '') })
  }
  return out
}

function sides(a: string | undefined, b: string | undefined): FileDiffSides {
  return {
    original: a ?? '',
    modified: b ?? '',
    originalExists: a !== undefined,
    modifiedExists: b !== undefined,
    binary: false,
    tooLarge: false
  }
}

export class DemoGit {
  private trees = new Map<string, WorktreeGit>()

  constructor(readonly startedAt: number) {
    for (const def of WORKTREES) {
      let files = BASE
      const commits: CommitRecord[] = []
      for (const c of def.commits) {
        const after = apply(files, c.changes)
        commits.push({
          hash: fakeSha(`${def.branch}:${c.subject}`),
          subject: c.subject,
          body: c.body ?? '',
          timestamp: startedAt - c.agoMin * 60_000,
          pushed: c.pushed,
          before: files,
          after
        })
        files = after
      }
      const index = apply(files, def.staged)
      this.trees.set(def.path, { def, head: files, index, work: apply(index, def.unstaged), commits })
    }
  }

  private tree(path: string): WorktreeGit | undefined {
    return this.trees.get(path)
  }

  headSha(path: string): string {
    const t = this.tree(path)
    return t?.commits.at(-1)?.hash ?? fakeSha('main')
  }

  changedFiles(path: string, mode: 'working' | 'branch' = 'working'): ChangedFile[] {
    const t = this.tree(path)
    if (!t) return []
    if (mode === 'branch') return compare(BASE, t.work, false)
    return [...compare(t.head, t.index, true), ...compare(t.index, t.work, false, t.index)]
  }

  diffSides(path: string, file: string, staged: boolean, mode: 'working' | 'branch' = 'working'): FileDiffSides {
    const t = this.tree(path)
    if (!t) return { ...sides(undefined, undefined), error: 'Not found' }
    if (mode === 'branch') return sides(BASE[file], t.work[file])
    return staged ? sides(t.head[file], t.index[file]) : sides(t.index[file], t.work[file])
  }

  readFile(path: string, file: string): string | undefined {
    return this.tree(path)?.work[file]
  }

  listFiles(path: string): string[] {
    const t = this.tree(path)
    return t ? Object.keys(t.work).sort() : []
  }

  writeWork(path: string, file: string, contents: string): void {
    const t = this.tree(path)
    if (t) t.work = { ...t.work, [file]: contents }
  }

  branchCommits(path: string): BranchCommit[] {
    const t = this.tree(path)
    if (!t) return []
    return [...t.commits].reverse().map((c) => ({
      hash: c.hash,
      shortHash: c.hash.slice(0, 7),
      subject: c.subject,
      author: AUTHOR.name,
      relativeDate: relative(this.startedAt - c.timestamp),
      timestamp: Math.floor(c.timestamp / 1000),
      pushed: c.pushed
    }))
  }

  private commit(path: string, hash: string): CommitRecord | undefined {
    return this.tree(path)?.commits.find((c) => c.hash === hash || c.hash.startsWith(hash))
  }

  commitMeta(path: string, hash: string): CommitMeta | null {
    const c = this.commit(path, hash)
    if (!c) return null
    return {
      hash: c.hash,
      shortHash: c.hash.slice(0, 7),
      author: AUTHOR.name,
      authorEmail: AUTHOR.email,
      date: new Date(c.timestamp).toISOString(),
      subject: c.subject,
      body: c.body
    }
  }

  commitChangedFiles(path: string, hash: string): ChangedFile[] {
    const c = this.commit(path, hash)
    return c ? compare(c.before, c.after, false) : []
  }

  commitFileSides(path: string, hash: string, file: string): FileDiffSides {
    const c = this.commit(path, hash)
    return c ? sides(c.before[file], c.after[file]) : { ...sides(undefined, undefined), error: 'Not found' }
  }

  commitDiff(path: string, hash: string): CommitDiff | null {
    const c = this.commit(path, hash)
    const meta = this.commitMeta(path, hash)
    if (!c || !meta) return null
    const diff = compare(c.before, c.after, false)
      .map((f) =>
        createTwoFilesPatch(
          c.before[f.path] === undefined ? '/dev/null' : `a/${f.path}`,
          c.after[f.path] === undefined ? '/dev/null' : `b/${f.path}`,
          c.before[f.path] ?? '',
          c.after[f.path] ?? ''
        ).replace(/^=+\n/, `diff --git a/${f.path} b/${f.path}\n`)
      )
      .join('')
    return { ...meta, diff }
  }
}

function relative(ms: number): string {
  const min = Math.round(ms / 60_000)
  if (min < 60) return `${min} minutes ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`
  const d = Math.round(h / 24)
  return `${d} day${d === 1 ? '' : 's'} ago`
}
