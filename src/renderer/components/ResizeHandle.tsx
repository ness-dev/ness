import { useRef } from 'react'

interface Props {
  /** Pointer movement since the last event, in screen coordinates. For
   *  axis='y' that means down-positive — callers that grow upward invert. */
  onDelta: (delta: number) => void
  axis?: 'x' | 'y'
  onDoubleClick?: () => void
  title?: string
}

export function ResizeHandle({
  onDelta,
  axis = 'x',
  onDoubleClick,
  title
}: Props) {
  const last = useRef(0)
  const vertical = axis === 'y'

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    last.current = vertical ? e.clientY : e.clientX

    const onMove = (ev: MouseEvent) => {
      const pos = vertical ? ev.clientY : ev.clientX
      const delta = pos - last.current
      last.current = pos
      if (delta !== 0) onDelta(delta)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = vertical ? 'row-resize' : 'col-resize'
    document.body.style.userSelect = 'none'
  }

  return (
    <div
      className={`${
        vertical ? 'h-px' : 'w-px'
      } shrink-0 bg-border-strong relative z-10`}
    >
      <div
        onMouseDown={handleMouseDown}
        onDoubleClick={onDoubleClick}
        title={title}
        className={`absolute ${
          vertical
            ? 'inset-x-0 -top-1 -bottom-1 cursor-row-resize'
            : 'inset-y-0 -left-0.5 -right-0.5 cursor-col-resize'
        } hover:bg-accent/40 active:bg-accent/60 transition-colors`}
      />
    </div>
  )
}
