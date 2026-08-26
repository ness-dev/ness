import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { basename, join, resolve, relative, isAbsolute } from 'path'
import {
  existsSync,
  mkdirSync,
  statSync,
  lstatSync,
  symlinkSync,
  unlinkSync,
  readFileSync,
  writeFileSync
} from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { log } from './debug'
import { perfLog } from './perf-log'
import { resolveUserShell, loginShellCommandArgs } from './user-shell'
import { detectInProgressOp } from './git-ops-state'
import { cachedGitRead } from './git-poll-cache'
import type { Worktree } from '../shared/state/worktrees'

const execFileAsync = promisify(execFile)

type ExecOpts = NonNullable<Parameters<typeof execFileAsync>[2]>

/** `status` and `diff` opportunistically refresh *and write* the index, which
 * takes .git/index.lock — so a background poll can make a rebase running in the
 * same worktree's PTY fail with "Unable to create index.lock: File exists".
 * GIT_OPTIONAL_LOCKS=0 skips the write-back; output is unchanged. Built per
 * call rather than hoisted: path-fix.ts merges into process.env.PATH at boot,
 * and a module-level snapshot could capture the pre-merge value. */
function readOnlyGitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
}

async function tracedExec(
  args: string[],
  opts: ExecOpts
): Promise<{ stdout: string; execMs: number; outputBytes: number }> {
  const t0 = performance.now()
  const { stdout } = await execFileAsync('git', args, { env: readOnlyGitEnv(), ...opts })
  const execMs = performance.now() - t0
  const text = typeof stdout === 'string' ? stdout : stdout.toString()
  return { stdout: text, execMs, outputBytes: text.length }
}

// Alias so existing imports of WorktreeInfo keep working; the canonical
// shape now lives in src/shared/state/worktrees.ts.
export type WorktreeInfo = Worktree

function getCreatedAt(path: string): number {
  try {
    const s = statSync(path)
    return s.birthtimeMs || s.ctimeMs || 0
  } catch {
    return 0
  }
}

/** Get a sensible default directory for worktrees: <repo>-worktrees/ alongside the repo */
export function defaultWorktreeDir(repoRoot: string): string {
  const repoName = basename(repoRoot)
  return join(repoRoot, '..', `${repoName}-worktrees`)
}

/** Pure `git worktree list --porcelain` parser. Extracted from
 *  listWorktrees so the prunable-handling logic can be unit-tested
 *  without shelling out. See the porcelain format docs:
 *  https://git-scm.com/docs/git-worktree#_porcelain_format. */
export function parseWorktreeListPorcelain(
  stdout: string,
  repoRoot: string
): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = []
  let current: Partial<WorktreeInfo> = {}
  const flush = (): void => {
    if (!current.path) return
    worktrees.push({
      path: current.path,
      branch: current.branch || '(detached)',
      head: current.head || '',
      isBare: current.isBare || false,
      isMain: current.path === repoRoot,
      createdAt: getCreatedAt(current.path),
      repoRoot,
      ...(current.prunable ? { prunable: true } : {}),
      ...(current.prunableReason ? { prunableReason: current.prunableReason } : {})
    })
    current = {}
  }
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      current.path = line.slice('worktree '.length)
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length)
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace('refs/heads/', '')
    } else if (line === 'bare') {
      current.isBare = true
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      // `prunable` marks entries whose on-disk directory was deleted
      // without a subsequent `git worktree prune`. Value form is
      // `prunable <reason>` (e.g. "gitdir file points to non-existent
      // location"); bare `prunable` also occurs.
      current.prunable = true
      const rest = line.slice('prunable'.length).trim()
      if (rest) current.prunableReason = rest
    } else if (line === '') {
      flush()
    }
  }
  // Trailing entry without a blank line — git doesn't always emit a
  // terminal blank on the last record.
  flush()
  return worktrees
}

export async function listWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
  const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoRoot
  })

  const worktrees = parseWorktreeListPorcelain(stdout, repoRoot)

  const detached = worktrees.filter((w) => w.branch === '(detached)' && !w.isBare)
  if (detached.length > 0) {
    const ops = await Promise.all(detached.map((w) => detectInProgressOp(w.path).catch(() => null)))
    detached.forEach((w, i) => {
      const op = ops[i]
      if (op) w.branch = op.label
    })
  }

  return worktrees
}

/** Fetch a PR's head ref into a named local branch. Force so a
 *  re-opened review picks up new commits without complaining about
 *  non-fast-forward.
 *
 *  Also points `refs/remotes/origin/<localBranch>` at the fetched SHA
 *  so the unpushed-commit detector (which reads `origin/<branch>` to
 *  figure out what's been published) treats the PR head as the
 *  upstream of record. Without this, every commit in a PR-review
 *  worktree shows up as "unpushed" in the Commits sidebar. */
export async function fetchPullRequestRef(
  repoRoot: string,
  prNumber: number,
  localBranch: string
): Promise<void> {
  log('worktree', `fetching pull/${prNumber}/head into ${localBranch}`)
  await execFileAsync(
    'git',
    ['fetch', 'origin', `+refs/pull/${prNumber}/head:refs/heads/${localBranch}`],
    { cwd: repoRoot }
  )
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--verify', `refs/heads/${localBranch}`],
      { cwd: repoRoot }
    )
    const sha = stdout.trim()
    if (sha) {
      await execFileAsync(
        'git',
        ['update-ref', `refs/remotes/origin/${localBranch}`, sha],
        { cwd: repoRoot }
      )
    }
  } catch (err) {
    // Best-effort. The worst case is the Commits sidebar mislabels
    // existing PR commits as unpushed — annoying but not blocking.
    log(
      'worktree',
      `failed to update remote-tracking ref for ${localBranch}`,
      err instanceof Error ? err.message : err
    )
  }
}

/** True if a local branch with this name already exists in the repo. */
export async function localBranchExists(repoRoot: string, branchName: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`], {
      cwd: repoRoot
    })
    return true
  } catch {
    return false
  }
}

export async function listBranches(repoRoot: string): Promise<string[]> {
  // Local branches only. Remote-tracking refs (`origin/*`) are intentionally
  // excluded — hundreds of remote branches make the picker UI unusable. Users
  // who need a remote ref can type it into the Ref tab on the New worktree
  // screen.
  const { stdout } = await execFileAsync(
    'git',
    ['branch', '--format=%(refname:short)'],
    { cwd: repoRoot }
  )
  return stdout.trim().split('\n').filter(Boolean)
}

export interface BranchInventoryEntry {
  name: string
  lastCommitMs: number
  /** Worktree this branch is already checked out in, or null if free. */
  checkedOutAt: string | null
  merged: boolean
}

/** Every local branch with the three facts the repo-import picker needs, in
 *  two git calls rather than three per branch — on a real repo this is 461
 *  branches, so a per-branch `git log` would be 461 subprocesses.
 *
 *  `merged` is ancestor-of-base, which catches fast-forward and merge-commit
 *  landings but NOT squash or rebase merges (both rewrite the SHA, so the
 *  original branch tip is no longer reachable from base). On a rebase-merging
 *  repo it found 57 of 461 branches. That gap is why the import picker treats
 *  merged as a badge and recency as the actual default-selection signal. */
export async function listBranchInventory(repoRoot: string): Promise<BranchInventoryEntry[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['for-each-ref', '--format=%(refname:short)\t%(committerdate:unix)\t%(worktreepath)', 'refs/heads'],
    { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 }
  )

  const merged = new Set<string>()
  try {
    const base = await getDefaultBaseRef(repoRoot)
    if (base !== 'HEAD') {
      const { stdout: mergedOut } = await execFileAsync(
        'git',
        ['branch', '--merged', base, '--format=%(refname:short)'],
        { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 }
      )
      for (const name of mergedOut.split('\n')) {
        const trimmed = name.trim()
        if (trimmed) merged.add(trimmed)
      }
      // A branch is an ancestor of itself, so the base always comes back in
      // its own merged list. Left in, `main` reads as landed work and the
      // import picker's "hide merged" default drops the one branch users
      // look for first.
      merged.delete(base.startsWith('origin/') ? base.slice('origin/'.length) : base)
    }
  } catch {
    // No resolvable base (no remote, fresh repo). Every branch reads as
    // unmerged, which is the safe direction: nothing gets deselected.
  }

  const entries: BranchInventoryEntry[] = []
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const [name, date, worktreePath] = line.split('\t')
    if (!name) continue
    entries.push({
      name,
      lastCommitMs: Number(date) * 1000 || 0,
      checkedOutAt: worktreePath || null,
      merged: merged.has(name)
    })
  }
  return entries
}

