import { getToolIntent, ToolCardChrome, trunc, type ToolCardProps } from './index'
import { BashIcon } from './tool-icons'
import { HighlightedText } from '../JsonModeChatFind'

export function BashCard({ block, result, autoApproved, sessionAllowed }: ToolCardProps): JSX.Element {
  const cmd = String(block.input?.command ?? '')
  // The model's description is the header when present — the raw
  // command is one click away in the body.
  const description = getToolIntent(block)
  return (
    <ToolCardChrome
      id={block.id}
      name="Bash"
      subtitle={description ? <HighlightedText text={description} /> : trunc(cmd, 80)}
      variant="warn"
      icon={BashIcon}
      isError={result?.isError}
      autoApproved={autoApproved}
      sessionAllowed={sessionAllowed}
    >
      <pre className="px-2 py-1 text-xs font-mono bg-app/40 whitespace-pre-wrap max-h-32 overflow-auto">
        $ <HighlightedText text={cmd} />
      </pre>
      {result && (
        <pre
          className={`px-2 py-1 text-xs font-mono whitespace-pre-wrap max-h-72 overflow-auto ${
            result.isError ? 'text-danger' : 'opacity-80'
          }`}
        >
          <HighlightedText text={trunc(result.content, 6000)} />
        </pre>
      )}
    </ToolCardChrome>
  )
}
