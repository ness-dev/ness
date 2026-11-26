// The mobile client against a real headless server. This is the guard
// for "a server or desktop change that didn't consider the phone": it
// drives the app's own NessClient (WebSocket transport + shared reducer
// mirror + the desktop's typed buildBackend API), Fleet and list model —
// the same code paths the screens use — and checks what they produce.
//
// Needs the headless build: `npm run build:headless` at the repo root,
// then `npm run test:mobile:contract`. CI runs it after the headless smoke.
//
// Not covered: anything that needs a real Claude (starting a chat,
// streaming, approvals) — CI has no Claude auth.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { NessClient, chatTabsOf, tabsOf } from '../src/ness'
import { Fleet, listModelFor, mergedFor } from '../src/fleet'
import { newChatTab, firstLeafId, pickInitialTab } from '../src/tabs'
import { applyTheme, c, type ThemeInputs } from '../src/theme'
import type { AppState } from '../../src/shared/state'
import type { WorktreeListModel, WorktreeRowModel } from '../../src/renderer/worktree-list-model'
import WS from 'ws'

// Node < 22 has no global WebSocket (React Native does).
globalThis.WebSocket ??= WS as unknown as typeof WebSocket

const SERVER = resolve(__dirname, '../../dist-headless/main/index.js')
const TOKEN = 'mobile-contract-token'

let tmp: string
let repo: string
let server: ChildProcess | undefined
let serverLog = ''
let client: NessClient
let fleet: Fleet

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/** Resolve once `pred` holds for the client's state (checked on every
 *  state change), or fail with the server log after `ms`. */
function until<T>(pred: (s: AppState) => T | undefined | false | null, what: string, ms = 15_000): Promise<T> {
  return new Promise((ok, fail) => {
    const check = (): boolean => {
      const v = pred(client.getState())
      if (v) {
        unsub()
        clearTimeout(timer)
        ok(v)
        return true
      }
      return false
    }
    const unsub = client.subscribe(() => void check())
    const timer = setTimeout(() => {
      unsub()
      fail(new Error(`timed out waiting for ${what}\n--- server log ---\n${serverLog.slice(-4000)}`))
    }, ms)
    check()
  })
}

const NO_COLLAPSE = { unifiedRepos: false, isGroupCollapsed: () => false, pinnedOpenRepos: {} }
const model = (): WorktreeListModel => {
  const entries = fleet.getEntries()
  return listModelFor(entries, mergedFor(entries), NO_COLLAPSE, null)
}
function rows(m: WorktreeListModel): WorktreeRowModel[] {
  const out: WorktreeRowModel[] = []
  const walk = (v: unknown): void => {
    if (!v || typeof v !== 'object') return
    if (Array.isArray(v)) return v.forEach(walk)
    const o = v as Record<string, unknown>
    if (typeof o.path === 'string' && o.worktree && typeof o.worktree === 'object') out.push(o as unknown as WorktreeRowModel)
    else Object.values(o).forEach(walk)
  }
  walk(m)
  return out
}
const rowFor = (path: string): WorktreeRowModel | undefined => rows(model()).find((r) => r.path === path)

beforeAll(async () => {
  if (!existsSync(SERVER)) throw new Error(`${SERVER} missing — run \`npm run build:headless\` at the repo root first`)
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ness-mobile-contract-')))
  repo = join(tmp, 'demo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'contract@example.invalid')
  git(repo, 'config', 'user.name', 'Contract')
  writeFileSync(join(repo, 'README.md'), '# demo\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'init')

  mkdirSync(join(tmp, 'home'))
  server = spawn(process.execPath, [SERVER, '--host', '127.0.0.1', '--port', '0'], {
    // A throwaway HOME and data dir: the server never sees the developer's
    // real config, tokens or ~/.claude.
    env: { ...process.env, HOME: join(tmp, 'home'), HARNESS_DATA_DIR: join(tmp, 'data'), HARNESS_AUTH_TOKEN: TOKEN, GITHUB_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const port = await new Promise<number>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`server didn't start\n${serverLog}`)), 30_000)
    const onData = (b: Buffer): void => {
      serverLog += b.toString()
      const m = /listening on ws:\/\/[^\s:]+:(\d+)/.exec(serverLog)
      if (m) {
        clearTimeout(timer)
        ok(Number(m[1]))
      }
    }
    server!.stdout!.on('data', onData)
    server!.stderr!.on('data', onData)
    server!.on('exit', (code) => fail(new Error(`server exited (${code})\n${serverLog}`)))
  })

  client = new NessClient('contract', 'Contract', `ws://127.0.0.1:${port}/`, TOKEN)
  fleet = new Fleet()
  fleet.setClients([client])
  client.connect()
})

