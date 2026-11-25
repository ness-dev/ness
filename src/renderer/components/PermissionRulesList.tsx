import { useEffect, useMemo, useState, type JSX, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Search } from 'lucide-react'
import type { StoredPermissionRule } from '../../shared/permission-match'
import { getMcpServerDisplay, getToolDisplay, type ToolDisplay } from './json-mode-cards/tool-display'
import type { ToolIcon } from './json-mode-cards/tool-icons'
import {
  GROUPING_THRESHOLD,
  filterGroups,
  groupPermissionRules,
  redundancy,
  redundantRules,
  type RuleGroup,
  type RuleGroupKind
} from './permission-groups'

/** What a row says inside its group: the group header already names the
 *  tool (Shell) or server (Notion), so rows only carry what differs. */
function rowLabel(rule: StoredPermissionRule, kind: RuleGroupKind | null): string {
  const display: ToolDisplay = getToolDisplay(rule.toolName)
  if (kind === 'shell') return rule.ruleContent ? '' : 'Any command'
  if (kind === 'mcp') {
    // Known brands' compactLabel is already the bare action; unknown
    // servers keep their prefix in it, which the header makes redundant.
    const sep = display.label.indexOf(' · ')
    return sep >= 0 ? display.label.slice(sep + 3) : display.label
  }
  return display.label
}

function groupIcon(group: RuleGroup): ToolIcon | null {
  switch (group.kind) {
    case 'shell':
      return getToolDisplay('Bash').icon
    case 'files':
      return getToolDisplay('Read').icon
    case 'web':
      return getToolDisplay('WebFetch').icon
    case 'mcp':
      return group.server ? getMcpServerDisplay(group.server).icon : null
    default:
      return null
  }
}

function RedundantBadge({ rule }: { rule: StoredPermissionRule }): JSX.Element | null {
  const why = redundancy(rule)
  if (!why) return null
  return (
    <span
      className="text-xs text-faint border border-border rounded px-1 shrink-0"
      title={
        why === 'built-in'
          ? 'Ness allows this tool without asking now, so this grant does nothing'
          : "Granted under Ness's old MCP server name, which nothing uses any more, so this grant does nothing"
      }
    >
      {why === 'built-in' ? 'built in' : 'old name'}
    </span>
  )
}

/** One saved "Always allow" grant. Renders the tool through the same
 *  `getToolDisplay` the chat tool cards use, so `mcp__ness-control__type_tab`
 *  reads as "Ness · Type Tab" with the server's icon instead of the raw wire
 *  name. The scoping half of the rule (`git status:*`, `/repo/**`) stays
 *  monospace — it's a pattern, not prose. Inside a group, `kind` drops
 *  whatever the group header already says. */
function PermissionRuleRow({
  rule,
  kind,
  indent,
  onRemove
}: {
  rule: StoredPermissionRule
  kind: RuleGroupKind | null
  indent: 0 | 1 | 2
  onRemove: () => void
}): JSX.Element {
  const display = getToolDisplay(rule.toolName)
  const Icon = kind === 'shell' || kind === 'mcp' ? null : display.icon
  const label = rowLabel(rule, kind)
  const pad = indent === 0 ? 'pl-3' : indent === 1 ? 'pl-9' : 'pl-14'
  return (
    <div className={`flex items-center gap-2 pr-3 py-2 ${pad}`}>
      {Icon ? (
        <Icon className="icon-sm shrink-0 text-dim" />
      ) : kind === null ? (
        <span className="icon-sm shrink-0" />
      ) : null}
      {label && <span className="text-xs text-fg-bright truncate shrink-0">{label}</span>}
      {rule.ruleContent && (
        <code className="text-xs text-dim font-mono truncate min-w-0" title={rule.ruleContent}>
          {rule.ruleContent}
        </code>
      )}
      <RedundantBadge rule={rule} />
      <button
        onClick={onRemove}
        title={`Remove ${rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName}`}
        className="text-xs text-dim hover:text-danger shrink-0 cursor-pointer ml-auto"
      >
        Remove
      </button>
    </div>
  )
}

/** "Remove all" that needs a second click, so a stray click on a group
 *  header's button can't wipe forty grants. */
function RemoveAllButton({
  count,
  armed,
  onArm,
  onConfirm
}: {
  count: number
  armed: boolean
  onArm: () => void
  onConfirm: () => void
}): JSX.Element {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        if (armed) onConfirm()
        else onArm()
      }}
      className={`text-xs shrink-0 cursor-pointer ml-auto ${
        armed ? 'text-danger font-medium' : 'text-dim hover:text-danger'
      }`}
    >
      {armed ? `Remove ${count}?` : 'Remove all'}
    </button>
  )
}

function GroupHeader({
  expanded,
  onToggle,
  icon: Icon,
  label,
  mono,
  count,
  indent,
  removeAll
}: {
  expanded: boolean
  onToggle: () => void
  icon: ToolIcon | null
  label: string
  mono?: boolean
  count: number
  indent: 0 | 1
  removeAll: ReactNode
}): JSX.Element {
  const Chevron = expanded ? ChevronDown : ChevronRight
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onToggle()
        }
      }}
      className={`flex items-center gap-2 pr-3 py-2 cursor-pointer hover:bg-surface ${indent === 0 ? 'pl-3' : 'pl-9'}`}
    >
      <Chevron className="icon-xs shrink-0 text-dim" />
      {Icon ? <Icon className="icon-sm shrink-0 text-dim" /> : indent === 0 ? <span className="icon-sm shrink-0" /> : null}
      <span className={`text-xs text-fg-bright truncate ${mono ? 'font-mono' : 'font-medium'}`}>{label}</span>
      <span className="text-xs text-faint shrink-0">{count}</span>
      {removeAll}
    </div>
  )
}