export interface AddWorktreeOptions {
  /** Explicit base branch to fork from. Overrides fetchRemote detection. */
  baseBranch?: string
  /** If true, fetch the default branch from origin before creating so the
   * new worktree starts at the tip of the latest remote main. Falls back
   * to local HEAD if the fetch fails (e.g. offline). */
  fetchRemote?: boolean
  /** When set, skip `-b` and check out the named branch as-is. Used by
   * the open-PR flow, where the local branch was already created by a
   * `git fetch origin pull/<N>/head:pr-<N>` ahead of this call. */
  checkoutExisting?: boolean
}

/**
 * Resolve a base ref to fork/branch from, optionally fetching origin first.
 * Matches the same logic addWorktree and continueWorktree share:
 * explicit baseBranch wins; else if fetchRemote, fetch origin's default
 * branch and use origin/<default>; else return undefined (caller uses HEAD).
 */
async function resolveBaseRef(
  repoRoot: string,
  options: { baseBranch?: string; fetchRemote?: boolean }
): Promise<string | undefined> {
  if (options.baseBranch) return options.baseBranch
  if (!options.fetchRemote) return undefined
  try {
    const defaultRef = await getDefaultBaseRef(repoRoot)
    const remoteBranch = defaultRef.startsWith('origin/')
      ? defaultRef.slice('origin/'.length)
      : defaultRef
    if (remoteBranch && remoteBranch !== 'HEAD') {
      log('worktree', `fetching origin ${remoteBranch}`)
      await execFileAsync('git', ['fetch', '--quiet', 'origin', remoteBranch], { cwd: repoRoot })
    }
    const resolvedRef = await getDefaultBaseRef(repoRoot)
    if (resolvedRef && resolvedRef !== 'HEAD') return resolvedRef
  } catch (err) {
    log('worktree', `remote fetch failed, falling back to local HEAD`, err instanceof Error ? err.message : err)
  }
  return undefined
}

export async function addWorktree(
  repoRoot: string,
  worktreeDir: string,
  branchName: string,
  options: AddWorktreeOptions = {}
): Promise<WorktreeInfo> {
  // Ensure worktree directory exists
  if (!existsSync(worktreeDir)) {
    mkdirSync(worktreeDir, { recursive: true })
  }

  const worktreePath = join(worktreeDir, branchName)

  if (options.checkoutExisting) {
    log('worktree', `creating worktree from existing branch: branch=${branchName} path=${worktreePath}`)
    await execFileAsync('git', ['worktree', 'add', worktreePath, branchName], {
      cwd: repoRoot
    })
  } else {
    const baseRef = await resolveBaseRef(repoRoot, options)

    log('worktree', `creating worktree: branch=${branchName} path=${worktreePath} base=${baseRef || 'HEAD'}`)

    const args = ['worktree', 'add', worktreePath, '-b', branchName]
    if (baseRef) {
      args.push(baseRef)
    }

    try {
      await execFileAsync('git', args, { cwd: repoRoot })
    } catch (err) {
      // If branch already exists, try checking it out instead of creating
      if (err instanceof Error && err.message.includes('already exists')) {
        await execFileAsync('git', ['worktree', 'add', worktreePath, branchName], {
          cwd: repoRoot
        })
      } else {
        throw err
      }
    }
  }

  const trees = await listWorktrees(repoRoot)
  const created = trees.find((t) => t.path === worktreePath)
  if (!created) throw new Error(`Failed to create worktree ${branchName}`)
  return created
}

export interface ContinueWorktreeResult {
  worktree: WorktreeInfo
  /** Dirty files were stashed and successfully re-applied. */
  stashReapplied: boolean
  /** Dirty files are still in the stash because pop conflicted. */
  stashConflict: boolean
}

/**
 * Reuse an existing worktree path and re-point it at a brand new branch
 * forked from the repo's default base (optionally fetching origin first).
 * If the worktree has uncommitted changes, they are stashed before the
 * checkout and popped afterward so the user's in-progress work carries
 * over to the fresh branch.
 */
export async function continueWorktree(
  repoRoot: string,
  worktreePath: string,
  newBranchName: string,
  options: AddWorktreeOptions = {}
): Promise<ContinueWorktreeResult> {
  const baseRef = await resolveBaseRef(repoRoot, options)
  log(
    'worktree',
    `continuing worktree: path=${worktreePath} newBranch=${newBranchName} base=${baseRef || 'HEAD'}`
  )

  const dirty = await isWorktreeDirty(worktreePath)
  let stashed = false
  if (dirty) {
    const stashMsg = `harness-continue ${newBranchName} ${Date.now()}`
    await execFileAsync('git', ['stash', 'push', '--include-untracked', '-m', stashMsg], {
      cwd: worktreePath
    })
    stashed = true
  }

  const checkoutArgs = ['checkout', '-b', newBranchName]
  if (baseRef) checkoutArgs.push(baseRef)

  try {
    await execFileAsync('git', checkoutArgs, { cwd: worktreePath })
  } catch (err) {
    if (stashed) {
      // Best-effort: try to restore dirty state so user isn't stranded
      try {
        await execFileAsync('git', ['stash', 'pop'], { cwd: worktreePath })
      } catch {}
    }
    throw err
  }

  let stashReapplied = false
  let stashConflict = false
  if (stashed) {
    try {
      await execFileAsync('git', ['stash', 'pop'], { cwd: worktreePath })
      stashReapplied = true
    } catch {
      // Pop left changes in a conflict state; stash entry is preserved.
      stashConflict = true
    }
  }

  const trees = await listWorktrees(repoRoot)
  const updated = trees.find((t) => t.path === worktreePath)
  if (!updated) throw new Error(`Failed to locate worktree ${worktreePath} after continue`)
  return { worktree: updated, stashReapplied, stashConflict }
}

/** Check if a worktree has uncommitted changes */
export async function isWorktreeDirty(path: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: path,
      env: readOnlyGitEnv()
    })
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

export interface ChangedFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
  staged: boolean
  /** Lines added. Undefined for binary files (numstat reports `-`) and
   * untracked files (no diff baseline yet). */
  additions?: number
  /** Lines deleted. Undefined for binary files and untracked files. */
  deletions?: number
}

export type ChangedFilesMode = 'working' | 'branch'

const BASE_REF_TTL_MS = 5 * 60 * 1000
const baseRefCache = new Map<string, { ref: string; at: number }>()

/** Detect the repo's default base branch (e.g. "main" or "master").
 *
 * Memoized because the polled panels call this twice per tick and it costs up
 * to five git spawns (symbolic-ref, then a rev-parse per candidate) to answer
 * a question whose answer effectively never changes. The 'HEAD' fallback is
 * deliberately not cached — it means nothing resolved yet, which is the state
 * a fresh worktree is in mid-setup, and it flips as soon as the remote lands. */
export async function getDefaultBaseRef(worktreePath: string): Promise<string> {
  const hit = baseRefCache.get(worktreePath)
  if (hit && Date.now() - hit.at < BASE_REF_TTL_MS) return hit.ref

  const ref = await resolveDefaultBaseRef(worktreePath)
  if (ref !== 'HEAD') baseRefCache.set(worktreePath, { ref, at: Date.now() })
  return ref
}

