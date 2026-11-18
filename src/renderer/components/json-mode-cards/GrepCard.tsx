import { ToolCardChrome, basename, trunc, type ToolCardProps } from './index'
import { GrepIcon } from './tool-icons'
import { HighlightedText } from '../JsonModeChatFind'

export function GrepCard({ block, result, autoApproved, sessionAllowed }: ToolCardProps): JSX.Element {
  const pattern = String(block.input?.pattern ?? '')
  const path = String(block.input?.path ?? '')
  // Corpus emits pattern then path segments for Grep; keep this order in
  // the subtitle so DOM-order cycling stays aligned.
  const subtitle = (
    <>
      /<HighlightedText text={pattern} />/
      {path && (
        <>
          {' in '}
          <HighlightedText text={path} />
        </>
      )}
    </>
  )
  return (
    <ToolCardChrome
      id={block.id}
      name="Grep"
      subtitle={subtitle}
      icon={GrepIcon}
      isError={result?.isError}
      autoApproved={autoApproved}
      sessionAllowed={sessionAllowed}
    >
      {result && (
        <pre className="px-2 py-1 text-xs font-mono whitespace-pre-wrap max-h-60 overflow-auto opacity-80">
          <HighlightedText text={trunc(result.content, 3000)} />
        </pre>
      )}
    </ToolCardChrome>
  )
}
