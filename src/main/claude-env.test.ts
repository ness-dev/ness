import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, symlinkSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

vi.mock('./debug', () => ({
  log: () => {}
}))

let currentShell = '/bin/sh'
vi.mock('./user-shell', () => ({
  resolveUserShell: () => currentShell
}))

const tmpRoot = mkdtempSync(join(require('os').tmpdir(), 'harness-claude-env-'))

function fakeShell(name: string, body: string): string {
  const path = join(tmpRoot, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

const launcherConfigDir = process.env.CLAUDE_CONFIG_DIR

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
  if (launcherConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = launcherConfigDir
})

beforeEach(async () => {
  const { resetClaudeEnvCacheForTests } = await import('./claude-env')
  resetClaudeEnvCacheForTests()
  delete process.env.CLAUDE_CONFIG_DIR
})

const BEGIN = '__HARNESS_ENV_BEGIN__'
const END = '__HARNESS_ENV_END__'

describe('parseEnvProbeOutput', () => {
  it('splits NUL-separated KEY=value pairs between the sentinels', async () => {
    const { parseEnvProbeOutput } = await import('./claude-env')
    const stdout = `${BEGIN}PATH=/usr/bin\0CLAUDE_CONFIG_DIR=/home/u/.claude-oss\0${END}`
    expect(parseEnvProbeOutput(stdout)).toEqual({
      PATH: '/usr/bin',
      CLAUDE_CONFIG_DIR: '/home/u/.claude-oss'
    })
  })

  it('keeps values containing = and newlines intact', async () => {
    const { parseEnvProbeOutput } = await import('./claude-env')
    const stdout = `${BEGIN}A=x=y\0B=line1\nline2\0${END}`
    expect(parseEnvProbeOutput(stdout)).toEqual({ A: 'x=y', B: 'line1\nline2' })
  })

  it('tolerates rc-file noise before and after the sentinels', async () => {
    const { parseEnvProbeOutput } = await import('./claude-env')
    const stdout = `starship init: ok\n${BEGIN}X=1\0${END}goodbye\n`
    expect(parseEnvProbeOutput(stdout)).toEqual({ X: '1' })
  })

  it('returns null when sentinels are missing', async () => {
    const { parseEnvProbeOutput } = await import('./claude-env')
    expect(parseEnvProbeOutput('no sentinels')).toBeNull()
    expect(parseEnvProbeOutput(`${BEGIN}X=1\0`)).toBeNull()
    expect(parseEnvProbeOutput('')).toBeNull()
  })
})

describe('captureShellEnv', () => {
  it('runs the probe in the requested cwd and returns the env', async () => {
    const { captureShellEnv } = await import('./claude-env')
    const shell = fakeShell(
      'cwd-shell',
      `printf '${BEGIN}'; printf 'PROBE_CWD=%s\\0CLAUDE_CONFIG_DIR=%s/.other\\0' "$(pwd -P)" "$HOME"; printf '${END}'`
    )
    const env = await captureShellEnv(shell, tmpRoot, 2000)
    expect(env?.PROBE_CWD).toBe(require('fs').realpathSync(tmpRoot))
    expect(env?.CLAUDE_CONFIG_DIR).toBe(join(homedir(), '.other'))
  })

  it('returns null when the shell prints no sentinels', async () => {
    const { captureShellEnv } = await import('./claude-env')
    const shell = fakeShell('silent-shell', 'exit 0')
    expect(await captureShellEnv(shell, tmpRoot, 2000)).toBeNull()
  })

  it('returns null on timeout', async () => {
    const { captureShellEnv } = await import('./claude-env')
    const shell = fakeShell('hang-shell', 'sleep 30')
    expect(await captureShellEnv(shell, tmpRoot, 200)).toBeNull()
  })

  it('returns null when the cwd does not exist', async () => {
    const { captureShellEnv } = await import('./claude-env')
    const shell = fakeShell('any-shell', `printf '${BEGIN}X=1\\0${END}'`)
    expect(await captureShellEnv(shell, join(tmpRoot, 'missing'), 2000)).toBeNull()
  })
})

describe('claudeConfigDirFor', () => {
  it('falls back to ~/.claude when nothing is cached and Ness has no override', async () => {
    const { claudeConfigDirFor } = await import('./claude-env')
    expect(claudeConfigDirFor('/some/worktree')).toBe(join(homedir(), '.claude'))
  })

  it('uses the captured CLAUDE_CONFIG_DIR for the cwd and its subdirectories', async () => {
    const { claudeConfigDirFor, resolveShellEnv, knownClaudeConfigDirs } = await import('./claude-env')
    const shell = fakeShell('oss-shell', `printf '${BEGIN}CLAUDE_CONFIG_DIR=/home/u/.claude-oss\\0${END}'`)
    currentShell = shell

    await resolveShellEnv(tmpRoot)
    expect(claudeConfigDirFor(tmpRoot)).toBe('/home/u/.claude-oss')
    expect(claudeConfigDirFor(join(tmpRoot, 'sub', 'dir'))).toBe('/home/u/.claude-oss')
    expect(claudeConfigDirFor(`${tmpRoot}-sibling`)).toBe(join(homedir(), '.claude'))
    expect(knownClaudeConfigDirs()).toContain('/home/u/.claude-oss')
    expect(knownClaudeConfigDirs()).toContain(join(homedir(), '.claude'))
  })

  it('ignores Ness’s own CLAUDE_CONFIG_DIR once the shell has answered for the cwd', async () => {
    const { claudeConfigDirFor, resolveShellEnv } = await import('./claude-env')
    const shell = fakeShell('plain-shell', `printf '${BEGIN}PATH=/usr/bin\\0${END}'`)
    currentShell = shell
    process.env.CLAUDE_CONFIG_DIR = '/launcher/home'
    expect(claudeConfigDirFor(tmpRoot)).toBe('/launcher/home')
    await resolveShellEnv(tmpRoot)
    expect(claudeConfigDirFor(tmpRoot)).toBe(join(homedir(), '.claude'))
  })

  it('lists one home once however it is spelled', async () => {
    const { resolveShellEnv, knownClaudeConfigDirs, claudeConfigDirFor, setExplicitClaudeConfigDirSource } =
      await import('./claude-env')
    const realHome = join(tmpRoot, 'real-home')
    const linkedHome = join(tmpRoot, 'linked-home')
    mkdirSync(realHome, { recursive: true })
    if (!existsSync(linkedHome)) symlinkSync(realHome, linkedHome)
    const a = join(tmpRoot, 'wt-slash')
    const b = join(tmpRoot, 'wt-link')
    mkdirSync(a, { recursive: true })
    mkdirSync(b, { recursive: true })

    currentShell = fakeShell('slash-shell', `printf '${BEGIN}CLAUDE_CONFIG_DIR=%s/\\0${END}' "$HOME/.claude"`)
    await resolveShellEnv(a)
    currentShell = fakeShell('link-shell', `printf '${BEGIN}CLAUDE_CONFIG_DIR=${linkedHome}\\0${END}'`)
    await resolveShellEnv(b)
    setExplicitClaudeConfigDirSource(() => `${realHome}/`)

    expect(claudeConfigDirFor(a)).toBe(realHome)
    // ~/.claude/ from the shell is the default home; the symlink and the
    // slash-suffixed override are both real-home.
    expect(knownClaudeConfigDirs()).toEqual([join(homedir(), '.claude'), realHome])
  })

  it('anchors a relative CLAUDE_CONFIG_DIR at the directory the shell ran in', async () => {
    const { resolveShellEnv, claudeConfigDirFor } = await import('./claude-env')
    currentShell = fakeShell('relative-shell', `printf '${BEGIN}CLAUDE_CONFIG_DIR=.claude-local\\0${END}'`)
    await resolveShellEnv(tmpRoot)
    expect(claudeConfigDirFor(tmpRoot)).toBe(join(tmpRoot, '.claude-local'))
    expect(claudeConfigDirFor(join(tmpRoot, 'sub'))).toBe(join(tmpRoot, '.claude-local'))
  })

  it('lets the settings override win over the shell', async () => {
    const { claudeConfigDirFor, resolveShellEnv, setExplicitClaudeConfigDirSource } = await import(
      './claude-env'
    )
    const shell = fakeShell('oss-shell2', `printf '${BEGIN}CLAUDE_CONFIG_DIR=/home/u/.claude-oss\\0${END}'`)
    currentShell = shell
    await resolveShellEnv(tmpRoot)
    setExplicitClaudeConfigDirSource(() => '/explicit/home')
    expect(claudeConfigDirFor(tmpRoot)).toBe('/explicit/home')
  })
})

describe('resolveShellEnv caching', () => {
  it('dedups concurrent probes and keeps the last good capture over a failed refresh', async () => {
    const { resolveShellEnv, warmShellEnv, cachedShellEnv } = await import('./claude-env')
    const marker = join(tmpRoot, 'fail-next')
    const shell = fakeShell(
      'flaky-shell',
      `if [ -e "${marker}" ]; then exit 0; fi; printf '${BEGIN}CLAUDE_CONFIG_DIR=/good\\0${END}'`
    )
    currentShell = shell
    const [a, b] = await Promise.all([resolveShellEnv(tmpRoot), resolveShellEnv(tmpRoot)])
    expect(a).toBe(b)
    expect(cachedShellEnv(tmpRoot)?.CLAUDE_CONFIG_DIR).toBe('/good')

    writeFileSync(marker, '')
    expect(await warmShellEnv(tmpRoot)).toEqual(a)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 120_000)
      expect((await resolveShellEnv(tmpRoot))?.CLAUDE_CONFIG_DIR).toBe('/good')
    } finally {
      vi.useRealTimers()
    }
  })

  it('serves a stale capture at once and refreshes it in the background', async () => {
    const { resolveShellEnv, cachedShellEnv, onShellEnvCaptured } = await import('./claude-env')
    const marker = join(tmpRoot, 'second-home')
    const shell = fakeShell(
      'changing-shell',
      `if [ -e "${marker}" ]; then sleep 0.3; printf '${BEGIN}CLAUDE_CONFIG_DIR=/second\\0${END}'; ` +
        `else printf '${BEGIN}CLAUDE_CONFIG_DIR=/first\\0${END}'; fi`
    )
    currentShell = shell
    expect((await resolveShellEnv(tmpRoot))?.CLAUDE_CONFIG_DIR).toBe('/first')

    writeFileSync(marker, '')
    let captured = 0
    let resolveCapture!: () => void
    const nextCapture = new Promise<void>((r) => (resolveCapture = r))
    onShellEnvCaptured(() => {
      captured++
      resolveCapture()
    })
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 120_000)
      const started = performance.now()
      expect((await resolveShellEnv(tmpRoot))?.CLAUDE_CONFIG_DIR).toBe('/first')
      expect(performance.now() - started).toBeLessThan(100)
    } finally {
      vi.useRealTimers()
    }
    await nextCapture
    expect(captured).toBe(1)
    expect(cachedShellEnv(tmpRoot)?.CLAUDE_CONFIG_DIR).toBe('/second')
    rmSync(marker)
  })

  it('retries a failed probe on the next resolve instead of serving the failure', async () => {
    const { resolveShellEnv, warmShellEnv } = await import('./claude-env')
    const marker = join(tmpRoot, 'broken-until-removed')
    writeFileSync(marker, '')
    const shell = fakeShell(
      'recovering-shell',
      `if [ -e "${marker}" ]; then exit 0; fi; printf '${BEGIN}CLAUDE_CONFIG_DIR=/late\\0${END}'`
    )
    currentShell = shell
    expect(await warmShellEnv(tmpRoot)).toBeNull()
    expect(await warmShellEnv(tmpRoot)).toBeNull()
    rmSync(marker)
    expect(await warmShellEnv(tmpRoot)).toBeNull()
    expect((await resolveShellEnv(tmpRoot))?.CLAUDE_CONFIG_DIR).toBe('/late')
  })

  it('runs a few probes at a time and lets a resolve overtake queued warm-ups', async () => {
    const { resolveShellEnv, warmShellEnv } = await import('./claude-env')
    const slots = join(tmpRoot, 'slots')
    const violation = join(tmpRoot, 'too-many-at-once')
    mkdirSync(slots, { recursive: true })
    const shell = fakeShell(
      'slow-shell',
      [
        `touch "${slots}/$$"`,
        `if [ "$(ls "${slots}" | wc -l)" -gt 2 ]; then touch "${violation}"; fi`,
        'sleep 0.3',
        `rm -f "${slots}/$$"`,
        `printf '${BEGIN}CWD=%s\\0${END}' "$(pwd)"`
      ].join('\n')
    )
    currentShell = shell
    const dirs = Array.from({ length: 7 }, (_, i) => join(tmpRoot, `wt${i}`))
    for (const d of dirs) mkdirSync(d, { recursive: true })

    const done: string[] = []
    const warms = dirs.slice(0, 6).map((d) => warmShellEnv(d).then(() => done.push(d)))
    const urgent = resolveShellEnv(dirs[6]).then(() => done.push(dirs[6]))
    await Promise.all([...warms, urgent])

    expect(existsSync(violation)).toBe(false)
    // Two warm-ups are already running when the resolve lands, so it is
    // the third to start; without priority it would be the last.
    expect(done.indexOf(dirs[6])).toBeLessThanOrEqual(3)
  })
})
