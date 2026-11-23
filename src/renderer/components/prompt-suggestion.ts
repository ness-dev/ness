/** The suggestion to offer in a chat composer right now, or undefined.
 *  Only an empty composer on an idle, awake session with nothing else
 *  competing for the user's next action gets one. */
export function offeredPromptSuggestion(args: {
  suggestion: string | undefined
  enabled: boolean
  asleep: boolean
  busy: boolean
  draft: string
  attachmentCount: number
  pendingApprovalCount: number
  mentionPopoverOpen: boolean
}): string | undefined {
  if (!args.suggestion || !args.enabled || args.asleep || args.busy) return undefined
  if (args.draft !== '' || args.attachmentCount > 0 || args.pendingApprovalCount > 0) {
    return undefined
  }
  // The popover owns Tab while it's open.
  if (args.mentionPopoverOpen) return undefined
  return args.suggestion
}

/** Plain Tab or Right Arrow accepts. Modified keys keep their usual
 *  meaning (Shift+Tab moves focus back, Alt+Right jumps words). */
export function isPromptSuggestionAcceptKey(e: {
  key: string
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
}): boolean {
  if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return false
  return e.key === 'Tab' || e.key === 'ArrowRight'
}
