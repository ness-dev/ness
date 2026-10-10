import * as monaco from 'monaco-editor'

export const conf: monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"', notIn: ['string'] },
    { open: "'", close: "'", notIn: ['string'] },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
}

const GROOVY_KEYWORDS = [
  'abstract', 'as', 'assert', 'break', 'case', 'catch', 'class', 'const',
  'continue', 'def', 'default', 'do', 'else', 'enum', 'extends', 'final',
  'finally', 'for', 'goto', 'if', 'implements', 'import', 'in', 'instanceof',
  'interface', 'native', 'new', 'package', 'private', 'protected', 'public',
  'return', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this',
  'threadsafe', 'throw', 'throws', 'trait', 'transient', 'try', 'void',
  'volatile', 'while',
]

const GROOVY_TYPE_KEYWORDS = [
  'boolean', 'byte', 'char', 'double', 'float', 'int', 'long', 'short',
  'String', 'Object', 'Integer', 'Long', 'Float', 'Double', 'Boolean',
  'Character', 'Number', 'BigInteger', 'BigDecimal', 'List', 'Map', 'Set',
  'Collection', 'Iterable', 'Closure', 'Class',
]

const GROOVY_CONSTANTS = ['true', 'false', 'null']

interface GroovyOptions {
  tokenPostfix: string
  dslNamespaces?: string[]
}

export function createGroovyLanguage(opts: GroovyOptions): monaco.languages.IMonarchLanguage {
  return {
    defaultToken: '',
    tokenPostfix: opts.tokenPostfix,
    keywords: GROOVY_KEYWORDS,
    typeKeywords: GROOVY_TYPE_KEYWORDS,
    constants: GROOVY_CONSTANTS,
    dslNamespaces: opts.dslNamespaces ?? [],
    operators: [
      '=', '>', '<', '!', '~', '?', ':', '==', '<=', '>=', '!=', '<=>', '===',
      '!==', '&&', '||', '++', '--', '+', '-', '*', '/', '&', '|', '^', '%',
      '<<', '>>', '>>>', '+=', '-=', '*=', '/=', '&=', '|=', '^=', '%=', '?:',
      '?.', '*.', '.&', '..', '..<', '->',
    ],
    symbols: /[=><!~?:&|+\-*/^%.]+/,
    escapes: /\\(?:[abfnrtv\\"'$]|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4})/,
    digits: /\d+(_+\d+)*/,
    hexdigits: /[0-9a-fA-F]+(_+[0-9a-fA-F]+)*/,
    tokenizer: {
      root: [
        [/[a-zA-Z_$][\w$]*/, {
          cases: {
            '@keywords': 'keyword',
            '@typeKeywords': 'type',
            '@constants': 'constant',
            '@dslNamespaces': 'type.identifier',
            '@default': 'identifier',
          },
        }],

        { include: '@whitespace' },

        [/@\s*[a-zA-Z_$][\w$]*/, 'annotation'],

        [/[{}()[\]]/, '@brackets'],
        [/[<>](?!@symbols)/, '@brackets'],
        [/@symbols/, {
          cases: {
            '@operators': 'delimiter',
            '@default': '',
          },
        }],

        [/(@digits)[eE]([-+]?(@digits))?[fFdDgG]?/, 'number.float'],
        [/(@digits)\.(@digits)([eE][-+]?(@digits))?[fFdDgG]?/, 'number.float'],
        [/0[xX](@hexdigits)[Ll]?[gG]?/, 'number.hex'],
        [/0[bB][01]+(_+[01]+)*[Ll]?[gG]?/, 'number.binary'],
        [/(@digits)[fFdDgG]/, 'number.float'],
        [/(@digits)[lLgGiI]?/, 'number'],

        [/[;,.]/, 'delimiter'],

        [/"""/, 'string', '@tripleString'],
        [/'''/, 'string', '@tripleStringSingle'],
        [/"/, 'string', '@string'],
        [/'/, 'string', '@stringSingle'],
      ],

      whitespace: [
        [/[ \t\r\n]+/, ''],
        [/\/\*\*(?!\/)/, 'comment.doc', '@javadoc'],
        [/\/\*/, 'comment', '@comment'],
        [/\/\/.*$/, 'comment'],
        [/#!.*$/, 'comment'],
      ],

      comment: [
        [/[^/*]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[/*]/, 'comment'],
      ],

      javadoc: [
        [/[^/*]+/, 'comment.doc'],
        [/\*\//, 'comment.doc', '@pop'],
        [/[/*]/, 'comment.doc'],
      ],

      string: [
        [/[^\\"$]+/, 'string'],
        [/@escapes/, 'string.escape'],
        [/\\./, 'string.escape.invalid'],
        [/\$[a-zA-Z_][\w]*/, 'identifier'],
        [/\$\{/, { token: 'delimiter.bracket', next: '@interp' }],
        [/\$/, 'string'],
        [/"/, 'string', '@pop'],
      ],

      stringSingle: [
        [/[^\\']+/, 'string'],
        [/@escapes/, 'string.escape'],
        [/\\./, 'string.escape.invalid'],
        [/'/, 'string', '@pop'],
      ],

      tripleString: [
        [/[^\\"$]+/, 'string'],
        [/@escapes/, 'string.escape'],
        [/\\./, 'string.escape.invalid'],
        [/\$[a-zA-Z_][\w]*/, 'identifier'],
        [/\$\{/, { token: 'delimiter.bracket', next: '@interp' }],
        [/\$/, 'string'],
        [/"""/, 'string', '@pop'],
        [/"/, 'string'],
      ],

      tripleStringSingle: [
        [/[^\\']+/, 'string'],
        [/@escapes/, 'string.escape'],
        [/\\./, 'string.escape.invalid'],
        [/'''/, 'string', '@pop'],
        [/'/, 'string'],
      ],

      interp: [
        [/\}/, { token: 'delimiter.bracket', next: '@pop' }],
        { include: 'root' },
      ],
    },
  }
}

export const language = createGroovyLanguage({ tokenPostfix: '.groovy' })
