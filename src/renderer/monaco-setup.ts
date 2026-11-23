// Monaco worker registration. Imported once from main.tsx before any
// editor is constructed. Vite's ?worker suffix bundles each worker as a
// standalone chunk and returns a Worker constructor.
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import EditorWorkerUrl from 'monaco-editor/esm/vs/editor/editor.worker?worker&url'
import JsonWorkerUrl from 'monaco-editor/esm/vs/language/json/json.worker?worker&url'
import CssWorkerUrl from 'monaco-editor/esm/vs/language/css/css.worker?worker&url'
import HtmlWorkerUrl from 'monaco-editor/esm/vs/language/html/html.worker?worker&url'
import TsWorkerUrl from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker&url'

const workerUrlByLabel: Record<string, string> = {
  editor: EditorWorkerUrl,
  json: JsonWorkerUrl,
  css: CssWorkerUrl,
  scss: CssWorkerUrl,
  less: CssWorkerUrl,
  html: HtmlWorkerUrl,
  handlebars: HtmlWorkerUrl,
  razor: HtmlWorkerUrl,
  typescript: TsWorkerUrl,
  javascript: TsWorkerUrl
}

// If a Monaco worker fails to construct, Monaco falls back to loading
// the worker source inline on the main thread. That fallback ALSO fails
// because the worker chunk is ESM and the inline-parse hits `export`,
// at which point Monaco's worker subsystem is poisoned for the entire
// renderer session — every diff editor renders without highlighting
// until full reload. We can't fix that here; we just capture enough
// detail to root-cause it and emit a window event so the UI can offer
// a one-click reload.
function safeCreateWorker(label: string, factory: () => Worker): Worker {
  try {
    const worker = factory()
    worker.addEventListener('error', (ev) => {
      const detail = {
        label,
        phase: 'runtime',
        message: ev.message,
        filename: (ev as ErrorEvent).filename,
        lineno: (ev as ErrorEvent).lineno,
        workerUrl: workerUrlByLabel[label]
      }
      // eslint-disable-next-line no-console
      console.error(`[monaco] worker '${label}' runtime error`, detail)
      window.dispatchEvent(new CustomEvent('monaco:worker-failed', { detail }))
    })
    return worker
  } catch (err) {
    const detail = {
      label,
      phase: 'construct',
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      userAgent: navigator.userAgent,
      workerUrl: workerUrlByLabel[label]
    }
    // eslint-disable-next-line no-console
    console.error(`[monaco] worker '${label}' construction failed`, detail)
    window.dispatchEvent(new CustomEvent('monaco:worker-failed', { detail }))
    throw err
  }
}

;(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === 'json') return safeCreateWorker('json', () => new JsonWorker())
    if (label === 'css' || label === 'scss' || label === 'less')
      return safeCreateWorker(label, () => new CssWorker())
    if (label === 'html' || label === 'handlebars' || label === 'razor')
      return safeCreateWorker(label, () => new HtmlWorker())
    if (label === 'typescript' || label === 'javascript')
      return safeCreateWorker(label, () => new TsWorker())
    return safeCreateWorker('editor', () => new EditorWorker())
  }
}

// Configure the TS/JS language defaults so JSX parses correctly and we
// don't get semantic noise from unresolved imports (no project-wide type
// graph — Monaco only sees one file at a time).
function configureTypescriptDefaults(): void {
  // The runtime API for the TypeScript language service lives at
  // monaco.languages.typescript. Recent @types mark it as `{deprecated: true}`
  // and don't expose its members through the type system, so we cast to any.
  // DO NOT switch this to `monaco.typescript` — that path is undefined at
  // runtime and throws during module evaluation, silently breaking every
  // Monaco editor's syntax highlighting + theme.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ts: any = (monaco as any).languages.typescript
  const tsOptions = {
    ...ts.typescriptDefaults.getCompilerOptions(),
    jsx: ts.JsxEmit.Preserve,
    jsxFactory: 'React.createElement',
    reactNamespace: 'React',
    allowNonTsExtensions: true,
    target: ts.ScriptTarget.Latest,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    esModuleInterop: true,
    allowJs: true
  }
  ts.typescriptDefaults.setCompilerOptions(tsOptions)
  ts.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: false
  })
  ts.javascriptDefaults.setCompilerOptions({
    ...ts.javascriptDefaults.getCompilerOptions(),
    jsx: ts.JsxEmit.Preserve,
    jsxFactory: 'React.createElement',
    reactNamespace: 'React',
    allowNonTsExtensions: true,
    target: ts.ScriptTarget.Latest,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    esModuleInterop: true,
    allowJs: true
  })
  ts.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: false
  })
}

configureTypescriptDefaults()

// Pull current Tailwind theme tokens from the document and build a Monaco
// theme that tracks them. Called once at boot and on theme changes.
function readVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