export function PermissionRulesList({
  rules,
  onRevoke,
  onRevokeMany,
  onClear
}: {
  rules: StoredPermissionRule[]
  onRevoke: (id: string) => void
  onRevokeMany: (ids: string[]) => void
  onClear: () => void
}): JSX.Element {
  // Collapse, filter and the armed "Remove all" are per-viewer UI, not
  // shared state.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [query, setQuery] = useState('')
  const [armedKey, setArmedKey] = useState<string | null>(null)

  useEffect(() => {
    if (!armedKey) return
    const t = setTimeout(() => setArmedKey(null), 4000)
    return () => clearTimeout(t)
  }, [armedKey])

  const redundant = useMemo(() => redundantRules(rules), [rules])
  const grouped = rules.length > GROUPING_THRESHOLD
  const groups = useMemo(() => (grouped ? groupPermissionRules(rules) : []), [grouped, rules])
  const filtering = query.trim().length > 0
  const visible = useMemo(
    () => filterGroups(groups, query, (r) => `${getToolDisplay(r.toolName).label} ${rowLabel(r, null)}`),
    [groups, query]
  )

  if (rules.length === 0) {
    return <div className="text-xs text-faint">No saved grants yet.</div>
  }

  const toggle = (key: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const isOpen = (key: string): boolean => filtering || expanded.has(key)
  const removeAll = (key: string, ids: string[]): ReactNode => (
    <RemoveAllButton
      count={ids.length}
      armed={armedKey === key}
      onArm={() => setArmedKey(key)}
      onConfirm={() => {
        setArmedKey(null)
        onRevokeMany(ids)
      }}
    />
  )

  return (
    <>
      {redundant.length > 0 && (
        <div className="flex items-center gap-3 mb-2 px-3 py-2 rounded border border-border bg-panel">
          <div className="text-xs text-dim flex-1">
            {redundant.length === 1 ? '1 grant is' : `${redundant.length} grants are`} for Ness tools
            that are now allowed without asking, or use Ness&apos;s old server name, so{' '}
            {redundant.length === 1 ? 'it does' : 'they do'} nothing.
          </div>
          <button
            onClick={() => onRevokeMany(redundant.map((r) => r.id))}
            className="text-xs text-fg-bright px-2 py-1 rounded border border-border-strong hover:bg-surface cursor-pointer shrink-0"
          >
            Remove {redundant.length === 1 ? 'it' : `${redundant.length} redundant grants`}
          </button>
        </div>
      )}

      {grouped && (
        <div className="relative mb-2">
          <Search className="icon-xs absolute left-2.5 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation()
                setQuery('')
              }
            }}
            placeholder={`Filter ${rules.length} grants…`}
            className="w-full text-xs bg-panel border border-border rounded pl-7 pr-2 py-1.5 text-fg placeholder:text-faint focus:outline-none focus:border-border-strong"
          />
        </div>
      )}

      <div className="border border-border rounded divide-y divide-border bg-panel">
        {!grouped &&
          rules.map((rule) => (
            <PermissionRuleRow
              key={rule.id}
              rule={rule}
              kind={null}
              indent={0}
              onRemove={() => onRevoke(rule.id)}
            />
          ))}

        {grouped && visible.length === 0 && (
          <div className="px-3 py-2 text-xs text-faint">No grants match “{query.trim()}”.</div>
        )}

        {grouped &&
          visible.map((group) => {
            const open = isOpen(group.key)
            return (
              <div key={group.key} className="divide-y divide-border">
                <GroupHeader
                  expanded={open}
                  onToggle={() => toggle(group.key)}
                  icon={groupIcon(group)}
                  label={group.label}
                  count={group.rules.length}
                  indent={0}
                  removeAll={removeAll(group.key, group.rules.map((r) => r.id))}
                />
                {open &&
                  group.loose.filter((r) => !r.ruleContent).map((rule) => (
                    <PermissionRuleRow
                      key={rule.id}
                      rule={rule}
                      kind={group.kind}
                      indent={1}
                      onRemove={() => onRevoke(rule.id)}
                    />
                  ))}
                {open &&
                  group.subgroups.map((sub) => {
                    const subOpen = isOpen(sub.key)
                    return (
                      <div key={sub.key} className="divide-y divide-border">
                        <GroupHeader
                          expanded={subOpen}
                          onToggle={() => toggle(sub.key)}
                          icon={null}
                          label={sub.label}
                          mono
                          count={sub.rules.length}
                          indent={1}
                          removeAll={removeAll(sub.key, sub.rules.map((r) => r.id))}
                        />
                        {subOpen &&
                          sub.rules.map((rule) => (
                            <PermissionRuleRow
                              key={rule.id}
                              rule={rule}
                              kind={group.kind}
                              indent={2}
                              onRemove={() => onRevoke(rule.id)}
                            />
                          ))}
                      </div>
                    )
                  })}
                {open &&
                  group.loose.filter((r) => r.ruleContent).map((rule) => (
                    <PermissionRuleRow
                      key={rule.id}
                      rule={rule}
                      kind={group.kind}
                      indent={1}
                      onRemove={() => onRevoke(rule.id)}
                    />
                  ))}
              </div>
            )
          })}
      </div>

      <button
        onClick={onClear}
        className="text-xs text-dim hover:text-danger mt-2 cursor-pointer"
      >
        Remove all {rules.length}
      </button>
    </>
  )
}