async function resolveDefaultBaseRef(worktreePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      { cwd: worktreePath }
    )
    const ref = stdout.trim()
    if (ref) return ref
  } catch {}
  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    try {
      await execFileAsync('git', ['rev-parse', '--verify', candidate], { cwd: worktreePath })
      return candidate
    } catch {}
  }
  return 'HEAD'
}

export interface BranchCommit {
  hash: string
  shortHash: string
  subject: string
  author: string
  relativeDate: string
  timestamp: number
  pushed: boolean
}

const COMMIT_FIELD_SEP = '\x1f'
const COMMIT_RECORD_SEP = '\x1e'

export const BRANCH_COMMIT_PRETTY_FORMAT =
  `format:%H${COMMIT_FIELD_SEP}%h${COMMIT_FIELD_SEP}%s${COMMIT_FIELD_SEP}%an${COMMIT_FIELD_SEP}%ar${COMMIT_FIELD_SEP}%at${COMMIT_RECORD_SEP}`

export function parseBranchCommitLog(
  stdout: string,
  unpushed: Set<string> | null
): BranchCommit[] {
  const result: BranchCommit[] = []
  for (const record of stdout.split(COMMIT_RECORD_SEP)) {
    const line = record.trim()
    if (!line) continue
    const parts = line.split(COMMIT_FIELD_SEP)
    if (parts.length < 6) continue
    const [hash, shortHash, subject, author, relativeDate, ts] = parts
    const pushed = unpushed === null ? false : !unpushed.has(hash)
    result.push({
      hash,
      shortHash,
      subject,
      author,
      relativeDate,
      timestamp: Number(ts) || 0,
      pushed
    })
  }
  return result
}

/** Hashes of commits on this branch not yet reachable from origin/<branch>.
 * Empty set if the branch has no remote tracking ref (all commits are local). */
async function getUnpushedHashes(worktreePath: string): Promise<Set<string> | null> {
  const branch = await getCurrentBranch(worktreePath)
  if (!branch) return null
  const remoteRef = `refs/remotes/origin/${branch}`
  try {
    await execFileAsync('git', ['rev-parse', '--verify', '--quiet', remoteRef], {
      cwd: worktreePath
    })
  } catch {
    return null
  }
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['log', `origin/${branch}..HEAD`, '--pretty=format:%H', '--max-count=500'],
      { cwd: worktreePath }
    )
    return new Set(stdout.split('\n').filter(Boolean))
  } catch {
    return new Set()
  }
}

/** Get commits unique to this branch (i.e. base..HEAD). */
export async function getBranchCommits(worktreePath: string): Promise<BranchCommit[]> {
  const { value } = await cachedGitRead<BranchCommit[]>({
    key: `${worktreePath}\x00commits`,
    worktreePath,
    fingerprintable: true,
    baseRef: await getDefaultBaseRef(worktreePath),
    read: () => getBranchCommitsImpl(worktreePath)
  })
  return value
}

async function getBranchCommitsImpl(worktreePath: string): Promise<BranchCommit[]> {
  const t0 = performance.now()
  let walledExec = 0
  let cumExec = 0
  let outputBytes = 0
  const execParts: number[] = []
  let result: BranchCommit[] = []

  const tBase = performance.now()
  const base = await getDefaultBaseRef(worktreePath)
  const baseMs = performance.now() - tBase
  walledExec += baseMs
  cumExec += baseMs
  execParts.push(baseMs)

  if (base !== 'HEAD') {
    try {
      const tA = performance.now()
      const [logRes, unpushed] = await Promise.all([
        tracedExec(
          [
            'log',
            `${base}..HEAD`,
            `--pretty=${BRANCH_COMMIT_PRETTY_FORMAT}`,
            '--max-count=200'
          ],
          { cwd: worktreePath }
        ),
        getUnpushedHashes(worktreePath)
      ])
      walledExec += performance.now() - tA
      cumExec += logRes.execMs
      execParts.push(logRes.execMs)
      outputBytes += logRes.outputBytes

      result = parseBranchCommitLog(logRes.stdout, unpushed)
    } catch {
      result = []
    }
  }

  logGitOp('getBranchCommits', {}, t0, walledExec, cumExec, outputBytes, execParts)
  return result
}

function mapNameStatus(code: string): ChangedFile['status'] {
  const c = code[0]
  if (c === 'A') return 'added'
  if (c === 'D') return 'deleted'
  if (c === 'R') return 'renamed'
  if (c === 'C') return 'renamed'
  return 'modified'
}

type NumstatCounts = { additions: number; deletions: number } | null

/** Parse `git diff --numstat -z` output. Rename rows look like
 * `add\tdel\t\0oldpath\0newpath\0` and are keyed by the destination path.
 * Binary files report `-` for both counts and map to null. */
function parseNumstatZ(stdout: string): Map<string, NumstatCounts> {
  const map = new Map<string, NumstatCounts>()
  const tokens = stdout.split('\0')
  let i = 0
  while (i < tokens.length) {
    const tok = tokens[i]
    if (!tok) { i++; continue }
    const tabs = tok.split('\t')
    if (tabs.length < 3) { i++; continue }
    const [addStr, delStr, pathField] = tabs
    const counts: NumstatCounts =
      addStr === '-' || delStr === '-'
        ? null
        : { additions: Number(addStr), deletions: Number(delStr) }
    if (pathField === '') {
      // Rename: next two NUL-separated tokens are old then new path.
      const newPath = tokens[i + 2] ?? ''
      if (newPath) map.set(newPath, counts)
      i += 3
    } else {
      map.set(pathField, counts)
      i++
    }
  }
  return map
}

/** `command` exists because GIT_OPTIONAL_LOCKS=0 does not cover every form of
 * `git diff`. It suppresses the index write-back for `status` and for
 * `diff --cached`, but the unstaged worktree-vs-index `git diff` refreshes and
 * writes the index anyway (git 2.50.1). That write lands in the gitdir
 * WorktreeWatcher watches, and `index` is in CHANGED_FILES_RELEVANT — so the
 * changed-files read retriggers its own invalidation, doubling the git work
 * behind every edit. `diff-files` is the plumbing equivalent of that one form
 * and does no opportunistic refresh, so the unstaged call uses it instead. */
async function numstatExec(
  worktreePath: string,
  args: string[],
  command: 'diff' | 'diff-files' = 'diff'
): Promise<{ stdout: string; execMs: number; outputBytes: number }> {
  try {
    return await tracedExec([command, '--numstat', '-z', ...args], {
      cwd: worktreePath,
      maxBuffer: 16 * 1024 * 1024
    })
  } catch {
    return { stdout: '', execMs: 0, outputBytes: 0 }
  }
}

// These fire on every panel refresh for every worktree — thousands per minute
// in a busy session. Tracing all of them made the log (and its writes) a
// bigger cost than the thing being traced, so both are gated the same way
// every other perf category is: only the slow ones are worth a line.
const SLOW_GIT_OP_MS = 50
const SLOW_CHANGED_FILES_MS = 50

function logGitOp(
  name: string,
  ctx: Record<string, unknown>,
  t0: number,
  walledExec: number,
  cumExec: number,
  outputBytes: number,
  execParts: number[]
): void {
  const total = performance.now() - t0
  const postMs = Math.max(0, total - walledExec)
  if (cumExec < SLOW_GIT_OP_MS && total < SLOW_GIT_OP_MS) return
  perfLog(
    'git-op',
    `${name} exec=${cumExec.toFixed(0)}ms post=${postMs.toFixed(0)}ms bytes=${outputBytes}`,
    {
      name,
      ...ctx,
      execMs: +cumExec.toFixed(1),
      postMs: +postMs.toFixed(1),
      outputBytes,
      execParts: execParts.map((n) => +n.toFixed(1))
    }
  )
}

/** Renamed entries from `git status --porcelain` are stored as
 * "old -> new" — match numstat by the destination path. */
function destOf(p: string): string {
  const idx = p.indexOf(' -> ')
  return idx >= 0 ? p.slice(idx + 4) : p
}

function applyCounts(file: ChangedFile, counts: NumstatCounts | undefined): void {
  if (!counts) return
  file.additions = counts.additions
  file.deletions = counts.deletions
}

