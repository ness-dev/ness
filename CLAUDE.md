# Ness — repo overview for Claude

This file is read automatically by Claude Code at the start of every session.
It documents the project structure and the conventions used here.

## What this app is

Ness is a macOS Electron app that manages multiple Claude Code instances
across git worktrees. The user runs many parallel Claude sessions, and Ness
gives them a single window with a sidebar of worktrees, terminal tabs per
worktree (Claude + raw shells), changed-files panel, PR status, and hotkey
navigation.

## Stack

- **Electron** main process + **React 19 / TypeScript** renderer
- **electron-vite** for the dev/build pipeline
- **xterm.js** + **node-pty** for terminals
- **Tailwind CSS v4** (CSS-imported, no PostCSS plugin) for styling
- **lucide-react** v1.x for icons (note: brand icons like `Github` are NOT exported in this version — use `GitPullRequest` etc.)
- **electron-builder** for packaging, signed with the user's personal Developer ID, notarized
- **electron-updater** for OTA updates from GitHub releases
- **`@anthropic-ai/claude-code`** is bundled as a dep (pinned native binary) and used by Chat tabs (internally `json-mode`) only. Terminal tabs (internally xterm-hosted) continue to spawn the user's PATH `claude` so power users on bleeding-edge / beta builds keep that experience. Both share `~/.claude/` for auth + MCP config.

## Architecture (read this before touching state)

This app went through a large refactor where **the main process owns all
shared state**, the renderer is a thin view layer, and a single transport
(currently Electron IPC, future: WebSocket) carries both state events
and side-effect signals. If you find yourself adding a `useState` to
hold a value that any other client of this workspace would also want,
you're doing it wrong — that value belongs in a slice.

### The store + slice pattern

State is partitioned into **slices** under `src/shared/state/`. Each
slice has:
- A `State` interface (the data shape)
- An `Event` discriminated union (the mutations)
- A `reducer(state, event) → state` pure function
- An `initial<Slice>` constant
- A test file with one test per event variant

Current slices: `settings`, `prs`, `onboarding`, `hooks`, `worktrees`,
`terminals` (which also owns `panes` and `lastActive`), `updater`,
`repoConfigs`. Adding a new piece of shared state means picking the
right slice (or making a new one) and editing the reducer + event union.

### How a state mutation flows end-to-end

1. **Renderer**: user clicks something. The handler calls a thin IPC
   method like `window.api.setTheme('solarized')`.
2. **Main / preload**: the IPC handler in `src/main/index.ts` does the
   side effect (validation, writing to disk, etc.) and **dispatches a
   typed event** through the store: `store.dispatch({type: 'settings/themeChanged', payload: 'solarized'})`.
3. **Main / store**: `src/main/store.ts` runs the dispatched event
   through the shared `rootReducer`, updates its in-memory `AppState`,
   bumps a monotonic `seq`, and notifies subscribers.
4. **Main / transport**: `src/main/transport-electron.ts` subscribes to
   the store and forwards every event over the `state:event` IPC channel
   to all `BrowserWindow`s.
5. **Renderer / client store**: `src/renderer/store.ts` listens on
   `state:event`, applies the **same** shared `rootReducer` to its local
   mirror, and bumps its own seq.
6. **Renderer / hooks**: `useSyncExternalStore` notifies any component
   reading via `useSettings()` (or the slice-specific hook). React
   re-renders.

The key property: **main and renderer apply the exact same reducer
function** from `src/shared/state/`, so they're guaranteed to stay in
sync with no glue code. The renderer's "client store" is just a passive
mirror.

### Where each kind of state lives

| Kind | Lives in | Why |
|---|---|---|
| Worktree list, panes, terminal status, PR status, settings, hooks consent, onboarding quest, updater status, repo configs, lastActive timestamps | **Main store slices** | Shared world state — every viewer of this workspace needs the same value |
| `activeWorktreeId`, `activePaneId`, modal visibility (`showSettings` etc.), sidebar widths, tree expansion (`collapsedGroups`), form drafts | **Renderer `useState`** | Per-client UI focus / layout — different viewers can validly differ |
| `hooksChecked` Sets, `prevStatusesRef`, debounce refs | **Renderer `useRef`** | Per-session bookkeeping that doesn't survive reload |
| Background polling clocks, dedup state | **Main FSM/poller classes** | Lives wherever the loop runs (PRPoller, ActivityDeriver) |

The test for "is this slice or renderer state": **would a second client
connecting to the same workspace want to see the same value?** If yes,
slice. If no, renderer.

### Key files

