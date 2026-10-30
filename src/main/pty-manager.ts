import * as pty from 'node-pty'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { log } from './debug'
import { cleanupTerminalLog } from './hooks'
import {
  saveTerminalHistory,
  loadTerminalHistory,
  clearTerminalHistory
} from './persistence'
import type { Store } from './store'
import type { PerfMonitor } from './perf-monitor'
import type { PtyStatus } from '../shared/state/terminals'

export type { PtyStatus }

/** Hard ceiling on concurrently live PTYs.
 *
 *  `pty:create` is a client-driven fire-and-forget signal with no bound on
 *  it: a client that mounts N terminals asks this process to spawn N
 *  subprocesses as fast as it can send. For agent tabs each of those is a
 *  full `claude`, so a client bug — or a client talking to a server with a
 *  large worktree fleet — can exhaust the host's memory before anyone
 *  notices. That happened: a renderer change made every backend's
 *  worktrees mount at once, and the remote it was connected to went to
 *  swap and stopped accepting SSH while still looking healthy to Tailscale.
 *
 *  The ceiling turns that from "the host dies" into "the client is told
 *  no", which is recoverable. It is deliberately generous — it exists to
 *  stop a runaway, not to ration normal use — and overridable for anyone
 *  legitimately running a bigger fleet, since refusing a spawn someone
 *  actually wanted is its own kind of breakage.
 *
 *  Attaches don't count: `create()` returns early for an id that already
 *  has a PTY, before this check. */
const DEFAULT_MAX_PTYS = 100

function resolveMaxPtys(): number {
  const raw = process.env.HARNESS_MAX_PTYS
  if (!raw) return DEFAULT_MAX_PTYS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    log('pty', `ignoring invalid HARNESS_MAX_PTYS=${raw}, using ${DEFAULT_MAX_PTYS}`)
    return DEFAULT_MAX_PTYS
  }
  return Math.floor(parsed)
}

interface PtyInstance {
  pty: pty.IPty
  status: PtyStatus
  isShell: boolean
  /** True when the shell was spawned in exec mode (`zsh -ilc <command>`).
   * For these the activity poller's "direct children" signal is unreliable
   * (the shell often exec's into the command itself, sharing PID), so we
   * skip polling and treat them as active for the PTY's lifetime. */
  isCommandShell: boolean
  activityActive: boolean
  activityProcess?: string
  hasBeenIdle: boolean
  spawnedAt: number
}

const SHELL_ACTIVITY_POLL_MS = 1500
// Force-arm the activity detector after this long even if we never caught
// the shell idle. Otherwise a user who types a command before .zshrc finishes
// keeps the shell perpetually "non-idle" and never gets a spinner — until the
// command exits, at which point arming finally happens but it's too late.
const SHELL_ARM_TIMEOUT_MS = 3000
// Cap per-terminal raw scrollback at ~1MB. The renderer replays this into a
// fresh xterm.js instance on reload; 1MB of ANSI-wrapped output is enough to
// cover a long Claude session without ballooning disk usage.
const HISTORY_CAP_BYTES = 1024 * 1024
const HISTORY_FLUSH_INTERVAL_MS = 30_000

// Ring-buffered raw PTY output. Appends truncate from the front when we exceed
// the cap. Stored as strings because `terminal:data` already ships strings
// (node-pty decodes UTF-8 for us), and we replay through xterm's string write.
class HistoryBuffer {
  private chunks: string[] = []
  private size = 0

  append(data: string): void {
    this.chunks.push(data)
    this.size += data.length
    while (this.size > HISTORY_CAP_BYTES && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!
      this.size -= dropped.length
    }
    if (this.size > HISTORY_CAP_BYTES) {
      // Single chunk exceeds cap — trim it from the front.
      const only = this.chunks[0]
      const overflow = this.size - HISTORY_CAP_BYTES
      this.chunks[0] = only.slice(overflow)
      this.size -= overflow
    }
  }

  seed(data: string): void {
    this.chunks = [data]
    this.size = data.length
  }

  toString(): string {
    if (this.chunks.length > 1) {
      const joined = this.chunks.join('')
      this.chunks = [joined]
      return joined
    }
    return this.chunks[0] || ''
  }
}

