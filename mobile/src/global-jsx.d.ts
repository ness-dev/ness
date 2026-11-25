// Renderer modules reused from ../src (tool-icons, NessMark, …) annotate
// returns as the global `JSX.Element`, which React 19's types no longer
// declare globally. Alias it so those files type-check from mobile/.
import type { JSX as ReactJSX } from 'react'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    type Element = ReactJSX.Element
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface IntrinsicElements extends ReactJSX.IntrinsicElements {}
  }
}
