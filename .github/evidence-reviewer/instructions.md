You are looking at **Ness**, a desktop app for running many coding agents (Claude Code, Codex) across git worktrees. In CI it runs as its headless server, and you see its **web client** in Chromium. The web client is the same React UI as the desktop app, with a few desktop-only bits (native window controls, native browser panes) missing.

## Fixture data

The app is seeded with a fixture repo `acme-app` that has three worktrees:

| Worktree | State |
|---|---|
| `main` | Two commits, clean |
| `feature/login` | One commit ahead of main (`src/login.ts`), plus one uncommitted edit to that file |
| `fix/readme-typo` | One uncommitted edit to `README.md`, no commits |

The repo has no GitHub remote, so PR badges, CI status and "Request AI review" have no real data. If a PR is about those features, say that the fixture can't exercise them rather than guessing.

## Layout

- **Left sidebar**: "WORKTREES" header, an "Add worktree" button, then worktrees grouped into sections ("Active", "Needs Attention", and others). Click a worktree row to select it. Its tabs appear nested under the row. A footer row of icon buttons sits at the bottom.
- **Top bar**: the repo / worktree breadcrumb, then the tab strip for the selected worktree. New worktrees start with a "Claude Code" terminal tab and a "Shell" tab.
- **Center**: the active tab's content (terminal, chat, browser, diff review).
- **Right column ("TOOLS")**: collapsible sections: Merge locally, Pull request, Commits, Changed files (Uncommitted / Committed), All files, Cost, Context.

## Things that work in CI

- Selecting worktrees, opening and closing tabs, splitting panes, and the sidebar context menus (right-click a worktree row).
- **Opening tabs.** The top bar, right of the breadcrumb, has a sparkle button (tooltip "New Chat tab" or "New Claude Code tab"; shift-click for the other mode, and the chevron beside it lists the options). It also has "New shell tab" and "New browser tab" buttons. A **Chat tab** opens and renders its UI even though it can't get a model reply, so UI that only appears for Chat tabs (some right-column panels, chat cards, composer controls) can still be reached this way.
- **Shell tabs** are real PTYs. You can click into one, type `ls`, and press Enter.
- Clicking a file in the Changed files panel opens a diff view.
- Settings, the command palette, the hotkey cheatsheet, and the perf HUD.
- Creating a worktree with "Add worktree" makes a real git worktree in the fixture.

## Things that do NOT work in CI

- **Claude Code / Codex sessions**: there is no `claude` binary and no auth. A "Claude Code" terminal tab shows `claude: command not found` and a "Claude Code exited. Start a new session" card. A Chat tab can't get a response. The right column shows "Connect a GitHub token" under Pull Request. All of that is expected. Don't treat that as a regression caused by the PR unless the PR touches that path.
- GitHub data: PR status, checks, merge buttons, and AI review requests.
- Native desktop features: menu bar, dock, OS notifications, "Open in editor", and Electron browser panes.

## Hotkeys

On this Linux runner, "Cmd" means the **Meta** key, so use `Meta+…` with the press tool.

| Action | Key |
|---|---|
| Command palette | `Meta+k` |
| Settings | `Meta+,` |
| Hotkey cheatsheet | `Meta+Shift+/` |
| New shell tab | `Meta+t` |
| Close tab | `Meta+w` |
| Next / previous worktree | `Meta+ArrowDown` / `Meta+ArrowUp` |
| Worktree N | `Meta+1` … `Meta+9` |
| Toggle sidebar | `Meta+b` |
| Toggle right column | `Meta+Shift+b` |
| Split pane right / down | `Meta+d` / `Meta+Shift+d` |
| Tab history back / forward | `Meta+[` / `Meta+]` |
| File quick-open | `Meta+p` |
| Perf HUD | `Meta+Alt+p` |

If a hotkey seems to do nothing, click somewhere neutral in the center pane first so the page has focus, then try again. Hotkeys can be swallowed while a terminal has focus.

## Tips

- **Hidden panels.** Not every right-column panel is visible by default. The sliders button next to "TOOLS" (labelled "Panel visibility") opens a menu that lists every panel with a show/hide toggle. If a PR adds or changes a right-column panel and you can't see it, check this menu before deciding it doesn't exist. Some panels only appear for certain tab types, such as Chat tabs.
- **find_text is a lead, not evidence.** It searches the whole DOM, including content scrolled out of view. When it finds the text you want, scroll that region (use scroll with the id of an element inside it) until the text is on screen, then capture. A claim backed only by find_text stays inconclusive.
- **Settings are long.** Settings opens to a section list, and each section scrolls. Pick the section first, then scroll inside the content pane, not the page.

- Dismiss announcement banners or "Switch to the new Chat mode" pills only if they block what you need. Otherwise leave them.
- The PR diff is the source of truth for what changed. Map changed component names (`src/renderer/components/Foo.tsx`) to what they render, then find that on screen.
- Changes to `src/main/`, `src/shared/state/`, or tests often have no direct visual. Look for the user-facing behaviour they enable before falling back to `not_visual`.
