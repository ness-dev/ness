import { useEffect, useState } from 'react'
import {
  Check,
  FileClock,
  GitMerge,
  History,
  MessageSquareText,
  ShieldCheck,
  X
} from 'lucide-react'
import { useAppStateFor } from '../store'
import { getBackendFor } from '../backend'
import type { LochRecordingResult } from '../../shared/loch'
import { BlameGutterPreview } from './BlameGutterPreview'
import { LOCH_VERSION } from '../../shared/loch'

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'installing' }
  | { kind: 'done'; result: Extract<LochRecordingResult, { ok: true }> }
  | { kind: 'error'; message: string }

function Feature({
  icon: Icon,
  title,
  children,
  illustration
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  children: React.ReactNode
  illustration?: React.ReactNode
}): JSX.Element {
  return (
    <div className="flex gap-3">
      <div className="shrink-0 mt-0.5 w-8 h-8 rounded-md bg-accent/10 flex items-center justify-center">
        <Icon className="icon-base text-accent" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-fg-bright">{title}</div>
        <div className="text-sm text-dim mt-0.5 leading-relaxed">{children}</div>
        {illustration}
      </div>
    </div>
  )
}

function Code({ children }: { children: React.ReactNode }): JSX.Element {
  return <code className="bg-panel px-1 rounded text-xs">{children}</code>
}

/** Full-screen explanation of loch history tracking for one repo, with the
 *  install action. This is the only place recording gets switched on from
 *  outside Settings, so it spells out exactly what gets written and where
 *  before the user agrees. */