afterAll(async () => {
  client?.close()
  if (server && server.exitCode === null) {
    const exited = new Promise((ok) => server!.once('exit', ok))
    server.kill('SIGTERM')
    await Promise.race([exited, new Promise((ok) => setTimeout(ok, 5000))])
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
})

describe('mobile client ↔ headless server', () => {
  it('connects and mirrors the snapshot', async () => {
    await until((s) => client.getConn().hasSnapshot && s, 'snapshot')
    expect(client.getConn().connected).toBe(true)
    expect(fleet.getEntries()).toHaveLength(1)
  })

  it("themes from the server's settings", () => {
    const st = client.getState().settings
    const inputs: ThemeInputs = {
      themeMode: st.themeMode,
      themeLight: st.themeLight,
      themeDark: st.themeDark,
      customThemes: st.customThemes,
      nessieColor: st.nessieColor,
      systemScheme: 'dark'
    }
    applyTheme(inputs)
    expect(c.app).toMatch(/^#|^rgb/)
    expect(c.brand).toMatch(/^#|^rgb/)
  })

  it('lists a repo added on the server in the worktree picker', async () => {
    const res = await client.api.addRepoAtPath(repo)
    expect(res).toBeTruthy()
    await until(() => rowFor(repo), 'main worktree row')
    const row = rowFor(repo)!
    expect(row.worktree.isMain).toBe(true)
    expect(row.worktree.branch).toBe('main')
  })

  it('shows aliases, pins and snoozes set through the API', async () => {
    await client.api.setAlias(repo, 'Contract Alias')
    await until(() => rowFor(repo)?.alias === 'Contract Alias', 'alias on the row')

    await client.api.pinWorktree(repo)
    await until(() => rowFor(repo)?.isPinned, 'pinned row')
    await client.api.unpinWorktree(repo)
    await until(() => rowFor(repo) && !rowFor(repo)!.isPinned, 'unpinned row')

    await client.api.clearAlias(repo)
    await until(() => rowFor(repo) && !rowFor(repo)!.alias, 'alias cleared')
  })

  it('picks up a worktree created outside Ness and removes it', async () => {
    const wt = join(tmp, 'demo-feature')
    git(repo, 'worktree', 'add', '-q', '-b', 'feature/contract', wt)
    await client.api.refreshWorktreesList()
    await until(() => rowFor(wt), 'new worktree row')
    expect(rowFor(wt)!.worktree.branch).toBe('feature/contract')

    await client.api.snooze(wt, Date.now() + 86_400_000)
    await until(() => rowFor(wt)?.isSnoozed, 'snoozed row')
    await client.api.unsnooze(wt)
    await until(() => rowFor(wt) && !rowFor(wt)!.isSnoozed, 'woken row')

    await client.api.removeWorktree(repo, wt)
    await until(() => !rowFor(wt) && !existsSync(wt), 'worktree removed', 30_000)
  })

  it('initialises panes the phone can open, and adds a Chat tab', async () => {
    await client.api.panesEnsureInitialized(repo)
    const tree = await until((s) => s.terminals.panes[repo], 'pane tree')
    const tabs = tabsOf(tree)
    expect(tabs.length).toBeGreaterThan(0)
    expect(pickInitialTab(tabs)).not.toBeNull()

    const tab = newChatTab()
    await client.api.panesAddTab(repo, tab, firstLeafId(tree))
    await until((s) => chatTabsOf(s, repo).some((t) => t.id === tab.id && t.sessionId === tab.sessionId), 'chat tab')
    // A never-started session has no transcript; the chat view relies on
    // an empty list here, not an error.
    expect(await client.api.getJsonClaudeEntries(tab.sessionId!)).toEqual([])
  })

  it('serves the tools panel data', async () => {
    writeFileSync(join(repo, 'NEW.md'), 'hi\n')
    const changed = await client.api.getChangedFiles(repo, 'working')
    expect(changed.map((f) => f.path)).toContain('NEW.md')
    expect(await client.api.listAllFiles(repo)).toContain('README.md')
    expect(Array.isArray(await client.api.getBranchCommits(repo))).toBe(true)
    expect(Array.isArray(await client.api.listTools(repo))).toBe(true)

    await client.api.setScratchpadText(repo, 'note from the phone')
    await until((s) => s.scratchpad.byWorktreePath[repo] === 'note from the phone', 'scratchpad text')
  })
})
