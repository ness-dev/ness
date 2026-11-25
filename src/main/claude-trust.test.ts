import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, promises as fsPromises, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('./debug', () => ({ log: () => {} }))

import { trustClaudeProject } from './claude-trust'

let dir: string
let configPath: string
let project: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ness-trust-'))
  configPath = join(dir, '.claude.json')
  project = join(dir, 'repo-worktrees', 'feat')
  mkdirSync(project, { recursive: true })
  // Keys are realpaths: on macOS tmpdir() sits behind the /var → /private/var symlink.
  project = realpathSync(project)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeConfig(config: unknown, mode = 0o600): void {
  writeFileSync(configPath, JSON.stringify(config, null, 2))
  chmodSync(configPath, mode)
}

function readConfig(): { projects?: Record<string, Record<string, unknown>>; [k: string]: unknown } {
  return JSON.parse(readFileSync(configPath, 'utf-8'))
}

describe('trustClaudeProject', () => {
  it('adds the trust key and preserves everything else', async () => {
    writeConfig({
      numStartups: 7,
      oauthAccount: { emailAddress: 'x' },
      projects: {
        '/other': { hasTrustDialogAccepted: true, lastCost: 1 },
        [project]: { lastSessionId: 'abc' }
      }
    })
    expect(await trustClaudeProject(configPath, project)).toBe(true)
    const config = readConfig()
    expect(config.numStartups).toBe(7)
    expect(config.oauthAccount).toEqual({ emailAddress: 'x' })
    expect(config.projects?.['/other']).toEqual({ hasTrustDialogAccepted: true, lastCost: 1 })
    expect(config.projects?.[project]).toEqual({ lastSessionId: 'abc', hasTrustDialogAccepted: true })
    expect(existsSync(`${configPath}.lock`)).toBe(false)
  })

  it('creates the projects map when the config has none', async () => {
    writeConfig({ numStartups: 1 })
    expect(await trustClaudeProject(configPath, project)).toBe(true)
    expect(readConfig().projects?.[project]?.hasTrustDialogAccepted).toBe(true)
  })

  it('is a no-op when the project is already trusted', async () => {
    writeConfig({ projects: { [project]: { hasTrustDialogAccepted: true } } })
    const before = readFileSync(configPath, 'utf-8')
    const mtime = statSync(configPath).mtimeMs
    expect(await trustClaudeProject(configPath, project)).toBe(true)
    expect(readFileSync(configPath, 'utf-8')).toBe(before)
    expect(statSync(configPath).mtimeMs).toBe(mtime)
  })

  it('keys by realpath', async () => {
    writeConfig({})
    const viaDot = join(project, '..', 'feat')
    expect(await trustClaudeProject(configPath, viaDot)).toBe(true)
    expect(Object.keys(readConfig().projects ?? {})).toEqual([project])
  })

  it('leaves a missing config uncreated', async () => {
    expect(await trustClaudeProject(configPath, project)).toBe(false)
    expect(existsSync(configPath)).toBe(false)
    expect(existsSync(`${configPath}.lock`)).toBe(false)
  })

  it('leaves an unparseable config untouched', async () => {
    writeFileSync(configPath, '{ not json')
    expect(await trustClaudeProject(configPath, project)).toBe(false)
    expect(readFileSync(configPath, 'utf-8')).toBe('{ not json')
  })

  it('preserves the file mode', async () => {
    writeConfig({}, 0o640)
    expect(await trustClaudeProject(configPath, project)).toBe(true)
    expect(statSync(configPath).mode & 0o777).toBe(0o640)
  })

  it('breaks a stale lock', async () => {
    writeConfig({})
    mkdirSync(`${configPath}.lock`)
    const old = (Date.now() - 60_000) / 1000
    utimesSync(`${configPath}.lock`, old, old)
    expect(await trustClaudeProject(configPath, project)).toBe(true)
    expect(readConfig().projects?.[project]?.hasTrustDialogAccepted).toBe(true)
    expect(existsSync(`${configPath}.lock`)).toBe(false)
  })

  it('gives up on a held lock without writing or releasing it', async () => {
    writeConfig({})
    mkdirSync(`${configPath}.lock`)
    expect(await trustClaudeProject(configPath, project, { lockWaitMs: 150 })).toBe(false)
    expect(readConfig().projects).toBeUndefined()
    // The lock belongs to whoever holds it; we must not remove it.
    expect(existsSync(`${configPath}.lock`)).toBe(true)
  })

  it('waits for a lock that is released in time', async () => {
    writeConfig({})
    mkdirSync(`${configPath}.lock`)
    setTimeout(() => rmSync(`${configPath}.lock`, { recursive: true }), 100)
    expect(await trustClaudeProject(configPath, project, { lockWaitMs: 2_000 })).toBe(true)
    expect(readConfig().projects?.[project]?.hasTrustDialogAccepted).toBe(true)
  })

  it('writes through a symlinked config to its target, keeping the link', async () => {
    const realDir = join(dir, 'dotfiles')
    mkdirSync(realDir)
    const real = join(realDir, 'claude.json')
    writeFileSync(real, JSON.stringify({ numStartups: 3 }))
    symlinkSync(real, configPath)
    expect(await trustClaudeProject(configPath, project)).toBe(true)
    expect(lstatSync(configPath).isSymbolicLink()).toBe(true)
    const config = JSON.parse(readFileSync(real, 'utf-8'))
    expect(config.numStartups).toBe(3)
    expect(config.projects[project].hasTrustDialogAccepted).toBe(true)
    // No temp file left beside either the link or the target.
    expect(readdirSync(dir).filter((f) => f.includes('.ness-'))).toEqual([])
    expect(readdirSync(realDir)).toEqual(['claude.json'])
  })

  it('removes its temp file when the rename fails', async () => {
    writeConfig({ numStartups: 1 })
    const spy = vi.spyOn(fsPromises, 'rename').mockRejectedValueOnce(new Error('EXDEV'))
    try {
      expect(await trustClaudeProject(configPath, project)).toBe(false)
    } finally {
      spy.mockRestore()
    }
    expect(readdirSync(dir).filter((f) => f.startsWith('.claude.json.'))).toEqual([])
    expect(readConfig().projects).toBeUndefined()
    expect(existsSync(`${configPath}.lock`)).toBe(false)
  })

  it('returns false for a path that does not exist', async () => {
    writeConfig({})
    expect(await trustClaudeProject(configPath, join(dir, 'nope'))).toBe(false)
    expect(readConfig().projects).toBeUndefined()
  })
})
