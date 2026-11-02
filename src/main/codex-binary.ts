// Resolves the bundled @openai/codex native binary that Codex Chat tabs
// spawn as `codex app-server`. Pinned per Ness release for the same reason
// the Claude binary is: the app-server protocol is versioned with the CLI,
// and a user's PATH install drifting (or breaking) shouldn't take Chat down.
//
// The wrapper package's bin/codex.js only picks a platform subpackage and
// execs vendor/<target-triple>/bin/codex, so we do the same directly. The
// subpackages are npm aliases (`@openai/codex-darwin-arm64` →
// `@openai/codex@<ver>-darwin-arm64`), installed hoisted next to the
// wrapper. Linux builds are musl-static, so one package covers glibc too.

import { createRequire } from 'module'
import { dirname, join, sep } from 'path'

const CODEX_PLATFORMS: Record<string, { pkg: string; triple: string; bin: string }> = {
  'darwin-arm64': { pkg: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin', bin: 'codex' },
  'darwin-x64': { pkg: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin', bin: 'codex' },
  'linux-x64': { pkg: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl', bin: 'codex' },
  'linux-arm64': { pkg: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl', bin: 'codex' },
  'win32-x64': { pkg: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc', bin: 'codex.exe' },
  'win32-arm64': { pkg: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc', bin: 'codex.exe' }
}

export function codexPlatformInfo(
  platform: string = process.platform,
  arch: string = process.arch
): { pkg: string; triple: string; bin: string } | null {
  return CODEX_PLATFORMS[`${platform}-${arch}`] ?? null
}

/** Rewrites a path inside app.asar to its app.asar.unpacked twin. spawn()
 *  goes through the OS, which can't see into the asar archive; the binary
 *  is extracted there via the asarUnpack config. No-op in dev. */
export function toUnpackedAsarPath(p: string): string {
  return p.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`)
}

let cached: string | null = null
export function bundledCodexBinPath(): string {
  if (cached) return cached
  const info = codexPlatformInfo()
  if (!info) {
    throw new Error(
      `bundled codex: unsupported platform ${process.platform}-${process.arch}; supported: ${Object.keys(CODEX_PLATFORMS).join(', ')}`
    )
  }
  const dynamicRequire = createRequire(__filename)
  const pkgJson = dynamicRequire.resolve(`${info.pkg}/package.json`)
  cached = toUnpackedAsarPath(join(dirname(pkgJson), 'vendor', info.triple, 'bin', info.bin))
  return cached
}
