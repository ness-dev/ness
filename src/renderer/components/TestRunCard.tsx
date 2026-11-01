import { useState } from 'react'
import {
  CircleCheck,
  CircleMinus,
  CircleX,
  FlaskConical,
  Loader2,
  Send,
  X
} from 'lucide-react'
import type { TestRun, TestStep } from '../types'
import type { TestRunStatus, TestStepStatus } from '../../shared/state/reviews'
import { TEST_RUN_STATUS_LABELS } from '../../shared/test-run-format'
import { resolveLocalImageSrc } from '../../shared/chat-image-src'
import { useBackend } from '../backend'
import { ExpandableMarkdown, ReviewMarkdown } from './ReviewMarkdown'
import { JsonModeChatImageThumb } from './JsonModeChatImageThumb'

const RUN_STATUS_CLASS: Record<TestRunStatus, string> = {
  running: 'bg-info/15 text-info',
  passed: 'bg-success/15 text-success',
  failed: 'bg-danger/15 text-danger',
  inconclusive: 'bg-warning/15 text-warning'
}

function StepIcon({ status }: { status: TestStepStatus }): JSX.Element {
  switch (status) {
    case 'running':
      return <Loader2 className="icon-xs shrink-0 animate-spin text-info" />
    case 'passed':
      return <CircleCheck className="icon-xs shrink-0 text-success" />
    case 'failed':
      return <CircleX className="icon-xs shrink-0 text-danger" />
    case 'skipped':
      return <CircleMinus className="icon-xs shrink-0 text-faint" />
  }
}

function StepRow({ step }: { step: TestStep }): JSX.Element {
  const shots = (step.screenshots ?? [])
    .map((p) => resolveLocalImageSrc(p))
    .filter((s): s is NonNullable<typeof s> => s !== null)
  const elapsed =
    step.status === 'running' ? null : Math.max(0, Math.round((step.updatedAt - step.startedAt) / 1000))
  return (
    <li className="flex gap-2.5">
      <div className="pt-0.5">
        <StepIcon status={step.status} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2.5">
          <span
            className={`min-w-0 truncate ${
              step.status === 'failed' ? 'text-danger font-medium' : 'text-fg'
            }`}
          >
            {step.title}
          </span>
          <div className="flex-1" />
          {elapsed !== null && elapsed > 0 && (
            <span className="shrink-0 text-faint tabular-nums">{elapsed}s</span>
          )}
        </div>
        {step.detail && (
          <div className="mt-1 pl-3 border-l-2 border-border">
            <ExpandableMarkdown text={step.detail} lines={step.status === 'failed' ? 4 : 3} />
          </div>
        )}
        {shots.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {shots.map((s) => (
              <JsonModeChatImageThumb key={s.path} path={s.path} mediaType={s.mediaType} shape="wide" />
            ))}
          </div>
        )}
      </div>
    </li>
  )
}

/** One tester run, as it happens: steps appear while the tester works
 *  and settle into their outcomes, then the summary and delivery state
 *  land when it finishes. */
export function TestRunCard({
  worktreePath,
  run,
  header,
  tabLabels
}: {
  worktreePath: string
  run: TestRun
  /** Who asked and when, rendered by the timeline in its own idiom. */
  header: React.ReactNode
  tabLabels: Map<string, string>
}): JSX.Element {
  const backend = useBackend()
  const [sending, setSending] = useState(false)
  const counts = { passed: 0, failed: 0, skipped: 0, running: 0 }
  for (const s of run.steps) counts[s.status]++
  const running = run.status === 'running'
  const target =
    run.delivery?.targetTabId !== undefined
      ? (tabLabels.get(run.delivery.targetTabId) ?? 'a closed tab')
      : run.requester.kind === 'agent'
        ? (tabLabels.get(run.requester.tabId) ?? run.requester.label ?? 'agent')
        : 'agent'

  const retry = (): void => {
    setSending(true)
    void backend.sendTestRun(worktreePath, run.id).finally(() => setSending(false))
  }

  return (
    <div className="rounded-md border border-border bg-panel px-4 py-3 text-xs">
      <div className="flex items-center gap-2.5">
        <span
          className={`shrink-0 inline-flex items-center gap-1.5 px-2 py-0.5 rounded font-medium ${RUN_STATUS_CLASS[run.status]}`}
        >
          {running ? <Loader2 className="icon-xs animate-spin" /> : <FlaskConical className="icon-xs" />}
          {TEST_RUN_STATUS_LABELS[run.status]}
        </span>
        <span className="shrink-0 text-faint tabular-nums">
          {counts.passed} passed · {counts.failed} failed
          {counts.skipped > 0 ? ` · ${counts.skipped} skipped` : ''}
        </span>
        {!running && run.delivery && (
          <span
            className={`truncate min-w-0 ${run.delivery.state === 'sent' ? 'text-success' : 'text-danger'}`}
          >
            {run.delivery.state === 'sent' ? `Sent to ${target}` : `Not sent to ${target}`}
          </span>
        )}
        <div className="flex-1" />
        {!running && run.delivery?.state === 'failed' && (
          <button
            onClick={retry}
            disabled={sending}
            className="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded bg-accent text-fg font-medium hover:bg-accent/80 cursor-pointer disabled:opacity-30 disabled:cursor-default"
          >
            <Send className="icon-xs" />
            Retry
          </button>
        )}
        {!running && (
          <button
            onClick={() => void backend.deleteTestRun(worktreePath, run.id)}
            aria-label="Dismiss test run"
            className="shrink-0 text-faint hover:text-danger cursor-pointer"
          >
            <X className="icon-xs" />
          </button>
        )}
      </div>
      {run.delivery?.state === 'failed' && run.delivery.error && (
        <div className="mt-1 text-danger">{run.delivery.error}</div>
      )}
      <div className="mt-2">{header}</div>
      {run.steps.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-3">
          {run.steps.map((s) => (
            <StepRow key={s.id} step={s} />
          ))}
        </ul>
      ) : running ? (
        <div className="mt-3 flex items-center gap-2 text-faint">
          <Loader2 className="icon-xs animate-spin" />
          Planning checks…
        </div>
      ) : null}
      {run.summary && (
        <div className="mt-3 pt-3 border-t border-border/50">
          <ReviewMarkdown text={run.summary} />
        </div>
      )}
      {run.headSha && (
        <div className="mt-2 text-faint">
          tested at <span className="font-mono">{run.headSha.slice(0, 7)}</span>
        </div>
      )}
    </div>
  )
}