export class PtyManager {
  private ptys = new Map<string, PtyInstance>()
  private activityTimer: NodeJS.Timeout | null = null
  private store: Store | null = null
  private sendSignal: ((channel: string, ...args: unknown[]) => void) | null = null
  // Per-terminal raw-byte scrollback owned by main. Populated from disk on
  // first touch by either getHistory(id) or create() (whichever comes first),
  // appended to from the PTY onData stream. Persistence to
  // userData/terminal-history/<id> happens on a throttled cadence and on
  // before-quit via flushAllHistory().
  private history = new Map<string, HistoryBuffer>()
  private historyDirty = new Set<string>()
  private historyFlushTimer: NodeJS.Timeout | null = null
  private perfMonitor: PerfMonitor | null = null

  /** Wire the authoritative store after it's constructed. PTY status,
   * shell activity, and cleanup events dispatch through it. */
  setStore(store: Store): void {
    this.store = store
  }

  setPerfMonitor(monitor: PerfMonitor): void {
    this.perfMonitor = monitor
  }

  getActivePtyCount(): number {
    return this.ptys.size
  }

  /** Wire the transport's sendSignal so terminal:data and terminal:exit
   * flow through the transport abstraction instead of reaching for
   * BrowserWindow.webContents directly. */
  setSendSignal(fn: (channel: string, ...args: unknown[]) => void): void {
    this.sendSignal = fn
  }

  hasTerminal(id: string): boolean {
    return this.ptys.has(id)
  }

  create(
    id: string,
    cwd: string,
    command: string,
    args: string[],
    extraEnv?: Record<string, string>,
    isShell: boolean = false,
    cols: number = 120,
    rows: number = 30
  ): void {
    log('pty', `create id=${id} cmd=${command} args=${JSON.stringify(args)} cwd=${cwd} cols=${cols} rows=${rows}`)
    if (this.ptys.has(id)) {
      // A PTY for this id is already running — most likely a second
      // client (web) just connected and its XTerminal mounted for the
      // same tab the desktop window already has open. Don't kill +
      // respawn; that would emit a terminal:exit to every connected
      // client and force-restart Claude. The new client gets the live
      // data stream via the existing terminal:data broadcast, and the
      // history it already loaded via getTerminalHistory replays the
      // scrollback up to the join point.
      log('pty', `create id=${id} no-op — PTY already exists, treating as attach`)
      return
    }

    // Checked after the attach case above, so reconnecting clients can
    // always rejoin terminals that are already running even at the limit.
    const maxPtys = resolveMaxPtys()
    if (this.ptys.size >= maxPtys) {
      log('pty', `spawn refused id=${id} — at PTY limit ${maxPtys}`)
      const msg =
        `\r\n\x1b[31mCan't launch terminal — this Ness backend is already running ` +
        `${this.ptys.size} terminals (limit ${maxPtys}).\x1b[0m\r\n` +
        `\x1b[33mClose some tabs, or raise the limit with HARNESS_MAX_PTYS.\x1b[0m\r\n`
      this.sendSignal?.('terminal:data', id, msg)
      this.store?.dispatch({
        type: 'terminals/statusChanged',
        payload: { id, status: 'idle', pendingTool: null }
      })
      return
    }

    const env = {
      ...process.env,
      ...(extraEnv || {}),
      CLAUDE_HARNESS_ID: id,
      HARNESS_TERMINAL_ID: id
    } as Record<string, string>
    const shell = command || env.SHELL || '/bin/zsh'
    // Pre-flight cwd existence check. node-pty maps a missing cwd to a
    // confusing "posix_spawnp failed" — better to fail fast with a
    // targeted message and surface it in the terminal buffer. See #185.
    if (!existsSync(cwd)) {
      log('pty', `spawn skipped id=${id} — cwd missing cwd=${cwd}`)
      const msg = `\r\n\x1b[31mCan't launch terminal — worktree directory no longer exists: ${cwd}\x1b[0m\r\n`
      this.sendSignal?.('terminal:data', id, msg)
      this.store?.dispatch({
        type: 'terminals/statusChanged',
        payload: { id, status: 'idle', pendingTool: null }
      })
      return
    }
    let ptyProcess: pty.IPty
    try {
      ptyProcess = pty.spawn(shell, args, {
        name: 'xterm-256color',
        // Spawn at the renderer's fitted dimensions so the first burst of
        // output paints at the correct grid size. Falling back to 120x30
        // races the eventual ResizeObserver fit, and any cursor-positioned
        // output that arrives in the gap lands at the wrong column.
        cols,
        rows,
        cwd,
        env
      })
    } catch (err) {
      log('pty', `spawn failed id=${id}`, err instanceof Error ? err.message : err)
      const msg = `\r\n\x1b[31mFailed to spawn "${shell}": ${err instanceof Error ? err.message : err}\x1b[0m\r\n`
      this.sendSignal?.('terminal:data', id, msg)
      this.store?.dispatch({
        type: 'terminals/statusChanged',
        payload: { id, status: 'idle', pendingTool: null }
      })
      return
    }

    // Shells spawned with an exec-mode flag (`-c`, `-ilc`, `-lc`, `-ic`) run
    // a single command and exit. The activity poller can't reliably track
    // them via `ps` direct children — zsh often exec's into the target
    // command, so the PTY pid becomes the command itself (no children until
    // the command forks workers). Mark them so pollShellActivity skips
    // them, and fire an active=true dispatch right now so the spinner shows
    // from t=0 and keeps showing until onExit clears shellActivity.
    const isCommandShell =
      isShell &&
      args.some((a) => a === '-c' || a === '-ilc' || a === '-lc' || a === '-ic')

    const instance: PtyInstance = {
      pty: ptyProcess,
      status: 'processing',
      isShell,
      isCommandShell,
      activityActive: isCommandShell,
      hasBeenIdle: isCommandShell,
      spawnedAt: Date.now()
    }

    // Seed the history buffer from disk if a file exists. Renderer calls
    // getHistory(id) right before createTerminal and writes the bytes into a
    // fresh xterm instance before wiring up live data, so this usually finds
    // the buffer already loaded and skips the read.
    const buf = this.ensureHistoryBuffer(id)

    ptyProcess.onData((data: string) => {
      // Tee into the history ring buffer before forwarding, so a reload
      // right after output arrives still sees it.
      buf.append(data)
      this.historyDirty.add(id)
      this.ensureHistoryFlushTimer()
      this.perfMonitor?.recordTerminalBytes(id, data.length)
      this.sendSignal?.('terminal:data', id, data)
    })

    ptyProcess.onExit(({ exitCode }) => {
      log('pty', `exit id=${id} code=${exitCode}`)
      this.store?.dispatch({
        type: 'terminals/statusChanged',
        payload: { id, status: 'idle', pendingTool: null }
      })
      this.store?.dispatch({ type: 'terminals/removed', payload: id })
      this.sendSignal?.('terminal:exit', id, exitCode)
      this.ptys.delete(id)
      cleanupTerminalLog(id)
    })

    this.ptys.set(id, instance)
    if (isShell) this.ensureActivityPoller()

    if (isCommandShell) {
      // Extract the first whitespace-delimited token of the command for a
      // human-readable processName label ("npm run dev" → "npm"). The last
      // arg to `zsh -ilc` is the command string.
      const cmdStr = args[args.length - 1] || ''
      const firstWord = cmdStr.trim().split(/\s+/)[0] || cmdStr
      instance.activityProcess = firstWord
      this.store?.dispatch({
        type: 'terminals/shellActivityChanged',
        payload: { id, active: true, processName: firstWord }
      })
    }
  }

