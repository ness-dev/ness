import type { MouseEvent as ReactMouseEvent } from 'react'

/** Props that close an element on middle-click. With no `onClose`, the
 *  browser's middle-button default (autoscroll) is left alone. */
export function middleClickToClose(onClose: (() => void) | undefined): {
  onMouseDown?: (e: ReactMouseEvent) => void
  onAuxClick?: (e: ReactMouseEvent) => void
} {
  if (!onClose) return {}
  return {
    // Suppress middle-button autoscroll so auxclick fires cleanly.
    onMouseDown: (e) => {
      if (e.button === 1) e.preventDefault()
    },
    onAuxClick: (e) => {
      if (e.button !== 1) return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }
}
