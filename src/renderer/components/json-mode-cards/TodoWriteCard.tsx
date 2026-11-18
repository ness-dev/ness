import { ToolCardChrome, type ToolCardProps } from './index'
import { TodoIcon } from './tool-icons'
import { extractTodos } from '../../../shared/state/json-claude-todos'
import { HighlightedText } from '../JsonModeChatFind'

export function TodoWriteCard({ block, autoApproved, sessionAllowed }: ToolCardProps): JSX.Element {
  const todos = extractTodos(block.input)
  return (
    <ToolCardChrome
      id={block.id}
      name="TodoWrite"
      subtitle={`${todos.length} item${todos.length === 1 ? '' : 's'}`}
      icon={TodoIcon}
      autoApproved={autoApproved}
      sessionAllowed={sessionAllowed}
    >
      <ul className="px-3 py-2 text-xs space-y-1">
        {todos.map((t, i) => (
          <li key={i} className="flex items-baseline gap-2">
            <span
              className={
                t.status === 'completed'
                  ? 'text-success'
                  : t.status === 'in_progress'
                    ? 'text-warning'
                    : 'text-faint'
              }
            >
              {t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '◐' : '☐'}
            </span>
            <span
              className={t.status === 'completed' ? 'line-through opacity-60' : ''}
            >
              <HighlightedText text={t.content} />
            </span>
          </li>
        ))}
      </ul>
    </ToolCardChrome>
  )
}