  /** Raw PTY scrollback for `id`, or empty string if none. Falls back to the
   * persisted file when nothing is in memory yet: on a cold app start the
   * renderer asks for history BEFORE it spawns, so reading only the in-memory
   * map returned '' and the saved scrollback stayed invisible until a renderer
   * reload happened to hit the buffer create() had since seeded. */
  getHistory(id: string): string {
    return this.ensureHistoryBuffer(id).toString()
  }

  /** The buffer for `id`, seeded from disk on first touch. Both getHistory and
   * create go through here so the file is read at most once per id. */
  private ensureHistoryBuffer(id: string): HistoryBuffer {
    const existing = this.history.get(id)
    if (existing) return existing
    const buf = new HistoryBuffer()
    const persisted = loadTerminalHistory(id)
    if (persisted) buf.seed(persisted)
    this.history.set(id, buf)
    return buf
  }

  /** Drop the in-memory buffer + delete the persisted file. Called on tab
   * close (before killTerminal) so a new tab with a fresh id doesn't
   * inherit stale content, and also used for any explicit "clear". */
  forgetHistory(id: string): void {
    this.history.delete(id)
    this.historyDirty.delete(id)
    clearTerminalHistory(id)
  }

  private ensureHistoryFlushTimer(): void {
    if (this.historyFlushTimer) return
    this.historyFlushTimer = setInterval(
      () => this.flushAllHistory(),
      HISTORY_FLUSH_INTERVAL_MS
    )
  }

