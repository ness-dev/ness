// Grouping for the Settings "Always-allowed tools" list.
//
// The list is append-only from the user's side ("Always allow" on a card),
// so it grows without bound: one real install had 119 grants, 44 of them
// exact Bash commands from a single scripting session and ~50 for Ness's
// own tools. A flat list of that is unreadable, so past a small size it's
// shown as collapsible groups instead: shell grants by the program they
// run, file and web tools together, and one group per MCP server.
//
// Pure (no React) so it's unit-testable; the component owns collapse and
// filter state.

import { ruleKey, type StoredPermissionRule } from '../../shared/permission-match'
import { isAlwaysAutoAllowedNessTool } from '../../shared/ness-tool-policy'
import { getMcpServerDisplay, parseMcpToolName } from './json-mode-cards/tool-display'

/** At or below this many grants the list renders flat, as before. */
export const GROUPING_THRESHOLD = 8

export type RuleGroupKind = 'shell' | 'files' | 'web' | 'mcp' | 'other'

export interface RuleSubgroup {
  key: string
  /** The program (`vimm`), the reason a set of grants is dead, or "Other". */
  label: string
  /** A program name, rendered monospace. */
  program?: boolean
  rules: StoredPermissionRule[]
}

export interface RuleGroup {
  key: string
  kind: RuleGroupKind
  label: string
  /** Raw MCP server name for `kind: 'mcp'`, for the icon. */
  server?: string
  /** Every rule in the group, in display order. */
  rules: StoredPermissionRule[]
  /** Shell: programs with two or more grants. Any group: grants that do
   *  nothing, by reason. Once a group has any, its leftovers go in a final
   *  "Other" subgroup so no row sits ungrouped beside them. */
  subgroups: RuleSubgroup[]
  /** Rules not in a subgroup: everything when there are no subgroups,
   *  otherwise only a bare "any command" grant, which leads the group. */
  loose: StoredPermissionRule[]
}

const FILE_TOOLS = new Set([
  'Read',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'ApplyPatch'
])
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch'])

const KIND_ORDER: Record<RuleGroupKind, number> = { shell: 0, files: 1, web: 2, mcp: 3, other: 4 }

// Commands that run another command: the grant is really about whatever
// they wrap (`timeout 45 godot …`, `bash -x ~/bin/vimm …`). Their own
// flags and numeric arguments are skipped too.
const WRAPPERS = new Set(['timeout', 'env', 'nice', 'nohup', 'time', 'sudo', 'bash', 'sh', 'zsh'])

/** The program a Bash grant runs: the first word after any `VAR=val`
 *  assignments and wrapper commands, without a trailing `:*`, wrapping
 *  parens or quotes, and reduced to its last path segment. Lowercased so
 *  `godot` and `/Applications/Godot.app/…/Godot` land together. Null for a
 *  bare grant. A wrapper with nothing after it is its own head. */
