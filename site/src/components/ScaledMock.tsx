import { useLayoutEffect, useRef, useState } from 'react'
import { MockHarness, type MockHarnessState } from './MockHarness'

const MOCK_W = 1000
const MOCK_H = 620

/** The mock is desktop chrome — sidebar, pane and right column add up to
 * 480px before the chat gets any — so laying it out in a narrow box leaves
 * a sliver of chat. Never lay it out narrower than MOCK_W; when the box is
 * narrower than that, scale the whole window down to fit instead.
 * The mock keeps MOCK_W × MOCK_H proportions at any width and takes its
 * height from the width. */
export function ScaledMock({ state }: { state: MockHarnessState }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [hostW, setHostW] = useState<number | null>(null)

  // Layout effect so the first paint already has the right scale rather
  // than jumping from a guess.
  useLayoutEffect(() => {
    const el = hostRef.current
    if (!el) return
    const measure = () => setHostW(el.clientWidth)
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [])

  const w = hostW ?? MOCK_W
  const layoutW = Math.max(w, MOCK_W)
  const scale = w / layoutW
  const layoutH = layoutW * (MOCK_H / MOCK_W)

  return (
    // Decorative: every label in the mock is a non-interactive span, and a
    // screen reader reading a fake app as page content is noise.
    <div
      ref={hostRef}
      aria-hidden="true"
      className="relative overflow-hidden"
      style={{ height: layoutH * scale }}
    >
      <div
        className="absolute top-0 left-0"
        style={{
          width: layoutW,
          height: layoutH,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
          visibility: hostW === null ? 'hidden' : undefined
        }}
      >
        <MockHarness state={state} />
      </div>
    </div>
  )
}
