import { useEffect, useRef, useState } from 'react'
import { useReducedMotion } from 'framer-motion'
import type { MockHarnessState, MockStatus } from './MockHarness'
import { BASE_WORKTREES } from './mock-data'
import { ScaledMock } from './ScaledMock'

/** The live app window under the hero. Loops through the moment Ness exists
 * for: one agent blocks on an approval, its row lights up, you jump to it and
 * approve, it gets back to work, and you return to what you were doing. */

interface Beat {
  ms: number
  active: string
  statuses: MockStatus[]
  highlight?: string
}

const BEATS: Beat[] = [
  { ms: 3500, active: '1', statuses: ['processing', 'processing', 'processing', 'idle', 'processing'] },
  {
    ms: 2500,
    active: '1',
    statuses: ['processing', 'needs-approval', 'processing', 'idle', 'processing'],
    highlight: '2'
  },
  { ms: 4000, active: '2', statuses: ['processing', 'needs-approval', 'waiting', 'idle', 'processing'] },
  { ms: 3000, active: '2', statuses: ['processing', 'processing', 'waiting', 'idle', 'idle'] }
]

function stateFor(beat: Beat): MockHarnessState {
  return {
    activeWorktreeId: beat.active,
    worktrees: BASE_WORKTREES.map((w, i) => ({ ...w, status: beat.statuses[i] })),
    highlightedElement: beat.highlight ? 'worktree-row' : null,
    highlightedWorktreeId: beat.highlight,
    panelMode: 'terminal',
    mergedClosedCount: 3,
    rightPanelOpen: true
  }
}

export function HeroMock() {
  const reduced = useReducedMotion()
  const sectionRef = useRef<HTMLElement>(null)
  const [visible, setVisible] = useState(false)
  const [beat, setBeat] = useState(0)

  // Only run while on screen — the video this replaced was paused off-screen
  // for free — and restart the story from the top each time it comes back.
  useEffect(() => {
    const el = sectionRef.current
    if (!el) return
    const io = new IntersectionObserver(([entry]) => {
      setVisible(entry.isIntersecting)
      if (!entry.isIntersecting) setBeat(0)
    })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (reduced || !visible) return
    const t = setTimeout(() => setBeat((b) => (b + 1) % BEATS.length), BEATS[beat].ms)
    return () => clearTimeout(t)
  }, [beat, reduced, visible])

  return (
    <section ref={sectionRef} className="max-w-6xl mx-auto px-6 pb-24">
      <div
        role="img"
        aria-label="The Ness app: a sidebar of agent worktrees, one of them asking for approval, next to a Claude chat and the worktree's pull request, commits and changed files"
      >
        <ScaledMock state={stateFor(BEATS[reduced ? 0 : beat])} />
      </div>
    </section>
  )
}