export function commandHead(ruleContent: string | undefined): string | null {
  if (!ruleContent) return null
  const content = ruleContent.replace(/:\*$/, '').trim()
  let wrapper: string | null = null
  for (const raw of content.split(/\s+/)) {
    const token = raw.replace(/^[('"]+|[)'"]+$/g, '')
    if (!token) continue
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue
    if (wrapper && (token.startsWith('-') || /^\d+[smhd]?$/.test(token))) continue
    const segment = (token.split('/').filter(Boolean).pop() ?? token).toLowerCase()
    if (WRAPPERS.has(segment)) {
      wrapper = segment
      continue
    }
    return segment
  }
  return wrapper
}

function byContent(a: StoredPermissionRule, b: StoredPermissionRule): number {
  // A bare grant ("any command", "any file") reads first: it's the widest.
  if (!a.ruleContent !== !b.ruleContent) return a.ruleContent ? 1 : -1
  return ruleKey(a).localeCompare(ruleKey(b))
}

export function groupPermissionRules(rules: StoredPermissionRule[]): RuleGroup[] {
  const groups = new Map<string, RuleGroup>()
  const add = (key: string, init: () => Omit<RuleGroup, 'rules' | 'subgroups' | 'loose'>, rule: StoredPermissionRule): void => {
    let group = groups.get(key)
    if (!group) {
      group = { ...init(), rules: [], subgroups: [], loose: [] }
      groups.set(key, group)
    }
    group.rules.push(rule)
  }

  for (const rule of rules) {
    const tool = rule.toolName
    if (tool === 'Bash') {
      add('shell', () => ({ key: 'shell', kind: 'shell', label: 'Shell commands' }), rule)
    } else if (FILE_TOOLS.has(tool)) {
      add('files', () => ({ key: 'files', kind: 'files', label: 'Files' }), rule)
    } else if (WEB_TOOLS.has(tool)) {
      add('web', () => ({ key: 'web', kind: 'web', label: 'Web' }), rule)
    } else {
      const mcp = parseMcpToolName(tool)
      if (mcp) {
        const server = getMcpServerDisplay(mcp.server)
        add(
          `mcp:${server.key}`,
          () => ({ key: `mcp:${server.key}`, kind: 'mcp', label: server.label, server: mcp.server }),
          rule
        )
      } else {
        add('other', () => ({ key: 'other', kind: 'other', label: 'Other tools' }), rule)
      }
    }
  }

  for (const group of groups.values()) {
    group.rules.sort(group.kind === 'shell' || group.kind === 'files' || group.kind === 'web' ? byContent : (a, b) => ruleKey(a).localeCompare(ruleKey(b)))
    const grouped = new Set<StoredPermissionRule>()
    const take = (key: string, label: string, rules: StoredPermissionRule[], program?: boolean): void => {
      group.subgroups.push({ key: `${group.key}:${key}`, label, rules, ...(program ? { program } : {}) })
      for (const r of rules) grouped.add(r)
    }

    if (group.kind === 'shell') {
      const byHead = new Map<string, StoredPermissionRule[]>()
      for (const rule of group.rules) {
        const head = commandHead(rule.ruleContent)
        if (head === null) continue
        byHead.set(head, [...(byHead.get(head) ?? []), rule])
      }
      const programs = [...byHead].filter(([, r]) => r.length >= 2)
      programs.sort(([a, ar], [b, br]) => br.length - ar.length || a.localeCompare(b))
      for (const [head, headRules] of programs) take(head, head, headRules, true)
    }

    const oldName = group.rules.filter((r) => !grouped.has(r) && redundancy(r) === 'old-name')
    const builtIn = group.rules.filter((r) => !grouped.has(r) && redundancy(r) === 'built-in')
    if (oldName.length > 0) take('old-name', 'Old server name', oldName)
    if (builtIn.length > 0) take('built-in', 'Built in', builtIn)

    // A bare grant stays at the top of its group; it's the widest one.
    const rest = group.rules.filter((r) => !grouped.has(r))
    if (group.subgroups.length === 0) {
      group.loose = rest
      continue
    }
    group.loose = group.kind === 'shell' ? rest.filter((r) => !r.ruleContent) : []
    const other = rest.filter((r) => !group.loose.includes(r))
    if (other.length > 0) take('other', 'Other', other)
    group.rules = [...group.loose, ...group.subgroups.flatMap((sub) => sub.rules)]
  }

  return [...groups.values()].sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      b.rules.length - a.rules.length ||
      a.label.localeCompare(b.label)
  )
}

const LEGACY_NESS_PREFIX = 'mcp__harness-control__'

/** Why a grant does nothing: its tool is a Ness tool that's allowed without
 *  asking whatever its input, or it names Ness's MCP server by its
 *  pre-rename name. Grants match on the exact tool name and no session
 *  registers `harness-control` any more, so those can never match, even
 *  for the input-gated tools (browser navigation, create_worktree) that a
 *  `ness-control` grant would still widen. */
export function redundancy(rule: StoredPermissionRule): 'built-in' | 'old-name' | null {
  if (rule.toolName.startsWith(LEGACY_NESS_PREFIX)) return 'old-name'
  if (isAlwaysAutoAllowedNessTool(rule.toolName)) return 'built-in'
  return null
}

/** Grants that do nothing but take up room in the list; see `redundancy`. */
export function redundantRules(rules: StoredPermissionRule[]): StoredPermissionRule[] {
  return rules.filter((r) => redundancy(r) !== null)
}

/** Narrow groups to the rules matching `query` (case-insensitive, against
 *  the rule's `Tool(content)` form, its row label and its group label).
 *  Empty groups and subgroups are dropped. */
export function filterGroups(
  groups: RuleGroup[],
  query: string,
  rowLabel: (rule: StoredPermissionRule) => string
): RuleGroup[] {
  const q = query.trim().toLowerCase()
  if (!q) return groups
  const out: RuleGroup[] = []
  for (const group of groups) {
    const groupHit = group.label.toLowerCase().includes(q)
    const keep = (r: StoredPermissionRule): boolean =>
      groupHit || ruleKey(r).toLowerCase().includes(q) || rowLabel(r).toLowerCase().includes(q)
    const subgroups = group.subgroups
      .map((s) => ({ ...s, rules: s.label.toLowerCase().includes(q) ? s.rules : s.rules.filter(keep) }))
      .filter((s) => s.rules.length > 0)
    const loose = group.loose.filter(keep)
    if (loose.length === 0 && subgroups.length === 0) continue
    out.push({ ...group, loose, subgroups, rules: [...loose, ...subgroups.flatMap((s) => s.rules)] })
  }
  return out
}
