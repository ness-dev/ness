import type { TestRun, TestRunStatus, TestStepStatus } from './state/reviews'

export const TEST_RUN_STATUS_LABELS: Record<TestRunStatus, string> = {
  running: 'Testing',
  passed: 'Passed',
  failed: 'Failed',
  inconclusive: 'Inconclusive'
}

export const TEST_STEP_STATUS_LABELS: Record<TestStepStatus, string> = {
  running: 'running',
  passed: 'passed',
  failed: 'FAILED',
  skipped: 'skipped'
}

/** Short handle for a step. report_test_step accepts it as `step_id`. */
export function shortStepId(id: string): string {
  return id.slice(0, 8)
}

/** The message a finished run sends to the tab that asked for it. Failed
 *  steps come first and keep their detail; passing ones are a checklist,
 *  since the author needs what broke more than what held. */
export function formatTestRunResults(run: TestRun): string {
  const counts = { passed: 0, failed: 0, skipped: 0, running: 0 }
  for (const s of run.steps) counts[s.status]++
  const tally = [
    `${counts.passed} passed`,
    `${counts.failed} failed`,
    ...(counts.skipped ? [`${counts.skipped} skipped`] : [])
  ].join(', ')
  const lines = [
    `Test run: ${TEST_RUN_STATUS_LABELS[run.status]}${run.headSha ? ` at ${run.headSha.slice(0, 7)}` : ''} (${tally})`,
    ''
  ]
  if (run.summary?.trim()) lines.push(run.summary.trim(), '')

  const failed = run.steps.filter((s) => s.status === 'failed')
  if (failed.length > 0) {
    lines.push('Failed:')
    for (const s of failed) {
      lines.push(`- ${s.title}`)
      if (s.detail?.trim()) {
        for (const l of s.detail.trim().split('\n')) lines.push(`  ${l}`)
      }
      for (const shot of s.screenshots ?? []) lines.push(`  Screenshot: ${shot}`)
    }
    lines.push('')
  }

  const rest = run.steps.filter((s) => s.status !== 'failed')
  if (rest.length > 0) {
    lines.push('Other checks:')
    for (const s of rest) lines.push(`- [${TEST_STEP_STATUS_LABELS[s.status]}] ${s.title}`)
  }
  return lines.join('\n').trimEnd()
}
