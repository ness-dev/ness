import { useRef, useState, useEffect, useLayoutEffect } from 'react'
import { motion, useMotionValueEvent, useReducedMotion, useScroll } from 'framer-motion'
import {
  MockHarness,
  type MockHarnessState,
  type MockStatus,
  type MockWorktree
} from './MockHarness'

type SectionIndex = 0 | 1 | 2 | 3
type Phase = { section: SectionIndex; localProgress: number }

const BASE_WORKTREES: Omit<MockWorktree, 'status'>[] = [
  {
    id: '1',
    branch: 'feat/onboarding',
    path: 'ness/feat-onboarding',
    age: '2d',
    pr: {
      number: 142,
      title: 'Onboarding flow ready for review',
      checks: 'success',
      additions: 142,
      deletions: 58,
      milestone: 'v1.4'
    },
    // Matches the right column: the edit lands in the uncommitted
    // src/welcome.tsx shown under Changed Files.
    chat: {
      prompt:
        'The welcome screen still says "Sign up" right after login. Show their name and a Continue button instead.',
      explanation:
        '`Welcome` reads the session before it has loaded, so it always renders the signed-out copy. Waiting on `status` fixes it.',
      edit: {
        path: 'src/welcome.tsx',
        summary: '+2 −1',
        lines: [
          { kind: 'ctx', old: 12, next: 12, text: 'export function Welcome() {' },
          { kind: 'remove', old: 13, text: '  const { user } = useSession()' },
          { kind: 'add', next: 13, text: '  const { user, status } = useSession()' },
          { kind: 'add', next: 14, text: "  if (status === 'loading') return <Spinner />" },
          { kind: 'ctx', old: 14, next: 15, text: '  if (!user) return <SignUpCta />' }
        ]
      },
      working: {
        todos: [
          { status: 'completed', text: 'Find why the signed-out copy shows' },
          { status: 'in_progress', text: 'Wait for the session before rendering' },
          { status: 'pending', text: 'Test the loading state' }
        ],
        streaming: 'Adding a test for the loading state'
      },
      approval: {
        command: 'npx vitest run src/welcome.test.tsx',
        description: 'Run the welcome screen tests'
      }
    }
  },
  {
    id: '2',
    branch: 'fix/login-flash',
    path: 'ness/fix-login-flash',
    age: '6h',
    chat: {
      prompt: 'Logging out flashes the dashboard for a frame before the redirect. Fix it.',
      explanation:
        'The redirect runs in an effect, after first paint. Guarding the route in its `loader` means a signed-out user never renders `Dashboard` at all.',
      edit: {
        path: 'src/router.ts',
        summary: '+1 −0',
        lines: [
          { kind: 'ctx', old: 21, next: 21, text: '  {' },
          { kind: 'ctx', old: 22, next: 22, text: "    path: '/dashboard'," },
          { kind: 'add', next: 23, text: '    loader: requireSession,' },
          { kind: 'ctx', old: 23, next: 24, text: '    element: <Dashboard />' },
          { kind: 'ctx', old: 24, next: 25, text: '  },' }
        ]
      },
      working: {
        todos: [
          { status: 'completed', text: 'Find where the redirect happens' },
          { status: 'in_progress', text: 'Move the guard into the loader' },
          { status: 'pending', text: 'Check it in the e2e suite' }
        ],
        streaming: 'Running the logout e2e test'
      },
      approval: {
        command: 'npx playwright test e2e/logout.spec.ts',
        description: 'Confirm the dashboard no longer flashes after logout'
      }
    }
  },
  {
    id: '3',
    branch: 'refactor/auth',
    path: 'ness/refactor-auth',
    age: '3h'
  },
  {
    id: '4',
    branch: 'chore/deps-bump',
    path: 'ness/chore-deps-bump',
    age: '1d'
  },
  {
    id: '5',
    branch: 'docs/api-reference',
    path: 'ness/docs-api-reference',
    age: '<1h'
  }
]

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

const MOCK_W = 1000
const MOCK_H = 620

/** The mock is desktop chrome — sidebar, pane and right column add up to
 * 480px before the chat gets any — so laying it out in a narrow box leaves
 * a sliver of chat. Never lay it out narrower than MOCK_W; when the box is
 * narrower than that, scale the whole window down to fit instead.
 *
 * `fill` sizes to the parent box (the pinned desktop column). Without it the
 * mock keeps MOCK_W × MOCK_H proportions and takes its height from the
 * width (the mobile stack). */
function ScaledMock({ state, fill = false }: { state: MockHarnessState; fill?: boolean }) {
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
  const layoutH = fill ? (box?.h ?? MOCK_H) / scale : MOCK_H

  return (
    <div
      ref={hostRef}
      className={fill ? 'absolute inset-0' : 'relative overflow-hidden'}
      style={fill ? undefined : { height: MOCK_H * scale }}
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
