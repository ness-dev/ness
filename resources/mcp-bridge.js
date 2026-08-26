#!/usr/bin/env node
// Ness MCP bridge — minimal MCP stdio server that forwards tool calls
// to the Ness control HTTP server running inside the Electron main process.
// Spawned by Claude Code via `ELECTRON_RUN_AS_NODE=1 <electron-binary> <this>`.
//
// To debug issue #167: tail /tmp/harness-control-bridge.log while spawning
// new chat tabs in dev mode. If a tab fails with "MCP tool not found", check:
//   * No "started" line at all → script never ran
//   * "started" but no "initialize received" → claude dropped the stdio pipe
//   * "initialize received" + "tools/list received" + exit → claude exited the
//     child intentionally after handshake; "tool not found" is then a
//     separate issue (config wasn't actually passed to claude's MCP discovery).

const http = require('http')
const readline = require('readline')
const fs = require('fs')

// Logger has to be defined BEFORE the env-var check so we can still record
// "the script started but env was empty" — otherwise that case looks
// identical to "the script never ran" in /tmp/harness-control-bridge.log.
const LOG_PATH = process.env.HARNESS_CONTROL_BRIDGE_LOG || '/tmp/harness-control-bridge.log'

try {
  const st = fs.statSync(LOG_PATH)
  if (st.size > 10 * 1024 * 1024) {
    fs.truncateSync(LOG_PATH, 0)
  }
} catch { /* ignore */ }

function logErr(...args) {
  const line = '[harness-mcp] ' + args.join(' ') + '\n'
  try { process.stderr.write(line) } catch { /* ignore */ }
  try { fs.appendFileSync(LOG_PATH, new Date().toISOString() + ' ' + line) } catch { /* ignore */ }
}

// Must not call logErr — a broken stderr would re-enter the handler.
function logFatal(kind, err) {
  try {
    fs.appendFileSync(
      LOG_PATH,
      new Date().toISOString() + ' [harness-mcp] ' + kind + ' ' + (err && err.stack || String(err)) + '\n'
    )
  } catch { /* ignore */ }
}

// Issue #167 debug. Logs BEFORE env-var validation so the line fires even
// when claude spawns us with missing env. The "started" line is the canary
// for "did claude even attempt to launch this script."
logErr(
  'started pid=' + process.pid +
  ' terminalId=' + (process.env.HARNESS_TERMINAL_ID || '') +
  ' sessionId=' + (process.env.HARNESS_SESSION_ID || '') +
  ' port=' + (process.env.HARNESS_PORT || '') +
  ' worktreeId=' + (process.env.HARNESS_WORKTREE_ID || '') +
  ' isMain=' + (process.env.HARNESS_IS_MAIN === '1' ? '1' : '0') +
  ' argv=[' + process.argv.map((a) => a.split('/').pop()).join(',') + ']' +
  ' nodeVersion=' + process.version +
  ' electronAsNode=' + (process.env.ELECTRON_RUN_AS_NODE || '') +
  ' execPath=' + process.execPath
)
process.on('exit', (code) => logErr('exit code=' + code))
process.on('uncaughtException', (err) => { logFatal('uncaught', err); process.exit(1) })
process.on('unhandledRejection', (err) => { logFatal('unhandledRejection', err) })

const PORT = process.env.HARNESS_PORT
const TOKEN = process.env.HARNESS_TOKEN
const TERMINAL_ID = process.env.HARNESS_TERMINAL_ID || ''

// Scope set at spawn by src/main/mcp-config.ts. The server re-resolves
// scope from TERMINAL_ID on every call (authoritative), so these are a
// best-effort hint used to customize the advertised tool list/descriptions
// for feature-worktree callers. Can go stale if the session teleports.
const SCOPE = {
  worktreeId: process.env.HARNESS_WORKTREE_ID || '',
  repoRoot: process.env.HARNESS_REPO_ROOT || '',
  isMain: process.env.HARNESS_IS_MAIN === '1'
}

