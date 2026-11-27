# Expo mobile client: spike findings

**Verdict: feasible, and cheaper than expected.** An Expo app can talk to
an unmodified Ness backend (desktop WS server or `harness-server`) by
importing `src/shared/state` and `src/shared/transport` directly. There
were **no server-side changes**. The demo pairs with a backend, lists
worktrees with live status, shows a json-mode transcript, sends messages,
and allows or denies permission requests. The approval was confirmed end
to end: the approved `touch` command really ran on the host.

Verified on:

- **Expo web** in a 393×852 mobile viewport against `harness-server` over
  LAN `ws://`: the full flow, including send and approve.
- **Expo Go on the iOS 26 simulator** (iPhone 17, SDK 58, RN 0.88, Hermes):
  deep-link pairing, the native `WebSocket` connect, the snapshot and the
  live worktree list.
- **Hermes bundles** for iOS and Android (`npx expo export`), about 1.6MB each.

Not verified: a physical device, Android at runtime, the camera scan on a
device, and expo-secure-store at runtime. Those parts need a device; the
code paths follow the SDK 58 docs.

## 1. Code sharing: works with no changes to shared code

- `src/shared/**` has **no package imports** (only relative imports, plus
  `vitest` in tests), no Node built-ins and no DOM globals. Babel and Hermes
  compile it without changes.
- Setup is `mobile/metro.config.js`, which adds `../src/shared` to
  `watchFolders`. The repo isn't an npm workspace, so Expo's monorepo
  auto-config doesn't trigger. Imports are plain relative paths
  (`../src/shared/state`), and `tsc --noEmit` in `mobile/` typechecks the
  shared files too.
- **Gotcha:** don't set `resolver.disableHierarchicalLookup`. npm nests
  `expo/node_modules/expo-asset`. Web still bundles, but the iOS and Android
  bundles fail.
- The phone store is about 80 lines (`mobile/src/ness.ts`). It is the
  renderer's `ClientStore` pattern: `mergeWireSnapshot` on (re)connect,
  `rootReducer` per event, and `useSyncExternalStore` selectors.
  `ROLLUP_STATUS_RANK` and `parseConnectionUrl` are reused as-is.
- Not shareable: anything in `src/renderer` (DOM, Tailwind, xterm, Monaco).
  The UI is a rewrite. A real app would want the json-mode entry rendering
  (markdown, tool cards, diffs) factored into a renderer-agnostic model
  layer; today that logic lives in `JsonModeChat.tsx`.
- **Risk:** shared code currently happens to be RN-safe. Nothing enforces
  that. Add a lint rule or a CI step (`cd mobile && npx tsc --noEmit &&
  npx expo export`) so a stray `import 'fs'` in `src/shared` fails a PR.

## 2. Connectivity and auth

- **Token:** the server accepts `?token=` on the upgrade URL or
  `Authorization: Bearer`. `WebSocketClientTransport` uses the query
  param, which RN's `WebSocket` supports. RN can also send headers via its
  non-standard third constructor arg, but that wasn't needed.
- **`URL`/`URLSearchParams`:** the transport calls
  `url.searchParams.set(...)`. Bare RN's `URL` historically threw "not
  implemented" there; Expo's runtime ships a full polyfill, and it worked in
  Expo Go.
- **No Origin check** on the WS upgrade, so the Expo web dev server on a
  different origin connected fine. That helps this spike, but it means the
  token is the only gate (see security below).
- **Cleartext `ws://`:**
  - *iOS:* App Transport Security allows local-network hosts only with
    `NSAllowsLocalNetworking`. iOS 14+ also shows the Local Network
    permission prompt, which needs `NSLocalNetworkUsageDescription`. Both are
    set in `app.json` `ios.infoPlist`. Expo Go ships its own Info.plist, so
    these only take effect in a dev or production build, and the simulator
    test proves nothing about ATS.
  - *Android:* release builds block cleartext by default.
    `android.usesCleartextTraffic: true` is set in `app.json` for the spike.
    I haven't verified that key against the SDK 58 app.json schema; run
    `npx expo-doctor` before relying on it.
