import {
  ToolCardChrome,
  extractArgs,
  getToolDisplay,
  isNessControl,
  trunc,
  type ToolCardProps
} from './index'
import { ArgsBlock, CompactArgs } from './ArgsDisplay'
import { HighlightedText } from '../JsonModeChatFind'
import { JsonModeChatImageThumb } from '../JsonModeChatImageThumb'

export function GenericToolCard({ block, result, autoApproved, sessionAllowed }: ToolCardProps): JSX.Element {
  const brand = isNessControl(block.name)
  const display = getToolDisplay(block.name)
  const args = extractArgs(block.input)
  const hasArgs = args.length > 0
  const images = result?.images ?? []

  return (
    <ToolCardChrome
      name={display.label}
      subtitle={hasArgs ? <CompactArgs args={args} /> : ''}
      variant="info"
      isError={result?.isError}
      brand={brand}
      icon={display.icon}
      autoApproved={autoApproved}
      sessionAllowed={sessionAllowed}
      autoExpand={images.length > 0}
    >
      {images.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-2 py-1.5 bg-app/40">
          {images.map((img) => (
            <JsonModeChatImageThumb
              key={img.path}
              path={img.path}
              mediaType={img.mediaType}
              shape="wide"
            />
          ))}
        </div>
      )}
      {hasArgs && <ArgsBlock args={args} rawInput={block.input} />}
      {result && result.content.trim() !== '' && (
        <pre
          className={`px-2 py-1 text-xs font-mono whitespace-pre-wrap max-h-60 overflow-auto ${
            result.isError ? 'text-danger' : 'opacity-80'
          }`}
        >
          <HighlightedText text={trunc(result.content, 3000)} />
        </pre>
      )}
    </ToolCardChrome>
  )
}
