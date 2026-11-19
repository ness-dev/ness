import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { scanExistingWork } from './work-discovery'

// Real git repos in a temp dir: the scan's whole job is reconciling what
// transcripts claim against what git says exists, so faking git would test
// nothing.
let root: string
let claudeHome: string
let codexHome: string
let repo: string
let feature: string

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com'
    }
  })
}

function writeClaudeSession(
  cwd: string,
  sessionId: string,
  opts: { lastPrompt?: string; mtime?: number; dirName?: string } = {}
): void {
  const dir = join(claudeHome, 'projects', opts.dirName ?? cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  const lines = [
    JSON.stringify({ type: 'session-owner', sessionId }),
    JSON.stringify({ type: 'user', cwd, sessionId, message: { role: 'user', content: 'hi "cwd":"/nope"' } })
  ]
  if (opts.lastPrompt) lines.push(JSON.stringify({ type: 'last-prompt', lastPrompt: opts.lastPrompt, sessionId }))
  const file = join(dir, `${sessionId}.jsonl`)
  writeFileSync(file, lines.join('\n') + '\n')
  if (opts.mtime) utimesSync(file, opts.mtime / 1000, opts.mtime / 1000)
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ness-work-discovery-')))
  claudeHome = join(root, 'claude-home')
  codexHome = join(root, 'codex-home')
  repo = join(root, 'code', 'app')
  feature = join(root, 'code', 'app-worktrees', 'feature')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  git(repo, 'worktree', 'add', '-q', '-b', 'feature', feature)
  git(repo, 'worktree', 'add', '-q', '-b', 'untouched', join(root, 'code', 'app-worktrees', 'untouched'))
  git(repo, 'worktree', 'add', '-q', '-b', 'codex-only', join(root, 'code', 'app-worktrees', 'codex-only'))
  mkdirSync(join(repo, 'sub'))

  writeClaudeSession(repo, 'main-old', { lastPrompt: 'older prompt', mtime: Date.now() - 60_000 })
  writeClaudeSession(repo, 'main-new', { lastPrompt: 'newest   prompt\nhere' })
  writeClaudeSession(feature, 'feat-live', { lastPrompt: 'live one', mtime: Date.now() - 120_000 })
  writeClaudeSession(feature, 'feat-newer', { lastPrompt: 'newer but not live' })
  // Started in a subdirectory: filed under a dir the worktree root can't resume from.
  writeClaudeSession(join(repo, 'sub'), 'sub-session')
  // History for a worktree that has since been deleted.
  writeClaudeSession(join(root, 'code', 'gone'), 'gone-session')

  mkdirSync(join(claudeHome, 'sessions'), { recursive: true })
  writeFileSync(
    join(claudeHome, 'sessions', `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: 'feat-live', cwd: feature, status: 'busy' })
  )
  writeFileSync(
    join(claudeHome, 'sessions', '999999.json'),
    JSON.stringify({ pid: 999999, sessionId: 'main-new', cwd: repo, status: 'idle' })
  )

  const codexDir = join(codexHome, 'sessions', '2026', '01', '02')
  mkdirSync(codexDir, { recursive: true })
  writeFileSync(
    join(codexDir, 'rollout-a.jsonl'),
    JSON.stringify({ type: 'session_meta', payload: { session_id: 'codex-1', cwd: repo, source: 'cli' } }) + '\n'
  )
  // Older than the Claude sessions in the same worktree.
  utimesSync(join(codexDir, 'rollout-a.jsonl'), (Date.now() - 600_000) / 1000, (Date.now() - 600_000) / 1000)
  writeFileSync(
    join(codexDir, 'rollout-c.jsonl'),
    JSON.stringify({
      type: 'session_meta',
      payload: { session_id: 'codex-thread', cwd: join(root, 'code', 'app-worktrees', 'codex-only'), source: 'cli' }
    }) + '\n'
  )
  writeFileSync(
    join(codexDir, 'rollout-b.jsonl'),
    JSON.stringify({ type: 'session_meta', payload: { session_id: 'codex-exec', cwd: repo, source: 'exec' } }) + '\n'
  )
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function scan(over: { addedRepoRoots?: string[]; ownSessionIds?: Set<string> } = {}) {
  return scanExistingWork({
    claudeConfigDirs: [claudeHome],
    codexHome,
    addedRepoRoots: over.addedRepoRoots ?? [],
    ownSessionIds: over.ownSessionIds ?? new Set()
  })
}

describe('scanExistingWork', () => {
  it('groups sessions by repo and lists every worktree, including untouched ones', async () => {
    const work = await scan()
    expect(work.repos).toHaveLength(1)
    const found = work.repos[0]
    expect(found.repoRoot).toBe(repo)
    expect(found.name).toBe('app')
    expect(found.alreadyAdded).toBe(false)
    expect(found.worktrees.map((w) => w.branch).sort()).toEqual(['codex-only', 'feature', 'main', 'untouched'])
    const untouched = found.worktrees.find((w) => w.branch === 'untouched')!
    expect(untouched.session).toBeUndefined()
    expect(untouched.lastActiveAt).toBeNull()
  })

  it('offers the newest conversation, with its last prompt flattened', async () => {
    const main = (await scan()).repos[0].worktrees.find((w) => w.isMain)!
    expect(main.session?.sessionId).toBe('main-new')
    expect(main.session?.lastPrompt).toBe('newest prompt here')
    // Two Claude sessions plus the interactive Codex one; `codex exec` runs
    // and the subdirectory session don't count.
    expect(main.sessionCount).toBe(3)
  })

  it('offers a Codex thread where that is what the worktree has', async () => {
    const wt = (await scan()).repos[0].worktrees.find((w) => w.branch === 'codex-only')!
    expect(wt.session).toMatchObject({ agentKind: 'codex', sessionId: 'codex-thread' })
  })

  it('prefers a conversation that is running elsewhere over a newer idle one', async () => {
    const work = await scan()
    const feat = work.repos[0].worktrees.find((w) => w.branch === 'feature')!
    expect(feat.session?.sessionId).toBe('feat-live')
    expect(feat.session?.live).toEqual({ pid: process.pid, status: 'busy' })
    expect(work.repos[0].liveCount).toBe(1)
  })

  it('ignores registry entries whose process has exited', async () => {
    const main = (await scan()).repos[0].worktrees.find((w) => w.isMain)!
    expect(main.session?.live).toBeUndefined()
  })

  it("does not report Ness's own sessions as running elsewhere", async () => {
    const work = await scan({ ownSessionIds: new Set(['feat-live']) })
    const feat = work.repos[0].worktrees.find((w) => w.branch === 'feature')!
    expect(feat.session?.sessionId).toBe('feat-newer')
    expect(feat.session?.live).toBeUndefined()
  })

  it('marks repos that are already registered and suggests the dominant agent', async () => {
    const work = await scan({ addedRepoRoots: [repo] })
    expect(work.repos[0].alreadyAdded).toBe(true)
    expect(work.suggestedAgent).toBe('claude')
  })

  it('finds nothing in an empty home', async () => {
    const work = await scanExistingWork({
      claudeConfigDirs: [join(root, 'no-such-home')],
      codexHome: join(root, 'no-such-codex'),
      addedRepoRoots: [],
      ownSessionIds: new Set()
    })
    expect(work.repos).toEqual([])
    expect(work.suggestedAgent).toBeNull()
  })
})