```
src/
├── shared/state/                  # Slices imported by BOTH main and renderer
│   ├── index.ts                   # Root reducer + AppState + StateEvent union
│   ├── settings.ts                # Theme, hotkeys, claudeCommand, fonts, …
│   ├── prs.ts                     # byPath PRStatus, mergedByPath, loading
│   ├── worktrees.ts               # list, repoRoots, pending FSM entries
│   ├── terminals.ts               # statuses, pendingTools, shellActivity, panes, lastActive
│   ├── onboarding.ts              # quest step
│   ├── hooks.ts                   # consent + justInstalled
│   ├── updater.ts                 # status (checking/available/downloading/…)
│   ├── repo-configs.ts            # byRepo: per-repo .ness.json contents
│   └── *.test.ts                  # vitest reducer tests, one per slice
│
├── main/
│   ├── index.ts                   # IPC handlers, menu, autoUpdater, store init
│   ├── store.ts                   # The authoritative Store class (~40 lines)
│   ├── transport-electron.ts      # Forwards store events to all windows via state:event IPC
│   ├── pr-poller.ts               # Background PR polling, focus refresh, dedup
│   ├── worktrees-fsm.ts           # Pending-creation FSM (addWorktree → setup script → outcome)
│   ├── panes-fsm.ts               # Every pane/tab mutation (addTab, closeTab, splitPane, …)
│   ├── activity-deriver.ts        # Subscribes to store, derives + records activity transitions
│   ├── pty-manager.ts             # node-pty lifecycle, dispatches statuses to store
│   ├── hooks.ts                   # Installs Claude Code hooks, dispatches statuses to store
│   ├── worktree.ts                # git worktree CRUD primitives
│   ├── github.ts                  # GitHub REST API calls
│   ├── repo-config.ts             # Per-repo .ness.json read/write (reads legacy .harness.json)
│   ├── persistence.ts             # JSON config at userData/config.json
│   ├── secrets.ts                 # safeStorage-encrypted secrets
│   └── debug.ts                   # File-based debug logger
│
├── preload/index.ts               # contextBridge — exposes window.api
│
└── renderer/
    ├── App.tsx                    # Root component, per-client UI focus + JSX
    ├── store.ts                   # Client mirror + useSettings/usePrs/usePanes/etc. hooks
    ├── types.ts                   # ElectronAPI interface (re-exports shared types)
    ├── hotkeys.ts                 # Hotkey definitions, parsing, formatting
    ├── worktree-sort.ts           # Group worktrees by PR status
    ├── components/                # React components
    └── hooks/
        ├── useHotkeys.ts          # Keyboard event subscription
        ├── useMetaHeld.ts         # Meta key detection
        ├── useTailLineBuffer.ts   # Rolling tail-line cache for CommandCenter
        ├── useTabHandlers.ts      # All pane/tab mutation handlers (addTab, splitPane, …)
        ├── useWorktreeHandlers.ts # All worktree+repo+pending-creation handlers
        └── useHotkeyHandlers.ts   # Sidebar-aware hotkey action map + keystroke binding
```

### Adding a new piece of shared state — the 5-file checklist

This is more ceremony than just adding a `useState`, but the payoff is
that any future client (web/mobile/another window) gets the value for
free. Pattern is the same for every slice:

1. **Add to the slice** (`src/shared/state/<slice>.ts`):
   - Add the field to the `State` interface
   - Add an `Event` variant for mutations
   - Add a reducer case
   - Update `initial<Slice>`
2. **Seed it in main** (`src/main/index.ts`, in the `new Store({...})` block)
3. **Add the IPC mutation handler** (in `main/index.ts` `registerIpcHandlers`):
   ```ts
   ipcMain.handle('myslice:setX', (_, value) => {
     // …validation, persist…
     store.dispatch({type: 'myslice/xChanged', payload: value})
     return true
   })
   ```
4. **Expose in preload + types**:
   - `src/preload/index.ts`: `setX: (v) => ipcRenderer.invoke('myslice:setX', v)`
   - `src/renderer/types.ts`: add to `ElectronAPI` interface
5. **Add a reducer test** in `src/shared/state/<slice>.test.ts` (one
   test per new event variant)

The renderer reads the value via the existing `useSettings()` /
`usePrs()` / etc. hook automatically — no new subscription code.

### High-frequency streams (terminal data)

State events are for **mutations**. They go through the reducer and
trigger React re-renders. This is fine for events that fire a few times
per second.

PTY data is **not** a state event — it's a side-effect signal. It flows
through its own `terminal:data` IPC channel directly to xterm.js via
`window.api.onTerminalData`. If we put it through the reducer, every
byte from a noisy build would re-render the world. The same conceptual
distinction applies for any future high-frequency stream.

### How the FSMs / pollers / derivers interact with the store

Some main-side modules subscribe to the store and react to events:

- **`PRPoller`** — owns background polling cadence + dedup. Dispatches
  `prs/*` events. Doesn't subscribe to anything; called externally on
  events that should kick a refresh (focus, worktree add, manual
  refresh button).
- **`WorktreesFSM`** — runs the pending-creation state machine
  (addWorktree → setup script → outcome). Dispatches `worktrees/*`
  events. On success, fires an `onWorktreeCreated` callback that the
  host wires to (a) PR poller refresh and (b) `panesFSM.ensureInitialized`.
- **`PanesFSM`** — owns every pane/tab mutation. Dispatches
  `terminals/panes*` events. Auto-persists panes to disk after each
  mutation.
- **`ActivityDeriver`** — actively *subscribes* to the store. Watches
  `terminals/*` and `prs/*` events, computes per-worktree effective
  state, debounces `lastActive` updates, dedups `recordActivity` calls
  to `activity.ts`.
- **`installHooksForAcceptedWorktrees`** — small subscriber in
  `main/index.ts` that listens for `worktrees/listChanged` and
  `hooks/consentChanged`, installs hooks into any new worktree if
  consent is `'accepted'`.

Construction order in `main/index.ts` matters: `PanesFSM` is constructed
**before** `WorktreesFSM` because the latter's `onWorktreeCreated`
callback closes over `panesFSM`. Don't reorder without thinking.

### Anti-patterns to avoid in slices and derivers

The store-and-slice architecture is sharp. Four common mistakes turn it
into a quadratic CPU sink. All four are caught either at code review or
by the cascade detector in `src/main/store.ts`, which logs a `[cascade]`
line to `perf.log` whenever one root event triggers more than 5 nested
dispatches.

**1. Subscribers that sweep all entities on every event.** A
`store.subscribe(...)` listener that loops over every session / worktree
/ PR on each event is the most common form of this bug. Streaming
events fire 30+ times per second; with N entities, that's `N × token_rate`
dispatches per stream. Always pull the affected entity id out of the
event payload and re-derive only that one. If the event genuinely
affects everything (e.g. the whole tree was replaced), say so in a
comment so the sweep is self-documenting.