if (!PORT || !TOKEN) {
  logErr('HARNESS_PORT and HARNESS_TOKEN required — exiting')
  process.exit(1)
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

// Backstop only. Node's http client has no default request timeout, so a
// control-server handler that never responds would hang the tool call — and
// therefore the agent — forever. Sits well above every server-side timeout so
// the server's own (more specific) error wins the race in the normal case.
const CALL_TIMEOUT_MS = Number(process.env.HARNESS_CALL_TIMEOUT_MS) || 60_000
// Worktree creation legitimately blocks on git fetch / PR checkout.
const WORKTREE_CREATE_TIMEOUT_MS = 300_000

function callControl(method, path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined
    const limit = timeoutMs || CALL_TIMEOUT_MS
    const req = http.request(
      {
        host: '127.0.0.1',
        port: Number(PORT),
        path,
        method,
        headers: {
          Authorization: 'Bearer ' + TOKEN,
          'Content-Type': 'application/json',
          'X-Harness-Terminal-Id': TERMINAL_ID,
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
        }
      },
      (res) => {
        let chunks = ''
        res.on('data', (c) => (chunks += c))
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(chunks ? JSON.parse(chunks) : {})
            } catch (e) {
              reject(new Error('bad json from Ness: ' + chunks))
            }
          } else {
            reject(new Error('Ness HTTP ' + res.statusCode + ': ' + chunks))
          }
        })
      }
    )
    req.setTimeout(limit, () => {
      // The 'timeout' event only fires — it doesn't abort — so destroy first.
      req.destroy(new Error('Ness did not respond within ' + limit + 'ms: ' + method + ' ' + path))
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

// Every other browser tool bounds its output (console logs at 200 entries,
// clickables at 500 items, screenshots at JPEG q70). Raw outerHTML is 1-5MB on
// a heavy page, which is a context-blowing tool result.
const DOM_DEFAULT_MAX_BYTES = 100_000
const DOM_HARD_MAX_BYTES = 2_000_000

function truncateDom(html, maxBytes) {
  const requested = Number(maxBytes)
  const cap = Number.isFinite(requested) && requested > 0
    ? Math.min(Math.round(requested), DOM_HARD_MAX_BYTES)
    : DOM_DEFAULT_MAX_BYTES
  const total = Buffer.byteLength(html, 'utf-8')
  if (total <= cap) return html
  const head = Buffer.from(html, 'utf-8').subarray(0, cap).toString('utf-8')
  return (
    head +
    '\n<!-- truncated by Ness: showing the first ' +
    cap +
    ' of ' +
    total +
    ' bytes. Pass max_bytes to raise the cap, or use get_tab_clickables for a compact view. -->'
  )
}

// Appended to create_worktree's description, and removed again by
// stripForkAffordance when the feature is off. Kept as its own constant so the
// two stay in sync — a literal that drifts would silently stop being stripped.
const FORK_DESCRIPTION_SENTENCE =
  ' The new tab normally starts as a blank conversation seeded with initialPrompt; set forkConversation to instead hand it a copy of THIS conversation to continue from.'

const TOOLS = [
  {
    name: 'create_worktree',
    description:
      "Create a new git worktree in a Ness-managed repo. Either create a brand-new branch (set branchName) OR check out an existing GitHub PR for review (set prNumber). Ness will open a new agent chat tab inside the new worktree automatically. Defaults to the caller's current repo when repoRoot is omitted." +
      FORK_DESCRIPTION_SENTENCE,
    inputSchema: {
      type: 'object',
      properties: {
        branchName: {
          type: 'string',
          description:
            'Name of the new branch to create for the worktree. Required when not creating from a PR.'
        },
        prNumber: {
          type: 'integer',
          minimum: 1,
          description:
            'GitHub PR number to check out for review. When set, Ness fetches refs/pull/<n>/head into a local branch named after the PR head (or `<headBranch>-pr-<n>` if taken locally) and opens a worktree against it. Useful for "review this PR" workflows.'
        },
        repoRoot: {
          type: 'string',
          description:
            "Absolute path to the repo root. Optional — defaults to the caller's current repo."
        },
        baseBranch: {
          type: 'string',
          description:
            "Branch to fork the new worktree from. Defaults to the repo's configured base. Ignored when prNumber is provided."
        },
        initialPrompt: {
          type: 'string',
          description:
            'A prompt to automatically send to the agent chat tab when it opens in the new worktree. Useful for "review this PR for X" or "implement feature Y" prompts. When prNumber is set and this is omitted, Ness uses the configured PR review prompt (Settings → Worktrees → PR review prompt). Pass an empty string to explicitly suppress any kickoff prompt on the PR path.'
        },
        agentKind: {
          type: 'string',
          enum: ['claude', 'codex'],
          description:
            "Which CLI agent to spawn in the new worktree's first tab. Defaults to the user's configured default agent (Settings → Agent)."
        },
        model: {
          type: 'string',
          description:
            "Model string to pass to the agent CLI's --model flag for this worktree's first tab (e.g. 'opus', 'sonnet-4-5', 'gpt-5'). Pinned per-tab — survives reloads, doesn't affect other worktrees. Omit to use the global default (Settings → Agent)."
        },
        alias: {
          type: 'string',
          description:
            'Optional display alias applied to the new worktree once creation succeeds. Same semantics as set_worktree_alias — trimmed and clamped to 80 chars, empty string is ignored. Useful when the user gave the task a memorable label ("call this one auth-refactor") so the sidebar/window title show that instead of the branch name.'
        },
        forkConversation: {
          type: 'boolean',
          description:
            'Copy YOUR current conversation into the new worktree, so its agent resumes holding everything said here instead of starting blank. Only works when you are a Ness Chat tab with existing history; otherwise the call is rejected and you should retry without it. Cannot be combined with prNumber.\n\nFORK when the new worktree continues THIS thread of work. Strongest signal: the user asks for continuity — "pick up where we left off", "they should already know what we discussed", "carry on from here". Take that at face value; it is a request to fork, and answering it with a hand-written briefing instead is the wrong call. Also fork when the work leans on things that only exist in this conversation: what you already read and ruled out, why the user rejected an earlier approach, a design the two of you converged on over several turns.\n\nDO NOT FORK for a task that merely sits next to this one ("also fix the flaky test", "do the same on the other service"), for a clean retry after an approach failed, or for reviewing someone else\'s code. There the history is noise the new agent must read past.\n\nDeciding: do not ask yourself whether you COULD write a sufficient briefing — you almost always can, so that question always answers "no fork" and is useless. Ask instead what the briefing would have to contain. If it needs to relay specific findings, discarded options, or user decisions from this conversation, fork: the transcript already holds those, faithfully, and your summary of them will be lossier than you expect. If it would just be a task description someone could have written before this conversation started, do not fork.\n\nCost of forking, so you can weigh it: the transcript is full of your earlier file edits, but the new branch is cut from the base ref, so it does NOT contain your uncommitted work and may not contain your commits. Ness prepends a note telling the new agent where it now is and which of those changes actually survived, and it will spend a little effort re-verifying before it builds.\n\nWhen you fork, still pass initialPrompt — it lands right after that note and is what actually directs the new agent. Write it as a continuation ("now build the page we just planned, here") and do not re-explain what the conversation already contains.'
        }
      }
    }
  },
  {
    name: 'list_worktrees',
    description:
      "List git worktrees currently managed by Ness, with the same status Ness groups the sidebar by. Each entry carries `status` + `statusLabel`: 'merged' (Merged / Closed — the work landed, treat it as finished), 'needs-attention' (open PR of yours with failing checks, conflicts, or changes requested), 'active' (Open PRs — yours, healthy, awaiting review), 'reviewing' (someone else's PR you're reviewing), 'no-pr' (labelled Active — a branch with no PR yet, i.e. work still in progress), 'snoozed' (deliberately parked). Note 'active' means \"has an open PR\" and 'no-pr' is the one labelled Active — read statusLabel, not the key. `prunable: true` means the directory was deleted and only a stale git ref remains. Entries also carry `alias` when the user has named the worktree — that's the name to pass to send_message, and the name a message from it will show. This describes PR/review state, NOT whether an agent is currently running there; Ness does not report agent liveness.",
    inputSchema: {
      type: 'object',
      properties: {
        repoRoot: {
          type: 'string',
          description: 'Optional repo root to filter by.'
        }
      }
    }
  },
  {
    name: 'list_repos',
    description: 'List the repo roots currently open in Ness.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'set_worktree_alias',
    description:
      "Set a user-facing display alias for a worktree. The alias replaces the branch name wherever the worktree is shown in Ness (sidebar, window title, tab strip, palette) — a cosmetic rename that never touches git. Defaults to the caller's current worktree when worktreePath is omitted. Aliases are trimmed and clamped to 80 chars; an empty string clears the alias (prefer clear_worktree_alias for that).",
    inputSchema: {
      type: 'object',
      properties: {
        alias: {
          type: 'string',
          description:
            'The alias to display. Trimmed and clamped to 80 characters. Empty string clears the alias.'
        },
        worktreePath: {
          type: 'string',
          description:
            "Absolute path of the worktree to alias. Optional — defaults to the caller's current worktree."
        }
      },
      required: ['alias']
    }
  },
  {
    name: 'rename_worktree',
    description:
      "Rename a worktree's git branch and/or set its display alias. Defaults to the caller's own worktree when worktreePath is omitted, so an agent can rename itself. Pass branchName, alias, or both in one call.\n\nThe branch rename is a real `git branch -m` — the folder on disk keeps its original name (it's what every open tab, terminal and running process is anchored to), so a worktree whose directory and branch names disagree is expected, not a bug. Renaming is refused once the branch has been pushed, because the renamed local branch would still push to the old remote ref: on a published branch, set an alias instead.\n\nWhen Ness created this worktree from a kickoff prompt alone, it guessed the branch name and asked you to call this tool with a better one. Do that in a single call, then get on with the work.",
    inputSchema: {
      type: 'object',
      properties: {
        branchName: {
          type: 'string',
          description:
            'New git branch name. Kebab-case, no spaces (slashes are allowed, e.g. `fix/login-redirect`). Rejected rather than silently sanitized if it is not a valid branch name, or if a branch by that name already exists.'
        },
        alias: {
          type: 'string',
          description:
            'Display alias shown instead of the branch name in the sidebar, window title, and tab strip. Short and human — Title Case with spaces ("Login Redirect", "PR 214 Review"), not a kebab-case slug that just repeats the branch name. Trimmed and clamped to 80 chars.'
        },
        worktreePath: {
          type: 'string',
          description:
            "Absolute path of the worktree to rename. Optional — defaults to the caller's own worktree."
        }
      }
    }
  },
  {
    name: 'clear_worktree_alias',
    description:
      "Remove the display alias for a worktree so it shows its branch name again in Ness. Defaults to the caller's current worktree when worktreePath is omitted. No-op if no alias was set.",
    inputSchema: {
      type: 'object',
      properties: {
        worktreePath: {
          type: 'string',
          description:
            "Absolute path of the worktree whose alias to clear. Optional — defaults to the caller's current worktree."
        }
      }
    }
  },
  {
    name: 'send_message',
    description:
      "Send a message to the agent working in another Ness worktree. It arrives as a turn in that agent's chat, labelled with your worktree as the sender, and wakes the tab if it was asleep. Use it to hand off work (\"the API change landed, you can rebase now\"), ask a question, or report that something you were asked to do is finished.\n\nThere is no separate reply channel. If you want an answer, say so in the message and ask them to send_message back to you — name your own worktree so they know where to reply. Then end your turn: you'll be woken when their message arrives, so there is no need to poll or wait.\n\nDelivery is immediate or not at all — nothing is queued. If the target worktree has no agent chat tab the call fails and the message is lost, so report that to the user rather than assuming it landed. The recipient always sees which worktree you are; the sender name cannot be set by you.",
    inputSchema: {
      type: 'object',
      properties: {
        worktree: {
          type: 'string',
          description:
            'Which worktree to message — a `<repo>/<branch>` handle, its display alias, or its absolute path. A bare branch name works only when it is unique across every open repo, which `main` never is. A `@worktree:<repo>/<branch>` token in the user\'s message is a worktree mention picked from the composer; pass it here as-is (with or without the `worktree:` prefix). Call list_worktrees first if you are unsure what exists.'
        },
        message: {
          type: 'string',
          description:
            'What to say. Write it for an agent who has none of your context: state what you did, what you need, and what you want them to do next.'
        }
      },
      required: ['worktree', 'message']
    }
  },
  {
    name: 'list_browser_tabs',
    description:
      'List the browser tabs currently open in the SAME worktree as the calling agent. Returns [{id, url, title}]. Use the returned ids with screenshot_tab, get_tab_dom, get_tab_url, and get_tab_console_logs.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'create_browser_tab',
    description:
      "Open a new browser tab in this worktree. Returns the new tab's id. Optionally navigates to a URL; otherwise opens at about:blank. Prefer this over telling the user to click the Browser button.",
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            "Optional URL to load. Accepts a bare host (e.g. 'github.com') — https:// is prepended if no scheme is present."
        }
      }
    }
  },
  {
    name: 'screenshot_tab',
    description:
      "Take a screenshot of a browser tab in this worktree at the viewport's CSS-pixel dimensions — so screenshot coords can be passed straight to click_tab. Returns a JPEG (quality 70) by default for context-efficiency; ask for PNG only when lossless matters. Screenshots are for visual verification, not for finding click targets — prefer get_tab_clickables for interaction. Tab id comes from list_browser_tabs.",
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'Browser tab id from list_browser_tabs.' },
        format: {
          type: 'string',
          enum: ['jpeg', 'png'],
          description: "Image format. Default 'jpeg' (much smaller than PNG). Use 'png' when you need lossless output."
        },
        quality: {
          type: 'number',
          description: 'JPEG quality 1-100. Default 70. Ignored when format is png.'
        }
      },
      required: ['tab_id']
    }
  },
  {
    name: 'get_tab_dom',
    description:
      "Return the serialized outer HTML of the tab's document. Useful for inspecting rendered DOM that an HTTP fetch wouldn't see. Truncated to 100KB by default — a heavy page's markup will blow your context otherwise, so prefer get_tab_clickables when you just need something to click.",
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'Browser tab id from list_browser_tabs.' },
        max_bytes: {
          type: 'number',
          description: 'Truncate the markup to this many bytes. Default 100000, max 2000000.'
        }
      },
      required: ['tab_id']
    }
  },
  {
    name: 'get_tab_url',
    description: 'Return the current URL of the tab (may differ from the last-navigated URL if the page redirected).',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'Browser tab id from list_browser_tabs.' }
      },
      required: ['tab_id']
    }
  },
  {
    name: 'get_tab_console_logs',
    description:
      "Return the most recent (up to ~200) console messages captured from the tab since it was opened. Entries are {ts, level, message}.",
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'Browser tab id from list_browser_tabs.' }
      },
      required: ['tab_id']
    }
  },
  {
    name: 'navigate_tab',
    description:
      "Navigate a browser tab in this worktree to a URL. Accepts a bare host (e.g. 'github.com') — https:// is prepended automatically if no scheme is present.",
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'Browser tab id from list_browser_tabs.' },
        url: { type: 'string', description: 'URL to load.' }
      },
      required: ['tab_id', 'url']
    }
  },
  {
    name: 'back_tab',
    description: 'Navigate the tab one step backward in its history (no-op if no back entry).',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'Browser tab id from list_browser_tabs.' }
      },
      required: ['tab_id']
    }
  },
  {
    name: 'forward_tab',
    description: 'Navigate the tab one step forward in its history (no-op if no forward entry).',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'Browser tab id from list_browser_tabs.' }
      },
      required: ['tab_id']
    }
  },
  {
    name: 'reload_tab',
    description: 'Reload the current page in the tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'Browser tab id from list_browser_tabs.' }
      },
      required: ['tab_id']
    }
  },
  {
    name: 'get_tab_clickables',
    description:
      "Return a JSON snapshot of in-viewport interactive elements (buttons, links, inputs, [role=button|link|tab|menuitem|checkbox|radio|switch|option|combobox|searchbox|textbox], [tabindex], [contenteditable], [onclick]) — including elements inside open shadow roots. Each item is {role, name, cx, cy, w, h} where cx/cy is the viewport-relative center to pass to click_tab. Use this for click targeting instead of screenshot+vision when the targets are real DOM elements with sensible names. Capped at 500 items; off-viewport elements are excluded — scroll first if needed.",
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'Browser tab id from list_browser_tabs.' }
      },
      required: ['tab_id']
    }
  },
  {
    name: 'click_tab',
    description:
      "Synthesize a mouse click at viewport-relative (x, y) coordinates inside a browser tab. Origin is the top-left of the tab's web view. Use a screenshot first to figure out where to click. A visible cursor + click ripple is overlaid on the page so the user can watch the interaction.",
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'Browser tab id from list_browser_tabs.' },
        x: { type: 'number', description: 'Viewport x coordinate (CSS pixels).' },
        y: { type: 'number', description: 'Viewport y coordinate (CSS pixels).' },
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: 'Mouse button (default left).'
        },
        click_count: {
          type: 'number',
          description: 'Number of clicks; use 2 for double-click. Default 1, max 3.'
        }
      },
      required: ['tab_id', 'x', 'y']
    }
  },
  {
    name: 'type_tab',
    description:
      "Type text into the focused element of a browser tab. Click the field first with click_tab to focus it. Pass `text` for literal characters (\\n becomes Enter, \\t becomes Tab). Pass `key` to press a single special key (Enter, Tab, Backspace, Delete, Escape, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space). You can pass both — `key` fires first, then `text`.",
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'Browser tab id from list_browser_tabs.' },
        text: { type: 'string', description: 'Literal text to insert.' },
        key: {
          type: 'string',
          description:
            "Optional special key to press (e.g. 'Enter', 'Backspace', 'ArrowDown')."
        }
      },
      required: ['tab_id']
    }
  },
  {
    name: 'scroll_tab',
    description:
      "Scroll a browser tab by (delta_x, delta_y) CSS pixels. Positive delta_y scrolls down. Equivalent to window.scrollBy in the page.",
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'Browser tab id from list_browser_tabs.' },
        delta_x: { type: 'number', description: 'Horizontal scroll in CSS pixels (default 0).' },
        delta_y: { type: 'number', description: 'Vertical scroll in CSS pixels (default 0).' }
      },
      required: ['tab_id']
    }
  },
  {
    name: 'show_cursor',
    description:
      "Render or move the visible fake cursor overlay at (x, y) inside a browser tab without clicking. Useful for showing the user where you're about to click. click_tab calls this automatically.",
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'Browser tab id from list_browser_tabs.' },
        x: { type: 'number', description: 'Viewport x coordinate (CSS pixels).' },
        y: { type: 'number', description: 'Viewport y coordinate (CSS pixels).' }
      },
      required: ['tab_id', 'x', 'y']
    }
  },
  {
    name: 'list_shells',
    description:
      "List shell tabs in the caller's worktree. Each entry includes id, label, command (if started with one), cwd, and alive (whether its PTY is still running). Use the returned id with read_shell_output/kill_shell. Prefer reading an existing shell over spawning a new one when you just want to inspect recent output.",
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'create_shell',
    description:
      "Spawn a new shell tab in this worktree. If `command` is set, runs it via `zsh -ilc <command>`; otherwise opens an interactive login shell. Returns the new shell's id — keep it so you can read_shell_output / kill_shell later. Use this instead of telling the user to run `npm run dev` by hand.",
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description:
            'Shell command to run (e.g. "npm run dev"). Leave empty to open an interactive shell.'
        },
        cwd: {
          type: 'string',
          description:
            'Directory to spawn in. Relative paths resolve against the worktree root; absolute paths are used as-is. Defaults to the worktree root.'
        },
        label: {
          type: 'string',
          description:
            'Optional short label shown on the tab. Defaults to a truncated form of the command.'
        }
      }
    }
  },
  {
    name: 'read_shell_output',
    description:
      "Return the most recent output from a shell tab in this worktree (cleaned of ANSI escape codes). Works whether the shell is still running or has already exited — handy for reading the final error after a failed build. Use `match` + `context` to narrow results and save tokens when looking for errors in a long dev-server log. Returns { output, matchCount? }.",
    inputSchema: {
      type: 'object',
      properties: {
        shell_id: { type: 'string', description: 'Shell id from list_shells or create_shell.' },
        lines: {
          type: 'number',
          description: 'Number of trailing lines to return. Default 200, max 5000. Applied after filtering when `match` is set.'
        },
        match: {
          type: 'string',
          description: "Case-insensitive regex. When set, only lines matching this pattern are returned (e.g. 'error|warn|fail'). Gap separators ('---') indicate skipped ranges."
        },
        context: {
          type: 'number',
          description: 'Lines of context to keep before/after each match. Default 0, max 20. Ignored when `match` is unset.'
        }
      },
      required: ['shell_id']
    }
  },
  {
    name: 'kill_shell',
    description:
      "Terminate the process in a shell tab AND close the tab. Use this as explicit cleanup when you're done with a shell. If you still need the final output, call read_shell_output first — it works up until kill_shell closes the tab. Natural exits (the process finishing on its own) leave the tab open for inspection; only explicit kill_shell closes it.",
    inputSchema: {
      type: 'object',
      properties: {
        shell_id: { type: 'string', description: 'Shell id from list_shells.' }
      },
      required: ['shell_id']
    }
  }
]

