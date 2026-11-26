import type { TerminalTab } from '../shared/state/terminals'

/** The tab a phone opens a worktree on when it has no remembered choice:
 *  the first conversation (Chat or a Claude Code terminal, in tab order),
 *  then a shell, then whatever is there. Shared by the phone web client
 *  (MobileApp.tsx) and the Expo app (mobile/), so keep it free of DOM and
 *  React imports. */
export function pickInitialTab(tabs: readonly TerminalTab[]): string | null {
  return (
    tabs.find((t) => t.type === 'json-claude' || t.type === 'agent')?.id ??
    tabs.find((t) => t.type === 'shell')?.id ??
    tabs[0]?.id ??
    null
  )
}
