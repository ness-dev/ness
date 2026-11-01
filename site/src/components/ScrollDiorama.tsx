import { useRef, useState, useEffect } from 'react'
import { motion, useMotionValueEvent, useReducedMotion, useScroll } from 'framer-motion'
import type { MockHarnessState, MockStatus } from './MockHarness'
import { BASE_WORKTREES } from './mock-data'
import { ScaledMock } from './ScaledMock'

type SectionIndex = 0 | 1 | 2 | 3
type Phase = { section: SectionIndex; localProgress: number }

interface Section {
  eyebrow: string
  title: string
  body: string
  bonus?: string
}

const SECTIONS: Section[] = [
  {
    eyebrow: 'Parallel sessions',
    title: 'All your agents in one place.',
    body: 'Every agent is its own git branch, its own folder, its own Claude (or Codex!). Kick off five tasks, switch between them in a keystroke, and never worry about two agents fighting over the same file.'
  },
  {
    eyebrow: 'Reliable status',
    title: 'See which agent needs attention at a glance.',
    body: 'Glancing at the sidebar tells you which agents need your attention. The second an agent is waiting on approval, the row lights up red and jumps the queue.'
  },
  {
    eyebrow: 'New worktree in a click',
    title: 'Start new work instantly.',
    body: 'Spawn a fresh agent from the sidebar. Ness manages the full lifecycle of the git worktree, so you never even have to learn the commands.',
    bonus: 'Bonus: Agents can create new worktrees themselves through the Ness MCP. Just ask!'
  },
  {
    eyebrow: 'Everything in one UI',
    title: 'Everything about the worktree, one keystroke away.',
    body: 'Pull request status, branch commits, changed-file review, and any file opened in an embedded editor. All right there next to Claude. Review what shipped without leaving Ness.'
  }
]

export function ScrollDiorama() {
  const sectionRef = useRef<HTMLElement>(null)
  const prefersReduced = useReducedMotion()

  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ['start start', 'end end']
  })

  const [phase, setPhase] = useState<Phase>({ section: 0, localProgress: 0 })

  useMotionValueEvent(scrollYProgress, 'change', (p) => {
    const clamped = Math.max(0, Math.min(1, p))
    const section = Math.min(3, Math.floor(clamped * 4)) as SectionIndex
    const localProgress = clamped * 4 - section
    setPhase({ section, localProgress })
  })

  useEffect(() => {
    if (prefersReduced) setPhase({ section: 3, localProgress: 1 })
  }, [prefersReduced])

  const mockState = dioramaStateFor(phase, prefersReduced ?? false)

  return (
    <>
      <section
        id="diorama"
        ref={sectionRef}
        className="relative diorama-bg hidden md:block"
        style={{ height: '640vh' }}
      >
        <div className="sticky top-0 h-screen flex items-center overflow-hidden">
          <div className="w-full grid grid-cols-[minmax(0,42%)_minmax(0,58%)] gap-8 max-w-[1400px] mx-auto">
            <div className="px-8 lg:px-16">
              <CopyStack activeSection={phase.section} />
            </div>

            <div className="relative h-[68vh] xl:translate-x-[8%]">
              <ScaledMock state={mockState} fill />
            </div>
          </div>

          <ProgressRail section={phase.section} />
        </div>
      </section>

      <StackedDiorama />
    </>
  )
}

/** Mobile fallback: one block per section, each with a static snapshot of
 * the mock above the copy. No scroll hijack, no pinning — just a readable
 * stack that mirrors the desktop narrative. */
function StackedDiorama() {
  return (
    <section className="md:hidden diorama-bg py-12">
      {SECTIONS.map((s, i) => {
        const sectionIdx = i as SectionIndex
        const mockState =
          sectionIdx === 0
            ? sectionOneState(0.8)
            : sectionIdx === 1
              ? sectionTwoState(0.8)
              : sectionIdx === 2
                ? sectionThreeState(0.8)
                : sectionFourState(0.8)
        return (
          <div key={i} className="mx-auto max-w-xl px-5 py-10">
            <div className="text-[11px] uppercase tracking-[0.2em] text-brand/80 font-semibold mb-3">
              {s.eyebrow}
            </div>
            <h2 className="text-3xl font-bold tracking-tight mb-3 leading-[1.15]">{s.title}</h2>
            <p className="text-base text-ink-400 leading-relaxed mb-2">{s.body}</p>
            {s.bonus && (
              <p className="text-sm text-ink-500 leading-relaxed mb-6">
                <span className="text-brand/80 font-semibold">Bonus:</span>{' '}
                {s.bonus.replace(/^Bonus:\s*/, '')}
              </p>
            )}
            {!s.bonus && <div className="mb-6" />}
            <ScaledMock state={mockState} />
          </div>
        )
      })}
    </section>
  )
}