const VIEW_BROWSER_TOOLS = new Set([
  'list_browser_tabs',
  'create_browser_tab',
  'screenshot_tab',
  'get_tab_dom',
  'get_tab_url',
  'get_tab_console_logs',
  'get_tab_clickables',
  'navigate_tab',
  'back_tab',
  'forward_tab',
  'reload_tab'
])
const FULL_CONTROL_BROWSER_TOOLS = new Set([
  'click_tab',
  'type_tab',
  'scroll_tab',
  'show_cursor'
])

// One /scope fetch backs every capability gate below. Defaults on failure are
// permissive for browser tools (pre-existing behaviour) but the fork and
// messaging gates default off — both are opt-in, and a server that doesn't
// report them would reject the call anyway, so advertising them would only
// waste a turn.
let cachedScope = null
async function getScopeInfo() {
  if (cachedScope) return cachedScope
  try {
    cachedScope = (await callControl('GET', '/scope')) || {}
  } catch {
    cachedScope = {}
  }
  return cachedScope
}

async function getToolPerms() {
  const s = await getScopeInfo()
  return {
    browser: s.browser || { enabled: true, mode: 'full' },
    messaging: s.messaging || { enabled: false }
  }
}

async function getConversationForkEnabled() {
  const s = await getScopeInfo()
  return s.conversationFork ? s.conversationFork.enabled === true : false
}

