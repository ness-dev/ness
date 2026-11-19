// Installs loch for users who don't have it: downloads a pinned release for
// this platform from GitHub, checks it against a SHA-256 committed here (not
// one fetched alongside the download, so a swapped release asset is caught),
// and puts the binary at ~/.loch/bin/loch. That path is loch's own home and
// outlives Ness updates, which matters because the hook lines name it.
//
// Only ever run from an explicit user action (opting a repo in to history
// tracking). Bump LOCH_VERSION and the sums together, from the release's
// SHA256SUMS.

import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync, copyFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { log } from './debug'
import { LOCH_VERSION, compareVersions } from '../shared/loch'

const execFileAsync = promisify(execFile)

const ASSETS: Record<string, { triple: string; sha256: string }> = {
  'darwin-arm64': {
    triple: 'aarch64-apple-darwin',
    sha256: 'a065223055dd5ce3423032e3273edb7f10954e618b9f1111a685eed3cf79e414'
  },
  'darwin-x64': {
    triple: 'x86_64-apple-darwin',
    sha256: '11b347f4cf91608b7379988daa0817f0ae0f2d1adf6fe89441165aabc45f2bda'
  },
  'linux-arm64': {
    triple: 'aarch64-unknown-linux-musl',
    sha256: '7a384f5dc1fdea050d3425266f7e4167c6a92ba616e729c2a95e06dbcd4b1baa'
  },
  'linux-x64': {
    triple: 'x86_64-unknown-linux-musl',
    sha256: 'c2a2e77d51486136c5ffeab0b7ceaf45a0a3da64db7ea353ac592f84d89c2233'
  },
  'win32-arm64': {
    triple: 'aarch64-pc-windows-msvc',
    sha256: 'bcd673f7d666d499de37f794c44d4e147e5fb52bdacdd994967fa07ac9851d55'
  },
  'win32-x64': {
    triple: 'x86_64-pc-windows-msvc',
    sha256: '87ab4784a7107f72ee85df6a9642814df7d35d97206e58f6396725e7c09a32f9'
  }
}

const DOWNLOAD_TIMEOUT_MS = 120_000

function exeName(): string {
  return process.platform === 'win32' ? 'loch.exe' : 'loch'
}

/** Where Ness installs loch. Checked after PATH by `lochBinary()`. */
export function managedLochPath(): string {
  return join(homedir(), '.loch', 'bin', exeName())
}

/** Whether there's a release Ness can install on this machine. */
export function canInstallLoch(): boolean {
  return `${process.platform}-${process.arch}` in ASSETS
}

/** `loch --version --json` of a binary, or null if it won't say. */
export async function binaryVersion(path: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(path, ['--version', '--json'], { timeout: 10_000 })
    const doc = JSON.parse(stdout) as { ok?: unknown; version?: unknown }
    return doc.ok === true && typeof doc.version === 'string' ? doc.version : null
  } catch {
    return null
  }
}

/** At boot: bring Ness's own copy up to LOCH_VERSION, but only for users who
 *  already have that copy and are recording somewhere — nobody else gets a
 *  download they didn't ask for. A loch on PATH is the user's to manage. */
export async function upgradeManagedLochIfStale(recordingAnywhere: boolean): Promise<void> {
  if (!recordingAnywhere || !existsSync(managedLochPath())) return
  const r = await installLoch()
  if (!r.ok) log('loch', `managed loch upgrade failed code=${r.code}`, r.error ?? '')
}

let inflight: Promise<InstallOutcome> | null = null

export type InstallOutcome = { ok: true; path: string } | { ok: false; code: string; error?: string }

export function installLoch(): Promise<InstallOutcome> {
  inflight ??= doInstall().finally(() => {
    inflight = null
  })
  return inflight
}

async function doInstall(): Promise<InstallOutcome> {
  const asset = ASSETS[`${process.platform}-${process.arch}`]
  if (!asset) return { ok: false, code: 'unsupported-platform' }
  const dest = managedLochPath()
  // An existing copy at least as new as the pinned release is kept. An older
  // one — or one whose version can't be read — is replaced, so bumping
  // LOCH_VERSION reaches users who already have ~/.loch/bin/loch.
  if (existsSync(dest)) {
    const have = await binaryVersion(dest)
    if (have && compareVersions(have, LOCH_VERSION) >= 0) return { ok: true, path: dest }
    log('loch', `replacing ${dest} (version ${have ?? 'unreadable'}) with ${LOCH_VERSION}`)
  }

  const name = `loch-${LOCH_VERSION}-${asset.triple}`
  const url = `https://github.com/ness-dev/loch/releases/download/v${LOCH_VERSION}/${name}.tar.gz`
  const started = Date.now()
  let body: Buffer
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
    if (!res.ok) return { ok: false, code: 'download-failed', error: `HTTP ${res.status}` }
    body = Buffer.from(await res.arrayBuffer())
  } catch (err) {
    return { ok: false, code: 'download-failed', error: err instanceof Error ? err.message : String(err) }
  }
  const digest = createHash('sha256').update(body).digest('hex')
  if (digest !== asset.sha256) {
    log('loch', `install checksum mismatch for ${name}: got ${digest}`)
    return { ok: false, code: 'checksum-mismatch' }
  }

  const work = mkdtempSync(join(tmpdir(), 'ness-loch-'))
  try {
    const tarball = join(work, `${name}.tar.gz`)
    writeFileSync(tarball, body)
    await execFileAsync('tar', ['-xzf', tarball, '-C', work])
    const extracted = join(work, name, exeName())
    if (!existsSync(extracted)) return { ok: false, code: 'bad-archive' }
    mkdirSync(join(homedir(), '.loch', 'bin'), { recursive: true })
    // Copy then rename so a half-written binary is never at `dest`.
    const staged = `${dest}.ness-${Date.now()}.tmp`
    copyFileSync(extracted, staged)
    chmodSync(staged, 0o755)
    renameSync(staged, dest)
  } catch (err) {
    return { ok: false, code: 'install-failed', error: err instanceof Error ? err.message : String(err) }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  log('loch', `installed loch ${LOCH_VERSION} to ${dest} ms=${Date.now() - started}`)
  return { ok: true, path: dest }
}
