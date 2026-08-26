import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionImportEvent } from '../shared/state/session-import'
import type { TerminalTab } from '../shared/state/terminals'
import { SessionImportManager, type CreateWorktreeParams } from './session-import'
import type { DiscoveredSession } from './session-scanner'
import type { BranchInventoryEntry } from './worktree'
import type { RepoImportSelection } from '../shared/repo-import-types'

/** forkTranscript reads and writes under the real ~/.claude/projects tree,
 *  so these tests point it at a scratch HOME. */
let fakeHome: string

function encodedDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

function writeTranscript(cwd: string, sessionId: string, lines: object[]): void {
  const dir = join(fakeHome, '.claude', 'projects', encodedDir(cwd))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${sessionId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    'utf8'
  )
}

function session(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    sessionId: 'sid-1',
    transcriptPath: '/x.jsonl',
    cwd: '/work/repo',
    gitBranch: 'main',
    title: 'Fix the thing',
    titleSource: 'ai',
    prNumber: null,
    prUrl: null,
    prRepository: null,
    firstTimestamp: 1,
    lastTimestamp: 2,
    userTurns: 1,
    userTurnsExact: true,
    sizeBytes: 10,
    mtimeMs: 2,
    cliVersion: '2.1.126',
    ...over
  }
}

interface Harness {
  manager: SessionImportManager
  events: SessionImportEvent[]
  tabs: { worktreePath: string; tab: TerminalTab }[]
  started: { sessionId: string; worktreePath: string }[]
  created: CreateWorktreeParams[]
}

interface HarnessOptions {
  inventory?: BranchInventoryEntry[]
  /** Branches whose worktree creation should fail. */
  failBranches?: string[]
}

function harness(sessions: DiscoveredSession[], options: HarnessOptions = {}): Harness {
  const events: SessionImportEvent[] = []
  const tabs: { worktreePath: string; tab: TerminalTab }[] = []
  const started: { sessionId: string; worktreePath: string }[] = []
  const created: CreateWorktreeParams[] = []
  const manager = new SessionImportManager({
    dispatch: (e) => events.push(e),
    getRepoRoots: () => [],
    addTab: (worktreePath, tab) => tabs.push({ worktreePath, tab }),
    startSession: (sessionId, worktreePath) => started.push({ sessionId, worktreePath }),
    homeDir: () => fakeHome,
    listBranchInventory: async () => options.inventory ?? [],
    createWorktree: async (params) => {
      created.push(params)
      if (options.failBranches?.includes(params.branchName)) {
        return { ok: false, path: null, error: 'branch is checked out elsewhere' }
      }
      return { ok: true, path: `/work/repo-worktrees/${params.branchName}` }
    },
    now: () => 1234
  })
  ;(manager as unknown as { sessions: DiscoveredSession[] }).sessions = sessions
  ;(manager as unknown as { scanned: boolean }).scanned = true
  return { manager, events, tabs, started, created }
}

function inventoryEntry(over: Partial<BranchInventoryEntry> = {}): BranchInventoryEntry {
  return { name: 'main', lastCommitMs: 1000, checkedOutAt: null, merged: false, ...over }
}

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'session-import-'))
  // os.homedir() reads $HOME, which is what forkTranscript resolves against.
  process.env.HOME = fakeHome
})

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true })

})