function filterToolsByPerms(tools, perms) {
  return tools.filter((t) => {
    if (t.name === 'send_message') return perms.messaging.enabled
    const isView = VIEW_BROWSER_TOOLS.has(t.name)
    const isFull = FULL_CONTROL_BROWSER_TOOLS.has(t.name)
    if (!isView && !isFull) return true
    if (!perms.browser.enabled) return false
    if (isFull && perms.browser.mode !== 'full') return false
    return true
  })
}

// Strip every trace of forking from create_worktree when it's disabled, rather
// than advertising a parameter whose only outcome is a rejection.
function stripForkAffordance(tools) {
  return tools.map((t) => {
    if (t.name !== 'create_worktree') return t
    const { forkConversation, ...rest } = t.inputSchema.properties
    return {
      ...t,
      description: t.description.replace(FORK_DESCRIPTION_SENTENCE, ''),
      inputSchema: { ...t.inputSchema, properties: rest }
    }
  })
}

async function handleToolCall(name, args) {
  if (name === 'create_worktree') {
    const prNumber = args && args.prNumber
    if (!args || (!args.branchName && !prNumber)) {
      throw new Error('branchName or prNumber is required')
    }
    if (prNumber !== undefined && prNumber !== null) {
      if (!Number.isInteger(prNumber) || prNumber <= 0) {
        throw new Error('prNumber must be a positive integer')
      }
    }
    if (
      args.agentKind !== undefined &&
      args.agentKind !== null &&
      args.agentKind !== 'claude' &&
      args.agentKind !== 'codex'
    ) {
      throw new Error('agentKind must be "claude" or "codex"')
    }
    const r = await callControl(
      'POST',
      '/worktrees',
      {
        terminalId: TERMINAL_ID,
        repoRoot: args.repoRoot,
        branchName: args.branchName,
        prNumber: prNumber,
        baseBranch: args.baseBranch,
        initialPrompt: args.initialPrompt,
        agentKind: args.agentKind,
        model: args.model,
        alias: args.alias,
        forkConversation: args.forkConversation === true
      },
      WORKTREE_CREATE_TIMEOUT_MS
    )
    const agentLabel = args.agentKind === 'codex' ? 'Codex' : 'Claude'
    const modelSuffix = args.model ? ` (model: ${args.model})` : ''
    const aliasSuffix = args.alias && args.alias.trim() ? ` (alias: "${args.alias.trim()}")` : ''
    const forkSuffix =
      args.forkConversation === true
        ? ' It resumes a copy of this conversation, and has been told where it is and which of your earlier changes came along.'
        : ''
    return prNumber
      ? `Created worktree ${r.path} on branch ${r.branch} for PR #${prNumber}${aliasSuffix}. Ness will open a new ${agentLabel} chat tab in it${modelSuffix}.`
      : `Created worktree ${r.path} on branch ${r.branch}${aliasSuffix}. Ness will open a new ${agentLabel} chat tab in it${modelSuffix}.${forkSuffix}`
  }
  if (name === 'list_worktrees') {
    const q =
      args && args.repoRoot ? '?repoRoot=' + encodeURIComponent(args.repoRoot) : ''
    const r = await callControl('GET', '/worktrees' + q)
    return JSON.stringify(r, null, 2)
  }
  if (name === 'list_repos') {
    const r = await callControl('GET', '/repos')
    return JSON.stringify(r, null, 2)
  }
  if (name === 'set_worktree_alias') {
    if (!args || typeof args.alias !== 'string') {
      throw new Error('alias is required')
    }
    const r = await callControl('POST', '/aliases', {
      alias: args.alias,
      worktreePath: args.worktreePath
    })
    const clampNote = r.clamped
      ? ' (input was normalized: whitespace trimmed and/or clamped to 80 chars)'
      : ''
    return r.alias
      ? 'Set alias "' + r.alias + '" for ' + r.worktreePath + clampNote
      : 'Cleared alias for ' + r.worktreePath + clampNote
  }
  if (name === 'rename_worktree') {
    const branchName = args && typeof args.branchName === 'string' ? args.branchName.trim() : ''
    const hasAlias = args && typeof args.alias === 'string'
    if (!branchName && !hasAlias) {
      throw new Error('branchName or alias is required')
    }
    const r = await callControl('POST', '/worktrees/rename', {
      branchName: branchName || undefined,
      alias: hasAlias ? args.alias : undefined,
      worktreePath: args && args.worktreePath
    })
    const parts = []
    if (r.branch) {
      parts.push(
        r.renamed
          ? 'Renamed branch ' + r.oldBranch + ' → ' + r.branch
          : 'Branch was already named ' + r.branch
      )
    }
    if (r.alias !== undefined) {
      parts.push(r.alias ? 'set alias "' + r.alias + '"' : 'cleared alias')
    }
    return parts.join(', ') + ' for ' + r.worktreePath + '.'
  }
  if (name === 'clear_worktree_alias') {
    const r = await callControl('DELETE', '/aliases', {
      worktreePath: args && args.worktreePath
    })
    return 'Cleared alias for ' + r.worktreePath
  }
  if (name === 'send_message') {
    if (!args || typeof args.worktree !== 'string' || !args.worktree.trim()) {
      throw new Error('worktree is required')
    }
    if (typeof args.message !== 'string' || !args.message.trim()) {
      throw new Error('message is required')
    }
    const r = await callControl('POST', '/messages', {
      worktree: args.worktree,
      message: args.message
    })
    return (
      'Delivered to ' +
      r.worktreePath +
      ', sent as "' +
      r.from +
      '"' +
      (r.woke ? ' (woke its sleeping chat tab)' : '')
    )
  }
  if (name === 'list_browser_tabs') {
    const r = await callControl('GET', '/browser/tabs')
    return JSON.stringify(r.tabs || [], null, 2)
  }
  if (name === 'create_browser_tab') {
    const r = await callControl('POST', '/browser/tabs', {
      url: (args && args.url) || ''
    })
    return 'Created browser tab ' + r.id + ' → ' + r.url
  }
  if (name === 'screenshot_tab') {
    if (!args || !args.tab_id) throw new Error('tab_id is required')
    const q = new URLSearchParams({ tabId: args.tab_id })
    if (args.format === 'png' || args.format === 'jpeg') q.set('format', args.format)
    if (typeof args.quality === 'number') q.set('quality', String(args.quality))
    const r = await callControl('GET', '/browser/screenshot?' + q.toString())
    const data = r && (r.data || r.pngBase64)
    if (!data) throw new Error(r && r.error ? r.error : 'screenshot failed')
    const mimeType =
      r.mimeType || (r.format === 'jpeg' ? 'image/jpeg' : 'image/png')
    return {
      content: [{ type: 'image', data, mimeType }]
    }
  }
  if (name === 'get_tab_dom') {
    if (!args || !args.tab_id) throw new Error('tab_id is required')
    const r = await callControl(
      'GET',
      '/browser/dom?tabId=' + encodeURIComponent(args.tab_id)
    )
    if (r == null || r.html == null) throw new Error(r && r.error ? r.error : 'dom read failed')
    return truncateDom(r.html, args.max_bytes)
  }
  if (name === 'get_tab_url') {
    if (!args || !args.tab_id) throw new Error('tab_id is required')
    const r = await callControl(
      'GET',
      '/browser/url?tabId=' + encodeURIComponent(args.tab_id)
    )
    return r && r.url ? r.url : ''
  }
  if (name === 'get_tab_console_logs') {
    if (!args || !args.tab_id) throw new Error('tab_id is required')
    const r = await callControl(
      'GET',
      '/browser/console?tabId=' + encodeURIComponent(args.tab_id)
    )
    return JSON.stringify((r && r.logs) || [], null, 2)
  }
  if (name === 'navigate_tab') {
    if (!args || !args.tab_id) throw new Error('tab_id is required')
    if (!args.url) throw new Error('url is required')
    await callControl('POST', '/browser/navigate', {
      tabId: args.tab_id,
      url: args.url
    })
    return 'navigated ' + args.tab_id + ' → ' + args.url
  }
  if (name === 'back_tab') {
    if (!args || !args.tab_id) throw new Error('tab_id is required')
    await callControl('POST', '/browser/back', { tabId: args.tab_id })
    return 'back ' + args.tab_id
  }
  if (name === 'forward_tab') {
    if (!args || !args.tab_id) throw new Error('tab_id is required')
    await callControl('POST', '/browser/forward', { tabId: args.tab_id })
    return 'forward ' + args.tab_id
  }
  if (name === 'reload_tab') {
    if (!args || !args.tab_id) throw new Error('tab_id is required')
    await callControl('POST', '/browser/reload', { tabId: args.tab_id })
    return 'reloaded ' + args.tab_id
  }
  if (name === 'get_tab_clickables') {
    if (!args || !args.tab_id) throw new Error('tab_id is required')
    const r = await callControl(
      'GET',
      '/browser/clickables?tabId=' + encodeURIComponent(args.tab_id)
    )
    if (!r || r.snapshot == null) throw new Error(r && r.error ? r.error : 'clickables read failed')
    return JSON.stringify(r.snapshot, null, 2)
  }
  if (name === 'click_tab') {
    if (!args || !args.tab_id) throw new Error('tab_id is required')
    if (typeof args.x !== 'number' || typeof args.y !== 'number') {
      throw new Error('x and y (numbers) are required')
    }
    await callControl('POST', '/browser/click', {
      tabId: args.tab_id,
      x: args.x,
      y: args.y,
      button: args.button,
      clickCount: args.click_count
    })
    return 'clicked ' + args.tab_id + ' at (' + args.x + ', ' + args.y + ')'
  }
  if (name === 'type_tab') {
    if (!args || !args.tab_id) throw new Error('tab_id is required')
    if (!args.text && !args.key) throw new Error('text or key is required')
    await callControl('POST', '/browser/type', {
      tabId: args.tab_id,
      text: args.text || '',
      key: args.key
    })
    const parts = []
    if (args.key) parts.push('key=' + args.key)
    if (args.text) parts.push(JSON.stringify(args.text))
    return 'typed into ' + args.tab_id + ' ' + parts.join(' + ')
  }
  if (name === 'scroll_tab') {
    if (!args || !args.tab_id) throw new Error('tab_id is required')
    const dx = typeof args.delta_x === 'number' ? args.delta_x : 0
    const dy = typeof args.delta_y === 'number' ? args.delta_y : 0
    await callControl('POST', '/browser/scroll', {
      tabId: args.tab_id,
      deltaX: dx,
      deltaY: dy
    })
    return 'scrolled ' + args.tab_id + ' by (' + dx + ', ' + dy + ')'
  }
  if (name === 'show_cursor') {
    if (!args || !args.tab_id) throw new Error('tab_id is required')
    if (typeof args.x !== 'number' || typeof args.y !== 'number') {
      throw new Error('x and y (numbers) are required')
    }
    await callControl('POST', '/browser/cursor', {
      tabId: args.tab_id,
      x: args.x,
      y: args.y
    })
    return 'cursor at (' + args.x + ', ' + args.y + ') in ' + args.tab_id
  }
  if (name === 'list_shells') {
    const r = await callControl('GET', '/shells')
    return JSON.stringify((r && r.shells) || [], null, 2)
  }
  if (name === 'create_shell') {
    const r = await callControl('POST', '/shells', {
      command: (args && args.command) || '',
      cwd: (args && args.cwd) || '',
      label: (args && args.label) || ''
    })
    const commandPart = args && args.command ? ' (' + args.command + ')' : ''
    return 'Created shell ' + r.id + ' "' + r.label + '"' + commandPart
  }
  if (name === 'read_shell_output') {
    if (!args || !args.shell_id) throw new Error('shell_id is required')
    const q = new URLSearchParams({ shellId: args.shell_id })
    if (args.lines != null) q.set('lines', String(args.lines))
    if (args.match) q.set('match', String(args.match))
    if (args.context != null) q.set('context', String(args.context))
    const r = await callControl('GET', '/shells/output?' + q.toString())
    const output = (r && r.output) || ''
    if (r && typeof r.matchCount === 'number') {
      return output
        ? `[${r.matchCount} match${r.matchCount === 1 ? '' : 'es'}]\n${output}`
        : `[${r.matchCount} matches]`
    }
    return output
  }
  if (name === 'kill_shell') {
    if (!args || !args.shell_id) throw new Error('shell_id is required')
    await callControl('POST', '/shells/kill', { shellId: args.shell_id })
    return 'killed ' + args.shell_id
  }
  throw new Error('unknown tool: ' + name)
}

