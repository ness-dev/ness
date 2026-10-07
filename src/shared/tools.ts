/** A user-defined right-column tool, discovered from
 * `<worktree>/.ness/tools/<id>/tool.json`. The directory name is the
 * id; the manifest supplies presentation. Nothing about how the panel
 * looks comes from the script's output — the script only emits markdown
 * for the body. */
export interface ToolSpec {
  /** Directory name under `.ness/tools/`. */
  id: string
  /** Panel header text. Static so the panel has a title before the
   * script has ever run (and while it's failing). */
  title: string
  /** Script path relative to the tool directory. Defaults to `run.sh`. */
  script: string
  /** Absolute path to the tool directory, exported to the script as
   * NESS_TOOL_DIR. */
  dir: string
  /** `auto` re-runs on the changed-files watcher signal and the poll
   * interval; `manual` only runs on mount and on the refresh button. */
  refresh: 'auto' | 'manual'
}

export interface ToolRunResult {
  ok: boolean
  /** Script stdout. Rendered as markdown regardless of ok, so a script
   * can format its own error output. */
  markdown: string
  /** Set when the tool failed to run at all (spawn error, timeout,
   * non-zero exit with no stdout). */
  error?: string
}

export const TOOLS_DIRNAME = '.ness/tools'
export const TOOL_MANIFEST_FILENAME = 'tool.json'
export const DEFAULT_TOOL_SCRIPT = 'run.sh'

/** Branch pre-filled alongside BUILD_CUSTOM_TOOL_PROMPT. */
export const BUILD_CUSTOM_TOOL_BRANCH = 'custom-tool'

/** Sent to the agent when the user clicks "Build a custom tool" in the
 * right column's panel menu. It lives next to the types it describes so
 * the contract has one source of truth — if the manifest fields, the env
 * vars, or the markdown mapping change, this changes with them. */
export const BUILD_CUSTOM_TOOL_PROMPT = `I want to add a custom Ness tool: a panel in this worktree's right column, backed by a script you write. Ask me what it should show if that isn't already clear from our conversation, then build it.

## Layout

Everything lives in this worktree:

    .ness/tools/<id>/
      tool.json
      run.sh          # must be executable

The directory name is the tool id. \`tool.json\`:

    { "title": "PR Comments", "script": "run.sh", "refresh": "manual" }

- **title** — the panel header. Static; it is never read from the script's output, so the panel has a title even while the script is failing.
- **script** — path relative to the tool directory, defaults to \`run.sh\`. It must stay inside the tool directory.
- **refresh** — \`"auto"\` re-runs on every git change in the worktree plus a 30s poll. \`"manual"\` (the default) runs only on mount and when the user clicks the panel's refresh button. Use \`manual\` for anything that hits the network or costs money.

## The script

- Spawned directly, so it needs a shebang — \`#!/usr/bin/env bash\`, python, node, whatever is executable.
- cwd is the worktree root.
- Env available: \`NESS_WORKTREE_PATH\`, \`NESS_BRANCH\`, \`NESS_REPO_ROOT\`, \`NESS_TOOL_DIR\`, \`NESS_TOOL_ID\`.
- **stdout is markdown and becomes the entire panel body.** Don't print anything you don't want rendered.
- stderr surfaces as an error tooltip on a non-zero exit. A script that fails but still wrote to stdout gets that output rendered anyway, so you can format your own error rows.
- Killed after 20s. Output capped at 256KB.

## Markdown vocabulary

The panel is a ~280px column, not a document. Markdown is mapped onto the same vocabulary the built-in panels use, so only these carry meaning:

- \`#\` / \`##\` → a section header bar (like "Changed Files")
- \`###\` / \`####\` → a lighter subheading
- \`- item\` → one panel row. Rows truncate, so keep them short.
- backtick code → a monospace chip; good for counts, sizes, shas
- \`**bold**\` → brightened, \`*italic*\` → dimmed
- \`>\` → an indented note, \`---\` → a divider
- tables render but are cramped; prefer rows

Images and raw HTML are dropped. Prose paragraphs look wrong here — think rows, not documents.

## Actions

Links are how a row does something:

- \`[Fix these](ness:send?text=Fix+the+failing+tests)\` — sends that text to the agent in this worktree
- \`[src/app.ts](ness:file?path=src/app.ts)\` — opens the file
- \`[Reload](ness:refresh)\` — re-runs the tool
- \`[View PR](https://github.com/owner/repo/pull/1)\` — opens in the browser

Query values must be URL-encoded. Any other link renders as inert text.

## Finishing

\`chmod +x\` the script, run it once yourself, and check the output reads as a tight list of rows rather than a wall of text. Then tell me to look — the panel shows up in this worktree's right column alongside the built-in ones, and can be reordered or hidden from the sliders menu at the top of that column. If it doesn't appear, the manifest failed to parse or the script isn't executable.

Tools are discovered per worktree, so the panel is live here on this branch while we iterate. Commit it when it's right, and it reaches everyone else on merge.`
