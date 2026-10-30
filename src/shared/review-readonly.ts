/** Read-only enforcement for reviewer Chat tabs.
 *
 *  A reviewer is there to read the diff and leave comments, not to change
 *  the branch it is reviewing — an edit from the reviewer would land in
 *  the author's working tree underneath them. Ness is the
 *  `--permission-prompt-tool` for Chat tabs, so every tool call a reviewer
 *  makes passes through ApprovalBridge, and this decides what it may do.
 *
 *  This is a guardrail, not a sandbox — the same framing as the
 *  auto-approver. A determined agent can still find a way to write
 *  (a python one-liner, an editor invocation nobody listed). It exists to
 *  stop a well-behaved reviewer from casually doing the wrong thing, and
 *  to make "the reviewer edited my code" a bug report rather than a
 *  routine event. Hard isolation would need a separate checkout, which is
 *  not what the reviewer is for: it reviews the author's working state.
 */

/** Tools a reviewer may never call: they write files outright. */
const DENIED_TOOLS = new Set([
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
  'ApplyPatch',
  'apply_patch'
])

/** Review tools are writes, but writing review comments is the job. */
const REVIEW_TOOL_SUFFIXES = [
  'add_review_comment',
  'reply_to_comment',
  'resolve_comment',
  'submit_review',
  'list_review_comments',
  'list_tabs'
]

/** Shell commands that change the repo, the working tree, or the world.
 *  Matched against the whole command string, so a pipeline or `&&` chain
 *  is caught by any one of its parts. */
const MUTATING_BASH = [
  // git: anything that isn't inspection
  /\bgit\s+(add|commit|push|pull|fetch|merge|rebase|reset|revert|restore|checkout|switch|cherry-pick|stash|clean|rm|mv|tag|branch\s+-[dDmM]|apply|am)\b/,
  // filesystem writes
  /\b(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|truncate|dd|install)\s/,
  /\b(tee|patch)\b/,
  /\bsed\s+(-[a-zA-Z]*i|--in-place)/,
  /\bperl\s+.*-i\b/,
  // output redirection into a file
  />{1,2}\s*[^\s&|]/,
  // package managers + publishing
  /\b(npm|yarn|pnpm|bun|pip|pip3|cargo|go|gem|brew)\s+(i|install|add|remove|uninstall|publish|update|upgrade|build|run)\b/,
  // anything that talks to GitHub in a mutating way
  /\bgh\s+(pr|issue|release|repo|api)\b/,
  /\bcurl\b.*\s-(X|-request)\s*(POST|PUT|PATCH|DELETE)/i,
  // privilege + process control
  /\bsudo\b/,
  /\bkill(all)?\b/
]

export type ReadOnlyVerdict = { allowed: true } | { allowed: false; reason: string }

const ALLOWED: ReadOnlyVerdict = { allowed: true }

/** Decide whether a reviewer session may run `toolName` with `input`. */
export function checkReviewerTool(
  toolName: string,
  input: Record<string, unknown>
): ReadOnlyVerdict {
  if (REVIEW_TOOL_SUFFIXES.some((t) => toolName === t || toolName.endsWith(`__${t}`))) {
    return ALLOWED
  }
  if (DENIED_TOOLS.has(toolName)) {
    return {
      allowed: false,
      reason: `${toolName} edits files, and you are reviewing this branch, not changing it. Leave the point as a review comment with add_review_comment instead.`
    }
  }
  if (toolName === 'Bash' || toolName === 'BashOutput') {
    const command = typeof input['command'] === 'string' ? input['command'] : ''
    for (const re of MUTATING_BASH) {
      if (re.test(command)) {
        return {
          allowed: false,
          reason:
            'That command changes the repo or the working tree, and you are reviewing this branch, not changing it. Read-only commands (git diff/show/log, grep, cat) are fine; say what should change in a review comment instead.'
        }
      }
    }
  }
  return ALLOWED
}

/** Passed to the agent CLI so the obvious write tools are not even
 *  offered. Defence in depth: `checkReviewerTool` is the real gate, since
 *  flags vary by agent and don't cover Bash. */
export const REVIEWER_DISALLOWED_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit']
