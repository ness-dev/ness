import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { listBranchInventory, parseWorktreeListPorcelain } from './worktree'

describe('parseWorktreeListPorcelain', () => {
  it('parses two active worktrees with branch + HEAD lines', () => {
    const stdout = [
      'worktree /Users/x/repo',
      'HEAD abcdef1',
      'branch refs/heads/master',
      '',
      'worktree /Users/x/repo-worktrees/feature',
      'HEAD 1234567',
      'branch refs/heads/feature/foo',
      ''
    ].join('\n')

    const trees = parseWorktreeListPorcelain(stdout, '/Users/x/repo')

    expect(trees).toHaveLength(2)
    expect(trees[0]).toMatchObject({
      path: '/Users/x/repo',
      branch: 'master',
      head: 'abcdef1',
      isMain: true,
      isBare: false,
      repoRoot: '/Users/x/repo'
    })
    expect(trees[0].prunable).toBeUndefined()
    expect(trees[1]).toMatchObject({
      path: '/Users/x/repo-worktrees/feature',
      branch: 'feature/foo',
      isMain: false
    })
  })

  it('tags an entry with prunable + reason when git reports one', () => {
    const stdout = [
      'worktree /Users/x/repo',
      'HEAD abcdef1',
      'branch refs/heads/master',
      '',
      'worktree /Users/x/repo/gh-pages',
      'HEAD 1234567',
      'branch refs/heads/gh-pages',
      'prunable gitdir file points to non-existent location',
      ''
    ].join('\n')

    const trees = parseWorktreeListPorcelain(stdout, '/Users/x/repo')

    expect(trees).toHaveLength(2)
    expect(trees[0].prunable).toBeUndefined()
    expect(trees[1].prunable).toBe(true)
    expect(trees[1].prunableReason).toBe(
      'gitdir file points to non-existent location'
    )
    // Path + branch survive so the sidebar can render + prune.
    expect(trees[1].path).toBe('/Users/x/repo/gh-pages')
    expect(trees[1].branch).toBe('gh-pages')
  })

  it('handles bare prunable lines with no reason', () => {
    const stdout = [
      'worktree /Users/x/repo/stale',
      'HEAD 1234567',
      'branch refs/heads/stale',
      'prunable',
      ''
    ].join('\n')

    const trees = parseWorktreeListPorcelain(stdout, '/Users/x/repo')

    expect(trees).toHaveLength(1)
    expect(trees[0].prunable).toBe(true)
    expect(trees[0].prunableReason).toBeUndefined()
  })

  it('marks the main worktree via matching repoRoot path', () => {
    const stdout = [
      'worktree /Users/x/repo',
      'HEAD abcdef1',
      'branch refs/heads/main',
      '',
      'worktree /Users/x/repo-worktrees/child',
      'HEAD 1234567',
      'branch refs/heads/child',
      ''
    ].join('\n')

    const trees = parseWorktreeListPorcelain(stdout, '/Users/x/repo')

    expect(trees[0].isMain).toBe(true)
    expect(trees[1].isMain).toBe(false)
  })

  it('flushes the trailing entry even when git omits the final blank', () => {
    const stdout = [
      'worktree /Users/x/repo',
      'HEAD abcdef1',
      'branch refs/heads/main'
    ].join('\n')

    const trees = parseWorktreeListPorcelain(stdout, '/Users/x/repo')

    expect(trees).toHaveLength(1)
    expect(trees[0].path).toBe('/Users/x/repo')
  })
})

describe('listBranchInventory', () => {
  let repo: string

  function git(...args: string[]): void {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'branch-inventory-'))
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' })
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    writeFileSync(join(repo, 'a.txt'), 'a')
    git('add', '.')
    git('commit', '-m', 'first')
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('does not report the base branch as merged into itself', async () => {
    // git branch --merged main lists main, since a branch is its own
    // ancestor. Taken at face value it makes `main` read as landed work and
    // the import picker's hide-merged default drops it.
    const entries = await listBranchInventory(repo)
    expect(entries.find((e) => e.name === 'main')?.merged).toBe(false)
  })

  it('still reports a branch that really did land', async () => {
    git('branch', 'landed')
    const entries = await listBranchInventory(repo)
    expect(entries.find((e) => e.name === 'landed')?.merged).toBe(true)
  })

  it('reports an unlanded branch as unmerged', async () => {
    git('checkout', '-b', 'ahead')
    writeFileSync(join(repo, 'b.txt'), 'b')
    git('add', '.')
    git('commit', '-m', 'second')
    git('checkout', 'main')
    const entries = await listBranchInventory(repo)
    expect(entries.find((e) => e.name === 'ahead')?.merged).toBe(false)
  })
})