/** Get changed files (staged, unstaged, and untracked) in a worktree */
export async function getChangedFiles(
  worktreePath: string,
  mode: ChangedFilesMode = 'working'
): Promise<ChangedFile[]> {
  const t0 = performance.now()
  const { value, cached } = await cachedGitRead<ChangedFile[]>({
    key: `${worktreePath}\x00changed:${mode}`,
    worktreePath,
    fingerprintable: mode === 'branch',
    baseRef: mode === 'branch' ? await getDefaultBaseRef(worktreePath) : null,
    read: () => getChangedFilesImpl(worktreePath, mode)
  })
  const ms = performance.now() - t0
  if (ms >= SLOW_CHANGED_FILES_MS) {
    perfLog(
      'changed-files',
      `mode=${mode} path=${basename(worktreePath)} took=${ms.toFixed(0)}ms files=${value.length}${cached ? ' cached' : ''}`,
      { worktreePath, mode, ms: +ms.toFixed(1), fileCount: value.length, cached }
    )
  }
  return value
}

async function getChangedFilesImpl(
  worktreePath: string,
  mode: ChangedFilesMode
): Promise<ChangedFile[]> {
  const t0 = performance.now()
  let walledExec = 0
  let cumExec = 0
  let outputBytes = 0
  const execParts: number[] = []
  let result: ChangedFile[] = []

  if (mode === 'branch') {
    const tBase = performance.now()
    const base = await getDefaultBaseRef(worktreePath)
    const baseMs = performance.now() - tBase
    walledExec += baseMs
    cumExec += baseMs
    execParts.push(baseMs)

    if (base !== 'HEAD') {
      try {
        const tA = performance.now()
        const [diff, ns] = await Promise.all([
          tracedExec(['diff', '--name-status', `${base}...HEAD`], { cwd: worktreePath }),
          numstatExec(worktreePath, [`${base}...HEAD`])
        ])
        walledExec += performance.now() - tA
        cumExec += diff.execMs + ns.execMs
        execParts.push(diff.execMs, ns.execMs)
        outputBytes += diff.outputBytes + ns.outputBytes

        const counts = parseNumstatZ(ns.stdout)
        for (const line of diff.stdout.split('\n')) {
          if (!line) continue
          const parts = line.split('\t')
          const code = parts[0]
          const filePath = parts[parts.length - 1]
          const file: ChangedFile = { path: filePath, status: mapNameStatus(code), staged: false }
          applyCounts(file, counts.get(filePath))
          result.push(file)
        }
      } catch {
        result = []
      }
    }
  } else {
    try {
      const tA = performance.now()
      const [status, stagedNs, unstagedNs] = await Promise.all([
        tracedExec(['status', '--porcelain', '-uall'], { cwd: worktreePath }),
        numstatExec(worktreePath, ['--cached']),
        numstatExec(worktreePath, [], 'diff-files')
      ])
      walledExec += performance.now() - tA
      cumExec += status.execMs + stagedNs.execMs + unstagedNs.execMs
      execParts.push(status.execMs, stagedNs.execMs, unstagedNs.execMs)
      outputBytes += status.outputBytes + stagedNs.outputBytes + unstagedNs.outputBytes

      const stagedCounts = parseNumstatZ(stagedNs.stdout)
      const unstagedCounts = parseNumstatZ(unstagedNs.stdout)
      const seen = new Set<string>()
      for (const line of status.stdout.split('\n')) {
        if (!line) continue
        const x = line[0]
        const y = line[1]
        const filePath = line.slice(3)

        if (x !== ' ' && x !== '?') {
          const fStatus =
            x === 'A' ? 'added' : x === 'D' ? 'deleted' : x === 'R' ? 'renamed' : 'modified'
          const file: ChangedFile = { path: filePath, status: fStatus, staged: true }
          applyCounts(file, stagedCounts.get(destOf(filePath)))
          result.push(file)
          seen.add(filePath)
        }

        if (y !== ' ' && y !== '?') {
          const fStatus = y === 'D' ? 'deleted' : 'modified'
          if (!seen.has(filePath)) {
            const file: ChangedFile = { path: filePath, status: fStatus, staged: false }
            applyCounts(file, unstagedCounts.get(destOf(filePath)))
            result.push(file)
            seen.add(filePath)
          }
        }

        if (x === '?' && y === '?') {
          result.push({ path: filePath, status: 'untracked', staged: false })
        }
      }
    } catch {
      // status failure: fall through with empty result
    }
  }

  logGitOp('getChangedFiles', { mode }, t0, walledExec, cumExec, outputBytes, execParts)
  return result
}

export interface CommitMeta {
  hash: string
  shortHash: string
  author: string
  authorEmail: string
  date: string
  subject: string
  body: string
}

export interface CommitDiff extends CommitMeta {
  diff: string
}

/** Get a single commit's metadata (no diff). Cheap — one `git show -s`. */
export async function getCommitMeta(
  worktreePath: string,
  hash: string
): Promise<CommitMeta | null> {
  if (!/^[0-9a-fA-F]{4,64}$/.test(hash)) return null
  try {
    const sep = '\x1f'
    const end = '\x1e'
    const { stdout: meta } = await execFileAsync(
      'git',
      ['show', '-s', `--pretty=format:%H${sep}%h${sep}%an${sep}%ae${sep}%aI${sep}%s${sep}%b${end}`, hash],
      { cwd: worktreePath }
    )
    const cleaned = meta.endsWith(end) ? meta.slice(0, -1) : meta
    const [fullHash, shortHash, author, authorEmail, date, subject, body = ''] = cleaned.split(sep)
    return { hash: fullHash, shortHash, author, authorEmail, date, subject, body }
  } catch {
    return null
  }
}

/** Get a single commit's metadata + full diff. */
export async function getCommitDiff(
  worktreePath: string,
  hash: string
): Promise<CommitDiff | null> {
  const meta = await getCommitMeta(worktreePath, hash)
  if (!meta) return null
  try {
    const { stdout: diff } = await execFileAsync(
      'git',
      ['show', '--no-color', '--pretty=format:', hash],
      { cwd: worktreePath, maxBuffer: 32 * 1024 * 1024 }
    )
    return { ...meta, diff: diff.replace(/^\n+/, '') }
  } catch {
    return null
  }
}

/** List full commit SHAs reachable from any ref, capped, for validating
 *  commit-SHA tokens printed in terminal output. `--all` covers local
 *  branches, tags, and remotes, so SHAs from `git log`, PR branches, etc.
 *  resolve; the cap keeps the payload bounded on large repos. */
export async function listRecentCommitShas(worktreePath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-list', '--all', '--max-count=10000'],
      { cwd: worktreePath, maxBuffer: 16 * 1024 * 1024 }
    )
    return stdout.split('\n').filter((l) => l.length > 0)
  } catch {
    return []
  }
}

export async function getCommitChangedFiles(
  worktreePath: string,
  hash: string
): Promise<ChangedFile[]> {
  const t0 = performance.now()
  const result = await getCommitChangedFilesImpl(worktreePath, hash)
  const ms = performance.now() - t0
  if (ms >= SLOW_CHANGED_FILES_MS) {
    perfLog(
      'changed-files',
      `mode=commit path=${basename(worktreePath)} took=${ms.toFixed(0)}ms files=${result.length}`,
      { worktreePath, mode: 'commit', hash, ms: +ms.toFixed(1), fileCount: result.length }
    )
  }
  return result
}

