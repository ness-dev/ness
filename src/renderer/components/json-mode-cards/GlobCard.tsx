import { ToolCardChrome, trunc, type ToolCardProps } from './index'
import { GlobIcon } from './tool-icons'
import { HighlightedText } from '../JsonModeChatFind'

export function GlobCard({ block, result, autoApproved, sessionAllowed }: ToolCardProps): JSX.Element {
  const pattern = String(block.input?.pattern ?? '')
  return (
    <ToolCardChrome
      id={block.id}
      name="Glob"
      subtitle={<HighlightedText text={pattern} />}
      icon={GlobIcon}
      isError={result?.isError}
      autoApproved={autoApproved}
      sessionAllowed={sessionAllowed}
    >
      {result && (
        <pre className="px-2 py-1 text-xs font-mono whitespace-pre-wrap max-h-60 overflow-auto opacity-80">
          <HighlightedText text={trunc(result.content, 2000)} />
        </pre>
      )}
    </ToolCardChrome>
  )
}