- **TLS story (recommended): Tailscale.** The phone and host join a
  tailnet, and `tailscale serve` (or `tailscale cert` with a small TLS
  front) gives `wss://<host>.<tailnet>.ts.net` with a real certificate. No
  ATS or cleartext exceptions, it works off-LAN, and the tailnet ACL adds a
  second auth layer. `parseConnectionUrl` already maps `https → wss`, so a
  `https://…ts.net/?token=…` QR would work with no client changes.
- **Security notes for productionising:**
  - The token travels in plain text on LAN `ws://`.
  - The token never rotates unless you press Rotate.
  - There is no per-device identity, so you can't revoke one phone.
  - For a phone that can approve tool calls, use per-device tokens and
    revocation, and make TLS mandatory off-LAN.

## 3. Pairing UX

- The Settings → **Web & mobile** QR encodes
  `http://<lan-ip>:<port>/?token=<64-hex>`, the same URL the web client
  opens. The app feeds it straight to `parseConnectionUrl`.
- Implemented:
  - In-app scanning: `CameraView` with `barcodeScannerSettings={{
    barcodeTypes: ['qr'] }}`.
  - Paste-a-link fallback.
  - **Deep link:** `<scheme>://pair?url=<encoded link>`. On iOS, the
    simulator test used `xcrun simctl openurl booted
    "exp://<metro>/--/pair?url=…"`.
- The connection is persisted with expo-secure-store on native and
  `localStorage` on web (web has no secure-store support), under one
  key, `ness.connection`.
- **Recommendation:** register a `ness://` scheme and have the desktop QR
  encode `ness://pair?url=…`, or a universal link. The system camera then
  opens the app already paired, and the in-app scanner becomes a fallback.
  The catch: an `http://` QR also opens the web client in a mobile browser,
  so encode both (the web client could offer an "Open in app" button) or
  show two QRs.

## 4. Minimum useful UI: channels and slices used

| Feature | Reads (slices) | Calls (channels) |
|---|---|---|
| Worktree list and status dots | `worktrees.list`, `terminals.panes`, `terminals.statuses`, `terminals.lastActive` | (none) |
| Pending-approval count | `jsonClaude.pendingApprovals` | (none) |
| Transcript | `jsonClaude.sessions[id]` | `jsonClaude:getEntries` (req) |
| Wake a slept chat | `jsonClaude.sessions[id]` | `jsonClaude:start` (req, id must be a UUID) |
| Send a message | (none) | `jsonClaude:send` (**fire-and-forget signal**) |
| Allow / deny | `jsonClaude.pendingApprovals` | `jsonClaude:resolveApproval` (req; allow must echo `updatedInput: input`) |

- A worktree's chat is a `json-claude` tab in its pane tree. The tab id is
  the session id.
- Terminal (xterm) agent tabs still give a status dot. Their transcript
  can't be read from a phone: it's PTY bytes, and the needs-approval prompt
  is in the TUI. **Mobile is effectively json-mode-only.**
- `jsonClaude:send` is a signal and `WebSocketClientTransport.send`
  **silently drops it while reconnecting**. On flaky mobile networks that
  loses messages. A mobile client should use a request variant with an ack,
  or queue locally until reconnect.

## 5. Background notifications (investigated, not built)

iOS suspends the app, and its socket, within seconds of backgrounding.
Android does the same under Doze. There's no reliable way to keep a WS
open, so "needs approval" alerts must come from push. Answering is
time-boxed but generous: Claude Code's MCP idle timeout abandons an
unanswered approval after 1800s (`approval-bridge.ts`), so a push that
gets the user back within minutes is good enough.

Recommended design:

1. **Register:** after pairing, the app gets an Expo push token
   (`expo-notifications`; this needs a dev or production build, not Expo
   Go) and calls a new request, `mobile:registerPushToken(token,
   deviceLabel)`. Main persists it in config and keys it to the pairing.
