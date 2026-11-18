import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { join } from 'path'
import { bundledCodexBinPath, codexPlatformInfo, toUnpackedAsarPath } from './codex-binary'

describe('codexPlatformInfo', () => {
  it('maps linux to the musl builds', () => {
    expect(codexPlatformInfo('linux', 'x64')?.triple).toBe('x86_64-unknown-linux-musl')
    expect(codexPlatformInfo('linux', 'arm64')?.triple).toBe('aarch64-unknown-linux-musl')
  })

  it('returns null for an unsupported platform', () => {
    expect(codexPlatformInfo('freebsd', 'x64')).toBeNull()
  })
})

describe('toUnpackedAsarPath', () => {
  it('rewrites a path inside app.asar', () => {
    const p = join('/App', 'Resources', 'app.asar', 'node_modules', 'x')
    expect(toUnpackedAsarPath(p)).toBe(join('/App', 'Resources', 'app.asar.unpacked', 'node_modules', 'x'))
  })

  it('leaves dev paths alone', () => {
    const p = join('/repo', 'node_modules', 'x')
    expect(toUnpackedAsarPath(p)).toBe(p)
  })
})

describe('bundledCodexBinPath', () => {
  it.runIf(codexPlatformInfo() !== null)('resolves to an installed binary on this host', () => {
    expect(existsSync(bundledCodexBinPath())).toBe(true)
  })
})