async function getCommitChangedFilesImpl(
  worktreePath: string,
  hash: string
): Promise<ChangedFile[]> {
  if (!/^[0-9a-fA-F]{4,64}$/.test(hash)) return []
  const t0 = performance.now()
  let walledExec = 0
  let cumExec = 0
  let outputBytes = 0
  const execParts: number[] = []
  let result: ChangedFile[] = []

  try {
    const tA = performance.now()
    const [nameStatus, ns] = await Promise.all([
      tracedExec(['diff-tree', '--no-commit-id', '-r', '--name-status', hash], {
        cwd: worktreePath
      }),
      numstatExec(worktreePath, [`${hash}^`, hash])
    ])
    walledExec += performance.now() - tA
    cumExec += nameStatus.execMs + ns.execMs
    execParts.push(nameStatus.execMs, ns.execMs)
    outputBytes += nameStatus.outputBytes + ns.outputBytes

    const counts = parseNumstatZ(ns.stdout)
    for (const line of nameStatus.stdout.split('\n')) {
      if (!line) continue
      const parts = line.split('\t')
      const code = parts[0]
      const filePath = parts[parts.length - 1]
      const file: ChangedFile = { path: filePath, status: mapNameStatus(code), staged: false }
      applyCounts(file, counts.get(filePath))
      result.push(file)
    }
  } catch {
    result = []
  }

  logGitOp('getCommitChangedFiles', { hash }, t0, walledExec, cumExec, outputBytes, execParts)
  return result
}

export async function getCommitRangeChangedFiles(
  worktreePath: string,
  fromHash: string,
  toHash: string
): Promise<ChangedFile[]> {
  const t0 = performance.now()
  if (
    !/^[0-9a-fA-F]{4,64}$/.test(fromHash) ||
    !/^[0-9a-fA-F]{4,64}$/.test(toHash)
  ) {
    return []
  }
  let walledExec = 0
  let cumExec = 0
  let outputBytes = 0
  const execParts: number[] = []
  let result: ChangedFile[] = []

  const range = `${fromHash}^..${toHash}`
  try {
    const tA = performance.now()
    const [nameStatus, ns] = await Promise.all([
      tracedExec(['diff', '--name-status', range], {
        cwd: worktreePath
      }),
      numstatExec(worktreePath, [range])
    ])
    walledExec += performance.now() - tA
    cumExec += nameStatus.execMs + ns.execMs
    execParts.push(nameStatus.execMs, ns.execMs)
    outputBytes += nameStatus.outputBytes + ns.outputBytes

    const counts = parseNumstatZ(ns.stdout)
    for (const line of nameStatus.stdout.split('\n')) {
      if (!line) continue
      const parts = line.split('\t')
      const code = parts[0]
      const filePath = parts[parts.length - 1]
      const file: ChangedFile = { path: filePath, status: mapNameStatus(code), staged: false }
      applyCounts(file, counts.get(filePath))
      result.push(file)
    }
  } catch {
    result = []
  }

  logGitOp('getCommitRangeChangedFiles', { fromHash, toHash }, t0, walledExec, cumExec, outputBytes, execParts)
  const rangeMs = performance.now() - t0
  if (rangeMs >= SLOW_CHANGED_FILES_MS) {
    perfLog(
      'changed-files',
      `mode=range path=${basename(worktreePath)} took=${rangeMs.toFixed(0)}ms files=${result.length}`,
      { worktreePath, mode: 'range', fromHash, toHash, ms: +rangeMs.toFixed(1), fileCount: result.length }
    )
  }
  return result
}

export async function getCommitRangeFileDiffSides(
  worktreePath: string,
  fromHash: string,
  toHash: string,
  filePath: string
): Promise<FileDiffSides> {
  if (
    !/^[0-9a-fA-F]{4,64}$/.test(fromHash) ||
    !/^[0-9a-fA-F]{4,64}$/.test(toHash)
  ) {
    return { original: '', modified: '', originalExists: false, modifiedExists: false, modifiedBinary: false }
  }
  const original = await getFileAtRef(worktreePath, `${fromHash}^`, filePath)
  const modified = await getFileAtRef(worktreePath, toHash, filePath)
  return {
    original: original ?? '',
    modified: modified ?? '',
    originalExists: original != null,
    modifiedExists: modified != null,
    modifiedBinary: false
  }
}

export async function getCommitFileDiffSides(
  worktreePath: string,
  hash: string,
  filePath: string
): Promise<FileDiffSides> {
  if (!/^[0-9a-fA-F]{4,64}$/.test(hash)) {
    return { original: '', modified: '', originalExists: false, modifiedExists: false, modifiedBinary: false }
  }
  const original = await getFileAtRef(worktreePath, `${hash}^`, filePath)
  const modified = await getFileAtRef(worktreePath, hash, filePath)
  return {
    original: original ?? '',
    modified: modified ?? '',
    originalExists: original != null,
    modifiedExists: modified != null,
    modifiedBinary: false
  }
}

/** Get the diff for a single file in a worktree */
export async function getFileDiff(
  worktreePath: string,
  filePath: string,
  staged: boolean,
  mode: ChangedFilesMode = 'working'
): Promise<string> {
  const t0 = performance.now()
  let walledExec = 0
  let cumExec = 0
  let outputBytes = 0
  const execParts: number[] = []
  let result = ''

  const finish = (): string => {
    logGitOp('getFileDiff', { mode, staged }, t0, walledExec, cumExec, outputBytes, execParts)
    return result
  }

  if (mode === 'branch') {
    const tBase = performance.now()
    const base = await getDefaultBaseRef(worktreePath)
    const baseMs = performance.now() - tBase
    walledExec += baseMs; cumExec += baseMs; execParts.push(baseMs)

    if (base === 'HEAD') return finish()
    try {
      const tA = performance.now()
      const r = await tracedExec(
        ['diff', '--no-color', `${base}...HEAD`, '--', filePath],
        { cwd: worktreePath }
      )
      walledExec += performance.now() - tA
      cumExec += r.execMs
      execParts.push(r.execMs)
      outputBytes += r.outputBytes
      result = r.stdout
    } catch {
      // ignore
    }
    return finish()
  }

  const args = ['diff', '--no-color']
  if (staged) args.push('--cached')
  args.push('--', filePath)

  try {
    const tA = performance.now()
    const r = await tracedExec(args, { cwd: worktreePath })
    walledExec += performance.now() - tA
    cumExec += r.execMs
    execParts.push(r.execMs)
    outputBytes += r.outputBytes
    if (r.stdout) {
      result = r.stdout
      return finish()
    }
  } catch {
    // diff may exit non-zero for some edge cases, fall through
  }

  // For untracked files, show the full file content as an "add" diff
  try {
    const tA = performance.now()
    const r = await tracedExec(
      ['diff', '--no-color', '--no-index', '/dev/null', filePath],
      { cwd: worktreePath }
    )
    walledExec += performance.now() - tA
    cumExec += r.execMs
    execParts.push(r.execMs)
    outputBytes += r.outputBytes
    result = r.stdout
  } catch (err) {
    // git diff --no-index exits with 1 when there are differences (which is always the case here)
    if (err instanceof Error && 'stdout' in err) {
      const out = (err as Error & { stdout: string }).stdout || ''
      outputBytes += out.length
      result = out
    }
  }
  return finish()
}

export interface FileDiffSides {
  original: string
  modified: string
  originalExists: boolean
  modifiedExists: boolean
  modifiedBinary: boolean
  error?: string
}

async function getFileAtRef(
  worktreePath: string,
  ref: string,
  filePath: string
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['show', `${ref}:${filePath}`], {
      cwd: worktreePath,
      maxBuffer: 16 * 1024 * 1024
    })
    return stdout
  } catch {
    return null
  }
}

