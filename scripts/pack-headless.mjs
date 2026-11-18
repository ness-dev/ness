#!/usr/bin/env node
// Assembles the headless-server tarball for the current host platform.
// One tarball per platform, built natively on a matching CI runner — we
// don't cross-compile (node-pty needs the target ABI's headers anyway).
// We use a shell shim + embedded Node binary instead of bun-compile or
// nexe so the user can debug the layout with `ls`, override the Node
// binary by editing one file, and we don't depend on a single-binary
// packer that sometimes lags Node releases.
//
// Layout of the staged tarball (extracted under ~/.harness-server/):
//   harness-server-<version>-<platform>/
//     bin/harness-server                            shell shim
//     VERSION
//     lib/
//       node                                        pinned Node binary
//       main/index.js                               vite-bundled main process
//       web-client/                                 vite-bundled renderer
//       mcp/{permission-prompt-mcp.js, mcp-bridge.js}
//       node_modules/
//         node-pty/, ws/                            runtime deps externalized by vite
//         @anthropic-ai/claude-code-<platform>/    json-mode subprocess (npm layout
//           package.json                            so require.resolve from main/index.js
//           claude                                  matches the Electron resolution path)
//         @openai/codex-<platform>/                Codex Chat subprocess, same layout
//           package.json, vendor/<triple>/bin/codex

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createWriteStream, createReadStream, existsSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile, cp, rm, chmod } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import * as tar from 'tar'

// Vite 8 / rolldown require Node ≥ 22.12 (or 20.19+, but 22.x is the
// active LTS line). Bumping this means the .github workflow's
// setup-node version + node-pty's rebuilt ABI both move with it.
const NODE_VERSION = '22.12.0'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const repoRoot = resolve(__dirname, '..')

function detectPlatform() {
  const p = process.platform
  const a = process.arch
  if (p === 'darwin' && a === 'arm64') return { platform: 'darwin-arm64', nodeDist: 'darwin-arm64' }
  if (p === 'linux' && a === 'x64') return { platform: 'linux-x64', nodeDist: 'linux-x64' }
  if (p === 'linux' && a === 'arm64') return { platform: 'linux-arm64', nodeDist: 'linux-arm64' }
  // darwin-x64 is intentionally not packed — see the matrix comment in
  // .github/workflows/headless-release.yml.
  throw new Error(`Unsupported host platform: ${p}-${a}. Run on darwin-arm64, linux-x64, or linux-arm64.`)
}

const CLAUDE_PLATFORM_PKG = {
  'darwin-arm64': '@anthropic-ai/claude-code-darwin-arm64',
  'linux-x64': '@anthropic-ai/claude-code-linux-x64',
  'linux-arm64': '@anthropic-ai/claude-code-linux-arm64'
}

