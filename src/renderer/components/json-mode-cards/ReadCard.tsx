import { useMemo, useState } from 'react'
import { ToolCardChrome, basename, trunc, type ToolCardProps } from './index'
import { ReadIcon } from './tool-icons'
import { HighlightedText, useFind } from '../JsonModeChatFind'
import { langForPath, highlightToLines } from './diff-util'

const DEFAULT_LINE_CAP = 500

interface ParsedLine {
  num: number
  text: string
}

/** Claude's Read result formats each line as `<lineNumber>\t<content>`.
 *  Strip the prefix so syntax highlighting sees real code, and remember
 *  the actual line numbers for the gutter. Falls back to sequential
 *  numbering if the prefix isn't present. */
function parseReadContent(content: string, fallbackStart: number): ParsedLine[] {
  const rawLines = content.split('\n')
  const out: ParsedLine[] = []
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]
    const m = raw.match(/^\s*(\d+)\t(.*)$/)
    if (m) {
      out.push({ num: Number(m[1]), text: m[2] })
    } else {
      out.push({ num: fallbackStart + i, text: raw })
    }
  }
  return out
}

export function ReadCard({ block, result, autoApproved, sessionAllowed }: ToolCardProps): JSX.Element {
  const fp = String(block.input?.file_path ?? '')
  const offset = Number(block.input?.offset) || 0
  const limit = Number(block.input?.limit) || 0
  const hasRange = offset > 0 || limit > 0
  const range = hasRange ? ` (${offset || 1}–${(offset || 1) + (limit || 0)})` : ''
  const [showAll, setShowAll] = useState(false)

  const { rendered, totalLines, isError } = useMemo(() => {
    if (!result || result.isError) {
      return { rendered: null, totalLines: 0, isError: result?.isError ?? false }
    }
    const parsed = parseReadContent(result.content, offset || 1)
    return { rendered: parsed, totalLines: parsed.length, isError: false }
  }, [result, offset])

  const lang = useMemo(() => langForPath(fp), [fp])

  const cap = showAll ? totalLines : Math.min(DEFAULT_LINE_CAP, totalLines)
  const visible = rendered ? rendered.slice(0, cap) : []
  const hidden = totalLines - cap

  const highlightedHtml = useMemo(() => {
    if (!visible.length) return [] as string[]
    const joined = visible.map((l) => l.text).join('\n')
    return highlightToLines(joined, lang)
  }, [visible, lang])
  const { query } = useFind()

  return (
    <ToolCardChrome
      id={block.id}
      name="Read"
      subtitle={`${basename(fp)}${range}`}
      icon={ReadIcon}
      isError={result?.isError}
      autoApproved={autoApproved}
      sessionAllowed={sessionAllowed}
    >
      {fp && (
        <div className="px-2 py-1 text-xs text-muted truncate font-mono">
          <HighlightedText text={fp} />
        </div>
      )}
      {result && isError && (
        <pre className="px-2 py-1 text-xs font-mono text-danger whitespace-pre-wrap max-h-72 overflow-auto">
          <HighlightedText text={trunc(result.content, 4000)} />
        </pre>
      )}
      {result && !isError && rendered && (
        <>
          <div className="text-xs font-mono max-h-72 overflow-auto bg-app/30">
            {visible.map((line, i) => {
              const html = highlightedHtml[i] ?? line.text
              return (
                <div
                  key={line.num + ':' + i}
                  className={`flex ${hasRange ? 'bg-warning/5' : ''}`}
                >
                  <span className="select-none text-muted w-12 shrink-0 text-right pr-2 text-xs tabular-nums opacity-70">
                    {line.num}
                  </span>
                  {query ? (
                    <code className="flex-1 whitespace-pre">
                      <HighlightedText text={line.text || ' '} />
                    </code>
                  ) : (
                    <code
                      className="flex-1 whitespace-pre"
                      dangerouslySetInnerHTML={{ __html: html || '&nbsp;' }}
                    />
                  )}
                </div>
              )
            })}
          </div>
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="w-full px-2 py-1 text-xs text-muted bg-app/40 hover:bg-app/60 border-t border-border/40 text-center cursor-pointer"
            >
              + {hidden} more line{hidden === 1 ? '' : 's'}
            </button>
          )}
        </>
      )}
    </ToolCardChrome>
  )
}