2. **Derive:** a main-side subscriber watches `jsonClaude/approvalRequested`.
   For xterm tabs it watches `terminals/statusChanged → 'needs-approval'`.
   It dedups per request id, which is the ActivityDeriver pattern (see
   CLAUDE.md anti-patterns #1 and #2). It should only push when no client
   has been active recently, otherwise the desktop user gets buzzed too.
3. **Send:** POST to Expo's push service (`exp.host/--/api/v2/push/send`),
   which relays to APNs and FCM. Keep the payload minimal (`"<branch>: Claude
   wants to run Bash"` plus request id and worktree path), because it
   transits Expo's, Apple's and Google's servers. Don't send command text
   unless the user opts in. Self-hosting APNs/FCM directly avoids the Expo
   hop but needs signing keys on every `harness-server`. A hosted relay is
   the usual compromise.
4. **Act:** use notification categories with Allow/Deny actions. Tapping
   one wakes the app briefly in the background, so it reconnects, calls
   `jsonClaude:resolveApproval` and exits. That works on LAN or Tailscale
   only. Off-network it needs either a relay that proxies to the host or a
   plain HTTP endpoint on the server, so the background task doesn't have
   to complete a WS handshake and snapshot.

Effort: about 2–3 days for push on the LAN or Tailscale path, and 1–2 weeks
if a hosted relay is in scope.

## 6. Perf

Measured against `harness-server` with this repo's 32 worktrees, using a
Node probe (`ws`) on the same wire:

| Thing | Size |
|---|---|
| Full snapshot (wire, entries stripped) | **50–63 KB**: `terminals` ~21KB, `settings` ~17KB, `worktrees` ~10KB, rest <2KB |
| One complete chat turn (user msg → tool use → answer) | ~17 events, **~20 KB** |
| Largest single frame | ~10 KB `worktrees/listChanged` (whole list resent on any change) |
| Transcript fetch (`getEntries`) | Proportional to history; 3 entries ≈ 2.7 KB |

- **The phone copes fine.** A 60KB JSON parse is about 1ms on Hermes, and
  the reducer is the same one the desktop runs. No filtering is needed for
  a first version.
- **Server-side changes worth making before shipping:**
  1. **`jsonClaude:getEntries` broadcasts.** The handler dispatches
     `jsonClaude/entriesSeeded` through the store, so *every* connected
     client receives the full transcript whenever any client opens a
     chat. Return the entries in the response only, or seed per client.
     This is the one real scaling issue.
  2. **Token deltas.** `--include-partial-messages` is on and
     `assistantTextDelta` / `assistantThinkingDelta` are events, so with N
     sessions streaming the phone receives every token of every session.
     My test turns didn't emit any deltas, so this is **unmeasured**. Before
     shipping, measure a long streamed answer with several sessions running
     at once. If it's heavy, add per-client subscription scoping, at least
     dropping delta events for sessions the client isn't viewing.
  3. `settings` (17KB) is irrelevant to the phone. A per-slice snapshot
     filter is easy, but at this size it's optional.
- Reconnect re-snapshots every time (the existing transport design). With
  mobile radio flapping that's 60KB per reconnect, which is acceptable.

## 7. Parity with the web client's mobile view

The app is a port of the web client's phone layout (`MobileApp.tsx`,
`WorktreeList variant="touch"`, `JsonModeChat.tsx`). To keep behaviour
identical by construction, it **imports the renderer's pure model code**,
not just `src/shared`:

| Reused as-is from `src/renderer` | Drives |
|---|---|
| `merge-backend-states.ts` (`getMergedWorktrees`) | multi-backend merge, including one section per repo across hosts |
| `worktree-list-model.ts` (`buildWorktreeListBase`, `applyProjectAccordion`) | project rows, groups, accordion, archive tail, pending rows |
| `worktree-row-style.ts`, `pending-tool.ts` | status/PR colours, the pending-tool line |
| `json-mode-cards/grouping.ts`, `turn-collapse.ts`, `tool-timeline.ts`, `tool-display.ts`, `automation-label.ts` | sub-agent nesting, turn folding, tool group labels, tool icons, labels and intents |
| `fuzzy.ts`, `uuid.ts` | slash/model popover, new-chat ids |

How that works:

- **Metro.** It watches all of `../src`. A `resolveRequest` guard resolves
  every package import made from `../src` against `mobile/node_modules`,
  so the Electron app's React can never load. A check confirmed the
  bundle has a single React.
- **Icon shims.** `tool-display` imports `lucide-react` and `react-icons/si`.
  Metro serves those as `src/shims/*`: lucide-react-native (same icon
  names), plus a brand-icon stand-in. `src/tw.ts` maps the desktop's
  `className="icon-sm text-danger animate-pulse"` to RN props. The two
  desktop icons that draw raw `<svg>` fall back to a wrench via an error
  boundary.
