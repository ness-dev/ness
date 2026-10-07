import { describe, it, expect } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseWorktreeListPorcelain,
  readClaudeAllowEntries,
  unsymlinkClaudeSettings
} from './worktree'

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

describe('unsymlinkClaudeSettings', () => {
  function scratch(): { main: string; wt: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), 'ness-unsymlink-'))
    const main = join(root, 'main')
    const wt = join(root, 'wt')
    mkdirSync(join(main, '.claude'), { recursive: true })
    mkdirSync(join(wt, '.claude'), { recursive: true })
    writeFileSync(
      join(main, '.claude', 'settings.local.json'),
      JSON.stringify({
        permissions: { allow: ['Bash(git status:*)', 'mcp__x__y'] }
      })
    )
    return { main, wt, cleanup: () => rmSync(root, { recursive: true, force: true }) }
  }

  it('replaces a symlink with a real file holding the target contents', () => {
    const { main, wt, cleanup } = scratch()
    try {
      const link = join(wt, '.claude', 'settings.local.json')
      symlinkSync(join(main, '.claude', 'settings.local.json'), link)

      const recovered = unsymlinkClaudeSettings(wt)

      expect(lstatSync(link).isSymbolicLink()).toBe(false)
      expect(JSON.parse(readFileSync(link, 'utf-8'))).toEqual({
        permissions: { allow: ['Bash(git status:*)', 'mcp__x__y'] }
      })
      expect(recovered).toEqual(['Bash(git status:*)', 'mcp__x__y'])
    } finally {
      cleanup()
    }
  })

  it('writing to the converted file no longer touches main', () => {
    // The point of the conversion: Claude refuses to write through a
    // symlink, so until it's a real file every grant is silently dropped.
    const { main, wt, cleanup } = scratch()
    try {
      const link = join(wt, '.claude', 'settings.local.json')
      const mainFile = join(main, '.claude', 'settings.local.json')
      symlinkSync(mainFile, link)
      unsymlinkClaudeSettings(wt)

      writeFileSync(link, JSON.stringify({ permissions: { allow: ['Read'] } }))

      expect(JSON.parse(readFileSync(mainFile, 'utf-8')).permissions.allow).toEqual([
        'Bash(git status:*)',
        'mcp__x__y'
      ])
    } finally {
      cleanup()
    }
  })

  it('returns null and leaves a real file alone', () => {
    const { main, cleanup } = scratch()
    try {
      expect(unsymlinkClaudeSettings(main)).toBeNull()
      expect(readClaudeAllowEntries(main)).toEqual([
        'Bash(git status:*)',
        'mcp__x__y'
      ])
    } finally {
      cleanup()
    }
  })

  it('is idempotent — a second call is a no-op', () => {
    const { main, wt, cleanup } = scratch()
    try {
      const link = join(wt, '.claude', 'settings.local.json')
      symlinkSync(join(main, '.claude', 'settings.local.json'), link)
      unsymlinkClaudeSettings(wt)
      expect(unsymlinkClaudeSettings(wt)).toBeNull()
      expect(existsSync(link)).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('drops a broken symlink so Claude can create a real file', () => {
    const { wt, cleanup } = scratch()
    try {
      const link = join(wt, '.claude', 'settings.local.json')
      symlinkSync(join(wt, 'nonexistent.json'), link)

      expect(unsymlinkClaudeSettings(wt)).toBeNull()
      expect(existsSync(link)).toBe(false)
      expect(lstatSync(join(wt, '.claude')).isDirectory()).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('returns an empty list when the target has no permissions.allow', () => {
    const { main, wt, cleanup } = scratch()
    try {
      writeFileSync(join(main, '.claude', 'settings.local.json'), '{"hooks":{}}')
      symlinkSync(
        join(main, '.claude', 'settings.local.json'),
        join(wt, '.claude', 'settings.local.json')
      )
      expect(unsymlinkClaudeSettings(wt)).toEqual([])
    } finally {
      cleanup()
    }
  })

  it('survives corrupt JSON in the target', () => {
    const { main, wt, cleanup } = scratch()
    try {
      const mainFile = join(main, '.claude', 'settings.local.json')
      writeFileSync(mainFile, '{not json')
      const link = join(wt, '.claude', 'settings.local.json')
      symlinkSync(mainFile, link)

      expect(unsymlinkClaudeSettings(wt)).toEqual([])
      // Still converted — a corrupt file is better than a doomed symlink.
      expect(lstatSync(link).isSymbolicLink()).toBe(false)
      expect(readFileSync(link, 'utf-8')).toBe('{not json')
    } finally {
      cleanup()
    }
  })

  it('returns null when there is no settings file at all', () => {
    const { wt, cleanup } = scratch()
    try {
      expect(unsymlinkClaudeSettings(wt)).toBeNull()
      expect(readClaudeAllowEntries(wt)).toEqual([])
    } finally {
      cleanup()
    }
  })
})
