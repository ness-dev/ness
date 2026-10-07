import { createContext, useContext, useMemo, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useBackend } from '../backend'

/** Markdown rendered into a ~280px right-column panel. The component map
 * deliberately re-uses the built-in panels' vocabulary rather than
 * document typography: headings become the section headers from
 * ChangedFilesPanel, list items become rows. A tool script can only
 * express what this map can render, which is what keeps custom panels
 * from drifting out of the design system.
 *
 * No rehype-raw — raw HTML in tool output stays inert. */

export interface NessLinkAction {
  /** e.g. `send`, `file` — the part after `ness:`. */
  verb: string
  params: URLSearchParams
}

const REMARK_PLUGINS = [remarkGfm]

/** react-markdown blanks any href whose protocol isn't http/https/mailto/
 * etc., so `ness:` action links arrive as `href=""` and fall through to
 * the inert-text branch below. Let ours through and keep the default
 * sanitizer for everything else — it's what stops `javascript:`. */
function urlTransform(url: string): string {
  return url.startsWith('ness:') ? url : defaultUrlTransform(url)
}

/** Set inside <li> so paragraphs don't add a second layer of row padding
 * when the markdown uses a loose list. */
const InRowContext = createContext(false)

const ROW_CLASS =
  'flex items-center gap-2 px-3 py-1 text-xs text-fg hover:bg-panel-raised cursor-default group'
const SECTION_CLASS =
  'px-3 py-1.5 text-xs font-medium text-dim uppercase tracking-wider bg-panel-raised/50'

function Paragraph({ children }: { children?: ReactNode }): JSX.Element {
  const inRow = useContext(InRowContext)
  if (inRow) return <>{children}</>
  return <div className="px-3 py-1 text-xs text-fg">{children}</div>
}

interface SidebarMarkdownProps {
  markdown: string
  onAction?: (action: NessLinkAction) => void
}

export function SidebarMarkdown({ markdown, onAction }: SidebarMarkdownProps): JSX.Element {
  const backend = useBackend()

  const components = useMemo<Components>(() => {
    const Section = ({ children }: { children?: ReactNode }): JSX.Element => (
      <div className={SECTION_CLASS}>{children}</div>
    )
    return {
      h1: Section,
      h2: Section,
      h3: ({ children }) => (
        <div className="px-3 py-1 text-xs font-medium text-dim uppercase tracking-wider">
          {children}
        </div>
      ),
      h4: ({ children }) => (
        <div className="px-3 py-1 text-xs font-medium text-muted">{children}</div>
      ),
      p: Paragraph,
      // No wrapper padding: rows sit flush under their section header,
      // the way ChangedFilesPanel's do.
      ul: ({ children }) => <>{children}</>,
      ol: ({ children }) => <>{children}</>,
      li: ({ children }) => (
        <InRowContext.Provider value={true}>
          <div className={ROW_CLASS}>
            <span className="truncate min-w-0 flex-1">{children}</span>
          </div>
        </InRowContext.Provider>
      ),
      a: ({ href, children }) => {
        const target = href ?? ''
        if (target.startsWith('ness:')) {
          return (
            <button
              onClick={() => {
                const rest = target.slice('ness:'.length)
                const [verb, query = ''] = rest.split('?')
                onAction?.({ verb, params: new URLSearchParams(query) })
              }}
              className="text-accent hover:underline cursor-pointer"
            >
              {children}
            </button>
          )
        }
        if (!/^https?:/i.test(target)) return <span className="text-fg">{children}</span>
        return (
          <button
            onClick={() => backend.openExternal(target)}
            className="text-accent hover:underline cursor-pointer"
          >
            {children}
          </button>
        )
      },
      code: ({ children }) => (
        <code className="font-mono text-xs text-muted tabular-nums">{children}</code>
      ),
      pre: ({ children }) => (
        <pre className="mx-3 my-1 p-2 rounded bg-surface text-xs font-mono overflow-x-auto">
          {children}
        </pre>
      ),
      strong: ({ children }) => <span className="text-fg-bright font-medium">{children}</span>,
      em: ({ children }) => <span className="text-faint italic">{children}</span>,
      blockquote: ({ children }) => (
        <div className="px-3 py-1 border-l-2 border-border ml-3 text-xs text-faint">{children}</div>
      ),
      hr: () => <div className="border-b border-border my-1" />,
      table: ({ children }) => (
        <div className="px-3 py-1 overflow-x-auto">
          <table className="text-xs">{children}</table>
        </div>
      ),
      th: ({ children }) => (
        <th className="text-left pr-3 font-medium text-dim uppercase tracking-wider">{children}</th>
      ),
      td: ({ children }) => <td className="pr-3 align-top">{children}</td>,
      // A 280px column is not a place for images, and rendering them
      // would let tool output phone home on render.
      img: () => null
    }
  }, [backend, onAction])

  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      urlTransform={urlTransform}
      components={components}
    >
      {markdown}
    </ReactMarkdown>
  )
}
