import { useMemo } from 'react'
import { unifiedDiff, langForPath, highlightLine, type DiffLine } from './diff-util'
import { HighlightedText, useFind } from '../JsonModeChatFind'

export function UnifiedDiff({
  oldStr,
  newStr,
  filePath
}: {
  oldStr: string
  newStr: string
  filePath?: string
}): JSX.Element {
  const lines = useMemo(() => unifiedDiff(oldStr, newStr), [oldStr, newStr])
  return <DiffLines lines={lines} filePath={filePath} />
}

/** Renders already-diffed lines — from `unifiedDiff` for Claude's Edit, or
 *  `parsePatchLines` for a patch an agent reported (Codex). */
export function DiffLines({
  lines,
  filePath
}: {
  lines: DiffLine[]
  filePath?: string
}): JSX.Element {
  const lang = filePath ? langForPath(filePath) : null
  const { query } = useFind()

  if (lines.length === 0) {
    return (
      <div className="px-2 py-1 text-xs text-muted italic">No changes.</div>
    )
  }

  return (
    <div className="text-xs font-mono max-h-72 overflow-auto bg-app/40">
      {lines.map((ln, i) => {
        if (ln.kind === 'hunk-sep') {
          return (
            <div
              key={i}
              className="flex items-center text-muted bg-app/60 border-y border-border/30 select-none"
            >
              <span className="w-4 shrink-0 text-center">{' '}</span>
              <span className="w-16 shrink-0 text-right pr-2 text-xs">…</span>
              <span className="flex-1 px-1 text-xs">…</span>
            </div>
          )
        }
        const bg =
          ln.kind === 'add'
            ? 'bg-success/10'
            : ln.kind === 'remove'
              ? 'bg-danger/10'
              : ''
        const fg =
          ln.kind === 'add'
            ? 'text-success/90'
            : ln.kind === 'remove'
              ? 'text-danger/90'
              : 'opacity-80'
        const marker = ln.kind === 'add' ? '+' : ln.kind === 'remove' ? '-' : ' '
        // When find is active, swap syntax-highlighted HTML for plain
        // text with <mark> injection. Users trade colors for the ability
        // to see matches; both come back when the find bar closes.
        return (
          <div key={i} className={`flex ${bg} ${fg}`}>
            <span className="w-4 shrink-0 text-center select-none opacity-70">
              {marker}
            </span>
            <span className="w-8 shrink-0 text-right pr-1 select-none text-muted text-xs tabular-nums">
              {ln.oldLn ?? ''}
            </span>
            <span className="w-8 shrink-0 text-right pr-2 select-none text-muted text-xs tabular-nums">
              {ln.newLn ?? ''}
            </span>
            {query ? (
              <code className="flex-1 whitespace-pre">
                <HighlightedText text={ln.text || ' '} />
              </code>
            ) : (
              <code
                className="flex-1 whitespace-pre"
                dangerouslySetInnerHTML={{
                  __html: highlightLine(ln.text, lang) || '&nbsp;'
                }}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