async function handle(msg) {
  const { id, method, params } = msg
  try {
    if (method === 'initialize') {
      logErr('initialize received')
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'ness-control', version: '1.0.0' }
        }
      }
    }
    if (method === 'notifications/initialized' || method === 'initialized') {
      return null
    }
    if (method === 'tools/list') {
      logErr('tools/list received')
      const perms = await getToolPerms()
      let tools = filterToolsByPerms(TOOLS, perms)
      if (!(await getConversationForkEnabled())) tools = stripForkAffordance(tools)
      return { jsonrpc: '2.0', id, result: { tools } }
    }
    if (method === 'tools/call') {
      logErr('tools/call received name=' + (params && params.name))
      const result = await handleToolCall(
        params && params.name,
        (params && params.arguments) || {}
      )
      const content =
        result && typeof result === 'object' && Array.isArray(result.content)
          ? result.content
          : [{ type: 'text', text: String(result) }]
      return {
        jsonrpc: '2.0',
        id,
        result: { content }
      }
    }
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: 'Method not found: ' + method }
    }
  } catch (err) {
    const message = (err && err.message) || String(err)
    logErr('error', method, message)
    if (method === 'tools/call') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: message }],
          isError: true
        }
      }
    }
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message }
    }
  }
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  const response = await handle(msg)
  if (response) send(response)
})
rl.on('close', () => process.exit(0))
