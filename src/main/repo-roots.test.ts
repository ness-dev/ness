import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('./persistence', () => ({ saveConfig: vi.fn() }))

import { addRepoAtPath, createAndRegisterProject, type RegisterRepoDeps } from './repo-roots'
import type { Config } from './persistence'
import type { Store } from './store'
import type { WorktreesFSM } from './worktrees-fsm'

// The shared bodies behind repo:addAtPath / repo:createNewProject and the
// MCP add_repo / create_project tools.
describe('repo-roots shared add/create helpers', () => {
  let tmp: string
  let deps: RegisterRepoDeps
  let refreshList: ReturnType<typeof vi.fn>
  const savedEnv = { ...process.env }

  beforeAll(() => {
    process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test'
    process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com'
  })
  afterAll(() => {
    process.env = savedEnv
  })

  beforeEach(() => {
    // Deliberately not realpath'd: on macOS tmpdir() sits under a symlink,
    // which is what the canonicalization below has to handle.
    tmp = mkdtempSync(join(tmpdir(), 'ness-repo-roots-'))
    refreshList = vi.fn(async () => {})
    deps = {
      config: { repoRoots: [] } as unknown as Config,
      store: { dispatch: vi.fn() } as unknown as Store,
      worktreesFSM: { dispatchRepos: vi.fn(), refreshList } as unknown as WorktreesFSM
    }
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('createAndRegisterProject registers the canonical path once', async () => {
    const result = await createAndRegisterProject(
      { parentDir: tmp, name: 'app', includeReadme: true, gitignorePreset: 'node' },
      deps
    )
    const canonical = realpathSync(join(tmp, 'app'))
    expect(result).toEqual({ path: canonical })
    expect(deps.config.repoRoots).toEqual([canonical])
    expect(refreshList).toHaveBeenCalledTimes(1)
  })

  it('createAndRegisterProject registers nothing on failure', async () => {
    mkdirSync(join(tmp, 'taken'))
    const result = await createAndRegisterProject(
      { parentDir: tmp, name: 'taken', includeReadme: true, gitignorePreset: 'none' },
      deps
    )
    expect(result).toEqual({ error: 'Directory already exists', code: 'exists' })
    expect(deps.config.repoRoots).toEqual([])
  })

  it('concurrent creates of one path: exactly one wins and its repo survives', async () => {
    const opts = { parentDir: tmp, name: 'race', includeReadme: true, gitignorePreset: 'node' as const }
    const results = await Promise.all(
      Array.from({ length: 4 }, () => createAndRegisterProject(opts, deps))
    )
    const winners = results.filter((r) => 'path' in r)
    expect(winners).toHaveLength(1)
    expect(results.filter((r) => 'error' in r && r.code === 'exists')).toHaveLength(3)
    // The losers' cleanup must not have deleted the winner's folder.
    const log = execFileSync('git', ['log', '--oneline'], {
      cwd: join(tmp, 'race'),
      encoding: 'utf-8'
    })
    expect(log).toContain('Initial commit')
    expect(deps.config.repoRoots).toHaveLength(1)
  })

  it('addRepoAtPath is idempotent and only refreshes on a new root', async () => {
    const repo = join(tmp, 'r')
    mkdirSync(repo)
    execFileSync('git', ['init', '-q'], { cwd: repo })
    const canonical = realpathSync(repo)
    expect(await addRepoAtPath(repo, deps)).toEqual({ kind: 'added', repoRoot: canonical })
    expect(await addRepoAtPath(repo, deps)).toEqual({ kind: 'added', repoRoot: canonical })
    expect(deps.config.repoRoots).toEqual([canonical])
    expect(refreshList).toHaveBeenCalledTimes(1)
  })

  it('addRepoAtPath passes not-a-repo through without registering', async () => {
    const result = await addRepoAtPath(tmp, deps)
    expect(result.kind).toBe('not-a-repo')
    expect(deps.config.repoRoots).toEqual([])
  })
})