async function getMergeBase(worktreePath: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['merge-base', ref, 'HEAD'], {
      cwd: worktreePath
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

/** Resolve the two sides of a single-file diff as plain text, suitable for
 * feeding Monaco's DiffEditor. Semantics match getFileDiff: working vs
 * index (unstaged), HEAD vs index (staged), merge-base vs HEAD (branch). */
export async function getFileDiffSides(
  worktreePath: string,
  filePath: string,
  staged: boolean,
  mode: ChangedFilesMode = 'working'
): Promise<FileDiffSides> {
  const t0 = performance.now()
  let walledExec = 0
  let cumExec = 0
  let outputBytes = 0
  const execParts: number[] = []

  const timed = async <T>(fn: () => Promise<T>): Promise<T> => {
    const tA = performance.now()
    const r = await fn()
    const ms = performance.now() - tA
    walledExec += ms
    cumExec += ms
    execParts.push(ms)
    return r
  }

  const finish = (sides: FileDiffSides): FileDiffSides => {
    logGitOp('getFileDiffSides', { mode, staged }, t0, walledExec, cumExec, outputBytes, execParts)
    return sides
  }

  if (mode === 'branch') {
    const baseRef = await timed(() => getDefaultBaseRef(worktreePath))
    if (baseRef === 'HEAD') {
      return finish({ original: '', modified: '', originalExists: false, modifiedExists: false, modifiedBinary: false })
    }
    const mb = await timed(() => getMergeBase(worktreePath, baseRef))
    const original = mb ? await timed(() => getFileAtRef(worktreePath, mb, filePath)) : null
    if (original) outputBytes += original.length
    const modified = await timed(() => getFileAtRef(worktreePath, 'HEAD', filePath))
    if (modified) outputBytes += modified.length
    return finish({
      original: original ?? '',
      modified: modified ?? '',
      originalExists: original != null,
      modifiedExists: modified != null,
      modifiedBinary: false
    })
  }

  if (staged) {
    const original = await timed(() => getFileAtRef(worktreePath, 'HEAD', filePath))
    if (original) outputBytes += original.length
    const modified = await timed(() => getFileAtRef(worktreePath, ':0', filePath))
    if (modified) outputBytes += modified.length
    return finish({
      original: original ?? '',
      modified: modified ?? '',
      originalExists: original != null,
      modifiedExists: modified != null,
      modifiedBinary: false
    })
  }

  let original = await timed(() => getFileAtRef(worktreePath, ':0', filePath))
  if (original == null) original = await timed(() => getFileAtRef(worktreePath, 'HEAD', filePath))
  if (original) outputBytes += original.length
  const read = await timed(() => readWorktreeFile(worktreePath, filePath))
  if (read.content) outputBytes += read.content.length
  if (read.binary) {
    return finish({
      original: original ?? '',
      modified: '',
      originalExists: original != null,
      modifiedExists: true,
      modifiedBinary: true
    })
  }
  return finish({
    original: original ?? '',
    modified: read.content ?? '',
    originalExists: original != null,
    modifiedExists: read.content != null,
    modifiedBinary: false,
    error: read.error
  })
}

export type MergeStrategy = 'squash' | 'merge-commit' | 'fast-forward'

export interface MainWorktreeStatus {
  path: string
  currentBranch: string
  baseBranch: string
  isOnBase: boolean
  isDirty: boolean
  /** True when the worktree is ready to accept a merge without any fixups */
  ready: boolean
}

/** Resolve the local base branch name (no remote prefix) — "main" or "master". */
async function getLocalBaseBranch(repoRoot: string): Promise<string> {
  const ref = await getDefaultBaseRef(repoRoot)
  const name = ref.startsWith('origin/') ? ref.slice('origin/'.length) : ref
  if (!name || name === 'HEAD') return 'main'
  return name
}

/** Get the current branch of a worktree, or empty string if detached. */
export async function getCurrentBranch(worktreePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], {
      cwd: worktreePath
    })
    return stdout.trim()
  } catch {
    return ''
  }
}

export type RenameBranchResult =
  | { ok: true; oldBranch: string; branch: string; renamed: boolean }
  | { ok: false; error: string }

/**
 * Rename the branch a worktree has checked out (`git branch -m`). The
 * directory on disk keeps its original name — it's the key every other
 * piece of Ness state (panes, aliases, terminal cwds, running PTYs) is
 * filed under, and `git worktree move` would pull it out from under an
 * agent that's mid-turn.
 *
 * Refuses once the branch has been pushed: `git branch -m` carries the
 * branch's config across, so the renamed local branch would still track
 * the old remote ref and quietly push there — which is how you detach a
 * PR from the branch it thinks it's watching.
 */
export async function renameWorktreeBranch(
  worktreePath: string,
  newBranch: string
): Promise<RenameBranchResult> {
  const oldBranch = await getCurrentBranch(worktreePath)
  if (!oldBranch) {
    return {
      ok: false,
      error: `${worktreePath} is in detached HEAD — there is no branch to rename`
    }
  }
  if (oldBranch === newBranch) {
    return { ok: true, oldBranch, branch: newBranch, renamed: false }
  }

  const upstream = await execFileAsync(
    'git',
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    { cwd: worktreePath }
  )
    .then(({ stdout }) => stdout.trim())
    .catch(() => '')
  if (upstream) {
    return {
      ok: false,
      error:
        `branch "${oldBranch}" is already published (tracking ${upstream}) — renaming it locally ` +
        `would leave it pushing to the old remote branch. Set a display alias instead.`
    }
  }

  try {
    await execFileAsync('git', ['branch', '-m', newBranch], { cwd: worktreePath })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      error: /already exists/i.test(message)
        ? `a branch named "${newBranch}" already exists in this repo`
        : message
    }
  }
  log('worktree', `renamed branch ${oldBranch} -> ${newBranch} in ${worktreePath}`)
  return { ok: true, oldBranch, branch: newBranch, renamed: true }
}

/** Report status of the main worktree for a local merge. */
export async function getMainWorktreeStatus(repoRoot: string): Promise<MainWorktreeStatus> {
  const t0 = performance.now()
  let walledExec = 0
  let cumExec = 0
  const execParts: number[] = []

  const t1 = performance.now()
  const trees = await listWorktrees(repoRoot)
  const ms1 = performance.now() - t1
  walledExec += ms1; cumExec += ms1; execParts.push(ms1)

  const main = trees.find((t) => t.isMain) || trees[0]
  const mainPath = main?.path || repoRoot

  const t2 = performance.now()
  const baseBranch = await getLocalBaseBranch(repoRoot)
  const ms2 = performance.now() - t2
  walledExec += ms2; cumExec += ms2; execParts.push(ms2)

  const t3 = performance.now()
  const currentBranch = await getCurrentBranch(mainPath)
  const ms3 = performance.now() - t3
  walledExec += ms3; cumExec += ms3; execParts.push(ms3)

  const t4 = performance.now()
  const isDirty = await isWorktreeDirty(mainPath)
  const ms4 = performance.now() - t4
  walledExec += ms4; cumExec += ms4; execParts.push(ms4)

  const isOnBase = currentBranch === baseBranch
  logGitOp('getMainWorktreeStatus', {}, t0, walledExec, cumExec, 0, execParts)
  return {
    path: mainPath,
    currentBranch,
    baseBranch,
    isOnBase,
    isDirty,
    ready: isOnBase && !isDirty
  }
}

/** Stash and/or checkout base in the main worktree so a merge can proceed.
 * Stashing is auto-labeled so the user can find it later via `git stash list`. */
export async function prepareMainForMerge(repoRoot: string): Promise<MainWorktreeStatus> {
  const status = await getMainWorktreeStatus(repoRoot)
  if (status.isDirty) {
    log('worktree', `stashing dirty changes in main worktree ${status.path}`)
    await execFileAsync(
      'git',
      ['stash', 'push', '--include-untracked', '-m', 'harness: auto-stash before local merge'],
      { cwd: status.path }
    )
  }
  if (!status.isOnBase) {
    log('worktree', `checking out ${status.baseBranch} in main worktree ${status.path}`)
    await execFileAsync('git', ['checkout', status.baseBranch], { cwd: status.path })
  }
  return getMainWorktreeStatus(repoRoot)
}

export interface MergeLocalResult {
  ok: true
  strategy: MergeStrategy
  mergedBranch: string
  baseBranch: string
  mainPath: string
}

/** Merge a worktree's branch into the local base branch inside the main worktree.
 * Requires the main worktree to already be on base and clean — caller should
 * run prepareMainForMerge first if needed. On conflict, aborts and throws. */