- **One desktop refactor.** `automationLabel` moved out of
  `JsonModeChat.tsx` into its own module, so both clients import it.

**Ported behaviour.** Each item mirrors the named file.

- **Shell** (`MobileApp`):
  - All tab types appear, with the web's icons.
  - The first tab picked is agent, then shell, then the first tab.
  - Selecting a tab wakes it on the rising edge (`panes:wakeTab`).
  - `panes:ensureInitialized` runs on worktree change.
  - `worktrees:refreshList` and `prs:refreshAllIfStale` run once per backend.
  - The New chat tab is `{id = sessionId = uuid}`.
  - Tapping the active tab opens "Switch to Chat/Terminal mode"
    (`panes:convertTabType`).
  - Diff, file and browser tabs show desktop-only placeholders.
- **Picker** (`WorktreeList` touch):
  - The header has unified/split, refresh (`prs:refreshAll`) and close,
    plus a Backends button.
  - Rows show the status dot (pulsing), shell spinner, pin, PR icon with
    review dot, agent-review icon, alias, stale badge, and the subtitle:
    detail prefs from settings, age, diff, milestone, PR pill.
  - The "…" sheet offers Alias/Rename, Clear Alias, Pin/Unpin, and
    Snooze/Wake (`settings.snoozeDefaultDays`).
  - Inline alias editing goes through `aliases:set`.
  - Group and tail collapse and project keep-open use the same storage
    keys as the web.
- **Chat** (`JsonModeChat`):
  - Start only when awake and no session exists. History is fetched once.
  - `setComposerVisible` tracks app foreground.
  - The first keystroke wakes a slept tab. `touchLastActive` is
    debounced to 5s.
  - Pipeline: `buildChildrenMap`, then the results map, then a
    150-entry window ("Show N earlier" / "Show all"), then `renderEntries`,
    `foldFinishedTurns`, and `groupConsecutiveToolRows`.
  - Cards: Bash, Edit, MultiEdit (unified diff with gutters via `diff`),
    Write, Read, Grep, Glob, TodoWrite, Task (nested sub-agent
    transcript), and Generic (parsed/raw args).
  - Other entries: thinking, compact, exit/restart, auth, agent-error,
    rate-limit, held notices, automated turns, queued bubbles with cancel.
- **Approval card** (`JsonClaudeApprovalCard`):
  - Allow once.
  - Allow `<tool>` this session (the permission-mode flip for edits).
  - Allow with edits.
  - Always allow… with the pattern ladder.
  - Deny with reason and interrupt.
  - Auto-approver status, and Edit guidance with Save & re-review.
  - AskUserQuestion goes to the question card.
- **Composer:**
  - State dot.
  - Permission pill that cycles mid-turn.
  - interrupt, and interrupt & send.
  - Send, which snaps the transcript to the bottom.
  - `/` popover with the two-stage `/model` picker.
  - The auto-allow strip with clear.
  - Density follows `settings.jsonModeChatDensity`.

**Deliberate differences, for a phone:**

- **Selection is remembered.** Last worktree and per-worktree tab are
  restored across launches. The web starts at `worktrees[0]` every time.
  The restore waits for every backend's snapshot (capped at 3s), so a
  slow host can't overwrite the saved choice.
- **Composer text.** No hotkey hints. The placeholder is "Message
  Claude", and Return inserts a newline unless send-on-Enter is on.
- **Origin badge.** Shown on rows only when more than one backend is
  enabled.
- **Larger tap targets.**
  - Every button and row in the picker is at least 44×44pt (audited).
  - Chat rows keep the web's density but get `hitSlop` to roughly 44pt.
  - Approval buttons are 44pt.
  - The composer buttons are 36pt.
- **Two new deep links:** `<scheme>://pair?url=…` and
  `<scheme>://open?wt=…&tab=…`. The second is also what an approval push
  notification would open.

**Fixed while porting** (the desktop fix is committed separately):

- **Auto-sleep fix (desktop).** `panes:wakeTab` now counts as activity.
  Previously, opening an idle chat from any phone woke it, and the next
  auto-sleep sweep (within 60s) slept it again, because nothing touches
  `lastActive` until a keystroke.
- **Modal replaced.** react-native-web's `Modal` failed to reopen after a
  close and kept a focus trap. The sheet and menu are now in-tree overlays.
- **Composer focus.** Focus returns to the input after a popover pick.

