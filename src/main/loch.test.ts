import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isLochForkPath, projectHasLochHooks, removeLochHooks, worktreeRelativePath } from './loch'

const hook = (bin: string, name: string): { type: string; command: string } => ({
  type: 'command',
  command: `${bin} hook ${name} 2>/dev/null || true`
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ness-loch-test-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('worktreeRelativePath', () => {
  it('accepts paths inside the worktree, relative or absolute', () => {
    expect(worktreeRelativePath('/repo', 'src/a.ts')).toBe('src/a.ts')
    expect(worktreeRelativePath('/repo', '/repo/src/a.ts')).toBe('src/a.ts')
    expect(worktreeRelativePath('/repo/', './src/../src/a.ts')).toBe('src/a.ts')
  })

  it('refuses anything that escapes the worktree, or the worktree itself', () => {
    expect(worktreeRelativePath('/repo', '../etc/passwd')).toBe(null)
    expect(worktreeRelativePath('/repo', 'src/../../etc/passwd')).toBe(null)
    expect(worktreeRelativePath('/repo', '/etc/passwd')).toBe(null)
    expect(worktreeRelativePath('/repo', '/repo-sibling/a.ts')).toBe(null)
    expect(worktreeRelativePath('/repo', '/repo')).toBe(null)
    expect(worktreeRelativePath('/repo', '')).toBe(null)
  })
})

describe('removeLochHooks', () => {
  const settingsPath = (): string => join(dir, '.claude', 'settings.local.json')
  const write = (obj: unknown): void => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(settingsPath(), JSON.stringify(obj))
  }

  it('strips loch lines and keeps everything else in the file', () => {
    write({
      permissions: { allow: ['Bash(ls)'] },
      hooks: { Stop: [{ hooks: [hook('/a/loch', 'stop'), { type: 'command', command: 'mine' }] }] }
    })
    expect(removeLochHooks(dir)).toBe(true)
    expect(JSON.parse(readFileSync(settingsPath(), 'utf8'))).toEqual({
      permissions: { allow: ['Bash(ls)'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] }
    })
  })

  it('leaves the file untouched when there is nothing to remove or it won’t parse', () => {
    expect(removeLochHooks(dir)).toBe(false) // no file
    write({ permissions: {} })
    const before = readFileSync(settingsPath(), 'utf8')
    expect(removeLochHooks(dir)).toBe(false)
    expect(readFileSync(settingsPath(), 'utf8')).toBe(before)
    writeFileSync(settingsPath(), '{ not json')
    expect(removeLochHooks(dir)).toBe(false)
    expect(readFileSync(settingsPath(), 'utf8')).toBe('{ not json')
  })
})

describe('projectHasLochHooks', () => {
  it('detects loch hooks committed in .claude/settings.json only', () => {
    expect(projectHasLochHooks(dir)).toBe(false)
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(
      join(dir, '.claude', 'settings.local.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [hook('loch', 'stop')] }] } })
    )
    expect(projectHasLochHooks(dir)).toBe(false)
    writeFileSync(
      join(dir, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [hook('loch', 'prompt')] }] } })
    )
    expect(projectHasLochHooks(dir)).toBe(true)
  })
})

describe('isLochForkPath', () => {
  const home = '/Users/x/.claude'
  const fork = 'f0f0f0f0-0000-0000-0000-000000000000'
  const source = '085777e0-ad5c-4f16-8e0d-a267b9191c72'

  it('accepts <home>/projects/<encoded-cwd>/<forkId>.jsonl', () => {
    expect(isLochForkPath(`${home}/projects/-Users-x-repo/${fork}.jsonl`, fork, source, [home])).toBe(true)
  })

  it('refuses anything else', () => {
    // the forked (source) transcript
    expect(isLochForkPath(`${home}/projects/-r/${source}.jsonl`, source, source, [home])).toBe(false)
    // a different file name
    expect(isLochForkPath(`${home}/projects/-r/${source}.jsonl`, fork, source, [home])).toBe(false)
    // outside any known home, or not directly under projects/<dir>/
    expect(isLochForkPath(`/tmp/projects/-r/${fork}.jsonl`, fork, source, [home])).toBe(false)
    expect(isLochForkPath(`${home}/projects/${fork}.jsonl`, fork, source, [home])).toBe(false)
    expect(isLochForkPath(`${home}/projects/-r/sub/${fork}.jsonl`, fork, source, [home])).toBe(false)
    expect(isLochForkPath(`${home}/projects/-r/../../${fork}.jsonl`, fork, source, [home])).toBe(false)
    expect(isLochForkPath(`${home}/projects/-r/${fork}.jsonl`, '', source, [home])).toBe(false)
  })
})