export async function mergeWorktreeLocally(
  repoRoot: string,
  sourceBranch: string,
  strategy: MergeStrategy
): Promise<MergeLocalResult> {
  const status = await getMainWorktreeStatus(repoRoot)
  if (!status.ready) {
    throw new Error(
      `Main worktree is not ready: ${status.isDirty ? 'has uncommitted changes' : `on ${status.currentBranch || 'detached HEAD'}, not ${status.baseBranch}`}`
    )
  }
  if (sourceBranch === status.baseBranch) {
    throw new Error(`Cannot merge ${sourceBranch} into itself`)
  }

  log('worktree', `merging ${sourceBranch} into ${status.baseBranch} (${strategy}) at ${status.path}`)

  try {
    if (strategy === 'squash') {
      await execFileAsync('git', ['merge', '--squash', sourceBranch], { cwd: status.path })
      // --squash stages the changes without committing. Commit them now.
      await execFileAsync(
        'git',
        ['commit', '-m', `${sourceBranch} (squashed)`],
        { cwd: status.path }
      )
    } else if (strategy === 'merge-commit') {
      await execFileAsync(
        'git',
        ['merge', '--no-ff', '-m', `Merge branch '${sourceBranch}'`, sourceBranch],
        { cwd: status.path }
      )
    } else {
      await execFileAsync('git', ['merge', '--ff-only', sourceBranch], { cwd: status.path })
    }
  } catch (err) {
    // Extract stderr from the execFile error — it's where git's actual
    // failure reason lives, and err.message only carries the command line.
    const stderr =
      err && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr: unknown }).stderr || '').trim()
        : ''
    const stdout =
      err && typeof err === 'object' && 'stdout' in err
        ? String((err as { stdout: unknown }).stdout || '').trim()
        : ''
    const baseMessage = err instanceof Error ? err.message : String(err)
    const detail = stderr || stdout || baseMessage

    log('worktree', `merge failed: ${detail}`)

    // Abort any partial merge/squash state so the user is left clean.
    try {
      await execFileAsync('git', ['merge', '--abort'], { cwd: status.path })
    } catch {}
    // For --squash the failure is typically at the `git commit` step (e.g.
    // nothing to commit because the branch is equivalent to base). In that
    // case `merge --abort` is a no-op, so also reset any staged changes.
    try {
      await execFileAsync('git', ['reset', '--hard', 'HEAD'], { cwd: status.path })
    } catch {}

    // Friendlier message for the common "nothing to commit" case on squash
    if (strategy === 'squash' && /nothing to commit/i.test(detail)) {
      throw new Error(
        `Nothing to merge — ${sourceBranch} has no changes relative to ${status.baseBranch}.`
      )
    }
    throw new Error(`Merge failed and was aborted: ${detail}`)
  }

  return {
    ok: true,
    strategy,
    mergedBranch: sourceBranch,
    baseBranch: status.baseBranch,
    mainPath: status.path
  }
}

export interface MergeConflictPreview {
  hasConflict: boolean
  files: string[]
  /** True if git merge-tree isn't supported by the installed git (pre-2.38). */
  unsupported?: boolean
}

/** Preview a three-way merge of `sourceBranch` into `baseBranch` in-memory
 * via `git merge-tree --write-tree`. Doesn't touch the working tree or any
 * refs. Returns the list of conflicted file paths on conflict. */
export async function previewMergeConflicts(
  repoRoot: string,
  sourceBranch: string,
  baseBranch: string
): Promise<MergeConflictPreview> {
  try {
    await execFileAsync(
      'git',
      ['merge-tree', '--write-tree', '--name-only', baseBranch, sourceBranch],
      { cwd: repoRoot }
    )
    return { hasConflict: false, files: [] }
  } catch (err) {
    if (err && typeof err === 'object') {
      const e = err as { code?: number; stdout?: string; stderr?: string; message?: string }
      // git merge-tree prints the tree OID on line 1, then conflicted file
      // paths on subsequent lines (with --name-only). Exit code 1 = conflicts.
      if (e.code === 1) {
        const lines = String(e.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)
        // Drop the first line (tree OID) — the rest are file paths.
        const files = lines.slice(1)
        return { hasConflict: true, files }
      }
      // "unknown switch" / unsupported → older git
      const stderr = String(e.stderr || e.message || '')
      if (/unknown (option|switch)|usage: git merge-tree/i.test(stderr)) {
        return { hasConflict: false, files: [], unsupported: true }
      }
    }
    // Unknown error — treat as "can't tell", don't block the user
    return { hasConflict: false, files: [], unsupported: true }
  }
}