**Not ported yet:**

- **Terminal tabs.** Deferred to its own worktree, as agreed.
- **New worktree screen and the details panel.** The details panel is PR
  status, merge, commits and cost: about 1,750 lines of desktop UI.
- **Composer extras.** @-mentions, image attachments, prompt suggestions,
  and the drag-to-resize handle.
- **Transcript extras.** Find-in-chat (no on-screen trigger on the web
  either) and rewind/fork (right-click only on the web; long-press would
  be the phone equivalent).
- **Brand icons.** They show as a plug icon.
- **Markdown.** Rendering is minimal: no tables, and no syntax
  highlighting.

**Tested:**

- **Expo web**, at 393×852 against two `harness-server`s, covered all of
  the above:
  - picker accordion, the pin/alias/unpin round trip, and restore across
    reloads;
  - wake on keystroke, history, tool grouping, every approval mode
    (Allow once executed for real), permission pill, slash and model
    popovers, streaming, and interrupt.
- **Performance on web:** 0 long tasks (main-thread blocks over 50ms)
  across 40s of a streamed 700-word markdown answer, on desktop CPU.
- **iOS simulator (Expo Go, Hermes):** the shell and a chat render
  identically, including the svg and lucide icons through the shim, and
  the deep link works.

**Not tested:**

- Native *interactions*: the simulator can't take synthetic taps with
  this Xcode.
- The queued-message path (the turn finished before the follow-up
  arrived).
- The jump-to-bottom pill: the hidden test tab never runs `scrollTo`.
- On-device Hermes performance.
- Android at runtime.

**Bundle:** the Hermes bundle is 4.6MB, up from 1.6MB, mostly the whole
lucide icon set behind the shim. A babel import-rewrite to per-icon
modules would recover most of it.

## 8. The tools panel (right column)

Both phone clients now have the desktop's **full** right column, not the
web client's old four-panel subset.

- **Web client:** `RightColumn` was split into `useRightPanelConfig`
  (tools list, effective order/visibility, `repoConfig:set` writers) and
  `RightPanelStack`. The desktop column and `MobileRightPanel` both render
  them, so the phone web sheet gets every panel in the repo's order, plus
  the visibility/reorder toolbar and "Build a custom tool…". The latter
  pre-fills the phone's new-worktree screen, like the desktop.
  - The diff, file and review openers became optional props. The phone
    omits them, so those rows don't open a tab it can't render.
  - Touch-only (`pointer-coarse:`) sizing gives the toolbar, panel headers
    and header actions 44px targets. Measured: all 16 buttons in the sheet
    are at least 44×44; they were 12–40px before.
- **App:** `mobile/src/panels/` contains `PanelsHost`, a ported
  `RightPanel` chrome and a ported `useWatchedQuery` (watch and invalidate
  signals plus a fallback poll), and RN ports of every panel:
  - PR Status and Merge Locally
  - Branch Commits, with the commit popover
  - Changed Files and All Files
  - Todos, Agents, Subscriptions
  - Cost and Context, with the same interest gates
  - Scratchpad
  - custom tools

  Visibility and order edits write the repo's `.ness.json`, the same file
  the desktop toolbar uses (verified).
- **Shared rules:**
  - Send-to-agent uses the desktop's routing (selected tab, else the
    pane's active tab, else the first agent or chat tab).
  - Removing a worktree from either phone UI always asks first.
- **Desktop fixes found on the way:** several panels used `*-error` /
  `text-text` classes that aren't theme tokens, so the Context meter's
  tool rows, the Cost/Context totals, the GitHub API log errors and the
  perf HUD rendered colourless. They now use `danger` / `fg`.
- **Verified on Expo web**, read-only on real repos:
  - PR #421's data, the checks list and the commit popover.
  - In the throwaway repo: visibility/order round-trip into `.ness.json`,
    Merge Locally's main-worktree check, the Scratchpad save across a
    reload, and Cost and Context loading live data on expand.
- **Not tested:** merge, approve and remove on a real PR/worktree
  (deliberately not run); Todos and Agents with live data; Subscriptions;
  a repo with custom tools.
- **React Native's `Alert` is a no-op on react-native-web**, so the app's
  long-press detail popups and confirmations only appear on native.

## Driving the simulator (agent testing)

