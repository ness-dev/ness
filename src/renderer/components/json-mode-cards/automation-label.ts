import type { JsonClaudeAutomationSource } from '../../../shared/state/json-claude'

/** `brand` picks the gradient chrome the ness-control tool cards use.
 *  A CI failure keeps the warning tone — it's a problem report, not a
 *  Ness feature showing off. */
export function automationLabel(
  source: JsonClaudeAutomationSource,
  from?: string
): { label: string; note: string; brand: boolean; collapsed?: boolean } {
  if (source === 'worktree-message') {
    return {
      label: from ? `Agent Message · from ${from}` : 'Agent Message',
      note: 'sent by another worktree',
      brand: true
    }
  }
  if (source === 'subscription-started') {
    return {
      label: from ? `New Follower · ${from}` : 'New Follower',
      note: 'another agent now follows this worktree',
      brand: true
    }
  }
  if (source === 'subscription-update') {
    return {
      label: from ? `Worktree Update · ${from}` : 'Worktree Update',
      note: 'a worktree you follow changed',
      brand: true
    }
  }
  if (source === 'reviewed-pr-update') {
    return { label: 'Ness · Reviewed PR update', note: 'the PR you are reviewing', brand: false }
  }
  if (source === 'pr-update') {
    return { label: 'Ness · PR update', note: "this worktree's pull request", brand: false }
  }
  if (source === 'progress-report') {
    return {
      label: from ? `Progress Report · from ${from}` : 'Progress Report',
      note: 'from a worktree you follow',
      brand: true
    }
  }
  if (source === 'review') {
    return {
      label: from ? `Code Review · from ${from}` : 'Code Review',
      note: 'submitted in the Review tab',
      brand: true
    }
  }
  if (source === 'worktree-kickoff') {
    return {
      label: from ? `Task Brief · from ${from}` : 'Task Brief',
      note: 'opened this worktree',
      brand: true
    }
  }
  // The body here is the human's own kickoff prompt — only the stripped
  // footer (rename yourself) was Ness's, hence "your prompt".
  if (source === 'worktree-autoname') {
    return {
      label: 'Kickoff Prompt',
      note: 'opened this worktree · naming it from your prompt',
      brand: true
    }
  }
  // The one automation the user fires by hand, so it says who asked.
  if (source === 'merge-conflict') {
    return {
      label: 'Ness · Merge conflicts',
      note: 'you asked the agent to resolve them',
      brand: false
    }
  }
  if (source === 'review-request') {
    return {
      label: from ? `Review Request · from ${from}` : 'Review Request',
      note: 'this agent is reviewing the branch',
      brand: true
    }
  }
  if (source === 'ci-failure') {
    return { label: 'Ness · CI failure', note: 'sent automatically', brand: false }
  }
  if (source === 'first-run-kickoff') {
    // The brief is instructions to the agent, not something the user needs
    // to read before its greeting, so it starts folded away.
    return { label: 'Ness · Getting started', note: 'sent when you pressed Start something new', brand: true, collapsed: true }
  }
  if (source === 'blame-ask') {
    return { label: 'Blame · Ask about a line', note: 'you opened this from the gutter', brand: true }
  }
  const unhandled: never = source
  return { label: `Ness · ${unhandled}`, note: 'sent automatically', brand: false }
}
