// Matcher for Ness-owned persistent tool permissions.
//
// Why this exists at all: "Always allow" used to hand the rule to Claude
// Code as an `addRules` / `destination:'localSettings'` payload and let it
// persist into `<worktree>/.claude/settings.local.json`. Two problems
// killed that:
//
//   1. Per-worktree files don't share, which is the whole complaint — a
//      grant in one worktree is invisible to its siblings.
//   2. Symlinking them together to compensate doesn't work either. The
//      bundled binary's settings writer passes `allowSymlink: false` for
//      every source except `userSettings`, then lstats the target and
//      throws "Refusing to write through symlink" when it is one. So a
//      symlinked worktree silently persists NOTHING.
//
// In json-mode Ness IS the `--permission-prompt-tool`, so it already sees
// every request before Claude would prompt. Owning the allowlist here
// means it lives in Ness's own global config, applies across every
// worktree and repo, and doesn't depend on Claude's settings writer.
//
// Rule shapes mirror what `permission-patterns.ts` generates, which in
// turn mirrors Claude's own `{toolName, ruleContent?}` union:
//   - bare {toolName}                  → any invocation of that tool
//   - Bash + "git status:*"            → command prefix (":*" = prefix)
//   - Bash + "git status"              → exact command
//   - file tools + "/abs/path"         → exact path
//   - file tools + "/abs/dir/**"       → path glob
//   - Grep/Glob + "<pattern>"          → exact pattern
//   - WebFetch + "domain:example.com"  → host match
//   - WebFetch + "<url>"               → exact url
//
// Unlike Claude's matcher, path rules here are NOT anchored to a
// destination root, because there is no per-worktree destination any
// more — a single global list is matched against absolute paths as given.
// That removes the cross-cwd caveat that used to force a bare-tool grant
// for any file outside the session's worktree.

export interface PermissionRule {
  toolName: string
  ruleContent?: string
}

/** A stored grant: the rule plus enough provenance for the Settings list
 *  to show where it came from. `id` is a stable key for removal. */
export interface StoredPermissionRule {
  id: string
  toolName: string
  ruleContent?: string
  /** Epoch ms the grant was made. */
  grantedAt: number
  /** Worktree path the approval came from, for display only. Absent for
   *  rules imported from a pre-existing settings.local.json. */
  grantedFrom?: string
}

/** Canonical string form, matching how Claude renders a rule and how
 *  `permissions.allow` entries are spelled: `Tool` or `Tool(content)`.
 *  Used as the dedup key so the same grant can't be stored twice. */
export function ruleKey(rule: PermissionRule): string {
  return rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName
}

/** Inverse of `ruleKey`. Parses a `permissions.allow` entry into a rule.
 *  Returns null for anything that isn't a well-formed entry, so importing
 *  a hand-edited settings file can't inject junk. */
export function parseRuleKey(entry: string): PermissionRule | null {
  const trimmed = entry.trim()
  if (!trimmed) return null
  const open = trimmed.indexOf('(')
  if (open === -1) {
    return /[()]/.test(trimmed) ? null : { toolName: trimmed }
  }
  if (!trimmed.endsWith(')')) return null
  const toolName = trimmed.slice(0, open).trim()
  const ruleContent = trimmed.slice(open + 1, -1).trim()
  if (!toolName || !ruleContent) return null
  return { toolName, ruleContent }
}