const CODEX_PLATFORM_PKG = {
  'darwin-arm64': { pkg: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin' },
  'linux-x64': { pkg: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl' },
  'linux-arm64': { pkg: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl' }
}

async function downloadNodeBinary(platform, nodeDist) {
  const cacheDir = join(repoRoot, '.cache', 'node-binaries')
  await mkdir(cacheDir, { recursive: true })
  const tarballName = `node-v${NODE_VERSION}-${nodeDist}.tar.gz`
  const cachedTarball = join(cacheDir, tarballName)
  const extractedNodePath = join(cacheDir, `node-v${NODE_VERSION}-${nodeDist}`, 'bin', 'node')

  if (existsSync(extractedNodePath)) {
    return extractedNodePath
  }

  if (!existsSync(cachedTarball)) {
    const url = `https://nodejs.org/dist/v${NODE_VERSION}/${tarballName}`
    console.log(`[pack-headless] downloading ${url}`)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Node download failed: ${res.status} ${res.statusText}`)
    const out = createWriteStream(cachedTarball)
    await pipeline(Readable.fromWeb(res.body), out)
  }

  console.log(`[pack-headless] extracting ${tarballName}`)
  await tar.x({ file: cachedTarball, cwd: cacheDir })

  if (!existsSync(extractedNodePath)) {
    throw new Error(`Node binary not at expected path after extract: ${extractedNodePath}`)
  }
  return extractedNodePath
}

function rebuildNodePtyForTargetNode() {
  // electron-builder's postinstall rebuilt node-pty against Electron's
  // ABI; we need plain-Node ABI for the headless tarball. Pointing
  // node-gyp at NODE_VERSION's headers gets us the right pty.node.
  // CXXFLAGS forces C++17 because node-pty 1.1.0's binding.gyp doesn't
  // set a standard, and macOS clang defaults to C++03 — too old for
  // node-addon-api 7's `std::initializer_list` and other C++11+ uses.
  const env = {
    ...process.env,
    npm_config_target: NODE_VERSION,
    npm_config_runtime: 'node',
    npm_config_disturl: 'https://nodejs.org/dist',
    npm_config_arch: process.arch,
    npm_config_target_arch: process.arch,
    npm_config_build_from_source: 'true',
    CXXFLAGS: `${process.env.CXXFLAGS ?? ''} -std=gnu++17`.trim(),
    CFLAGS: `${process.env.CFLAGS ?? ''} -std=gnu99`.trim()
  }
  console.log(`[pack-headless] rebuilding node-pty against Node ${NODE_VERSION}`)
  const result = spawnSync('npm', ['rebuild', 'node-pty', '--build-from-source'], {
    cwd: repoRoot,
    env,
    stdio: 'inherit'
  })
  if (result.status !== 0) {
    throw new Error(`npm rebuild node-pty failed with status ${result.status}`)
  }
}

async function copyClaudeBinary(platform, libDir) {
  const pkgName = CLAUDE_PLATFORM_PKG[platform]
  if (!pkgName) throw new Error(`No claude-code package mapping for ${platform}`)
  const r = createRequire(join(repoRoot, 'package.json'))
  const pkgJsonPath = r.resolve(`${pkgName}/package.json`)
  const srcPkgDir = dirname(pkgJsonPath)
  if (!existsSync(join(srcPkgDir, 'claude'))) {
    throw new Error(`claude binary not found at ${join(srcPkgDir, 'claude')}. Run npm install first.`)
  }
  const destPkgDir = join(libDir, 'node_modules', pkgName)
  await mkdir(dirname(destPkgDir), { recursive: true })
  await cp(srcPkgDir, destPkgDir, { recursive: true })
  await chmod(join(destPkgDir, 'claude'), 0o755)
}

async function copyCodexBinary(platform, libDir) {
  const info = CODEX_PLATFORM_PKG[platform]
  if (!info) throw new Error(`No codex package mapping for ${platform}`)
  const r = createRequire(join(repoRoot, 'package.json'))
  const srcPkgDir = dirname(r.resolve(`${info.pkg}/package.json`))
  const binRel = join('vendor', info.triple, 'bin', 'codex')
  if (!existsSync(join(srcPkgDir, binRel))) {
    throw new Error(`codex binary not found at ${join(srcPkgDir, binRel)}. Run npm install first.`)
  }
  const destPkgDir = join(libDir, 'node_modules', info.pkg)
  await mkdir(dirname(destPkgDir), { recursive: true })
  await cp(srcPkgDir, destPkgDir, { recursive: true })
  await chmod(join(destPkgDir, binRel), 0o755)
}

// vite externalizes runtime npm deps (see vite.headless.config.ts), so
// `require('node-pty')` and `require('ws')` in the bundled main.js
// resolve through plain Node lookup at runtime. We ship them as a real
// node_modules tree next to main.js so resolution Just Works.
const RUNTIME_PACKAGES = ['node-pty', 'ws']

async function copyRuntimePackages(libDir) {
  const destRoot = join(libDir, 'node_modules')
  await mkdir(destRoot, { recursive: true })
  for (const name of RUNTIME_PACKAGES) {
    const src = join(repoRoot, 'node_modules', name)
    if (!existsSync(src)) {
      throw new Error(`runtime package missing from node_modules: ${name}`)
    }
    const dest = join(destRoot, name)
    await cp(src, dest, {
      recursive: true,
      filter: (path) => {
        // Skip nested node_modules and obj.target build artifacts to
        // keep tarball lean — pty.node + spawn-helper are what's needed.
        if (path.includes(`${name}/node_modules`)) return false
        if (path.endsWith('.tsbuildinfo')) return false
        if (path.includes('/build/Release/obj.target')) return false
        if (path.includes('/build/Release/.deps')) return false
        return true
      }
    })
  }
}

async function sha256OfFile(file) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

async function main() {
  const { platform, nodeDist } = detectPlatform()
  const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
  const version = pkg.version
  const stageRootName = `harness-server-${version}-${platform}`
  const releaseDir = join(repoRoot, 'release', 'headless')
  const stageDir = join(releaseDir, stageRootName)

  console.log(`[pack-headless] platform=${platform} version=${version}`)

  if (!existsSync(join(repoRoot, 'dist-headless', 'main', 'index.js'))) {
    throw new Error(`dist-headless/main/index.js missing — run "npm run build:headless" first`)
  }
  if (!existsSync(join(repoRoot, 'dist-headless', 'web-client'))) {
    throw new Error(`dist-headless/web-client missing — run "npm run build:headless" first`)
  }

  await rm(stageDir, { recursive: true, force: true })
  await mkdir(join(stageDir, 'bin'), { recursive: true })
  await mkdir(join(stageDir, 'lib', 'main'), { recursive: true })
  await mkdir(join(stageDir, 'lib', 'mcp'), { recursive: true })

  const nodeBin = await downloadNodeBinary(platform, nodeDist)
  await cp(nodeBin, join(stageDir, 'lib', 'node'))
  await chmod(join(stageDir, 'lib', 'node'), 0o755)

  rebuildNodePtyForTargetNode()

  const libDir = join(stageDir, 'lib')
  await cp(join(repoRoot, 'dist-headless', 'main', 'index.js'), join(libDir, 'main', 'index.js'))
  await cp(join(repoRoot, 'dist-headless', 'web-client'), join(libDir, 'web-client'), {
    recursive: true
  })
  await copyRuntimePackages(libDir)
  await copyClaudeBinary(platform, libDir)
  await copyCodexBinary(platform, libDir)
  await cp(
    join(repoRoot, 'resources', 'permission-prompt-mcp.js'),
    join(libDir, 'mcp', 'permission-prompt-mcp.js')
  )
  await cp(
    join(repoRoot, 'resources', 'mcp-bridge.js'),
    join(libDir, 'mcp', 'mcp-bridge.js')
  )

  const shim = `#!/bin/sh
DIR="$(cd "$(dirname "$0")/.." && pwd)"

# --version short-circuits without booting Node so it stays instant.
case "$1" in
  --version|-v|version)
    cat "$DIR/VERSION"
    exit 0
    ;;
esac

exec "$DIR/lib/node" "$DIR/lib/main/index.js" "$@"
`
  const shimPath = join(stageDir, 'bin', 'harness-server')
  await writeFile(shimPath, shim, 'utf8')
  await chmod(shimPath, 0o755)

  await writeFile(join(stageDir, 'VERSION'), `${version}\n`, 'utf8')

  const tarballName = `${stageRootName}.tar.gz`
  const tarballPath = join(releaseDir, tarballName)
  await rm(tarballPath, { force: true })

  console.log(`[pack-headless] writing ${tarballName}`)
  await tar.c(
    {
      gzip: true,
      file: tarballPath,
      cwd: releaseDir,
      portable: true
    },
    [stageRootName]
  )

  const sha = await sha256OfFile(tarballPath)
  const shaPath = `${tarballPath}.sha256`
  await writeFile(shaPath, `${sha}  ${tarballName}\n`, 'utf8')

  const size = statSync(tarballPath).size
  const mb = (size / 1024 / 1024).toFixed(1)
  console.log(`[pack-headless] done`)
  console.log(`  tarball: ${tarballPath}`)
  console.log(`  size:    ${mb} MB`)
  console.log(`  sha256:  ${sha}`)
}

main().catch((err) => {
  console.error('[pack-headless] failed:', err.message)
  if (err.stack) console.error(err.stack)
  process.exit(1)
})