**2. Derivers that dispatch identity events.** Even when scoped to a
single entity, a deriver should cache its last-derived value per entity
and skip the dispatch when nothing changed. Most "status" derivations
don't change between adjacent streaming tokens — the dedup is the
difference between "once per turn" and "once per token."

**3. Reducers that lose reference identity on single-item patches.**
`collection.map((x) => x.id === target ? patch(x) : x)` always allocates
a new array, even when nothing matched. Downstream `useSyncExternalStore`
selectors that hold a reference to the array see "changed" and
re-evaluate. Use `findIndex + slice` instead: `return state` when no
match, otherwise build the new array as
`[...arr.slice(0, i), patched, ...arr.slice(i + 1)]`. Untouched entries
keep their reference; downstream selectors don't fire.

**4. Renderer hooks that read whole maps then filter in JS.** A hook
like `useJsonClaude()` that returns the entire slice causes every
consumer to re-evaluate on any change to any entity. Add a per-id
selector (`useJsonClaudeSession(id)`) and use that in components that
care about one entity. The whole-slice hook is only correct in the few
places that genuinely need the full map (sidebar grouping, etc.).

**Diagnosing in production.** The HUD at Cmd+Opt+P shows live event
rates and a stacked bar of which event types are firing most. The
`perf.log` file (see "How performance debugging works" below) captures
per-event detail including `[cascade]` lines when these anti-patterns
fire. If you see a `[cascade]` line for a streaming event type, suspect
anti-pattern #1 first.

### How the renderer reads + mutates state

```tsx
// Read — re-renders this component when the slice changes.
const settings = useSettings()
const theme = settings.theme

// Mutate — fire-and-forget IPC. The store dispatches and the read
// above re-renders automatically.
window.api.setTheme('solarized')
```

The renderer **never holds a local copy of shared state**. There's no
"I'll keep my own `themeState` and re-fetch" pattern anywhere. If you
catch yourself writing `useState` for a value that came from the store,
delete it and read via the hook.

Per-client UI state (active worktree, modal visibility, sidebar width)
**stays as `useState` in App.tsx** — those are inherently per-viewer.

### Why "where does this live" can take a few file hops to answer

A `useSettings().theme` read traces through:
1. `App.tsx` calls the hook
2. `src/renderer/store.ts` defines the hook (`useAppState((s) => s.settings)`)
3. `useSyncExternalStore` reads from the client mirror in `store.ts`
4. The mirror was populated by a `state:event` IPC message
5. Main dispatched that event from an IPC handler in `main/index.ts`
6. The handler ran the reducer in `src/shared/state/settings.ts`

Six files for one value. The mitigation: **the structure is the same
for every slice**. Once you understand it once, every other slice
follows the same path. Search for "settingsReducer" or grep for the
event type if you're trying to find where something happens.

## How status detection works

The reliable status (processing / waiting / needs-approval) comes from
**Claude Code hooks** that we install into each worktree's
`.claude/settings.local.json`. The hooks write a status JSON to
`/tmp/harness-status/<terminal-id>.json` and the main process watches that
directory via `fs.watch`. The hook script uses `$CLAUDE_HARNESS_ID` env var
which the PtyManager sets when spawning each terminal.

## How performance debugging works

Two log files in `userData`:

- **`debug.log`** — categorical events. **Append-only across sessions**
  (same persistence model as `perf.log`) so crash forensics from before
  the most recent restart are still inspectable. Rotated at 10MB into
  `debug.log.1` (one archive only). Tail with `npm run log` (uses
  `tail -F` so it survives rotation). Manual clear via `npm run log:clear`
  (removes both `debug.log` and `debug.log.1`).
- **`perf.log`** — perf trace. **Append-only across sessions** so lag
  that happened earlier (possibly before the most recent restart) is
  still inspectable. Rotated at 10MB into `perf.log.1` (one archive
  only). Tail with `npm run log:perf` (uses `tail -F` so it survives
  rotation). Clear before a fresh repro with `npm run log:perf:clear`
  (removes both `perf.log` and `perf.log.1`).

  Writes are **buffered and async** — lines accumulate and flush on a
  1 s timer or at 500 buffered lines, whichever comes first, via
  `appendFile` rather than `appendFileSync`. This matters: the profiler
  runs on the same main thread it's measuring, so a blocking write per
  line makes it a source of the lag it reports. `flushPerfLogSync()`
  drains the buffer on shutdown so the tail of a session isn't lost.
  The corollary for anyone reading the log live: the last second or so
  of events may not be on disk yet.

What gets written to `perf.log` (and where the threshold lives):

- `[store-slow]` — any `store.dispatch` whose reducer + listener fan-out
  totals ≥ `SLOW_DISPATCH_MS` (5 ms; `src/main/store.ts`).
- `[ipc-slow]` — any IPC request or fire-and-forget signal handler that
  takes ≥ `SLOW_IPC_MS` (50 ms; `src/main/transport-electron.ts` and
  `src/main/transport-websocket.ts` — both transports are wrapped so
  headless gets the same trace).
- `[eventloop-spike]` — main-process event-loop lag (timer drift on a
  500 ms interval) ≥ `LAG_SPIKE_THRESHOLD_MS` (100 ms;
  `src/main/perf-monitor.ts`).
