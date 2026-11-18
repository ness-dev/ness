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
- **Shell tabs** are real PTYs. You can click into one, type `ls`, and press Enter.
- Clicking a file in the Changed files panel opens a diff view.
- Settings, the command palette, the hotkey cheatsheet, and the perf HUD.
- Creating a worktree with "Add worktree" makes a real git worktree in the fixture.

## Things that do NOT work in CI

- **Claude Code / Codex sessions**: there is no `claude` binary and no auth. A "Claude Code" terminal tab may show an error or an empty terminal, and a Chat tab can't get a response. Don't treat that as a regression caused by the PR unless the PR touches that path.
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

- Dismiss announcement banners or "Switch to the new Chat mode" pills only if they block what you need. Otherwise leave them.
- The PR diff is the source of truth for what changed. Map changed component names (`src/renderer/components/Foo.tsx`) to what they render, then find that on screen.
- Changes to `src/main/`, `src/shared/state/`, or tests often have no direct visual. Look for the user-facing behaviour they enable before falling back to `not_visual`.
