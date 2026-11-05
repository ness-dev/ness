declare module 'highlight.js/lib/common' {
  import type { HLJSApi } from 'highlight.js'
  const hljs: HLJSApi
  export default hljs
}

declare module 'highlight.js/lib/languages/*' {
  import type { LanguageFn } from 'highlight.js'
  const lang: LanguageFn
  export default lang
}
