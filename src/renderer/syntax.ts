// `highlight.js/lib/common` ships only the ~30 most popular languages
// (smaller bundle than the full `highlight.js` entry) but has no `.d.ts`
// of its own — the local module declaration in `highlight-common.d.ts`
// fills that in.
import hljs from 'highlight.js/lib/common'
import groovy from 'highlight.js/lib/languages/groovy'
import properties from 'highlight.js/lib/languages/properties'
import asciidoc from 'highlight.js/lib/languages/asciidoc'

hljs.registerLanguage('groovy', groovy)
hljs.registerLanguage('properties', properties)
hljs.registerLanguage('asciidoc', asciidoc)

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  groovy: 'groovy',
  gradle: 'groovy',
  properties: 'properties',
  adoc: 'asciidoc',
  asciidoc: 'asciidoc',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  sql: 'sql',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  lua: 'lua',
  pl: 'perl',
  r: 'r',
  scala: 'scala',
  dart: 'dart',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  clj: 'clojure',
  vue: 'xml',
}

const FILENAME_TO_LANG: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  '.gitignore': 'bash',
  '.env': 'bash',
}

export function detectLanguage(filePath?: string): string | null {
  if (!filePath) return null
  const base = filePath.split('/').pop()?.toLowerCase() ?? ''
  if (FILENAME_TO_LANG[base]) return FILENAME_TO_LANG[base]
  const dot = base.lastIndexOf('.')
  if (dot === -1) return null
  const ext = base.slice(dot + 1)
  return EXT_TO_LANG[ext] ?? null
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Highlight a single line in isolation. Used for diffs where each line is
 * independent (multi-line constructs like strings won't be detected).
 */
export function highlightLine(line: string, language: string | null): string {
  if (!language || !hljs.getLanguage(language)) return escapeHtml(line)
  try {
    return hljs.highlight(line, { language, ignoreIllegals: true }).value
  } catch {
    return escapeHtml(line)
  }
}

/**
 * Highlight an entire file's contents and split the resulting HTML into
 * per-line strings, properly closing and reopening any spans that cross
 * newlines so each line is independently injectable.
 */
export function highlightToLines(code: string, language: string | null): string[] {
  if (!language || !hljs.getLanguage(language)) {
    return code.split('\n').map(escapeHtml)
  }
  let html: string
  try {
    html = hljs.highlight(code, { language, ignoreIllegals: true }).value
  } catch {
    return code.split('\n').map(escapeHtml)
  }

  const lines: string[] = []
  const openTags: string[] = []
  let current = ''
  let i = 0
  while (i < html.length) {
    const ch = html[i]
    if (ch === '<') {
      const end = html.indexOf('>', i)
      if (end === -1) {
        current += html.slice(i)
        break
      }
      const tag = html.slice(i, end + 1)
      current += tag
      if (tag.startsWith('</')) {
        openTags.pop()
      } else if (!tag.endsWith('/>')) {
        openTags.push(tag)
      }
      i = end + 1
    } else if (ch === '\n') {
      for (let j = 0; j < openTags.length; j++) current += '</span>'
      lines.push(current)
      current = ''
      for (const t of openTags) current += t
      i++
    } else {
      current += ch
      i++
    }
  }
  lines.push(current)
  return lines
}