describe('importSession', () => {
  it('adopts in place when the session already ran in the target worktree', () => {
    const h = harness([session({ sessionId: 'sid-1', cwd: '/work/repo' })])
    const outcome = h.manager.importSession('sid-1', '/work/repo')

    expect(outcome.ok).toBe(true)
    expect(outcome.mode).toBe('adopt')
    // Same id: the CLI resumes the existing transcript, no copy made.
    expect(outcome.sessionId).toBe('sid-1')
    expect(h.tabs[0].tab.id).toBe('sid-1')
    expect(h.tabs[0].tab.sessionId).toBe('sid-1')
    expect(h.tabs[0].tab.type).toBe('json-claude')
    expect(h.started).toEqual([{ sessionId: 'sid-1', worktreePath: '/work/repo' }])
  })

  it('titles the tab from the session title', () => {
    const h = harness([session({ title: 'Fix the thing' })])
    h.manager.importSession('sid-1', '/work/repo')
    expect(h.tabs[0].tab.label).toBe('Fix the thing')
  })

  it('falls back to a generic label when the session is untitled', () => {
    const h = harness([session({ title: null })])
    h.manager.importSession('sid-1', '/work/repo')
    expect(h.tabs[0].tab.label).toBe('Imported chat')
  })

  it('forks into the target when the session ran elsewhere', () => {
    writeTranscript('/work/source', 'sid-1', [
      { type: 'user', sessionId: 'sid-1', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', sessionId: 'sid-1', message: { id: 'm1', content: [] } }
    ])
    const h = harness([session({ sessionId: 'sid-1', cwd: '/work/source' })])

    const outcome = h.manager.importSession('sid-1', '/work/dest')

    expect(outcome.ok).toBe(true)
    expect(outcome.mode).toBe('fork')
    expect(outcome.sessionId).not.toBe('sid-1')

    // The copy lands in the destination worktree's encoded project dir...
    const destDir = join(fakeHome, '.claude', 'projects', encodedDir('/work/dest'))
    const written = readdirSync(destDir)
    expect(written).toEqual([`${outcome.sessionId}.jsonl`])

    // ...with every line restamped to the new session id.
    const body = readFileSync(join(destDir, written[0]), 'utf8').trim().split('\n')
    for (const line of body) {
      expect(JSON.parse(line).sessionId).toBe(outcome.sessionId)
    }

    // ...and the source is untouched.
    const srcDir = join(fakeHome, '.claude', 'projects', encodedDir('/work/source'))
    expect(readdirSync(srcDir)).toEqual(['sid-1.jsonl'])
    const srcBody = readFileSync(join(srcDir, 'sid-1.jsonl'), 'utf8').trim().split('\n')
    expect(JSON.parse(srcBody[0]).sessionId).toBe('sid-1')
  })

  it('opens the forked tab under the new id, not the source id', () => {
    writeTranscript('/work/source', 'sid-1', [
      { type: 'user', sessionId: 'sid-1', message: { role: 'user', content: 'hi' } }
    ])
    const h = harness([session({ sessionId: 'sid-1', cwd: '/work/source' })])
    const outcome = h.manager.importSession('sid-1', '/work/dest')
    expect(h.tabs[0].tab.id).toBe(outcome.sessionId)
    expect(h.started[0].sessionId).toBe(outcome.sessionId)
    expect(h.started[0].worktreePath).toBe('/work/dest')
  })

  it('fails cleanly when the source transcript is missing', () => {
    const h = harness([session({ sessionId: 'gone', cwd: '/work/source' })])
    const outcome = h.manager.importSession('gone', '/work/dest')
    expect(outcome.ok).toBe(false)
    expect(h.tabs).toHaveLength(0)
    expect(h.started).toHaveLength(0)
  })

  it('fails cleanly for an unknown session id', () => {
    const h = harness([])
    const outcome = h.manager.importSession('nope', '/work/dest')
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('session not found')
  })

  it('fails cleanly when the session has no recorded cwd', () => {
    const h = harness([session({ cwd: null })])
    const outcome = h.manager.importSession('sid-1', '/work/dest')
    expect(outcome.ok).toBe(false)
    expect(h.tabs).toHaveLength(0)
  })
})

describe('scan', () => {
  it('dispatches started then completed', async () => {
    const h = harness([])
    mkdirSync(join(fakeHome, '.claude', 'projects'), { recursive: true })
    await h.manager.scan()
    expect(h.events[0].type).toBe('sessionImport/scanStarted')
    expect(h.events[h.events.length - 1]).toEqual({
      type: 'sessionImport/scanCompleted',
      payload: { sessionCount: 0, groupCount: 0, at: 1234 }
    })
  })

  it('coalesces progress so a large corpus cannot flood the store', async () => {
    // 300 files must not become 300 dispatches — at most one per whole
    // percent, plus the final one.
    const projects = join(fakeHome, '.claude', 'projects', 'dir-a')
    mkdirSync(projects, { recursive: true })
    for (let i = 0; i < 300; i++) {
      writeFileSync(
        join(projects, `s${i}.jsonl`),
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' } }) + '\n',
        'utf8'
      )
    }
    const h = harness([])
    await h.manager.scan()
    const progress = h.events.filter((e) => e.type === 'sessionImport/scanProgress')
    expect(progress.length).toBeLessThanOrEqual(101)
    // ...and the last one still reports completion, so the bar lands full.
    const last = progress[progress.length - 1]
    expect(last).toEqual({
      type: 'sessionImport/scanProgress',
      payload: { scanned: 300, total: 300 }
    })
  })

  it('hands a second caller the in-flight scan rather than an early answer', async () => {
    // The wizard probes several repos at once. A caller that resolved before
    // the shared scan finished would read an empty session list and report
    // every repo but the first as having no history at all.
    mkdirSync(join(fakeHome, '.claude', 'projects'), { recursive: true })
    const h = harness([])
    const first = h.manager.scan()
    expect(h.manager.scan()).toBe(first)
    await first
    expect(h.events.filter((e) => e.type === 'sessionImport/scanStarted')).toHaveLength(1)
  })

  it('reports not scanning once finished', async () => {
    const h = harness([])
    mkdirSync(join(fakeHome, '.claude', 'projects'), { recursive: true })
    const inFlight = h.manager.scan()
    expect(h.manager.isScanning()).toBe(true)
    await inFlight
    expect(h.manager.isScanning()).toBe(false)
  })
})

describe('importRepoBranches', () => {
  function repoHarness(over: HarnessOptions = {}): Harness {
    return harness(
      [
        session({ sessionId: 'new', gitBranch: 'feat', cwd: '/work/repo', lastTimestamp: 900 }),
        session({ sessionId: 'old', gitBranch: 'feat', cwd: '/work/repo', lastTimestamp: 100 }),
        session({ sessionId: 'other', gitBranch: 'fix', cwd: '/work/repo', lastTimestamp: 500 })
      ],
      { inventory: [inventoryEntry({ name: 'feat' }), inventoryEntry({ name: 'fix' })], ...over }
    )
  }

  function pick(branch: string, ...sessionIds: string[]): RepoImportSelection {
    return { branch, sessionIds }
  }

  it('creates a worktree per requested branch', async () => {
    const h = repoHarness()
    const result = await h.manager.importRepoBranches({
      repoRoot: '/work/repo',
      branches: [pick('feat', 'new'), pick('fix', 'other')]
    })
    expect(result.ok).toBe(true)
    expect(result.created).toBe(2)
    expect(h.created.map((c) => c.branchName)).toEqual(['feat', 'fix'])
  })

  it('checks out the existing branch rather than cutting a new one', async () => {
    const h = repoHarness()
    await h.manager.importRepoBranches({
      repoRoot: '/work/repo',
      branches: [pick('feat', 'new')]
    })
    // runPending would otherwise try `-b feat` against a branch that exists.
    expect(h.created[0].forkSource).toBeDefined()
  })

  it('seeds the worktree with the newest selected chat whatever order it was sent in', async () => {
    const h = repoHarness()
    await h.manager.importRepoBranches({
      repoRoot: '/work/repo',
      branches: [pick('feat', 'old', 'new')]
    })
    expect(h.created[0].forkSource?.sessionId).toBe('new')
  })

  it('forks silently so a bulk import does not fire an agent turn per worktree', async () => {
    const h = repoHarness()
    await h.manager.importRepoBranches({
      repoRoot: '/work/repo',
      branches: [pick('feat', 'new'), pick('fix', 'other')]
    })
    expect(h.created.every((c) => c.forkSource?.silent === true)).toBe(true)
  })

  it('opens only the chats that were selected', async () => {
    const h = repoHarness()
    const result = await h.manager.importRepoBranches({
      repoRoot: '/work/repo',
      branches: [pick('feat', 'new')]
    })
    // The lead chat rides in via forkSource, so no extra tab is added.
    expect(h.tabs).toHaveLength(0)
    expect(result.importedChats).toBe(1)
  })

  it('attaches every additional selected chat as its own tab', async () => {
    writeTranscript('/work/repo', 'old', [
      { type: 'user', sessionId: 'old', message: { role: 'user', content: 'hi' } }
    ])
    const h = repoHarness()
    const result = await h.manager.importRepoBranches({
      repoRoot: '/work/repo',
      branches: [pick('feat', 'new', 'old')]
    })
    expect(h.tabs).toHaveLength(1)
    expect(h.tabs[0].worktreePath).toBe('/work/repo-worktrees/feat')
    expect(result.importedChats).toBe(2)
  })

  it('leaves the extra chat tabs asleep so 40 chats are not 40 subprocesses', async () => {
    writeTranscript('/work/repo', 'old', [
      { type: 'user', sessionId: 'old', message: { role: 'user', content: 'hi' } }
    ])
    const h = repoHarness()
    await h.manager.importRepoBranches({
      repoRoot: '/work/repo',
      branches: [pick('feat', 'new', 'old')]
    })
    expect(h.tabs[0].tab.mode).toBe('asleep')
    expect(h.started).toHaveLength(0)
  })

  it('ignores selected chats that belong to another branch', async () => {
    const h = repoHarness()
    const result = await h.manager.importRepoBranches({
      repoRoot: '/work/repo',
      branches: [pick('feat', 'new', 'other')]
    })
    expect(result.importedChats).toBe(1)
    expect(h.tabs).toHaveLength(0)
  })

  it('falls back to the newest chat when the selection is empty', async () => {
    const h = repoHarness()
    await h.manager.importRepoBranches({
      repoRoot: '/work/repo',
      branches: [pick('feat')]
    })
    expect(h.created[0].forkSource?.sessionId).toBe('new')
  })

  it('keeps going when one branch fails, and names the one that did', async () => {
    const h = repoHarness({ failBranches: ['feat'] })
    const result = await h.manager.importRepoBranches({
      repoRoot: '/work/repo',
      branches: [pick('feat', 'new'), pick('fix', 'other')]
    })
    expect(result.created).toBe(1)
    expect(result.ok).toBe(true)
    const failed = result.branches.find((b) => b.branch === 'feat')
    expect(failed?.ok).toBe(false)
    expect(failed?.error).toBe('branch is checked out elsewhere')
    expect(result.branches.find((b) => b.branch === 'fix')?.ok).toBe(true)
  })

  it('rejects a branch with no importable history instead of creating an empty worktree', async () => {
    const h = repoHarness()
    const result = await h.manager.importRepoBranches({
      repoRoot: '/work/repo',
      branches: [pick('never-chatted')]
    })
    expect(result.created).toBe(0)
    expect(result.ok).toBe(false)
    expect(h.created).toHaveLength(0)
  })
})

describe('probeRepo', () => {
  it('reports the branches worth importing', async () => {
    const h = harness(
      [session({ sessionId: 'a', gitBranch: 'feat', cwd: '/work/repo', lastTimestamp: 1000 })],
      { inventory: [inventoryEntry({ name: 'feat' })] }
    )
    const plan = await h.manager.probeRepo('/work/repo')
    expect(plan.repoLabel).toBe('repo')
    expect(plan.candidates.map((c) => c.branch)).toEqual(['feat'])
  })

  it('scans on first call so callers can fire it straight off a repo add', async () => {
    mkdirSync(join(fakeHome, '.claude', 'projects'), { recursive: true })
    const h = harness([])
    ;(h.manager as unknown as { scanned: boolean }).scanned = false
    await h.manager.probeRepo('/work/repo')
    expect(h.events.some((e) => e.type === 'sessionImport/scanStarted')).toBe(true)
  })

})

describe('getTree', () => {
  it('groups the held sessions', () => {
    const h = harness([
      session({ sessionId: 'a', cwd: '/work/repo', gitBranch: 'main' }),
      session({ sessionId: 'b', cwd: '/work/repo', gitBranch: 'feat' })
    ])
    const tree = h.manager.getTree()
    expect(tree).toHaveLength(1)
    expect(tree[0].branches).toHaveLength(2)
  })
})
