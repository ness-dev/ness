import { ToolCardChrome, basename, trunc, type ToolCardProps } from './index'
import { WriteIcon } from './tool-icons'
import { HighlightedText } from '../JsonModeChatFind'

export function WriteCard({ block, result, autoApproved, sessionAllowed }: ToolCardProps): JSX.Element {
  const fp = String(block.input?.file_path ?? '')
  const content = String(block.input?.content ?? '')
  return (
    <ToolCardChrome
      id={block.id}
      name="Write"
      subtitle={basename(fp)}
      icon={WriteIcon}
      isError={result?.isError}
      autoApproved={autoApproved}
      sessionAllowed={sessionAllowed}
    >
      {fp && (
        <div className="px-2 py-1 text-xs text-muted truncate font-mono">
          <HighlightedText text={fp} />
        </div>
      )}
      <pre className="px-2 py-1 text-xs font-mono whitespace-pre-wrap max-h-60 overflow-auto bg-app/40">
        <HighlightedText text={trunc(content, 4000)} />
      </pre>
      {result && result.isError && (
        <pre className="px-2 py-1 text-xs font-mono text-danger whitespace-pre-wrap">
          <HighlightedText text={trunc(result.content, 1000)} />
        </pre>
      )}
    </ToolCardChrome>
  )
}
