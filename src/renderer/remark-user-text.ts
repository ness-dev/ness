import type { Processor } from 'unified'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { remarkMermaid } from './remark-mermaid'

/** Turns off CommonMark's indented code block. People indent prose in a
 *  prompt to nest a thought or paste a snippet of a log line; neither
 *  means "monospace box". Fenced ``` blocks still render as code. */
export function remarkNoIndentedCode(this: Processor): void {
  const data = this.data() as { micromarkExtensions?: unknown[] }
  ;(data.micromarkExtensions ??= []).push({ disable: { null: ['codeIndented'] } })
}

/** Markdown for text a person typed. Gentler than assistant text: a
 *  single newline stays a line break, and indentation is never code. */
export const USER_REMARK_PLUGINS = [remarkGfm, remarkBreaks, remarkNoIndentedCode, remarkMermaid]
