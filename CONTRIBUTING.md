# Contributing to Ness

Thanks for taking the time to contribute. This project is small enough that a single thoughtful PR really does move it forward — every external contribution we've gotten so far has shaped the product in ways we couldn't have anticipated.

## Ways to help

If you want to contribute anything, go ahead. Happy to review issues or PRs, usually I can get to them in a day or two.

I am also definitely interested in growing the team of people who can review/accept PRs. If you are interested in contributing at an even higher level let me know. My email is in my profile @frenchie4111

I am also specifically interested in people who want to own big forward looking features. The ones I have in mind are:

 1. A much better change review process. This is discussed a bit in [High Level Roadmap](https://github.com/ness-dev/ness/issues/31). The goal is to unify PR reviews and agent reviews into one awesome interface
 2. A better workflow from Ticket/Issue -> Worktree -> PR. I want to be able to be able to spin up a worktree in one click from my issue tracker and have an agent build it

## Development setup

See the [Setup, building, and running locally](README.md#setup-building-and-running-locally) section of the README for the canonical setup steps. Short version:

```sh
git clone https://github.com/ness-dev/ness.git
cd ness
npm install --legacy-peer-deps
npm run dev
```

The `--legacy-peer-deps` flag is required because of an `electron-vite@5` peer range.

## Testing a remote backend in Docker

Remote / multi-backend work (the WebSocket transport, the backend chip strip, the web client, SSH bootstrap) needs a `harness-server` to point at. Rather than deploying to a real box on every change, run one in a container:

```sh
npm run remote:up
```

That builds the headless server **from your working tree**, starts it, waits for it to answer, and prints a connect URL. Paste the URL into the sidebar's backend chip strip (`+`) or `File → Add Backend…` and click "Test & save" — or just open it in a browser to get the web client. The port and token are fixed, so the URL is stable across rebuilds and can be bookmarked or handed to an agent:

```
http://127.0.0.1:37291/?token=ness-dev-token
```

| Command | What it does |
|---|---|
| `npm run remote:up` | Build (cached), start, print the connect URL |
| `npm run remote:logs` | Follow the server log |
| `npm run remote:shell` | Shell inside the container |
| `npm run remote:restart` | Restart the server without rebuilding |
| `npm run remote:down` | Stop it; volumes (auth, workspace) kept |
| `npm run remote:reset` | Stop it and discard auth + workspace |
| `npm run remote:status` / `remote:url` | Is it up / what's the URL |

The iteration loop is `edit → npm run remote:up → reconnect`. The dependency layer is keyed on `package-lock.json`, so a source-only change re-runs just the bundle step.

**Agent auth.** Chat tabs need Claude credentials. `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are passed through from your host environment when set. Otherwise authenticate once inside the container — it persists in a volume across restarts and rebuilds:

```sh
npm run remote:shell
claude   # then /login
```

To share your host credentials instead and skip that entirely, `npm run remote:up -- --host-claude`. Read the warning at the top of `docker/compose.host-claude.yaml` first: it read-write bind-mounts your real `~/.claude.json`, so container agents write into the same session history and MCP config your host Claude Code uses.

**The workspace.** The server needs at least one repo to manage, so the entrypoint seeds a throwaway `sample-app` git repo and registers it as a repo root. Point it at something real with `NESS_CLONE_URL`:

```sh
NESS_CLONE_URL=https://github.com/ness-dev/ness.git npm run remote:up
```

**What this does and doesn't cover.** It's a glibc Linux backend running the same `src/main` code a real remote runs, so transport, state-sync, PTY, worktree and agent behaviour are all exercised for real — including the Linux-only paths you can't hit from macOS. It is **not** testing the shipping artifact: the image builds from source rather than installing a release tarball, so the tarball layout, the embedded Node binary and `install-headless.sh` aren't in the loop. For those, run `npm run pack:headless` inside the container (`npm run remote:shell`) and install the result, or lean on the headless smoke test in CI. Browser tabs also need a Chromium the image doesn't ship — set `HARNESS_PLAYWRIGHT_BROWSER` to one you install yourself.

Everything is loopback-only (`127.0.0.1:37291`) because the default token is fixed and well-known. Don't publish the port to a LAN; set `NESS_REMOTE_TOKEN` and bind deliberately if you need to.

## How to edit code in this codebase

Honestly - every single line of code in this codebase is written by claude. (at least all the lines I wrote). So I highly recommend using claude code to make changes (I keep Ness itself open at all times)

There is a pretty well tuned CLAUDE.md file that should be able to make changes correctly

## Before you submit a PR

The CLAUDE.md file

## Commit and PR conventions

Just all the normal things. Please make sure your agent is committing regularly. Keep PRs focussed when you can but **don't be lazy: fix cleanup issues if you find them during the course of fixing a PR**

## Architecture overview

Ness is built as three layers in one repo. Understanding the layering up front will save you a lot of "where does this go?" thrash.

### Frontend / backend split

```
┌──────────────────────────────────────────────────────────────┐
│  Renderer (React, src/renderer)                              │
│  Reads state via hooks, mutates via window.api.* calls.      │
│  Owns nothing authoritative — it's a view layer.             │
└──────────────┬───────────────────────────────────────────────┘
               │  window.api  (typed RPC surface)
               ▼
┌──────────────────────────────────────────────────────────────┐
│  Preload (src/preload)                                       │
│  Tiny: builds window.api from a Transport. Two transports:   │
│   • ElectronClientTransport — IPC to the local main process  │
│   • WebSocketClientTransport — WS to a remote harness-server │
└──────────────┬───────────────────────────────────────────────┘
               │  transport (Electron IPC or WebSocket)
               ▼
┌──────────────────────────────────────────────────────────────┐
│  Main / Backend (src/main)                                   │
│  Owns the world: store, PTYs, json-claude subprocess         │
│  manager, PR poller, file watchers, persistence.             │
│  Runs as the Electron main process OR as a standalone        │
│  headless Node server (`harness-server`).                    │
└──────────────────────────────────────────────────────────────┘
```

The backend is the *same code* whether it's running embedded in Electron or as a remote `harness-server`. The transport abstraction (in `src/main/transport-*.ts` and `src/preload/transport-*.ts`) makes this work: every IPC method has the same shape over Electron's `ipcRenderer.invoke` as over a WebSocket request frame. When you add a new IPC handler, you add it once and both transports handle it.

This is also what lets a single Electron app connect to either its embedded local backend *or* a remote `harness-server` over WebSocket (run another Mac/Linux box, point your laptop at it — see the [headless server README section](README.md#headless-server)).

### Slice-based state

There is exactly one store of truth, and it lives in the **main process** at `src/main/store.ts`. State is partitioned into slices under `src/shared/state/`:

- `worktrees`, `terminals` (statuses + panes), `prs`, `settings`, `json-claude`, `repo-configs`, `snooze`, `updater`, `hooks`, `onboarding` — roughly one slice per concern.

Each slice is:

```ts
export interface MySliceState { /* the data shape */ }

export type MySliceEvent =
  | { type: 'mySlice/somethingChanged'; payload: ... }
  | { type: 'mySlice/somethingElseChanged'; payload: ... }

export const initialMySlice: MySliceState = { /* empty defaults */ }

export function mySliceReducer(state: MySliceState, event: MySliceEvent): MySliceState {
  switch (event.type) {
    case 'mySlice/somethingChanged': return { ...state, ... }
    // ...
  }
}
```

Mutations to shared state ALWAYS go through `store.dispatch(event)`. The reducer runs, the new state replaces the old, and every subscriber is notified.

### The renderer is a passive mirror

Here's the part that's pretty nice: **the renderer applies the exact same reducer functions to its local mirror of the state**. When main dispatches an event, the transport pushes it over the wire (`state:event` IPC channel or WS frame); the renderer's `ClientStore` (`src/renderer/store.ts`) receives it and calls the same `rootReducer(state, event)`.

The renderer never needs glue code to "sync" with main — both sides apply the same pure reducer to the same event stream and end up with identical state. React components read via `useSyncExternalStore`-backed hooks (`useSettings()`, `useWorktrees()`, etc.) that subscribe to the local mirror.

To mutate state from a React component:

```tsx
// Read — re-renders this component when the slice changes.
const settings = useSettings()
const theme = settings.theme

// Mutate — fire-and-forget RPC. Main dispatches; the local mirror
// applies the same reducer; this component re-renders automatically.
window.api.setTheme('solarized')
```

The renderer **never holds a local copy** of shared state. If you're tempted to write `const [x, setX] = useState(...)` for something that came from the store, stop — read it via the hook instead.

There's one exception: high-frequency streams (PTY bytes). Those flow through their own `terminal:data` signal directly to xterm.js; putting them through the reducer would re-render the world on every byte. Anything that fires >10x per second probably wants the same treatment.

### Where to read more

The deep architecture documentation lives in [CLAUDE.md](CLAUDE.md). It's the orientation file for AI coding assistants, but most of it is just as useful for human contributors. Worth reading before non-trivial changes:

- **Architecture (read this before touching state)** — slices, events, the renderer mirror, and where to put new state. Expands on the section above.
- **Adding a new piece of shared state** — the 5-file checklist for adding a field/event to a slice.
- **Anti-patterns to avoid in slices and derivers** — common mistakes that look fine in isolation but cause perf problems at scale (subscriber sweeps, reducer `.map()` allocations, etc.).
- **How performance debugging works** — the perf log + HUD that we lean on when something feels slow.

If you're touching the Chat interface specifically (internally referred to as "json-mode"), the `plans/json-mode-native-chat.md` document has the live feature backlog and design notes.

## Code style

We don't run a strict formatter on every PR [yet](https://github.com/ness-dev/ness/issues/48), but informally the codebase prefers:

- **Don't add comments that just restate the code.** Comments are for *why* something is non-obvious, not *what* the code does. Identifier names and types should carry the *what*. If you find yourself describing the code in English, ask whether the code itself could be clearer.
- **No backwards-compatibility shims for removed code.** If something is unused, delete it cleanly — don't leave `// removed` comments or re-export shims.
- **Per-client UI state stays in `useState`.** Things that should be visible to other viewers of the same workspace (worktrees, sessions, settings) go in a slice. Modal visibility, sidebar widths, and view focus stay as renderer-local `useState`.
- **Use the dedicated helpers, not raw alternatives.** Glob/Grep over `find`/`grep`, edits over `sed`/`awk`, etc. — applies just as much to humans as to AI tooling.

## Reviewing PRs

In the spirit of the rest of the project, most reviews will be done using claude (using the PR review feature inside of Ness itself).

In a modern AI way: If there are any small nitpicks or styling issues in the PR, the reviewer's claude code instance will take care of them (and leave a related comment on the PR). This is because it's just so much faster for the reviewer to handle it than for you to take their comments and put them into your claude instance

For larger review comments then the standard comments & PR discussion process should be used. Anything that would require re-thinking the architechture or UX of the PR.

## Questions

If you're stuck or unsure about how to approach something, please open a [discussion](https://github.com/ness-dev/ness/discussions) or just put a question in an issue. We'd rather answer questions early than have a contributor build something in a direction that doesn't quite fit.

Thanks again for being here.
