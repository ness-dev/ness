import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { aggregateRepos, findRepoRoot, scanRepoIndex } from './repo-index'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'repo-index-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeSession(dir: string, sessionId: string, lines: string[]): void {
  const dirPath = join(root, dir)
  mkdirSync(dirPath, { recursive: true })
  writeFileSync(join(dirPath, `${sessionId}.jsonl`), lines.join('\n') + '\n', 'utf8')
}

function cwdLine(cwd: string): string {
  return JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hi' } })
}

/** Stands in for the `.git` probe: these directories are repos, nothing else is. */
function reposAt(...roots: string[]): (dir: string) => boolean {
  return (dir) => roots.includes(dir)
}

const never = (): boolean => false

describe('findRepoRoot', () => {
  it('collapses a worktree path without touching the filesystem', () => {
    // The worktree is usually deleted by now, so nothing on disk can answer.
    expect(findRepoRoot('/Users/x/apps/proj-worktrees/feature', never)).toBe('/Users/x/apps/proj')
  })

  it('walks up from a subdirectory of a plain checkout', () => {
    const has = reposAt('/Users/x/apps/proj')
    expect(findRepoRoot('/Users/x/apps/proj/src/main', has)).toBe('/Users/x/apps/proj')
  })

  it('returns the checkout itself when the cwd is already the root', () => {
    const has = reposAt('/Users/x/apps/proj')
    expect(findRepoRoot('/Users/x/apps/proj', has)).toBe('/Users/x/apps/proj')
  })

  it('prefers the innermost repo when one is nested in another', () => {
    const has = reposAt('/Users/x/apps/outer', '/Users/x/apps/outer/inner')
    expect(findRepoRoot('/Users/x/apps/outer/inner/src', has)).toBe('/Users/x/apps/outer/inner')
  })

  it('gives up on a cwd that is under no repo at all', () => {
    expect(findRepoRoot('/tmp/scratch', never)).toBeNull()
  })
})

describe('aggregateRepos', () => {
  const resolve = (cwd: string): string | null => findRepoRoot(cwd, reposAt('/Users/x/apps/proj'))

  it('merges chat counts and takes the newest activity across directories', () => {
    const repos = aggregateRepos(
      [
        { cwd: '/Users/x/apps/proj-worktrees/a', chatCount: 3, lastActivityMs: 100 },
        { cwd: '/Users/x/apps/proj-worktrees/b', chatCount: 4, lastActivityMs: 500 },
        { cwd: '/Users/x/apps/proj', chatCount: 1, lastActivityMs: 200 }
      ],
      resolve
    )
    expect(repos).toEqual([
      { repoRoot: '/Users/x/apps/proj', repoLabel: 'proj', chatCount: 8, lastActivityMs: 500 }
    ])
  })

  it('sorts newest activity first', () => {
    const repos = aggregateRepos(
      [
        { cwd: '/a/old-worktrees/x', chatCount: 1, lastActivityMs: 100 },
        { cwd: '/a/new-worktrees/x', chatCount: 1, lastActivityMs: 900 },
        { cwd: '/a/mid-worktrees/x', chatCount: 1, lastActivityMs: 500 }
      ],
      (cwd) => findRepoRoot(cwd, never)
    )
    expect(repos.map((r) => r.repoLabel)).toEqual(['new', 'mid', 'old'])
  })

  it('drops cwds that name no resolvable repo', () => {
    const dirs = [{ cwd: '/tmp/scratch', chatCount: 1, lastActivityMs: 1 }]
    expect(aggregateRepos(dirs, (cwd) => findRepoRoot(cwd, never))).toEqual([])
  })
})

describe('scanRepoIndex', () => {
  it('reads the cwd out of transcripts rather than trusting directory names', async () => {
    writeSession('-Users-x-apps-proj-worktrees-feat', 'a', [
      cwdLine('/Users/x/apps/proj-worktrees/feat')
    ])
    const result = await scanRepoIndex({ root, hasGitDir: reposAt('/Users/x/apps/proj') })
    expect(result.repos).toHaveLength(1)
    expect(result.repos[0].repoRoot).toBe('/Users/x/apps/proj')
    expect(result.scannedDirs).toBe(1)
  })

  it('finds repos for a user who has never used a worktree', async () => {
    writeSession('d', 'a', [cwdLine('/Users/x/apps/proj')])
    writeSession('e', 'b', [cwdLine('/Users/x/apps/proj/src')])
    const result = await scanRepoIndex({ root, hasGitDir: reposAt('/Users/x/apps/proj') })
    expect(result.repos).toHaveLength(1)
    expect(result.repos[0].chatCount).toBe(2)
  })

  it('counts every transcript in a directory', async () => {
    writeSession('d', 'a', [cwdLine('/Users/x/apps/proj-worktrees/one')])
    writeSession('d', 'b', [cwdLine('/Users/x/apps/proj-worktrees/one')])
    const result = await scanRepoIndex({ root, hasGitDir: reposAt('/Users/x/apps/proj') })
    expect(result.repos[0].chatCount).toBe(2)
  })

  it('drops repos whose root no longer exists on disk', async () => {
    writeSession('gone', 'a', [cwdLine('/Users/x/apps/deleted-worktrees/feat')])
    writeSession('here', 'b', [cwdLine('/Users/x/apps/alive-worktrees/feat')])
    const result = await scanRepoIndex({ root, hasGitDir: reposAt('/Users/x/apps/alive') })
    expect(result.repos.map((r) => r.repoLabel)).toEqual(['alive'])
  })

  it('falls through to later files when the first has no cwd', async () => {
    writeSession('d', 'a', [JSON.stringify({ type: 'summary', summary: 'x' })])
    writeSession('d', 'b', [cwdLine('/Users/x/apps/proj-worktrees/feat')])
    const result = await scanRepoIndex({ root, hasGitDir: reposAt('/Users/x/apps/proj') })
    expect(result.repos[0].repoRoot).toBe('/Users/x/apps/proj')
  })

  it('ignores directories with no transcripts', async () => {
    mkdirSync(join(root, 'empty'), { recursive: true })
    writeFileSync(join(root, 'empty', 'notes.txt'), 'hello', 'utf8')
    const result = await scanRepoIndex({ root, hasGitDir: () => true })
    expect(result.repos).toEqual([])
    expect(result.scannedDirs).toBe(1)
  })

  it('returns an empty result when the projects root is missing', async () => {
    const result = await scanRepoIndex({ root: join(root, 'nope') })
    expect(result.repos).toEqual([])
    expect(result.scannedDirs).toBe(0)
  })
})