// Monaco only accepts #rrggbb / #rrggbbaa, and throws lazily (on first
// tokenize) for anything else — leaving the editor on whatever theme it had.
// Custom properties come back verbatim, so the CSS minifier's `#fff` for
// `#ffffff`, or a custom theme's `rgb(...)`, would break it. Let the browser
// resolve the colour on a probe and re-serialize it as 6-digit hex.
let colorProbe: HTMLElement | null = null
function toHex(color: string, fallback: string): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color
  if (!colorProbe) {
    colorProbe = document.createElement('span')
    colorProbe.style.display = 'none'
    document.body.appendChild(colorProbe)
  }
  colorProbe.style.color = ''
  colorProbe.style.color = color
  const m = getComputedStyle(colorProbe).color.match(/\d+(\.\d+)?/g)
  if (!colorProbe.style.color || !m || m.length < 3) return fallback
  return '#' + m.slice(0, 3).map((c) => Math.round(+c).toString(16).padStart(2, '0')).join('')
}

function readColor(name: string, fallback: string): string {
  return toHex(readVar(name, fallback), fallback)
}

let themeObserver: MutationObserver | null = null

export function defineHarnessTheme(): void {
  applyHarnessTheme()
  // Monaco themes are global and static, so re-derive on every theme switch
  // (theme-apply.ts rewrites [data-theme] and inline style on :root).
  // Without this, a diff opened after switching kept the boot theme.
  if (!themeObserver && typeof MutationObserver !== 'undefined') {
    themeObserver = new MutationObserver(() => applyHarnessTheme())
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'style']
    })
  }
}

let lastThemeKey = ''

function applyHarnessTheme(): void {
  const bg = readColor('--color-app', '#0b0d10')
  const panel = readColor('--color-panel', '#12151a')
  const fg = readColor('--color-fg', '#e6e6e6')
  const muted = readColor('--color-muted', '#b0b0b0')
  const faint = readColor('--color-faint', '#6b7280')
  const border = readColor('--color-border', '#1f242c')
  const borderStrong = readColor('--color-border-strong', '#3a424d')
  // Set by every light theme in styles.css (custom light themes inherit it
  // from the default light selector they're layered on).
  const light = readVar('--theme-scheme', 'dark') === 'light'

  // The observer also fires for unrelated inline-style writes on :root
  // (uiScale, brand colour); skip the redefine when nothing Monaco reads moved.
  const key = [bg, panel, fg, muted, faint, border, borderStrong, light].join('|')
  if (key === lastThemeKey) return
  lastThemeKey = key

  monaco.editor.defineTheme('harness', {
    base: light ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: fg.replace('#', '') }
    ],
    colors: {
      'editor.background': bg,
      'editor.foreground': fg,
      'editorLineNumber.foreground': faint,
      'editorLineNumber.activeForeground': muted,
      'editorGutter.background': bg,
      'editor.lineHighlightBackground': panel,
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': fg,
      'editorWhitespace.foreground': light ? borderStrong : '#2a2f38',
      'editor.selectionBackground': light ? '#add6ff' : '#3a4252',
      'editor.inactiveSelectionBackground': light ? '#e5ebf1' : '#2a3040',
      'editorIndentGuide.background1': border,
      'editorIndentGuide.activeBackground1': light ? borderStrong : '#3a424d',
      'editorWidget.background': panel,
      'editorWidget.border': border,
      'scrollbarSlider.background': light ? '#64646433' : '#3a424d55',
      'scrollbarSlider.hoverBackground': light ? '#64646455' : '#4a5260aa',
      'scrollbarSlider.activeBackground': light ? '#00000055' : '#5a6270',
      'diffEditor.insertedTextBackground': light ? '#1a7f3730' : '#2ea04355',
      'diffEditor.removedTextBackground': light ? '#cf222e2a' : '#f8514955',
      'diffEditor.insertedLineBackground': light ? '#1a7f3714' : '#2ea04322',
      'diffEditor.removedLineBackground': light ? '#cf222e12' : '#f8514922'
    }
  })
  monaco.editor.setTheme('harness')
}

// Map common file extensions to Monaco language ids. Monaco ships with
// grammars for all the common languages; we just need to pick the right
// id so syntax highlighting kicks in.
export function detectMonacoLanguage(filePath: string | undefined): string {
  if (!filePath) return 'plaintext'
  const name = filePath.split('/').pop() || ''
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  const byName: Record<string, string> = {
    dockerfile: 'dockerfile',
    makefile: 'makefile',
    'cmakelists.txt': 'cmake'
  }
  if (byName[name.toLowerCase()]) return byName[name.toLowerCase()]
  const byExt: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    json: 'json', jsonc: 'json',
    html: 'html', htm: 'html',
    css: 'css', scss: 'scss', less: 'less',
    md: 'markdown', markdown: 'markdown',
    py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', hh: 'cpp', cxx: 'cpp',
    sh: 'shell', bash: 'shell', zsh: 'shell',
    yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
    sql: 'sql', xml: 'xml', svg: 'xml',
    php: 'php', swift: 'swift', kt: 'kotlin', dart: 'dart', lua: 'lua',
    graphql: 'graphql', gql: 'graphql',
    dockerfile: 'dockerfile'
  }
  return byExt[ext] || 'plaintext'
}