- `[snapshot]` — one summary line every `SNAPSHOT_INTERVAL_MS` (30 s)
  with current rates, lag, active PTYs, and top event types. Cheap
  continuous trace for "what was happening at <timestamp>". Memory keys
  are explicitly prefixed (`mainRssMB` / `mainHeapUsedMB` vs
  `rendererHeapUsedMB`), because an unqualified `memoryHeapUsedMB` here
  used to mean main-only — it read 30MB while the renderer sat at 900MB,
  which is worse than reporting no memory at all.
- `[renderer-slow]` / `[renderer-snapshot]` — one aggregated 1 s bucket
  per renderer (`src/renderer/renderer-perf.ts`), delivered over the
  `perf:reportRendererSample` fire-and-forget signal. `-slow` when a
  threshold tripped, `-snapshot` for the 30 s heartbeat. Carries long
  tasks + blocking time, renderer heap and GC churn, input latency, and
  React commits/time. See "Why the renderer needs its own telemetry".
- `[changed-files]` — `getChangedFiles` / `getCommitChangedFiles` /
  `getCommitRangeChangedFiles` calls taking ≥ `SLOW_CHANGED_FILES_MS`
  (50 ms; `src/main/worktree.ts`).
- `[git-op]` — per-call timing breakdown (exec/post/bytes split) for git
  functions taking ≥ `SLOW_GIT_OP_MS` (50 ms; `src/main/worktree.ts`).
- `[microtask-drift]` — main-thread blocks ≥50ms (higher resolution than the 500ms event-loop sampler).

`[changed-files]` and `[git-op]` were originally logged unconditionally,
on the theory that they were infrequent enough for a complete trace to
be worth it. They aren't — they fire on every panel refresh for every
worktree, and a single session produced 77k and 115k lines respectively.
Don't un-gate them for a "complete" trace; if you need one for a
specific repro, lower the constant temporarily instead.

The HUD at **Cmd+Opt+P** shows live aggregates (rates, history sparkline,
React commits per second, long tasks / blocked ms, renderer heap and GC
churn, top event types). `perf.log` captures the per-event detail the HUD
can't display. They're complementary — `PerfMonitor` aggregates for the
HUD, `perfLog` writes discrete slow-event lines.

For AI agents debugging perf: ask the user to `npm run log:perf:clear`,
reproduce, then tail `perf.log` and look for the slow-* lines around the
reported timestamp.

### Why the renderer needs its own telemetry

Everything above except the `[renderer-*]` lines measures the **main
process**. That gap once cost two days: a report of "the whole UI stutters
whenever a worktree is calling a tool" was chased through three rounds of
main-process optimization while `perf.log` showed `store=0-3/s`,
`ipc=0-3/s`, `lag=0-2ms`, no `[cascade]` lines, and zero slow-render lines
— with the renderer at 155% CPU and 966MB RSS. The bug was
`rehype-highlight` rebuilding 37 highlight.js grammars on every markdown
render, per streamed token.

Three structural reasons the old instrumentation couldn't see it, and what
replaced them:

1. **A per-commit frame-budget gate misses death by a thousand cuts.**
   `[render-slow]` only fired on commits ≥16 ms; the pathology was hundreds
   of individually-fine commits. `renderer-perf.ts` aggregates instead, so
   `reactTotalMs` per second is what's compared against a threshold. It
   also removes an IPC from the commit hot path.
2. **Nothing measured renderer GC or heap.** A GC pause happens *between*
   tasks, in a different process from the one `perf-monitor.ts` samples, so
   it is invisible to both React profiler callbacks and main-process
   event-loop lag. The `longtask` PerformanceObserver catches those pauses
   (plus layout thrash and any non-React work).
3. **`[snapshot]` memory was main-only but unlabelled.** Now prefixed, per
   above.

**Two fields lied for months, and both hid the same class of bug. Read this
before trusting a `[renderer-*]` line.**

- **`reactCommits` / `reactTotalMs` were structurally 0 in every packaged
  build.** React's production build compiles out `enableProfilerTimer`, so
  `<Profiler>`'s `onRender` is never called — `react-dom-client.production.js`
  contains zero occurrences of `onRender`. `"reactCommits":0` appeared in
  100% of ~1,823 samples across two log files and never once nonzero. The fix
  — aliasing `react-dom/client` → `react-dom/profiling` in
  `electron.vite.config.ts` — turned out to cost more than the number was
  worth: React 19.2's profiling entry emits a `performance.measure()` per
  component render for the DevTools Performance track, and in a trace of a
  loaded session `logComponentRender` + `logComponentEffect` + their
  `performance.now()` calls were **~15% of total renderer CPU**, plus 21k
  retained `PerformanceMeasure` objects in a heap snapshot taken while nothing
  was recording. So the alias is now **opt-in via `HARNESS_REACT_PROFILING=1`**.
  Default builds ship `reactProfiling: false` on every sample and every
  consumer renders `n/a` — never `0`, which is what caused the original
  misreading. **Do not add a bare `react-dom` alias** — the profiling build
  itself does `require("react-dom")` for `ReactDOMSharedInternals`, so that
  creates a cycle and the app dies at startup on `reading 'd'`.

  The meta-lesson, since this bug's *fix* became the next bug: **profiling
  builds are not free, and instrumentation added to explain a slowdown can
  become a measurable share of it.** After enabling any always-on profiler,
  re-profile and confirm the instrumentation isn't in its own top-10.
