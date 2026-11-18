import { ToolCardChrome, basename, trunc, type ToolCardProps } from './index'
import { EditIcon } from './tool-icons'
import { UnifiedDiff } from './UnifiedDiff'
import { HighlightedText } from '../JsonModeChatFind'

export function EditCard({ block, result, autoApproved, sessionAllowed }: ToolCardProps): JSX.Element {
  const fp = String(block.input?.file_path ?? '')
  const oldStr = String(block.input?.old_string ?? '')
  const newStr = String(block.input?.new_string ?? '')
  const oldLines = oldStr ? oldStr.split('\n').length : 0
  const newLines = newStr ? newStr.split('\n').length : 0
  const diffSummary = oldStr || newStr ? ` (+${newLines} −${oldLines})` : ''
  return (
    <ToolCardChrome
      id={block.id}
      name="Edit"
      subtitle={`${basename(fp)}${diffSummary}`}
      icon={EditIcon}
      isError={result?.isError}
      autoApproved={autoApproved}
      sessionAllowed={sessionAllowed}
    >
      {fp && (
        <div className="px-2 py-1 text-xs text-muted truncate font-mono">
          <HighlightedText text={fp} />
        </div>
      )}
      <UnifiedDiff oldStr={oldStr} newStr={newStr} filePath={fp} />
      {result && result.isError && (
        <pre className="px-2 py-1 text-xs font-mono text-danger whitespace-pre-wrap">
          <HighlightedText text={trunc(result.content, 1000)} />
        </pre>
      )}
    </ToolCardChrome>
  )
}
