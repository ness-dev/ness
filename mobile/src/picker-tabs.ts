// Tabs nested under worktree rows in the picker (experimental, behind the
// Settings toggle). The rows mirror the desktop's WorktreeTabRows: every
// tab, file and diff ones included, in worktreeTabEntries order. Pure, so
// it's unit-tested without React Native.
import type { PtyStatus, TerminalTab } from '../../src/shared/state/terminals'
import type { WorktreeTabEntry } from '../../src/renderer/worktree-tab-entries'

/** Tabs shown per worktree before a "N more" row. A phone screen holds
 *  ~12 rows; past this the list stops being a list of worktrees. */
export const NESTED_TAB_LIMIT = 5

/** The first `limit` tabs, swapping the last visible slot for the selected
 *  tab when it would otherwise be hidden, so the current tab is never
 *  folded away. */
export function visibleTabEntries(
  entries: readonly WorktreeTabEntry[],
  activeTabId: string | null,
  limit = NESTED_TAB_LIMIT
): { shown: WorktreeTabEntry[]; hidden: number } {
  // A single overflow row costs as much as the tab it would hide.
  if (entries.length <= limit + 1) return { shown: [...entries], hidden: 0 }
  const shown = entries.slice(0, limit)
  const activeIdx = activeTabId ? entries.findIndex((e) => e.tab.id === activeTabId) : -1
  if (activeIdx >= limit) shown[limit - 1] = entries[activeIdx]
  return { shown, hidden: entries.length - limit }
}

export type NestedTabStatus = 'working' | 'waiting' | 'needs-approval' | 'exited' | 'asleep' | 'running' | null

/** One status per tab row, by the desktop's rules: a shell shows only
 *  whether a command is running; agent and chat tabs show their PTY
 *  status. The phone adds the two the desktop shows by other means: an
 *  exited chat session (the desktop's chat pane says so) and an asleep
 *  tab (the desktop italicises the label). Attention wins over asleep. */
export function nestedTabStatus(
  tab: Pick<TerminalTab, 'type' | 'mode'>,
  status: PtyStatus | undefined,
  shellRunning: boolean,
  sessionExited: boolean
): NestedTabStatus {
  if (tab.type === 'shell') {
    if (shellRunning) return 'running'
    return tab.mode === 'asleep' ? 'asleep' : null
  }
  if (status === 'needs-approval') return 'needs-approval'
  if (status === 'processing') return 'working'
  if (status === 'waiting') return 'waiting'
  if (tab.type === 'json-claude' && sessionExited) return 'exited'
  if (tab.mode === 'asleep') return 'asleep'
  return null
}

export const NESTED_TAB_STATUS_LABEL: Record<Exclude<NestedTabStatus, null>, string> = {
  working: 'Working',
  waiting: 'Waiting for input',
  'needs-approval': 'Needs approval',
  exited: 'Exited',
  asleep: 'Asleep',
  running: 'Running a command'
}

/** VoiceOver label for a nested tab row: kind (the icon says it visually),
 *  title and status. A title that only repeats the kind ("Shell") isn't
 *  read twice. */
export function nestedTabA11yLabel(tab: Pick<TerminalTab, 'type'>, title: string, status: NestedTabStatus): string {
  const kind = tabKindLabel(tab)
  const name = title === kind ? title : `${kind}: ${title}`
  return status ? `${name}, ${NESTED_TAB_STATUS_LABEL[status]}` : name
}

/** What kind of tab, for VoiceOver (the icon says it visually). */
export function tabKindLabel(tab: Pick<TerminalTab, 'type'>): string {
  switch (tab.type) {
    case 'json-claude':
      return 'Chat'
    case 'agent':
      return 'Terminal agent'
    case 'shell':
      return 'Shell'
    case 'diff':
      return 'Diff'
    case 'file':
      return 'File'
    case 'browser':
      return 'Browser'
    case 'review':
      return 'Review'
    default:
      return 'Tab'
  }
}
