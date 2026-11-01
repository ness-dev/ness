import { CircleAlert, CircleCheck, ListChecks, Loader2, MessageSquare } from 'lucide-react'
import { useLatestAgentReviewStatus, useTerminalStatus } from '../store'
import { REVIEW_VERDICT_LABELS } from '../../shared/review-format'

/** Icon for a Review tab that reflects the worktree's latest agent review:
 *  in progress, or the verdict it came back with. A dot marks a review
 *  that hasn't been delivered yet. */
export function ReviewStatusIcon({
  worktreePath,
  className,
  hideWhenNone
}: {
  worktreePath: string
  className: string
  /** Render nothing when there's no agent review, for the tab strip,
   *  where tabs carry no kind icon. */
  hideWhenNone?: boolean
}): JSX.Element | null {
  const { kind, unsent, reviewerTabId } = useLatestAgentReviewStatus(worktreePath)
  const reviewerStatus = useTerminalStatus(reviewerTabId ?? '')

  let icon: JSX.Element
  let label: string
  switch (kind) {
    case 'none':
      return hideWhenNone ? null : <ListChecks className={className} />
    case 'reviewing':
      // A reviewer that has gone idle without submitting has stalled; a
      // spinner there would never stop.
      if (reviewerStatus === 'processing') {
        icon = <Loader2 className={`${className} animate-spin text-accent`} />
        label = 'Agent review in progress'
      } else if (reviewerStatus === 'needs-approval') {
        icon = <ListChecks className={`${className} text-danger animate-pulse`} />
        label = 'Agent review waiting for approval'
      } else {
        icon = <ListChecks className={`${className} text-accent opacity-60`} />
        label = 'Agent review requested, reviewer idle'
      }
      break
    case 'approve':
      icon = <CircleCheck className={`${className} text-success`} />
      label = REVIEW_VERDICT_LABELS.approve
      break
    case 'changes-requested':
      icon = <CircleAlert className={`${className} text-warning`} />
      label = REVIEW_VERDICT_LABELS['changes-requested']
      break
    case 'comment':
      icon = <MessageSquare className={`${className} text-info`} />
      label = REVIEW_VERDICT_LABELS.comment
      break
  }
  if (unsent) label += ' · not sent'
  return (
    <span className="relative inline-flex shrink-0" title={label} aria-label={label}>
      {icon}
      {unsent && (
        <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-warning" />
      )}
    </span>
  )
}