  /** Persist any dirty buffers to disk. Called on a throttled cadence and on
   * before-quit so scrollback survives reload/quit without a sync IPC. */
  flushAllHistory(): void {
    if (this.historyDirty.size === 0) return
    for (const id of this.historyDirty) {
      const buf = this.history.get(id)
      if (!buf) continue
      saveTerminalHistory(id, buf.toString())
    }
    this.historyDirty.clear()
  }

  private ensureActivityPoller(): void {
    if (this.activityTimer) return
    this.activityTimer = setInterval(() => this.pollShellActivity(), SHELL_ACTIVITY_POLL_MS)
  }

  private pollShellActivity(): void {
    const shellInstances: Array<[string, PtyInstance]> = []
    for (const entry of this.ptys) {
      // Command shells manage their own activity state (set active=true at
      // create, cleared on exit via terminals/removed), so skip them here.
      if (entry[1].isShell && !entry[1].isCommandShell) shellInstances.push(entry)
    }
    if (shellInstances.length === 0) {
      if (this.activityTimer) {
        clearInterval(this.activityTimer)
        this.activityTimer = null
      }
      return
    }

    execFile('ps', ['-A', '-o', 'pid=,ppid=,comm='], (err, stdout) => {
      if (err) return
      // Build ppid → first child comm map (walk once)
      const childrenByPpid = new Map<number, string[]>()
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.+)$/)
        if (!match) continue
        const ppid = parseInt(match[2], 10)
        const comm = match[3].trim()
        const list = childrenByPpid.get(ppid)
        if (list) list.push(comm)
        else childrenByPpid.set(ppid, [comm])
      }

      for (const [id, instance] of shellInstances) {
        const shellPid = instance.pty.pid
        if (!shellPid) continue

        const directChildren = childrenByPpid.get(shellPid) || []
        const rawActive = directChildren.length > 0

        // Arm detection on first quiescence so login-shell init (nvm,
        // starship, git subprocs) doesn't false-positive. Fall back to
        // arming on a hard timeout — without it, a user who types a
        // command before init settled keeps the shell non-idle forever
        // and never gets a spinner until that command exits.
        if (!instance.hasBeenIdle) {
          if (!rawActive || Date.now() - instance.spawnedAt >= SHELL_ARM_TIMEOUT_MS) {
            instance.hasBeenIdle = true
          }
          if (!instance.hasBeenIdle) continue
        }

        const active = rawActive
        const processName = active ? directChildren[0] : undefined
        if (
          active !== instance.activityActive ||
          processName !== instance.activityProcess
        ) {
          instance.activityActive = active
          instance.activityProcess = processName
          this.store?.dispatch({
            type: 'terminals/shellActivityChanged',
            payload: { id, active, processName }
          })
        }
      }
    })
  }

  write(id: string, data: string): void {
    this.ptys.get(id)?.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    log('pty', `resize id=${id} cols=${cols} rows=${rows}`)
    try {
      this.ptys.get(id)?.pty.resize(cols, rows)
    } catch {
      // ignore resize errors on dead PTYs
    }
  }

  kill(id: string, signal?: string): void {
    log('pty', `kill id=${id}${signal ? ` signal=${signal}` : ''}`)
    const instance = this.ptys.get(id)
    if (!instance) return
    this.ptys.delete(id)

    const pid = instance.pty.pid
    // node-pty calls setsid() for each spawn, so the shell is its own
    // process-group leader and PGID === pid. Signalling -pid delivers to
    // the whole group (zsh + claude + any descendants) in one syscall,
    // instead of leaving grandchildren attached to our libuv handles.
    if (pid && pid > 0) {
      try {
        process.kill(-pid, (signal as NodeJS.Signals) || 'SIGKILL')
      } catch {
        // Group may already be dead.
      }
    }
    try {
      // Belt & suspenders: close the master fd and let node-pty tear down
      // its own handles. Without this, the read stream on the master can
      // keep Electron's quit sequence waiting even after the descendants
      // are gone.
      instance.pty.kill(signal)
    } catch {
      // pty already dead
    }
    cleanupTerminalLog(id)
  }

  killAll(signal?: string): void {
    // Persist any dirty scrollback before tearing down. kill() itself leaves
    // the history buffer intact — reload relies on that — so flushing here
    // ensures a subsequent process start reads the latest bytes from disk.
    this.flushAllHistory()
    for (const [id] of this.ptys) {
      this.kill(id, signal)
    }
    if (this.activityTimer) {
      clearInterval(this.activityTimer)
      this.activityTimer = null
    }
    if (this.historyFlushTimer) {
      clearInterval(this.historyFlushTimer)
      this.historyFlushTimer = null
    }
  }
}
