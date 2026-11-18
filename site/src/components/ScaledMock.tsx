import { useLayoutEffect, useRef, useState } from 'react'
import { MockHarness, type MockHarnessState } from './MockHarness'

const MOCK_W = 1000
const MOCK_H = 620

/** The mock is desktop chrome — sidebar, pane and right column add up to
 * 480px before the chat gets any — so laying it out in a narrow box leaves
 * a sliver of chat. Never lay it out narrower than MOCK_W; when the box is
 * narrower than that, scale the whole window down to fit instead.
 *
 * `fill` sizes to the parent box (the pinned desktop column). Without it the
 * mock keeps MOCK_W × MOCK_H proportions at any width and takes its height
 * from the width (the hero, the mobile stack). */
export function ScaledMock({ state, fill = false }: { state: MockHarnessState; fill?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<{ w: number; h: number } | null>(null)

  // Layout effect so the first paint already has the right scale rather
  // than jumping from a guess.
  useLayoutEffect(() => {
    const el = hostRef.current
    if (!el) return
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [])

  const hostW = box?.w ?? MOCK_W
  const layoutW = Math.max(hostW, MOCK_W)
  const scale = hostW / layoutW
  const layoutH = fill ? (box?.h ?? MOCK_H) / scale : layoutW * (MOCK_H / MOCK_W)

  return (
    // Decorative: every label in the mock is a non-interactive span, and a
    // screen reader reading a fake app as page content is noise.
    <div
      ref={hostRef}
      aria-hidden="true"
      className={fill ? 'absolute inset-0' : 'relative overflow-hidden'}
      style={fill ? undefined : { height: layoutH * scale }}
    >
      <div
        className="absolute top-0 left-0"
        style={{
          width: layoutW,
          height: layoutH,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
          visibility: box ? undefined : 'hidden'
        }}
      >
        <MockHarness state={state} />
      </div>
    </div>
  )
}