- **`heapUsedMB` and its deltas are quantized and up to ~20 minutes stale.**
  Chrome caches `performance.memory` on pages that aren't cross-origin
  isolated. Observed: `heapUsedMB` pinned at exactly 560.8 for 40 minutes
  across 617 samples (9 distinct values in an entire log) while real RSS swung
  600MB inside 30 seconds. So `heapGrowthMB` / `heapReclaimedMB` **cannot**
  show an allocate-and-collect sawtooth — the exact shape they were added to
  catch — and when the cached value does refresh, the whole 20-minute delta
  gets misattributed to one 1-second bucket. The trustworthy number is
  `rendererRssMB` / `rendererCpuPct` in `[snapshot]`, sampled in main via
  `app.getAppMetrics()` and scoped to `BrowserWindow` webContents (browser
  tabs are separate renderer processes and are deliberately excluded). The
  `performance.memory`-derived fields are suffixed `…Quantized` so they can't
  be misread as live.
- **`rendererBlockingMsPerSec` was not per second.** It logged the renderer
  bucket's raw `blockingMs`. That bucket is nominally 1 s but stretches without
  bound when the renderer's timer is starved — a DevTools heap snapshot
  produced a single ~104 s bucket, which surfaced as `blocked=103792ms/s`.
  Reading those totals as rates overstates blocking by 20-100x and makes a
  mostly-idle renderer look pegged. Now normalized by `elapsedMs`, with
  `rendererBucketMs` and `rendererBlockingMsTotal` logged alongside so the raw
  numbers stay recoverable. **Check `rendererBucketMs` before comparing
  blocking across snapshots** — a long window is itself a signal that the
  renderer stalled, and it means everything derived from that bucket is
  averaged over a period long enough to hide the spike.

Two of these three were caught only because someone asked whether a number
could physically be what it claimed: 100% zeros, a heap that never moved, and
1399 ms of blocking inside a 1000 ms second. **Sanity-check units and ranges
against physical limits before drawing conclusions** — a rate that exceeds its
own denominator is a units bug, not a finding.

The general lesson, since this has now cost three investigations: **a
telemetry field that reads a constant is not evidence of a quiet system, it is
evidence of broken instrumentation.** Before optimizing against a metric,
confirm it has ever moved — `grep -oE '"field":[0-9.]+' perf.log | sort -u`
takes seconds and would have caught both of these.

The hard constraint when extending this: **the telemetry must not become
the bottleneck.** `longtask` can fire continuously under load, so buckets
are aggregated in memory and emitted at most once a second, only when a
threshold trips (idle cost: one signal per 30 s). Never log or send per
event, and keep renderer→main telemetry on a fire-and-forget signal so it
can't block a render.

These counters are deliberately **not slice state**: two clients viewing
the same workspace have their own renderers with their own heaps and frame
budgets, so there's no shared truth to mirror — and it's high-frequency,
which keeps it out of the reducer regardless.

## How GitHub integration works

The user pastes a GitHub personal access token into Settings. It's encrypted
via `safeStorage` and stored in `userData/secrets.enc`. All GitHub data
(PR status, check runs, statuses) goes through `src/main/github.ts` using
`fetch()` against the REST API.

Token resolution lives in `src/main/github-auth.ts` and runs once at boot
(re-runs on a 401): an explicit PAT in `secrets.enc` or `GITHUB_TOKEN` wins,
then `gh auth token` (spawned through a login zsh so Homebrew's `gh` is on
PATH), then nothing. The `gh` CLI is an **optional** auto-detect convenience
— if it's installed and authenticated, Ness uses its token automatically;
if not, the PAT paste flow in Settings is still the fallback. Ness has no
hard dependency on `gh`.

## Important quirks

