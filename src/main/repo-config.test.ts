import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  loadRepoConfig,
  saveRepoConfig,
  repoConfigFilename,
  migrateRepoConfigFilename,
  invalidateRepoConfigCache
} from './repo-config'

const NEW = '.ness.json'
const LEGACY = '.harness.json'

let repo: string

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'repo-config-'))
  invalidateRepoConfigCache()
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
  invalidateRepoConfigCache()
})

function write(name: string, body: unknown): void {
  writeFileSync(join(repo, name), JSON.stringify(body))
}

describe('repoConfigFilename', () => {
  it('uses the new name when the repo has no config yet', () => {
    expect(repoConfigFilename(repo)).toBe(NEW)
  })

  it('keeps the legacy name when only that exists', () => {
    write(LEGACY, { version: 1 })
    expect(repoConfigFilename(repo)).toBe(LEGACY)
  })

  it('prefers the new name when both exist', () => {
    write(LEGACY, { version: 1 })
    write(NEW, { version: 1 })
    expect(repoConfigFilename(repo)).toBe(NEW)
  })
})

describe('loadRepoConfig', () => {
  it('reads a legacy .harness.json', () => {
    write(LEGACY, { version: 1, setupCommand: 'legacy-setup' })
    expect(loadRepoConfig(repo).setupCommand).toBe('legacy-setup')
  })

  it('reads a new .ness.json', () => {
    write(NEW, { version: 1, setupCommand: 'new-setup' })
    expect(loadRepoConfig(repo).setupCommand).toBe('new-setup')
  })

  it('prefers .ness.json over .harness.json when both exist', () => {
    write(LEGACY, { version: 1, setupCommand: 'legacy-setup' })
    write(NEW, { version: 1, setupCommand: 'new-setup' })
    expect(loadRepoConfig(repo).setupCommand).toBe('new-setup')
  })
})

describe('saveRepoConfig', () => {
  it('creates .ness.json for a repo with no existing config', () => {
    saveRepoConfig(repo, { setupCommand: 'x' })
    expect(existsSync(join(repo, NEW))).toBe(true)
    expect(existsSync(join(repo, LEGACY))).toBe(false)
  })

  it('keeps writing .harness.json for a repo that already has one', () => {
    write(LEGACY, { version: 1, setupCommand: 'old' })
    invalidateRepoConfigCache()
    saveRepoConfig(repo, { setupCommand: 'updated' })

    // The committed, git-tracked file is updated in place — not renamed.
    expect(existsSync(join(repo, NEW))).toBe(false)
    expect(JSON.parse(readFileSync(join(repo, LEGACY), 'utf-8')).setupCommand).toBe('updated')
  })

  it('writes to .ness.json again once the repo has been converted', () => {
    write(LEGACY, { version: 1, setupCommand: 'old' })
    invalidateRepoConfigCache()
    migrateRepoConfigFilename(repo)
    saveRepoConfig(repo, { setupCommand: 'after-convert' })

    expect(existsSync(join(repo, LEGACY))).toBe(false)
    expect(JSON.parse(readFileSync(join(repo, NEW), 'utf-8')).setupCommand).toBe('after-convert')
  })

  it('clears both filenames so a stale legacy file cannot resurrect settings', () => {
    write(LEGACY, { version: 1, setupCommand: 'old' })
    write(NEW, { version: 1, setupCommand: 'new' })
    invalidateRepoConfigCache()

    saveRepoConfig(repo, {})

    expect(existsSync(join(repo, NEW))).toBe(false)
    expect(existsSync(join(repo, LEGACY))).toBe(false)
    invalidateRepoConfigCache()
    expect(loadRepoConfig(repo)).toEqual({})
  })
})

describe('migrateRepoConfigFilename', () => {
  it('renames a legacy file and preserves its contents', () => {
    write(LEGACY, { version: 1, setupCommand: 'keep-me' })
    invalidateRepoConfigCache()

    expect(migrateRepoConfigFilename(repo)).toBe(true)
    expect(existsSync(join(repo, LEGACY))).toBe(false)
    expect(repoConfigFilename(repo)).toBe(NEW)
    expect(loadRepoConfig(repo).setupCommand).toBe('keep-me')
  })

  it('is a no-op when there is nothing to convert', () => {
    expect(migrateRepoConfigFilename(repo)).toBe(false)
    write(NEW, { version: 1 })
    expect(migrateRepoConfigFilename(repo)).toBe(false)
  })

  it('drops the legacy file without clobbering an existing .ness.json', () => {
    write(LEGACY, { version: 1, setupCommand: 'stale' })
    write(NEW, { version: 1, setupCommand: 'current' })
    invalidateRepoConfigCache()

    expect(migrateRepoConfigFilename(repo)).toBe(true)
    expect(existsSync(join(repo, LEGACY))).toBe(false)
    expect(loadRepoConfig(repo).setupCommand).toBe('current')
  })
})

// The Merge Locally panel was removed. Repo config files are usually
// committed, so ones written before then must keep loading, and we never
// rewrite them just because they carry its keys.
describe('repo configs from before Merge Locally was removed', () => {
  const OLD = {
    version: 1,
    setupCommand: 'npm ci',
    mergeStrategy: 'merge-commit',
    hideMergePanel: true,
    hiddenRightPanels: { merge: true, commits: true },
    rightPanelOrder: ['merge', 'pr', 'commits'],
    someFutureKey: { nested: 1 }
  }

  it('loads without throwing and keeps the fields still in use', () => {
    write(NEW, OLD)
    const cfg = loadRepoConfig(repo)
    expect(cfg.setupCommand).toBe('npm ci')
    expect(cfg.mergeStrategy).toBe('merge-commit')
  })

  it('loading does not touch the file on disk', () => {
    write(LEGACY, OLD)
    const before = readFileSync(join(repo, LEGACY), 'utf-8')
    loadRepoConfig(repo)
    expect(readFileSync(join(repo, LEGACY), 'utf-8')).toBe(before)
    expect(existsSync(join(repo, NEW))).toBe(false)
  })

  it('drops the merge panel keys on the next write', () => {
    write(NEW, OLD)
    const saved = saveRepoConfig(repo, loadRepoConfig(repo))
    expect(saved.hiddenRightPanels).toEqual({ commits: true })
    expect(saved.rightPanelOrder).toEqual(['pr', 'commits'])
    const onDisk = JSON.parse(readFileSync(join(repo, NEW), 'utf-8'))
    expect(onDisk).not.toHaveProperty('hideMergePanel')
    expect(onDisk.mergeStrategy).toBe('merge-commit')
  })

  it('an order of only the removed panel is dropped entirely', () => {
    const saved = saveRepoConfig(repo, {
      setupCommand: 'x',
      rightPanelOrder: ['merge'] as unknown as never
    })
    expect(saved).not.toHaveProperty('rightPanelOrder')
  })
})