- **What works:** Xcode 27 ships an MCP server, `xcode-tools`
  (`xcrun mcpbridge`). Its `DeviceInteraction*` tools tap, swipe and type,
  and return a screenshot plus the UI hierarchy after each action. It's
  registered with Claude Code for this repo (`claude mcp add xcode --
  xcrun mcpbridge`). This agent is approved; approval is raised by
  `XcodeNewProject` / `XcodeOpenWorkspace` on a throwaway project.
- **What didn't work:**
  - `idb` taps fail on Xcode 27: SimulatorKit moved to
    `Contents/SharedFrameworks`.
  - Device interaction needs an **iOS 27+ simulator**.

## Recommended architecture to productionise

- **Keep** importing `src/shared` directly. Enforce RN-safety in CI with
  `tsc` plus `expo export` for `mobile/`.
- Move the mobile store into a small `src/shared/client-store.ts` that both
  the renderer and mobile use, instead of duplicating it.
- Keep the renderer's model layer DOM-free (it mostly is). The one coupling
  that forced shims is `tool-display.ts` owning icon components; splitting
  labels from icons would remove the `lucide-react` shim.
- Navigation: Expo Router (done). Routes live in `src/app/` (the table is in
  `src/app/_layout.tsx`); screens are in `src/screens/`, and shared
  connections, the fleet and the theme are in `src/workspace.tsx`.
- Transcript rendering: build an RN markdown renderer plus tool-call
  summaries. Reuse the `JsonClaudeChatEntry` model, not the DOM components.
- Server:
  - Make `getEntries` respond only to the asking client.
  - Add an acked send.
  - Optionally add per-client event scoping.
  - Add a push-token registry with an approval push deriver.
  - Issue per-device tokens.
- Transport: Tailscale `wss` by default, with LAN `ws` as an opt-in.

**Rough effort:**

- About 1 week for a polished LAN/Tailscale v1: list, transcript, send,
  approve.
- Plus 2–3 days for push notifications.
- Plus 1–2 weeks for a hosted relay, off-network approvals and per-device
  auth.
- Plus App Store and Play review overhead.

## Future work

Each item is meant for its own worktree.

- **Development build.** Move off Expo Go (`npx expo run:ios` / EAS) so
  the app can ship native modules. Several items below need it.
- **First EAS builds** (`eas build --profile preview|production`). OTA
  updates are wired up (`mobile-update.yml`, project `@mikepersonal/ness`)
  but only reach EAS-built apps. Needs `ios.bundleIdentifier` /
  `android.package` (permanent once on a store) and Apple / Google
  credentials.
- **Terminal and Shell tabs.** Currently a "terminal tabs don't work
  yet" placeholder.
- **File and diff viewer** from Changed Files, All Files and commits.
  Wanted before launch.
- **"Switch to Chat mode" button** on the terminal placeholder. Wanted
  before launch.
- **Paged history loading.** A server change so long transcripts arrive
  in pages instead of one `getEntries` response.
- **Polish:**
  - Visual tap targets under 44pt: the permission pill (20pt), chat fold
    rows (26pt), context breakdown rows (28pt).
  - The "@" in Changed Files rows isn't its own VoiceOver element.
  - No ellipsis on the tool-group summary line.
  - The lucide shim pulls in the whole icon set; the bundle is about
    4.6MB.
- **Phone-only theme override.** The app follows the first backend's
  theme today.
- **More regression coverage:**
  - A fake `claude` for the contract test, to cover starting a chat,
    streaming and approvals.
  - Render tests (jest-expo) for screens that crash on unexpected state.

## Running the spike

```sh
# backend (from repo root)
npm run build:headless
HARNESS_DATA_DIR=./.headless-data HARNESS_WS_HOST=0.0.0.0 node dist-headless/main/index.js
#   → prints "[web-client] open http://<lan-ip>:37291/?token=…"

# app
cd mobile && npm install
npx expo start --web     # or --ios / --android (Expo Go)
# paste the printed link, scan the Settings QR, or deep-link:
xcrun simctl openurl booted "exp://<lan-ip>:8081/--/pair?url=<url-encoded link>"
```

Note: starting `harness-server` installs Ness's status hooks into
`~/.claude/settings.json`, `~/.codex/hooks.json` and `~/.cursor/hooks.json`,
the same as the desktop app does.