- **Worktree dep installs** — fresh git worktrees under
  `claude-harness-worktrees/` start with no `node_modules`. Run
  `npm install --legacy-peer-deps` once before building (the `--legacy-peer-deps`
  flag is required because `electron-vite@5` declares a peer range that
  npm's strict resolver rejects against the installed `vite@7`).
- **node-pty rebuild** — `node-pty` is a native module compiled against a
  specific Electron version. After running `npm run pack` or `npm run dist*`,
  the postdist hook runs `electron-rebuild -f -w node-pty` so dev mode keeps
  working. If dev mode ever errors with `posix_spawnp failed`, run
  `npm run rebuild:dev` manually.
- **Hooks consent** — first time a user activates a worktree, we show a
  banner asking permission to install the hooks. We never write to user
  files without that consent.
- **Login shell wrapping** — the PtyManager spawns `/bin/zsh -ilc <command>`
  instead of running the command directly, so the user's full PATH is loaded
  (homebrew binaries, nvm, etc.).
- **Login-shell PATH fix at boot** — at boot we run the user's login shell once
  via `path-fix.ts` to capture its PATH and **merge** into `process.env.PATH`.
  Without this, the bundled claude (spawned directly, not via shell) inherits
  whatever stripped PATH Ness was launched with and can't find homebrew/
  nvm/pyenv tools. The fix runs in both Electron-local boots (Finder/Dock
  launches with `/usr/bin:/bin:/usr/sbin:/sbin`) and headless boots
  (`ssh host 'harness-server'` / systemd / launchd run non-interactive
  non-login = same stripped PATH). Merge order: existing entries that aren't
  already in captured come first, then the full captured list — preserves
  launcher-prepended entries like npm's `node_modules/.bin` in `npm run dev`
  while still appending Homebrew/nvm. The probe uses sentinel-wrapped output
  so rc-file noise (starship init, nvm welcome) is discarded cleanly. Gated
  to macOS only; linux can be added if anyone reports the same problem.
- **Auto-updater is dev-mode no-op** — `setupAutoUpdater()` returns early
  unless `app.isPackaged`.
- **`package.json` `name` is load-bearing — never change it.** It's still
  `"harness"` even though the product is Ness. Electron derives
  `app.getName()` from it (there's no top-level `productName` — the one in
  `build` is electron-builder's and Electron never reads it), and that name
  keys *two* things: the userData directory
  (`~/Library/Application Support/harness`) and the macOS Safe Storage
  keychain item (service `harness Safe Storage`, account `harness Key`),
  which is what decrypts `secrets.enc`. The filesystem is case-insensitive
  but the keychain is **not**, so even a capitalization change breaks token
  decryption with "A keychain can not be found to store …". Packaged builds
  additionally pin the dir explicitly in `applyUserDataPathOverride()`
  (`src/main/desktop-shell.ts`) so a future `name` edit can't orphan
  existing installs' config, secrets, and pane layout. Same reasoning as
  `build.appId` staying `org.mikelyons.harness`.
- **Dual browser-controller** — Browser tabs are backed by Electron's
  `WebContentsView` in desktop mode and by `playwright-core` in headless
  mode. Both implement the `BrowserManagerLike` contract so MCP tools,
  the control server, and the pane reconciler call the same surface.
  `playwright-core` is a runtime dep but **doesn't bundle Chromium** —
  the user provides one. Resolution: `HARNESS_PLAYWRIGHT_BROWSER`
  env var first (path to a Chromium executable), else Playwright's
  `channel: 'chrome'` (system Chrome on macOS/Win/Linux). If neither
  resolves, the first `create_browser_tab` MCP call throws a clear
  message. The headless renderer (web client) renders a polled JPEG
  via `RemoteBrowserView` instead of a native overlay — live screencast
  is a follow-up.
- **Multi-backend (Tier 1)** — a single Electron Ness can connect
  to N backends (the in-process local one + remote `harness-server`
  instances), with a chip strip at the bottom of the sidebar to switch.
  See `plans/tier-1-multi-backend-ux.md` for the full design.
  Architecturally: `src/renderer/store.ts` holds a `BackendsRegistry`
  of `(transport, ClientStore)` pairs; the local entry uses
  `ElectronClientTransport` (via the preload's `__harness_local_transport`
  handle), remotes use `WebSocketClientTransport` directly in renderer
  context. Each transport's `onStateEvent` is wired to its own store at
  registration time, so there's no central event router — per-backend
  channels are naturally segregated. `window.api` is built in the
  RENDERER (`src/renderer/build-backend.ts`, exported via
  `src/renderer/backend.ts` as `getBackend()` / `useBackend()`),
  with each method calling `registry.getActiveTransport().request(...)`
  lazily. For local active that's the preload-bridged handle (1
  contextBridge crossing); for remote active it's the WS transport
  directly (0 crossings — same wire path as the standalone web client).
  The preload itself is tiny — only exposes the local transport handle
  and a few electron-only helpers (`webUtils.getPathForFile`, window
  controls). `connections:*` methods always go to the local transport
  (renderer-shell-owned per design §C/§G). Menu signals
  (`onOpenSettings`, etc.) likewise bind to the local transport since
  only the local Electron has a Menu. The legacy `HARNESS_REMOTE_URL`
  env-var mode was removed in Tier 1 — adding a remote backend now
  happens via the chip strip's `+` button (or `File → Add Backend…`
  if/when wired). Tokens encrypted in `secrets.enc` keyed
  `backend-token:<id>`; connections list lives in `userData/config.json`.
