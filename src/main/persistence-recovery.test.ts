import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Point persistence at a throwaway userData dir per test.
let DIR = ''
vi.mock('./paths', () => ({
  userDataDir: () => DIR
}))

import {
  loadConfig,
  saveConfigSync,
  getConfigLoadError,
  validateConfigFile,
  discardCorruptConfigAndReset
} from './persistence'

const configPath = (): string => join(DIR, 'config.json')

beforeEach(() => {
  DIR = mkdtempSync(join(tmpdir(), 'harness-cfg-'))
})
afterEach(() => {
  rmSync(DIR, { recursive: true, force: true })
})

describe('loadConfig corrupt-file handling', () => {
  it('a missing file is a clean default load (no error, writes enabled)', () => {
    const cfg = loadConfig()
    expect(getConfigLoadError()).toBeNull()
    expect(cfg.repoRoots).toEqual([])
    // First run stamps firstLaunchAt and persists it immediately.
    expect(cfg.firstLaunchAt).toBeGreaterThan(0)
    expect(JSON.parse(readFileSync(configPath(), 'utf-8')).firstLaunchAt).toBe(cfg.firstLaunchAt)
    // Writes work after a clean load.
    saveConfigSync({ ...cfg, repoRoots: ['/x'] })
    expect(JSON.parse(readFileSync(configPath(), 'utf-8')).repoRoots).toEqual(['/x'])
  })

  it('malformed JSON: returns defaults, records error, quarantines, suspends writes', () => {
    writeFileSync(configPath(), '{ this is not json')
    const cfg = loadConfig()

    // Falls back to defaults rather than throwing.
    expect(cfg.repoRoots).toEqual([])

    // Error captured.
    const err = getConfigLoadError()
    expect(err).not.toBeNull()
    expect(err?.configPath).toBe(configPath())
    expect(err?.backupPath).toBeTruthy()

    // Quarantine copy holds the original bad content.
    expect(readFileSync(err!.backupPath!, 'utf-8')).toBe('{ this is not json')

    // Writes are suspended — the bad original survives for hand-editing.
    saveConfigSync({ ...cfg, repoRoots: ['/should-not-persist'] })
    expect(readFileSync(configPath(), 'utf-8')).toBe('{ this is not json')
  })

  it('validateConfigFile reflects the on-disk state without applying it', () => {
    writeFileSync(configPath(), 'garbage')
    loadConfig()
    expect(validateConfigFile().ok).toBe(false)

    // Simulate the user fixing the file by hand.
    writeFileSync(configPath(), JSON.stringify({ repoRoots: ['/fixed'] }))
    expect(validateConfigFile()).toEqual({ ok: true })
  })

  it('discardCorruptConfigAndReset re-enables writes and persists defaults', () => {
    writeFileSync(configPath(), 'nope')
    loadConfig()
    expect(getConfigLoadError()).not.toBeNull()

    const fresh = discardCorruptConfigAndReset()
    expect(getConfigLoadError()).toBeNull()

    // Default config written over the bad file, and it parses.
    const onDisk = JSON.parse(readFileSync(configPath(), 'utf-8'))
    expect(onDisk.repoRoots).toEqual([])
    expect(fresh.connections?.[0].kind).toBe('local')

    // Writes resumed.
    saveConfigSync({ ...fresh, repoRoots: ['/y'] })
    expect(JSON.parse(readFileSync(configPath(), 'utf-8')).repoRoots).toEqual(['/y'])
  })

  it('an existing config without firstLaunchAt is stamped 0; an existing stamp is kept', () => {
    writeFileSync(configPath(), JSON.stringify({ repoRoots: [] }))
    expect(loadConfig().firstLaunchAt).toBe(0)
    writeFileSync(configPath(), JSON.stringify({ repoRoots: [], firstLaunchAt: 123 }))
    expect(loadConfig().firstLaunchAt).toBe(123)
  })

  it('first run creates a missing userData dir and persists the stamp', () => {
    const parent = DIR
    DIR = join(parent, 'not-yet-created')
    try {
      const cfg = loadConfig()
      expect(JSON.parse(readFileSync(configPath(), 'utf-8')).firstLaunchAt).toBe(cfg.firstLaunchAt)
    } finally {
      DIR = parent
    }
  })

  it('atomic write leaves no stray .tmp file behind', () => {
    const cfg = loadConfig()
    saveConfigSync({ ...cfg, repoRoots: ['/z'] })
    const leftovers = readdirSync(DIR).filter((f) => f.endsWith('.tmp'))
    expect(leftovers).toEqual([])
    expect(existsSync(configPath())).toBe(true)
  })
})