function strField(input: Record<string, unknown> | undefined, key: string): string | null {
  if (!input) return null
  const v = input[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

function extractHost(url: string): string | null {
  try {
    return new URL(url).host || null
  } catch {
    const m = url.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i)
    return m ? m[1] : null
  }
}

/** Glob match supporting `**` (any chars incl. `/`), `*` (any chars except
 *  `/`) and `?` (one char except `/`). Everything else is literal. Mirrors
 *  the subset of glob syntax `permission-patterns.ts` can emit. */
function globMatch(pattern: string, value: string): boolean {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    // `/**` makes the separator part of the wildcard, so `/a/**` matches
    // the directory itself as well as everything under it. Without this a
    // grant on `/repo/src/**` wouldn't cover `/repo/src`.
    if (pattern[i] === '/' && pattern[i + 1] === '*' && pattern[i + 2] === '*') {
      re += '(?:/.*)?'
      i += 2
      continue
    }
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*'
        i++
      } else {
        re += '[^/]*'
      }
    } else if (ch === '?') {
      re += '[^/]'
    } else {
      re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`).test(value)
}

/** Normalize away a trailing slash so `/a/b/` and `/a/b` compare equal. */
function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p
}

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const SEARCH_TOOLS = new Set(['Grep', 'Glob'])

function matchBash(ruleContent: string, input: Record<string, unknown> | undefined): boolean {
  const command = strField(input, 'command')
  if (!command) return false
  const cmd = command.trim()
  if (ruleContent.endsWith(':*')) {
    const prefix = ruleContent.slice(0, -2).trim()
    if (!prefix) return false
    // Prefix must land on a token boundary: `git s:*` must not allow
    // `git stash drop` via a bare string prefix of `git status`.
    return cmd === prefix || cmd.startsWith(prefix + ' ')
  }
  return cmd === ruleContent.trim()
}

function matchFileTool(
  ruleContent: string,
  input: Record<string, unknown> | undefined
): boolean {
  const filePath = strField(input, 'file_path') ?? strField(input, 'notebook_path')
  if (!filePath) return false
  const target = stripTrailingSlash(filePath)
  const pattern = stripTrailingSlash(ruleContent)
  if (/[*?]/.test(pattern)) return globMatch(pattern, target)
  return pattern === target
}

function matchWebFetch(
  ruleContent: string,
  input: Record<string, unknown> | undefined
): boolean {
  const url = strField(input, 'url')
  if (!url) return false
  if (ruleContent.startsWith('domain:')) {
    const want = ruleContent.slice('domain:'.length).trim().toLowerCase()
    if (!want) return false
    const host = extractHost(url)?.toLowerCase()
    if (!host) return false
    return host === want || host.endsWith('.' + want)
  }
  if (/[*?]/.test(ruleContent)) return globMatch(ruleContent, url)
  return ruleContent === url
}

/** True when `rule` authorizes this specific tool call. */
export function ruleMatches(
  rule: PermissionRule,
  toolName: string,
  input: Record<string, unknown> | undefined
): boolean {
  // `*` is the escape hatch for "any tool" — only reachable if the user
  // explicitly grants it from the suggestion picker's fallback option.
  if (rule.toolName !== '*' && rule.toolName !== toolName) return false
  // A bare rule is tool-wide, which is also what makes it the only grant
  // that can cover a tool whose input shape we don't model.
  if (!rule.ruleContent) return true
  if (toolName === 'Bash') return matchBash(rule.ruleContent, input)
  if (FILE_TOOLS.has(toolName)) return matchFileTool(rule.ruleContent, input)
  if (SEARCH_TOOLS.has(toolName)) {
    const pattern = strField(input, 'pattern')
    return pattern !== null && pattern === rule.ruleContent
  }
  if (toolName === 'WebFetch' || toolName === 'WebSearch') {
    return matchWebFetch(rule.ruleContent, input)
  }
  // Unknown tool with a scoped rule: we don't know which input field the
  // content refers to, so refuse rather than over-allow.
  return false
}

/** The matching rule for this call, or null if none of them allow it.
 *  Returned (rather than a boolean) so callers can log/attribute which
 *  grant fired. */
export function findMatchingRule(
  rules: readonly StoredPermissionRule[],
  toolName: string,
  input: Record<string, unknown> | undefined
): StoredPermissionRule | null {
  if (!toolName) return null
  for (const rule of rules) {
    if (ruleMatches(rule, toolName, input)) return rule
  }
  return null
}
