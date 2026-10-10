import * as monaco from 'monaco-editor'

export const conf: monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '//', blockComment: ['////', '////'] },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: '`', close: '`' },
  ],
  surroundingPairs: [
    { open: '*', close: '*' },
    { open: '_', close: '_' },
    { open: '`', close: '`' },
    { open: '[', close: ']' },
  ],
}

export const language: monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.asciidoc',
  admonitions: ['NOTE', 'TIP', 'WARNING', 'CAUTION', 'IMPORTANT'],
  tokenizer: {
    root: [
      // Block comment delimiter (4+ slashes on their own line)
      [/^\/{4,}\s*$/, 'comment', '@blockComment'],
      // Line comment
      [/^\/\/.*$/, 'comment'],

      // Headers: leading = signs followed by space
      [/^={1,6}\s+.*$/, 'keyword'],
      // Setext-style header underline (= or - line on its own)
      [/^={3,}\s*$/, 'keyword'],
      [/^-{3,}\s*$/, 'keyword'],

      // Source block delimiter ---- (and start source block state)
      [/^-{4,}\s*$/, { token: 'delimiter', next: '@sourceBlock' }],
      // Literal block delimiter ....
      [/^\.{4,}\s*$/, { token: 'delimiter', next: '@literalBlock' }],
      // Other block delimiters (example/sidebar/quote/passthrough)
      [/^={4,}\s*$/, 'delimiter'],
      [/^\*{4,}\s*$/, 'delimiter'],
      [/^_{4,}\s*$/, 'delimiter'],
      [/^\+{4,}\s*$/, 'delimiter'],
      [/^\|={3,}\s*$/, 'delimiter'],

      // Block attribute lines: [source,java], [NOTE], [verse, author], etc.
      [/^\[.*\]\s*$/, 'attribute.name'],

      // Block titles: .Title
      [/^\.[^.\s].*$/, 'string'],

      // Document attribute definition: :name: value  or  :!name:
      [/^:[!a-zA-Z0-9_-]+:.*$/, 'variable'],

      // Admonition paragraph: NOTE:  WARNING:  etc.
      [/^(NOTE|TIP|WARNING|CAUTION|IMPORTANT):\s/, 'keyword'],

      // List markers
      [/^\s*\*+\s/, 'keyword'],
      [/^\s*-\s/, 'keyword'],
      [/^\s*\.+\s/, 'keyword'],
      [/^\s*\d+\.\s/, 'keyword'],
      // Description list: term::
      [/^\s*[^\s].*::\s*$/, 'type'],

      // Table cell prefix in tables (don't enter table state — just colorize)
      [/^\|/, 'delimiter'],

      // Inline rules fall through to common handling
      { include: '@inline' },
    ],

    inline: [
      // Attribute reference {name}
      [/\{[a-zA-Z_][\w-]*\}/, 'variable'],

      // Inline macros: image::path[], video::, include::, link:, xref:, kbd:, btn:, menu:, footnote:
      [/(image|video|audio|include|link|xref|kbd|btn|menu|footnote|footnoteref|icon|mailto|http|https|ftp|irc)(::?)([^[\s]*)(\[)/,
        ['keyword', 'delimiter', 'string.link', { token: 'delimiter.bracket', next: '@macroArgs' }]],

      // Cross reference <<id>> or <<id,text>>
      [/<<[^>]+>>/, 'string.link'],

      // URLs (bare)
      [/\bhttps?:\/\/[^\s\[\]]+/, 'string.link'],

      // Inline monospace `...`
      [/`[^`\n]+`/, 'string'],

      // Inline bold *...* (constrained — bounded by non-word chars on the outside)
      [/(^|\s|[(\[{])(\*[^*\n]+\*)/, ['', 'strong']],
      // Constrained bold **...**
      [/\*\*[^*\n]+\*\*/, 'strong'],

      // Inline italic _..._
      [/(^|\s|[(\[{])(_[^_\n]+_)/, ['', 'emphasis']],
      [/__[^_\n]+__/, 'emphasis'],

      // Superscript / subscript / highlight
      [/\^[^\^\s\n]+\^/, 'string'],
      [/~[^~\s\n]+~/, 'string'],
      [/#[^#\s\n]+#/, 'string'],

      // Escaped characters
      [/\\./, ''],
    ],

    sourceBlock: [
      [/^-{4,}\s*$/, { token: 'delimiter', next: '@pop' }],
      [/.*$/, 'string'],
    ],

    literalBlock: [
      [/^\.{4,}\s*$/, { token: 'delimiter', next: '@pop' }],
      [/.*$/, 'string'],
    ],

    blockComment: [
      [/^\/{4,}\s*$/, { token: 'comment', next: '@pop' }],
      [/.*$/, 'comment'],
    ],

    macroArgs: [
      [/\]/, { token: 'delimiter.bracket', next: '@pop' }],
      [/[^\]]+/, ''],
    ],
  },
}