/** Resolve a branch ref to its current SHA, or null if it doesn't exist. */
export async function getBranchSha(repoRoot: string, branch: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', `refs/heads/${branch}`], {
      cwd: repoRoot
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

/** True if `branch` is an ancestor of `base` (i.e. non-squash merged). */
export async function isBranchAncestorOfBase(
  repoRoot: string,
  branch: string,
  base: string
): Promise<boolean> {
  try {
    await execFileAsync('git', ['merge-base', '--is-ancestor', branch, base], { cwd: repoRoot })
    return true
  } catch {
    return false
  }
}

/** Sum of added/removed lines and touched files for committed work on this
 *  branch vs its default base. Returns zeros if the base can't be resolved. */
export async function getBranchDiffStats(
  worktreePath: string
): Promise<{ added: number; removed: number; files: number }> {
  try {
    const base = await getDefaultBaseRef(worktreePath)
    if (!base || base === 'HEAD') return { added: 0, removed: 0, files: 0 }
    const { stdout } = await execFileAsync(
      'git',
      ['diff', '--numstat', `${base}...HEAD`],
      { cwd: worktreePath, maxBuffer: 8 * 1024 * 1024 }
    )
    let added = 0
    let removed = 0
    let files = 0
    for (const line of stdout.split('\n')) {
      if (!line) continue
      const [a, r] = line.split('\t')
      // Binary files show "-\t-" — skip line counts but still count the file.
      if (a !== '-') added += parseInt(a, 10) || 0
      if (r !== '-') removed += parseInt(r, 10) || 0
      files++
    }
    return { added, removed, files }
  } catch {
    return { added: 0, removed: 0, files: 0 }
  }
}

/** List every tracked-or-untracked-but-not-ignored file in the worktree, as repo-relative paths. */
export async function listAllFiles(worktreePath: string): Promise<string[]> {
  const t0 = performance.now()
  let walledExec = 0
  let cumExec = 0
  let outputBytes = 0
  const execParts: number[] = []
  let result: string[] = []

  try {
    const tA = performance.now()
    const r = await tracedExec(
      ['ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd: worktreePath, maxBuffer: 32 * 1024 * 1024 }
    )
    walledExec += performance.now() - tA
    cumExec += r.execMs
    execParts.push(r.execMs)
    outputBytes += r.outputBytes

    const files = r.stdout.split('\n').filter((l) => l.length > 0)
    files.sort((a, b) => a.localeCompare(b))
    result = files
  } catch (err) {
    log('worktree', `listAllFiles failed: ${(err as Error).message}`)
  }

  logGitOp('listAllFiles', {}, t0, walledExec, cumExec, outputBytes, execParts)
  return result
}

const MAX_FILE_READ_BYTES = 2 * 1024 * 1024

export interface FileReadResult {
  content: string | null
  size: number
  binary: boolean
  truncated: boolean
  error?: string
}

/** Read a single file from within a worktree. Rejects paths that escape the worktree. */
export async function readWorktreeFile(
  worktreePath: string,
  filePath: string
): Promise<FileReadResult> {
  const base = resolve(worktreePath)
  const target = isAbsolute(filePath) ? resolve(filePath) : resolve(base, filePath)
  const rel = relative(base, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { content: null, size: 0, binary: false, truncated: false, error: 'Path escapes worktree' }
  }
  try {
    const st = statSync(target)
    if (!st.isFile()) {
      return { content: null, size: 0, binary: false, truncated: false, error: 'Not a regular file' }
    }
    const truncated = st.size > MAX_FILE_READ_BYTES
    const buf = await readFile(target)
    const slice = truncated ? buf.subarray(0, MAX_FILE_READ_BYTES) : buf
    // Heuristic binary check: NUL byte in the first 8KB.
    const sniff = slice.subarray(0, Math.min(slice.length, 8192))
    let binary = false
    for (let i = 0; i < sniff.length; i++) {
      if (sniff[i] === 0) {
        binary = true
        break
      }
    }
    if (binary) {
      return { content: null, size: st.size, binary: true, truncated, error: undefined }
    }
    return { content: slice.toString('utf8'), size: st.size, binary: false, truncated }
  } catch (err) {
    return {
      content: null,
      size: 0,
      binary: false,
      truncated: false,
      error: (err as Error).message
    }
  }
}

// Larger ceiling for binary viewers (images / PDFs) than the editor read
// path, which is meant for text editing.
const MAX_FILE_BINARY_READ_BYTES = 50 * 1024 * 1024

const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  pdf: 'application/pdf'
}

export type FileBinaryReadResult =
  | { ok: true; base64: string; mime: string; size: number }
  | { ok: false; error: string }

// base64 keeps the bytes intact across both Electron IPC structured-clone
// and the JSON-only WebSocket transport, at ~33% size overhead.
export async function readWorktreeFileBinary(
  worktreePath: string,
  filePath: string
): Promise<FileBinaryReadResult> {
  const base = resolve(worktreePath)
  const target = isAbsolute(filePath) ? resolve(filePath) : resolve(base, filePath)
  const rel = relative(base, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, error: 'Path escapes worktree' }
  }
  try {
    const st = statSync(target)
    if (!st.isFile()) {
      return { ok: false, error: 'Not a regular file' }
    }
    if (st.size > MAX_FILE_BINARY_READ_BYTES) {
      return { ok: false, error: `File too large (${st.size} bytes, max ${MAX_FILE_BINARY_READ_BYTES})` }
    }
    const buf = await readFile(target)
    const ext = (filePath.split('.').pop() || '').toLowerCase()
    const mime = EXT_TO_MIME[ext] ?? 'application/octet-stream'
    return {
      ok: true,
      base64: buf.toString('base64'),
      mime,
      size: st.size
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export interface FileWriteResult {
  ok: boolean
  error?: string
}

const MAX_FILE_WRITE_BYTES = 5 * 1024 * 1024

/** Write a single file within a worktree. Rejects paths that escape the
 * worktree and refuses symlinks. Last-write-wins — no concurrent-edit
 * detection in v1. */
export async function writeWorktreeFile(
  worktreePath: string,
  filePath: string,
  contents: string
): Promise<FileWriteResult> {
  const base = resolve(worktreePath)
  const target = isAbsolute(filePath) ? resolve(filePath) : resolve(base, filePath)
  const rel = relative(base, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, error: 'Path escapes worktree' }
  }
  const byteLen = Buffer.byteLength(contents, 'utf8')
  if (byteLen > MAX_FILE_WRITE_BYTES) {
    return { ok: false, error: `File too large (${byteLen} bytes, max ${MAX_FILE_WRITE_BYTES})` }
  }
  try {
    // Refuse to clobber a symlink — the real file lives somewhere we
    // haven't validated.
    try {
      const lst = lstatSync(target)
      if (lst.isSymbolicLink()) {
        return { ok: false, error: 'Refusing to write through a symlink' }
      }
      if (lst.isDirectory()) {
        return { ok: false, error: 'Target is a directory' }
      }
    } catch {
      // Target may not exist yet — that's fine, we're creating it.
    }
    await writeFile(target, contents, 'utf8')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export interface WorktreeScriptResult {
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
  error?: string
}

/** Run a user-configured setup/teardown command via the user's login shell
 * so homebrew/nvm paths resolve, with cwd set to the worktree and HARNESS_*
 * env vars exposing the worktree context. */
export async function runWorktreeScript(
  kind: 'setup' | 'teardown',
  command: string,
  ctx: { worktreePath: string; branch: string; repoRoot: string },
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void
): Promise<WorktreeScriptResult> {
  const trimmed = command.trim()
  if (!trimmed) {
    return { ok: true, exitCode: 0, stdout: '', stderr: '' }
  }
  log('worktree', `running ${kind} script for ${ctx.worktreePath}`)
  return new Promise((resolve) => {
    try {
      const child = spawn(resolveUserShell(), loginShellCommandArgs(trimmed), {
        cwd: ctx.worktreePath,
        env: {
          ...process.env,
          HARNESS_WORKTREE_PATH: ctx.worktreePath,
          HARNESS_BRANCH: ctx.branch,
          HARNESS_REPO_ROOT: ctx.repoRoot
        }
      })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (d) => {
        const chunk = d.toString()
        stdout += chunk
        onOutput?.('stdout', chunk)
      })
      child.stderr?.on('data', (d) => {
        const chunk = d.toString()
        stderr += chunk
        onOutput?.('stderr', chunk)
      })
      child.on('error', (err) => {
        log('worktree', `${kind} script spawn error: ${err.message}`)
        resolve({ ok: false, exitCode: -1, stdout, stderr, error: err.message })
      })
      child.on('close', (code) => {
        const exitCode = code ?? -1
        const ok = exitCode === 0
        log(
          'worktree',
          `${kind} script finished exit=${exitCode}${stderr ? ` stderr=${stderr.trim().slice(0, 200)}` : ''}`
        )
        resolve({ ok, exitCode, stdout, stderr })
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log('worktree', `${kind} script failed to start: ${msg}`)
      resolve({ ok: false, exitCode: -1, stdout: '', stderr: '', error: msg })
    }
  })
}

/** Point a worktree's `.claude/settings.local.json` at the main worktree's
 * copy via a symlink, so "Don't ask again" permissions granted in any
 * worktree apply to all of them. No-op if main has no settings.local.json
 * yet — we don't want to create one just to have something to symlink.
 * Idempotent: if the target is already a symlink, does nothing. If a
 * regular file already exists in the new worktree, it is merged into
 * main's copy (shallow merge) before being replaced with the symlink. */
export function symlinkClaudeSettings(mainWorktreePath: string, newWorktreePath: string): void {
  if (mainWorktreePath === newWorktreePath) return
  const mainSettingsPath = join(mainWorktreePath, '.claude', 'settings.local.json')
  if (!existsSync(mainSettingsPath)) return

  const newClaudeDir = join(newWorktreePath, '.claude')
  const newSettingsPath = join(newClaudeDir, 'settings.local.json')

  if (!existsSync(newClaudeDir)) mkdirSync(newClaudeDir, { recursive: true })

  if (existsSync(newSettingsPath)) {
    const stat = lstatSync(newSettingsPath)
    if (stat.isSymbolicLink()) return
    try {
      const mainSettings = JSON.parse(readFileSync(mainSettingsPath, 'utf-8'))
      const newSettings = JSON.parse(readFileSync(newSettingsPath, 'utf-8'))
      writeFileSync(mainSettingsPath, JSON.stringify({ ...mainSettings, ...newSettings }, null, 2))
    } catch {
      // If either file is corrupt JSON, fall through and let the symlink win.
    }
    unlinkSync(newSettingsPath)
  }

  symlinkSync(mainSettingsPath, newSettingsPath)
}

export async function removeWorktree(repoRoot: string, path: string, force?: boolean): Promise<void> {
  log('worktree', `removing worktree: path=${path} force=${force}`)
  const args = ['worktree', 'remove', path]
  if (force) args.push('--force')
  await execFileAsync('git', args, { cwd: repoRoot })
}

/** Drop `.git/worktrees/<name>` entries whose on-disk directory no
 *  longer exists. Same as running `git worktree prune` by hand — this
 *  is the recovery action wired to the "Stale" badge in the sidebar. */
export async function pruneWorktrees(repoRoot: string): Promise<void> {
  log('worktree', `pruning stale worktrees at repoRoot=${repoRoot}`)
  await execFileAsync('git', ['worktree', 'prune'], { cwd: repoRoot })
}
