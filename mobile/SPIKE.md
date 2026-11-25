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

## 7. Looking like Ness, with several backends

The UI is a port of the web client's mobile layout (`MobileApp.tsx`):

- **Top bar:** the worktree switcher (repo name, branch) and that
  worktree's chat tabs with status dots, plus a `+` for a new chat
  (`panes:addTab` then `jsonClaude:start`).
- **Worktree sheet:** a project card per repo, then the sidebar's groups
  (Open PRs / Active / …) from the shared `groupWorktrees()`. Rows show the
  status dot, PR icon, age, `+adds −dels` and a `#PR` pill.
- **Chat:** finished turns fold into "Worked for 28s · 3 tools" (a
  simplified `foldFinishedTurns`). The live turn shows tool lines and a
  "Working · Ns" row. User bubbles use `accent/10`, and the approval card
  copies `JsonClaudeApprovalCard`.
- **Composer:** state dot, permission-mode pill and Send, plus Stop while
  busy.

Colours and sizes come from the web client's computed `--color-*`
variables (`mobile/src/theme.ts`). Icons are `lucide-react-native`, the RN
sibling of the desktop's `lucide-react`.

Two small helpers, `formatTurnDuration` and `formatWorktreeAge`, are
*copied* from `src/renderer`, because Metro only watches `src/shared`.
Moving them (and the turn-folding model) into `src/shared` is the first
refactor for a real app.

**Multiple backends.** The app keeps a saved list (`ness.backends` in
secure-store), each entry with an enable switch, and runs one `NessClient`
(transport plus store) per enabled backend. The desktop's `BackendsRegistry`
is the same shape. The worktree sheet lists every backend's repos, tagged
with the backend label when more than one is enabled. Re-pairing the same
host, for example after a token rotate, replaces the saved entry.

This was verified on Expo web against two `harness-server`s at once: this
repo, and a throwaway repo labelled "Build box". The test switched between
them, started a new chat on the second, and allowed two tool calls there.
The same build renders in Expo Go on iOS.

Unlike the desktop, it doesn't merge the same repo across backends into one
section (`worktree-list-model.ts` does that by origin URL). That would be a
straightforward port if wanted.

## Recommended architecture to productionise

- **Keep** importing `src/shared` directly. Enforce RN-safety in CI with
  `tsc` plus `expo export` for `mobile/`.
- Move the mobile store into a small `src/shared/client-store.ts` that both
  the renderer and mobile use, instead of duplicating it.
- Navigation: switch to Expo Router (the spike uses state-switched screens
  in one file).
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