- **Dual-claude model** — Ness ships two Claude Code binaries. **Terminal
  tabs** (internally xterm-hosted) spawn `/bin/zsh -ilc claude` so the user's
  PATH `claude` is what runs (lets bleeding-edge / beta testers stay on their
  own build). **Chat tabs** (internally `json-mode`) spawn the bundled
  `@anthropic-ai/claude-code` native binary directly — pinned per Ness
  release so the `--permission-prompt-tool` round trip and stream-json
  schema can't drift between npm publishes. Both share `~/.claude/` for
  auth + MCP config, so the dual binaries are invisible at the user
  level. The bundled binary is the platform-specific one from
  `@anthropic-ai/claude-code-<platform>-<arch>` (~216MB on disk per
  platform); resolved at runtime via `createRequire` so the bundler
  doesn't try to inline it. electron-builder hardlink-dedups, so the
  resolver targets the platform subpackage's `claude` directly rather
  than the wrapper's `bin/claude.exe`. Both packages live in
  `asarUnpack` (native binaries can't exec from inside asar). The
  undocumented `useSystemClaudeForJsonMode: true` setting in
  `config.json` flips json-mode back to PATH `claude` for diagnostics
  / version comparison — no UI, edit the JSON directly.

## Workflow conventions

These are how the user wants Claude to behave when working on this repo:

1. **Commit as you go.** When a coherent change is done and the build is
   clean, commit it with a descriptive message. Don't batch multiple
   features into one commit.

2. **Push after every commit.** Always run `git push origin <branch>`
   immediately after a commit succeeds. The user does not want commits
   piling up locally.

3. **Verify before committing.** After any TS/TSX change, run both:
   - `npm run typecheck` — catches type errors across main + renderer via
     project references. `electron-vite build` does NOT run `tsc`, so the
     build alone will miss type errors.
   - `npx electron-vite build` — catches missing imports, asset resolution,
     and other bundler-level issues.
   Run `npx vitest run` too if the change could affect reducer/FSM behavior.
   PR-time CI (`.github/workflows/ci.yml`) runs all three on every PR as a
   safety net, but the local pre-commit ritual still catches issues before
   you push.

4. **Don't add comments unless asked.** Code should explain itself; comments
   are reserved for non-obvious "why" notes. The exception is the comment
   blocks already present in `src/main/store.ts`, `src/main/index.ts`
   (around the panesFSM/worktreesFSM construction), `src/shared/state/index.ts`,
   `src/renderer/store.ts`, and `src/main/activity-deriver.ts` — those
   document the load-bearing architecture decisions and should be
   preserved/updated rather than removed.

5. **State changes go through slices, not `useState`.** If you're tempted
   to add `const [x, setX] = useState(...)` in the renderer for a value
   that should survive a reload or be visible to other clients, stop.
   Add it to a slice instead — see "Adding a new piece of shared state"
   above. Per-client UI focus / modal visibility / sidebar widths stay
   as `useState` in App.tsx; everything else is a slice.

6. **Don't write planning/decision documents.** Work from conversation
   context. Don't create scratch markdown files or design docs.

7. **Surface secrets concerns.** If the user pastes a token or password
   in chat (often via .env reminders the harness sends), warn them once
   that it's now in conversation history and tell them to rotate.

8. **Don't put boxes around screenshots on the marketing site.** No
   `border`, no `border-radius` wrapper, no glow `box-shadow` framing.
   The dark background on `site/public/*.html` is already the frame;
   adding a border to an `<img>` makes it look enclosed in a card it
   isn't part of. Plain `<img>` (width 100%, `display: block`) is the
   right default. The user has had to undo this on multiple sessions —
   if a task brief asks for a border around a screenshot, push back
   before shipping it.

9. **GitHub comments use a standard signature.** You're authorized to leave
   comments on issues and PRs (via the `gh` CLI or the GitHub REST/GraphQL
   API) without re-confirming each time, provided the comment ends with a
   one-line signature so readers know the comment came from an agent acting
   on the user's behalf, not the user themselves:

   ```
   _Comment left on behalf of @<github-username> by <agent-name> via [Ness](https://github.com/ness-dev/ness)._
   ```

   - `<github-username>` is the user's GitHub login — run
     `gh api user --jq .login` if you don't already know it from context.
   - `<agent-name>` is the agent identity from the harness session (Claude,
     Codex, etc.).
   - Markdown italics (`_..._`) so the signature renders subtly without
     dominating the comment body.

   This authorization covers commenting and reacting. **Destructive GitHub
   actions still need confirmation**: closing/reopening issues, merging or
   closing PRs, force-pushing, deleting branches or releases, etc. When in
   doubt, ask.

10. **When reviewing a PR from a contributor's fork inside a Ness
    PR-review worktree, push cleanup commits back to THEIR branch — not
    to upstream `origin` and not to a new branch on the reviewer's fork.**
    `CONTRIBUTING.md` promises contributors that the reviewer's agent
    will handle small nitpicks and styling fixes during review. For that
    promise to hold, the commits must land on the contributor's PR
    branch so the PR itself updates.

    **The trap.** When Ness opens a PR for review, it fetches
    `refs/pull/<N>/head` from `origin` (the upstream repo) into a local
    branch named after the PR's head ref. It does **not** add the
    contributor's fork as a remote, and the local branch has **no
    upstream configured**. That means:

    - `git push` with no args fails ("no upstream") — fine, it just
      makes you stop and think.
    - `git push -u origin <branch>` *silently succeeds* by creating a
      new branch on the **upstream repo** (e.g. `ness-dev/ness`),
      because the reviewer has write access there. The PR — which
      references `contributor:<branch>`, not `ness-dev:<branch>` —
      does **not** update. This is the most common failure mode.
    - Creating a new branch like `review-fix/foo` on the reviewer's own
      fork and opening a parallel PR is also wrong: fragments the
      change history, confuses the contributor, forces manual
      cherry-picking.

    **The fix.** Inside the Ness-created worktree, run
    `gh pr checkout <num>` once before pushing. `gh` is idempotent on a
    branch that already exists at the right SHA — it just adds the
    contributor's fork as a remote (named after the fork owner) and
    sets the branch's upstream to point at it. After that, plain
    `git push` does the right thing:

    ```sh
    # inside the Ness PR-review worktree
    gh pr checkout <num>   # patches up remote + upstream config;
                           # safe no-op on the existing local branch
    # …make the fix, commit…
    git push               # pushes to the contributor's fork; PR updates
    ```

    Then leave a PR comment with the standard signature (§9) noting
    what you cleaned up, so the contributor isn't surprised by the new
    commit.

    **Fallback when `git push` fails with a permissions error.** The
    contributor disabled "Allow edits by maintainers" on their PR
    (default is ON, but it can be turned off). In that case post a PR
    comment with the suggested diff as a code block — do **not** open
    a parallel PR.

    **Tripwire.** If you find yourself about to run
    `git checkout -b review-fix/...`, `git push -u origin <branch>`,
    or `gh pr create` against a PR you're reviewing, stop. You're on
    the wrong path — go back and `gh pr checkout <num>` first.

11. **Use the canonical text and icon sizes so the UI scales together.**
    The renderer's root `html` font-size is driven by the `uiScale`
    setting, so every `rem`-based size (Tailwind `text-*` and the `w-N` /
    `h-N` grid) shifts in lockstep. Inline pixel sizes do NOT scale and
    will look wrong at the larger rungs.

    **Text — pick from this set only:**
    `text-xs`, `text-sm`, `text-base`, `text-lg`, `text-2xl`, `text-3xl`.
    No `text-[Npx]`, no inline `style={{ fontSize: ... }}`, no `text-xl` /
    `text-4xl` / `text-5xl`. If the design seems to call for an
    in-between size, snap to the nearest canonical step — the per-px
    hierarchy doesn't earn its keep against the visual noise.

    **Icons — use the `icon-*` aliases, not the lucide `size={N}` prop
    or raw `w-N h-N` classes.** The lucide `size` prop bakes pixel
    literals into the SVG `width` / `height` attributes, so icons stay
    fixed regardless of root font-size. `icon-*` is a rem-based alias
    defined in `src/renderer/styles.css` via Tailwind v4's `@utility`,
    and mirrors the `text-*` ladder. Pick from this set only:

    | utility    | px   |
    |---         |---   |
    | `icon-2xs` | 10px |
    | `icon-xs`  | 12px |
    | `icon-sm`  | 14px |
    | `icon-base`| 16px |
    | `icon-lg`  | 20px |
    | `icon-xl`  | 32px |

    Example: `<Loader2 className="icon-sm animate-spin" />`. If a
    design genuinely wants 18px or 26px (one-offs), use
    `w-[1.125rem] h-[1.125rem]` / `w-[1.625rem] h-[1.625rem]`. If the
    rung you need would be the third callsite of that one-off, add a
    new `@utility` entry in `styles.css` and use that instead.

    Note: `w-N h-N` literals are still correct for *non-icon* fixed-size
    boxes that the design doesn't want growing with `uiScale` — color
    swatches, decorative dots, avatar circles. Checkboxes are NOT in
    this set; treat them as icons (use `icon-base`) so the hit target
    scales with the rest of the UI.

    Exceptions where pixel literals are correct (because the consumer
    isn't part of the rem grid): Monaco/XTerminal font sizes, the
    PerfMonitor HUD's SVG numerics, JsonModeChat's
    `--chat-{body,chrome,meta}-text` CSS variable system, and non-icon
    components that legitimately take a pixel size (e.g.
    `<QRCodeSVG size={128} />`).

    Note: ReviewDiffPane's inline-styled comment widgets render into
    Monaco view zones via `createRoot`, but they're still in the same
    document, so `rem` resolves against the scaled root `<html>` —
    they use `rem` (not px) so they scale with `uiScale` like the rest
    of the UI. Don't reintroduce px font sizes there.

## Releasing

End-to-end release is automated via `npm run release <version>`:

```
npm run release 1.0.1
```

The script handles preflight checks, version bump, README link updates,
release notes from `git log`, and the GitHub interactions that drive
the build. Build/sign/notarize/`gh release create` all run in CI on
the tag push at the end — notarization creds live in Actions secrets
(`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`), not in
a local `.env`.

`main` is protected by a ruleset requiring PRs + the `ci` status
check, so the script can't push the version-bump commit straight to
main. Instead it commits on a `release/v<ver>` branch, opens a PR via
`gh pr create`, blocks on `gh pr checks --watch`, merges (rebase by
default, falling back to a merge commit if rebase is disabled — never
squash so the "Release v<ver>" subject stays on main), then pulls
main and tags the new HEAD. The tag push is what fires
`release.yml`.

If the script fails mid-flight it is **not idempotent** — clean up
and re-run with the same version. The trap handles the early windows
(restoring touched files, dropping a local release branch). For
later windows it prints the exact cleanup commands:

- After branch pushed / PR opened / CI failed:
  `gh pr close <num> --delete-branch` (or `git push origin :release/v<ver>`)
  then `git checkout main && git branch -D release/v<ver>`.
- After merge but before tag push:
  `git checkout main && git pull --ff-only && git tag v<ver> && git push origin v<ver>`.

The header comment of `scripts/release.sh` is the canonical recovery
doc — update both if the flow changes again.

Linux release builds now produce both `.deb` (Ubuntu/Debian) and
`.AppImage` (every distro) — both attached to the GitHub release
automatically by `.github/workflows/build-linux.yml` on tag push.

### Headless smoke test on every PR

PR CI (`.github/workflows/ci.yml`) runs `scripts/smoke-headless.sh`
after the typecheck / build / tests block. The script launches
`dist-headless/main/index.js` on an ephemeral port, parses the
`[web-client] open ...` URL out of its stdout, delegates HTTP
validation to `scripts/web-smoke.mjs` (auth gate + HTML + asset
reach) and WS validation to `scripts/ws-smoke.mjs` (upgrade +
snapshot round-trip), then SIGTERMs and confirms clean shutdown.
Catches tarball-layout / module-resolution / boot-time regressions
before they ride a tag push to release. Run locally:
`npm run build:headless && bash scripts/smoke-headless.sh`.

### Headless tarballs

The `Headless Release` workflow (`.github/workflows/headless-release.yml`)
fires on the same tag push and runs a three-platform matrix
(`darwin-arm64`, `linux-x64`, `linux-arm64` — Intel Mac is omitted
because the macos-13 runner queue is too unreliable). Each runner
calls `npm run pack:headless`, which downloads a pinned Node binary
(`NODE_VERSION` in `scripts/pack-headless.mjs`), rebuilds `node-pty`
against that ABI, and assembles a self-contained tarball at
`release/headless/harness-server-<version>-<platform>.tar.gz` plus
`.sha256`. The job uploads both as release assets — no extra step in
`scripts/release.sh` is needed. Bumping `NODE_VERSION` requires
matching the `actions/setup-node` step in the workflow.

## Common commands

| Command | What it does |
|---|---|
| `npm run dev` | Launch in dev mode (electron-vite) |
| `npm run log` | Tail the debug log file |
| `npm run log:clear` | Clear the debug log |
| `npm run log:perf` | Tail the perf trace log (append-only across sessions) |
| `npm run log:perf:clear` | Clear the perf trace log (use before a fresh repro) |
| `npm run build` | Build all three (main, preload, renderer) to `out/` |
| `npm run pack` | Build + package without distribution (no signing) |
| `npm run dist:mac` | Full signed + notarized macOS build |
| `npm run rebuild:dev` | Rebuild node-pty for dev Electron |
| `npm run release <ver>` | Full end-to-end release |
