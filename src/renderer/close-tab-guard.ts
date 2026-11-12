import type { PtyStatus, ShellActivity } from '../shared/state/terminals'

/** Why closing this tab needs confirmation, or null when it can close
 *  straight away. Busy means an agent mid-turn or a shell with a live process. */
export function closeTabConfirmReason(
  status: PtyStatus | undefined,
  shellActivity: ShellActivity | undefined
): string | null {
  if (shellActivity?.active) return 'running a process'
  switch (status) {
    case 'needs-approval':
      return 'waiting for your approval'
    case 'waiting':
      return 'waiting for your input'
    case 'processing':
      return 'still working'
    default:
      return null
  }
}
