import { ToolCardChrome, type ToolCardProps } from './index'
import { TodoIcon } from './tool-icons'
import { HighlightedText } from '../JsonModeChatFind'

const STATUS_LABEL: Record<string, string> = {
  pending: 'pending',
  in_progress: 'in progress',
  completed: 'completed',
  deleted: 'deleted'
}

function statusColor(status: string): string {
  return status === 'completed'
    ? 'text-success'
    : status === 'in_progress'
      ? 'text-warning'
      : status === 'deleted'
        ? 'text-danger'
        : 'text-faint'
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function ids(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string')
    : []
}

/** TaskCreate / TaskUpdate. Both mutate one task, so the interesting
 *  content is a single line — what changed, and to what. Without this
 *  they fall through to GenericToolCard and a session that drives the
 *  Tasks tool reads as a wall of raw JSON. */
export function TaskMutationCard({
  block,
  result,
  autoApproved,
  sessionAllowed
}: ToolCardProps): JSX.Element {
  const input = (block.input ?? {}) as Record<string, unknown>
  const isCreate = block.name === 'TaskCreate'
  const subject = str(input.subject)
  const description = str(input.description)
  const activeForm = str(input.activeForm)
  const owner = str(input.owner)
  const status = str(input.status)
  const taskId = str(input.taskId)
  const blocks = ids(input.addBlocks)
  const blockedBy = ids(input.addBlockedBy)

  // The created task's id only exists in the result ("Task #3 created
  // successfully: …"), so the header can't name it until that lands.
  const createdId = result?.content
    ? /^Task #(\d+) created/.exec(result.content)?.[1]
    : undefined
  const label = createdId ?? taskId

  return (
    <ToolCardChrome
      id={block.id}
      name={isCreate ? 'TaskCreate' : 'TaskUpdate'}
      subtitle={label ? `#${label}` : undefined}
      variant={result?.isError ? 'warn' : 'info'}
      icon={TodoIcon}
      autoApproved={autoApproved}
      sessionAllowed={sessionAllowed}
    >
      <div className="px-3 py-2 text-xs space-y-1">
        {subject && (
          <div className="text-fg-bright">
            <HighlightedText text={subject} />
          </div>
        )}
        {status && (
          <div className={statusColor(status)}>
            → {STATUS_LABEL[status] ?? status}
          </div>
        )}
        {activeForm && !subject && (
          <div className="text-muted italic">
            <HighlightedText text={activeForm} />
          </div>
        )}
        {owner && <div className="text-muted">owner: {owner}</div>}
        {blockedBy.length > 0 && (
          <div className="text-muted">
            blocked by {blockedBy.map((i) => `#${i}`).join(', ')}
          </div>
        )}
        {blocks.length > 0 && (
          <div className="text-muted">
            blocks {blocks.map((i) => `#${i}`).join(', ')}
          </div>
        )}
        {description && (
          <div className="text-faint whitespace-pre-wrap">
            <HighlightedText text={description} />
          </div>
        )}
        {result?.isError && (
          <div className="text-danger whitespace-pre-wrap">{result.content}</div>
        )}
      </div>
    </ToolCardChrome>
  )
}
