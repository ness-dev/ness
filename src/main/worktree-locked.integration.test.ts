import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { execFileSync } from 'child_process'
import { join } from 'path'

import { listWorktrees, pruneWorktrees, removeWorktree } from './worktree'

// REAL git, no mocks. Claude Code locks the worktrees it creates for its
// own isolation, then cleans up the scratchpad they live in, which leaves
// locked entries whose directory is gone.

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString()
}

let tmp: string
let repo: string

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'wt-locked-')))
  repo = join(tmp, 'repo')
  fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 't@t.t')
  git(repo, 'config', 'user.name', 'T')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function makeLockedWorktree(name: string, reason?: string): string {
  const path = join(tmp, name)
  git(repo, 'worktree', 'add', '-q', path, '-b', name)
  git(repo, 'worktree', 'lock', ...(reason ? ['--reason', reason] : []), path)
  return path
}

describe('locked worktrees', () => {
  it('lists a locked, missing worktree as prunable with its lock reason', async () => {
    const path = makeLockedWorktree('gone', 'claude agent')
    fs.rmSync(path, { recursive: true, force: true })

    const wt = (await listWorktrees(repo)).find((w) => w.path === path)

    expect(wt).toMatchObject({ locked: true, lockedReason: 'claude agent', prunable: true })
  })

  it('lists a locked, present worktree as locked but not prunable', async () => {
    const path = makeLockedWorktree('here')

    const wt = (await listWorktrees(repo)).find((w) => w.path === path)

    expect(wt?.locked).toBe(true)
    expect(wt?.prunable).toBeUndefined()
  })

  it('removeWorktree clears a locked entry whose directory is gone', async () => {
    const path = makeLockedWorktree('gone')
    fs.rmSync(path, { recursive: true, force: true })

    await removeWorktree(repo, path)

    expect((await listWorktrees(repo)).map((w) => w.path)).toEqual([repo])
  })

  it('removeWorktree still refuses a locked worktree whose directory exists', async () => {
    const path = makeLockedWorktree('here')

    await expect(removeWorktree(repo, path, true)).rejects.toThrow(/locked/)
    expect(fs.existsSync(path)).toBe(true)
  })

  it('pruneWorktrees unlocks and prunes missing locked entries but keeps present ones locked', async () => {
    const gone = makeLockedWorktree('gone')
    const here = makeLockedWorktree('here')
    fs.rmSync(gone, { recursive: true, force: true })

    await pruneWorktrees(repo)

    const trees = await listWorktrees(repo)
    expect(trees.map((w) => w.path)).toEqual([repo, here])
    expect(trees[1].locked).toBe(true)
  })
})