function CopyStack({ activeSection }: { activeSection: SectionIndex }) {
  return (
    <div className="relative h-[68vh]">
      <div className="relative w-full h-full">
        {SECTIONS.map((s, i) => {
          const active = i === activeSection
          return (
            <motion.div
              key={i}
              initial={false}
              animate={{
                opacity: active ? 1 : 0,
                y: active ? 0 : i < activeSection ? -24 : 24
              }}
              transition={{ duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
              className="absolute inset-0 flex flex-col pt-[6vh]"
              style={{
                pointerEvents: active ? 'auto' : 'none',
                zIndex: active ? 2 : 1
              }}
            >
              <div className="text-xs uppercase tracking-[0.2em] text-brand/80 font-semibold mb-5">
                {s.eyebrow}
              </div>
              <h2 className="text-4xl lg:text-5xl font-bold tracking-tight leading-[1.08] mb-6">
                {s.title}
              </h2>
              <p className="text-lg text-ink-400 leading-relaxed max-w-xl">{s.body}</p>
              {s.bonus && (
                <p className="text-sm text-ink-500 leading-relaxed max-w-xl mt-4">
                  <span className="text-brand/80 font-semibold">Bonus:</span>{' '}
                  {s.bonus.replace(/^Bonus:\s*/, '')}
                </p>
              )}
            </motion.div>
          )
        })}
      </div>
    </div>
  )
}

function ProgressRail({ section }: { section: SectionIndex }) {
  return (
    <div className="absolute left-6 top-1/2 -translate-y-1/2 flex flex-col gap-3 hidden lg:flex">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className={`w-1.5 h-8 rounded-full transition-colors ${
            i === section ? 'bg-brand' : 'bg-ink-800'
          }`}
        />
      ))}
    </div>
  )
}

function dioramaStateFor(phase: Phase, reduced: boolean): MockHarnessState {
  if (reduced) return finalState()

  const { section, localProgress } = phase

  if (section === 0) return sectionOneState(localProgress)
  if (section === 1) return sectionTwoState(localProgress)
  if (section === 2) return sectionThreeState(localProgress)
  return sectionFourState(localProgress)
}

function sectionOneState(progress: number): MockHarnessState {
  const revealCount = Math.min(BASE_WORKTREES.length, Math.floor(progress * 6) + 2)
  const worktrees = BASE_WORKTREES.slice(0, revealCount).map((w, i) => ({
    ...w,
    status: sectionOneStatusFor(i, progress)
  }))
  return {
    activeWorktreeId: '1',
    worktrees,
    highlightedElement: progress > 0.15 ? 'sidebar' : null,
    panelMode: 'terminal',
    mergedClosedCount: 3
  }
}

function sectionOneStatusFor(i: number, progress: number): MockStatus {
  const rotations: MockStatus[][] = [
    ['processing', 'processing', 'processing', 'processing'],
    ['processing', 'waiting', 'processing', 'processing'],
    ['idle', 'processing', 'processing', 'idle'],
    ['processing', 'processing', 'idle', 'processing'],
    ['waiting', 'processing', 'processing', 'processing']
  ]
  const phase = Math.min(3, Math.floor(progress * 4))
  return rotations[i]?.[phase] ?? 'processing'
}

function sectionTwoState(progress: number): MockHarnessState {
  const worktrees = BASE_WORKTREES.map((w, i) => {
    let status: MockStatus = sectionOneStatusFor(i, 0.8)
    if (i === 1) status = progress > 0.2 ? 'needs-approval' : 'processing'
    return { ...w, status }
  })
  const highlightRow = progress > 0.35
  return {
    activeWorktreeId: highlightRow ? '2' : '1',
    worktrees,
    highlightedElement: highlightRow ? 'worktree-row' : 'sidebar',
    highlightedWorktreeId: '2',
    panelMode: 'terminal',
    mergedClosedCount: 3
  }
}

function sectionThreeState(progress: number): MockHarnessState {
  const worktrees = BASE_WORKTREES.map((w, i) => ({
    ...w,
    status: i === 1 ? ('needs-approval' as MockStatus) : sectionOneStatusFor(i, 0.8)
  }))
  const showForm = progress > 0.5
  return {
    activeWorktreeId: showForm ? 'new' : '1',
    worktrees,
    highlightedElement: 'new-worktree-button',
    panelMode: showForm ? 'new-worktree-flow' : 'terminal',
    mergedClosedCount: 3
  }
}

function sectionFourState(progress: number): MockHarnessState {
  const worktrees = BASE_WORKTREES.map((w, i) => ({
    ...w,
    status: sectionOneStatusFor(i, 0.8)
  }))
  const panelOpen = progress > 0.25
  return {
    activeWorktreeId: '1',
    worktrees,
    highlightedElement: panelOpen ? null : 'right-column-button',
    panelMode: 'terminal',
    mergedClosedCount: 3,
    rightPanelOpen: panelOpen
  }
}

function finalState(): MockHarnessState {
  const worktrees = BASE_WORKTREES.map((w, i) => ({
    ...w,
    status: sectionOneStatusFor(i, 0.8)
  }))
  return {
    activeWorktreeId: '1',
    worktrees,
    highlightedElement: null,
    panelMode: 'terminal',
    mergedClosedCount: 3,
    rightPanelOpen: true
  }
}