export function HistoryTrackingExplainer({
  repoRoot,
  backendId,
  onClose
}: {
  repoRoot: string
  /** The backend hosting the repo — installs happen on that machine. */
  backendId: string | null
  onClose: () => void
}): JSX.Element {
  const backend = getBackendFor(backendId)
  const available = useAppStateFor(backendId, (s) => s.loch.available)
  // Ness downloads loch on install where a release exists for the platform,
  // so "not installed" only blocks installing where there's nothing to fetch.
  const installable = useAppStateFor(backendId, (s) => s.loch.installable)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [checking, setChecking] = useState(false)
  const name = basename(repoRoot)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const install = (): void => {
    setPhase({ kind: 'installing' })
    backend.setLochRecording(repoRoot, true).then(
      (r) =>
        setPhase(
          r.ok
            ? { kind: 'done', result: r }
            : {
                kind: 'error',
                message:
                  r.code === 'download-failed'
                    ? `Couldn’t download loch${r.error ? ` (${r.error})` : ''}. Check your connection and try again.`
                    : r.code === 'checksum-mismatch'
                      ? 'The loch download didn’t match its expected checksum, so it wasn’t installed.'
                      : r.code === 'not-installed' || r.code === 'unsupported-platform'
                        ? 'loch isn’t available for this machine.'
                        : `Install failed (${r.code})${r.error ? `: ${r.error}` : ''}`
              }
        ),
      (err) => setPhase({ kind: 'error', message: String(err) })
    )
  }

  const dontAsk = (): void => {
    void backend.setLochPromptDismissed(repoRoot, true)
    onClose()
  }

  const checkAgain = (): void => {
    setChecking(true)
    backend.refreshLochAvailability().finally(() => setChecking(false))
  }

  return (
    <div className="fixed inset-0 z-50 bg-app overflow-y-auto">
      <button
        onClick={onClose}
        className="fixed top-4 right-4 p-2 rounded text-faint hover:text-fg hover:bg-panel cursor-pointer"
        aria-label="Close"
      >
        <X className="icon-base" />
      </button>

      <div className="max-w-2xl mx-auto px-8 py-16">
        <div className="flex items-center gap-2 mb-3">
          <History className="icon-lg text-accent" />
          <span className="text-xs font-semibold uppercase tracking-wider text-accent">
            History tracking
          </span>
          <span className="text-xs text-dim bg-panel border border-border rounded px-1.5 py-0.5 font-mono">
            {name}
          </span>
        </div>
        <h1 className="text-3xl font-semibold text-fg-bright leading-tight">
          See what turn, conversation &amp; agent wrote every line of code
        </h1>
        <p className="text-base text-dim mt-3 leading-relaxed">
          History tracking records each agent turn in <span className="text-fg">{name}</span> as
          it happens, so later you can point at any line and get back to the conversation, the
          prompt, and the reasoning behind it. It&apos;s powered by{' '}
          <span className="text-fg">loch</span>, which runs entirely on this machine.
        </p>

        <div className="mt-10 flex flex-col gap-6">
          <Feature icon={FileClock} title="Blame in the gutter" illustration={<BlameGutterPreview />}>
            In the file viewer gutter you can hover to see exactly which agent, turn and
            conversation wrote that line of code.
          </Feature>
          <Feature icon={MessageSquareText} title="Ask the conversation">
            Click on the gutter to open the conversation and ask it a question. Opening the
            conversation will <em>fork</em> the conversation.
          </Feature>
          <Feature icon={GitMerge} title="Survives squashes and rebases">
            Lines are matched by content, not by git commit. This allows it to survive squashes
            or other git history losses.
          </Feature>
        </div>

        <div className="mt-12 rounded-lg border border-border bg-panel-raised p-5">
          <div className="flex items-center gap-2 mb-3">
            <ShieldCheck className="icon-base text-fg" />
            <h2 className="text-base font-semibold text-fg-bright">What installing does</h2>
          </div>
          <ul className="text-sm text-dim leading-relaxed list-disc pl-5 flex flex-col gap-2">
            {!available && (
              <li>
                Downloads loch {LOCH_VERSION} from its GitHub releases into{' '}
                <Code>~/.loch/bin</Code>, since it isn&apos;t on this machine yet. The download is
                checked against a checksum pinned in Ness before it&apos;s installed.
              </li>
            )}
            <li>
              Adds three Claude Code hooks (prompt, turn end, session end) to{' '}
              <Code>.claude/settings.local.json</Code> in every worktree of {name}, including
              ones you create later. That file is machine-local, so nothing is committed. The
              hooks apply to Claude in Ness and in your own terminal.
            </li>
            <li>
              At each turn, loch snapshots the workspace and the session transcript into{' '}
              <Code>~/.loch</Code> on this machine. Nothing is uploaded; snapshots nobody needs
              are cleaned up automatically.
            </li>
            <li>
              Earlier history is backfilled once, in the background, from existing transcripts
              and commits. Those lines are marked <em>backfilled</em> because the match is
              approximate.
            </li>
            <li>
              Turn it off any time in Settings → Conversation blame. That removes the hooks;
              what&apos;s already recorded stays in <Code>~/.loch</Code>.
            </li>
          </ul>
        </div>

        <div className="mt-10">
          {phase.kind === 'done' ? (
            <div className="flex items-start gap-3">
              <div className="shrink-0 w-8 h-8 rounded-full bg-success/15 flex items-center justify-center">
                <Check className="icon-base text-success" />
              </div>
              <div className="flex-1">
                <div className="text-base font-semibold text-fg-bright">
                  History tracking is on for {name}
                </div>
                <div className="text-sm text-dim mt-1">
                  {phase.result.installed > 0 &&
                    `Hooks added to ${phase.result.installed} worktree${phase.result.installed === 1 ? '' : 's'}. `}
                  {phase.result.viaProject > 0 &&
                    `${phase.result.viaProject} already record through the repo’s own settings. `}
                  Earlier history is being backfilled now; new turns show up as they finish.
                </div>
                <button
                  onClick={onClose}
                  className="mt-4 px-4 py-2 rounded-md bg-accent/20 hover:bg-accent/30 text-fg-bright border border-accent/40 text-sm font-medium cursor-pointer"
                >
                  Done
                </button>
              </div>
            </div>
          ) : !available && !installable ? (
            <div className="rounded-lg border border-warning/30 bg-warning/10 p-4">
              <div className="text-sm font-semibold text-fg-bright">
                loch isn&apos;t available for this machine
              </div>
              <div className="text-sm text-dim mt-1 leading-relaxed">
                There&apos;s no loch release Ness can install here. If you build or install{' '}
                <Code>loch</Code> yourself and put it on your PATH, check again.
              </div>
              <div className="flex items-center gap-3 mt-3">
                <button
                  onClick={checkAgain}
                  disabled={checking}
                  className="px-3 py-1.5 rounded-md bg-panel border border-border text-sm text-fg hover:bg-panel-raised cursor-pointer disabled:opacity-50"
                >
                  {checking ? 'Checking…' : 'Check again'}
                </button>
                <button onClick={onClose} className="text-sm text-faint hover:text-fg cursor-pointer">
                  Not now
                </button>
              </div>
            </div>
          ) : (
            <>
              {phase.kind === 'error' && (
                <div className="text-sm text-danger mb-3">{phase.message}</div>
              )}
              <div className="flex items-center gap-3">
                <button
                  onClick={install}
                  disabled={phase.kind === 'installing'}
                  className="whitespace-nowrap px-4 py-2 rounded-md bg-accent/20 hover:bg-accent/30 text-fg-bright border border-accent/40 text-sm font-medium cursor-pointer disabled:opacity-50"
                >
                  {phase.kind === 'installing' ? 'Installing…' : 'Install history tracking'}
                </button>
                <button onClick={onClose} className="whitespace-nowrap text-sm text-dim hover:text-fg cursor-pointer px-2">
                  Not now
                </button>
                <button
                  onClick={dontAsk}
                  className="whitespace-nowrap ml-auto text-sm text-faint hover:text-fg cursor-pointer"
                  title={`Hide the sidebar prompt for ${name}. You can still turn it on in Settings.`}
                >
                  Don&apos;t ask again
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
