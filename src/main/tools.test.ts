import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { discoverTools, runTool } from './tools'

let root: string

function addTool(id: string, manifest: unknown, script?: string): string {
  const dir = join(root, '.ness/tools', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'tool.json'), JSON.stringify(manifest))
  if (script !== undefined) {
    const scriptPath = join(dir, 'run.sh')
    writeFileSync(scriptPath, script)
    chmodSync(scriptPath, 0o755)
  }
  return dir
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ness-tools-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const ctx = { branch: 'feature/x', repoRoot: '/repo' }

describe('discoverTools', () => {
  it('returns [] when there is no tools directory', () => {
    expect(discoverTools(root)).toEqual([])
  })

  it('reads the manifest and defaults script + refresh', () => {
    addTool('pr-comments', { title: 'PR Comments' })
    const [spec] = discoverTools(root)
    expect(spec.id).toBe('pr-comments')
    expect(spec.title).toBe('PR Comments')
    expect(spec.script).toBe('run.sh')
    expect(spec.refresh).toBe('manual')
  })

  it('falls back to the directory name when title is missing', () => {
    addTool('deploys', {})
    expect(discoverTools(root)[0].title).toBe('deploys')
  })

  it('skips a directory whose manifest is malformed', () => {
    const dir = join(root, '.ness/tools/broken')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'tool.json'), '{not json')
    expect(discoverTools(root)).toEqual([])
  })

  it('rejects a script path that escapes the tool directory', () => {
    addTool('evil', { title: 'Evil', script: '../../../../bin/sh' })
    expect(discoverTools(root)).toEqual([])
  })
})

describe('runTool', () => {
  it('returns stdout as markdown', async () => {
    addTool('hello', { title: 'Hello' }, '#!/bin/sh\necho "## Section"\necho "- a row"\n')
    const res = await runTool(root, 'hello', ctx)
    expect(res.ok).toBe(true)
    expect(res.markdown).toContain('## Section')
    expect(res.markdown).toContain('- a row')
  })

  it('exposes the ness env vars to the script', async () => {
    addTool('env', { title: 'Env' }, '#!/bin/sh\necho "$NESS_BRANCH $NESS_TOOL_ID"\n')
    const res = await runTool(root, 'env', ctx)
    expect(res.markdown.trim()).toBe('feature/x env')
  })

  it('reports a non-zero exit but still surfaces any output', async () => {
    addTool('fails', { title: 'Fails' }, '#!/bin/sh\necho "partial"\necho "boom" >&2\nexit 3\n')
    const res = await runTool(root, 'fails', ctx)
    expect(res.ok).toBe(false)
    expect(res.markdown).toContain('partial')
    expect(res.error).toContain('boom')
  })

  it('errors on an unknown tool id', async () => {
    const res = await runTool(root, 'nope', ctx)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('Unknown tool')
  })

  it('errors when the manifest points at a missing script', async () => {
    addTool('noscript', { title: 'No Script' })
    const res = await runTool(root, 'noscript', ctx)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('Script not found')
  })

  it('tells the user to chmod +x when the script is not executable', async () => {
    addTool('noexec', { title: 'No Exec' }, '#!/bin/sh\necho hi\n')
    chmodSync(join(root, '.ness/tools/noexec/run.sh'), 0o644)
    const res = await runTool(root, 'noexec', ctx)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('chmod +x')
  })
})
