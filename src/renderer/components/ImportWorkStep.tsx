// Body of the onboarding wizard's last step when the scan found existing
// work. It borrows the sidebar's vocabulary — the repo letter square, the
// repo's hashed colour, status dots — so what a user ticks here is
// recognisably what they navigate by a minute later, but lays rows out
// across the full card instead of the sidebar's narrow column.
import { useMemo, useState, type JSX } from 'react'
import { Check, ChevronDown, ChevronRight, Loader2, Minus } from 'lucide-react'
import { RepoIcon, repoNameColor } from './RepoIcon'
import {
  formatAge,
  partitionRepos,
  summarizeWork,
  type DiscoveredRepo,
  type DiscoveredWorktree,
  type DiscoveredWork
} from '../../shared/work-discovery'

const WORKTREES_SHOWN = 4

interface ImportWorkStepProps {
  work: DiscoveredWork
  selected: ReadonlySet<string>
  onSelectedChange: (next: Set<string>) => void
  importing: boolean
  /** Message from a failed import, shown above the button. */
  error?: string | null
  onImport: () => void
  onAddManually: () => void
  onNewProject: () => void
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function Checkbox({
  state,
  disabled
}: {
  state: 'on' | 'off' | 'mixed'
  disabled?: boolean
}): JSX.Element {
  return (
    <span
      aria-hidden
      className={`icon-base rounded border flex items-center justify-center shrink-0 transition-colors ${
        state === 'off'
          ? 'border-border-strong bg-app/40'
          : disabled
            ? 'border-border-strong bg-border-strong text-app'
            : 'border-accent bg-accent text-app'
      }`}
    >
      {state === 'on' && <Check className="icon-xs" strokeWidth={3} />}
      {state === 'mixed' && <Minus className="icon-xs" strokeWidth={3} />}
    </span>
  )
}

function WorktreeStatus({ wt, now }: { wt: DiscoveredWorktree; now: number }): JSX.Element {
  const live = wt.session?.live
  if (live) {
    const label = live.status === 'busy' ? 'working' : live.status
    return (
      <span className="text-fg whitespace-nowrap">
        {label} <span className="text-dim">· elsewhere</span>
      </span>
    )
  }
  if (wt.lastActiveAt == null) return <span className="text-faint whitespace-nowrap">no conversations</span>
  return <span className="text-dim whitespace-nowrap">{formatAge(wt.lastActiveAt, now)}</span>
}

function WorktreeDot({ wt }: { wt: DiscoveredWorktree }): JSX.Element {
  const live = wt.session?.live
  const cls = !live
    ? wt.session
      ? 'bg-faint'
      : 'border border-border-strong'
    : live.status === 'busy'
      ? 'bg-success animate-pulse'
      : live.status === 'waiting'
        ? 'bg-warning'
        : 'bg-success/50'
  return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${cls}`} />
}

function RepoRow({
  repo,
  checked,
  expanded,
  now,
  onToggle,
  onExpand
}: {
  repo: DiscoveredRepo
  checked: boolean
  expanded: boolean
  now: number
  onToggle: () => void
  onExpand: () => void
}): JSX.Element {
  const [showAll, setShowAll] = useState(false)
  const shown = showAll ? repo.worktrees : repo.worktrees.slice(0, WORKTREES_SHOWN)
  const hidden = repo.worktrees.length - shown.length
  return (
    <div className={`rounded-lg border transition-colors ${checked ? 'border-border-strong bg-app/40' : 'border-border'}`}>
      <div className="flex items-center">
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          aria-label={`Open ${repo.name} in Ness`}
          disabled={repo.alreadyAdded}
          onClick={onToggle}
          className={`flex-1 min-w-0 flex items-center gap-3 pl-3 pr-2 py-2.5 text-left ${
            repo.alreadyAdded ? 'cursor-default' : 'cursor-pointer'
          }`}
        >
          <Checkbox state={checked ? 'on' : 'off'} disabled={repo.alreadyAdded} />
          <RepoIcon repoName={repo.name} className="text-lg" />
          <span className={`text-sm font-semibold truncate ${repoNameColor(repo.name)}`}>{repo.name}</span>
          <span className="ml-auto pl-3 text-xs text-dim whitespace-nowrap">
            {plural(repo.worktrees.length, 'worktree')}
            {' · '}
            {repo.alreadyAdded ? (
              'already in Ness'
            ) : repo.liveCount > 0 ? (
              <span className="text-fg">{repo.liveCount} running now</span>
            ) : (
              formatAge(repo.lastActiveAt, now)
            )}
          </span>
        </button>
        <button
          type="button"
          onClick={onExpand}
          aria-expanded={expanded}
          aria-label={expanded ? `Hide ${repo.name} worktrees` : `Show ${repo.name} worktrees`}
          className="self-stretch px-3 text-dim hover:text-fg cursor-pointer"
        >
          {expanded ? <ChevronDown className="icon-sm" /> : <ChevronRight className="icon-sm" />}
        </button>
      </div>
      {expanded && (
        <div className="border-t border-border/60 py-1.5">
          {shown.map((wt) => (
            <div key={wt.path} className="flex items-center gap-3 pl-11 pr-4 py-1 text-xs" title={wt.path}>
              <WorktreeDot wt={wt} />
              <span className="w-56 max-w-[45%] shrink-0 truncate text-fg-bright">{wt.branch}</span>
              <span className="hidden sm:block flex-1 min-w-0 truncate text-dim">
                {wt.session?.lastPrompt ?? ''}
              </span>
              <span className="ml-auto pl-2">
                <WorktreeStatus wt={wt} now={now} />
              </span>
            </div>
          ))}
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="ml-11 mt-1 text-xs text-accent hover:underline cursor-pointer"
            >
              Show {hidden} more
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function ImportWorkStep({
  work,
  selected,
  onSelectedChange,
  importing,
  error,
  onImport,
  onAddManually,
  onNewProject
}: ImportWorkStepProps): JSX.Element {
  const now = work.scannedAt
  const { primary, rest } = useMemo(() => partitionRepos(work.repos, now), [work.repos, now])
  // The most recent repo opens expanded so the step shows real branches and
  // prompts without a click; the others stay one line each.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(primary[0] ? [primary[0].repoRoot] : [])
  )
  const [showRest, setShowRest] = useState(primary.length === 0)

  const summary = useMemo(() => summarizeWork(work.repos), [work.repos])
  const selectable = work.repos.filter((r) => !r.alreadyAdded)
  const chosen = selectable.filter((r) => selected.has(r.repoRoot))
  const liveChosen = chosen.reduce((n, r) => n + r.liveCount, 0)
  const visible = (showRest ? [...primary, ...rest] : primary).filter((r) => !r.alreadyAdded)
  const allVisibleOn = visible.length > 0 && visible.every((r) => selected.has(r.repoRoot))

  const toggle = (repoRoot: string): void => {
    const next = new Set(selected)
    if (!next.delete(repoRoot)) next.add(repoRoot)
    onSelectedChange(next)
  }
  const toggleExpanded = (repoRoot: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (!next.delete(repoRoot)) next.add(repoRoot)
      return next
    })
  }
  const setAllVisible = (on: boolean): void => {
    const next = new Set(selected)
    for (const repo of visible) {
      if (on) next.add(repo.repoRoot)
      else next.delete(repo.repoRoot)
    }
    onSelectedChange(next)
  }

  const renderRow = (repo: DiscoveredRepo): JSX.Element => (
    <RepoRow
      key={repo.repoRoot}
      repo={repo}
      checked={repo.alreadyAdded || selected.has(repo.repoRoot)}
      expanded={expanded.has(repo.repoRoot)}
      now={now}
      onToggle={() => toggle(repo.repoRoot)}
      onExpand={() => toggleExpanded(repo.repoRoot)}
    />
  )

  return (
    <div className="ml-8">
      <div className="flex items-baseline gap-x-4 gap-y-1 flex-wrap mb-2.5">
        <span className="text-xs text-dim">Found on this machine</span>
        {(
          [
            [summary.repos, 'repo'],
            [summary.worktrees, 'worktree'],
            [summary.conversations, 'conversation']
          ] as const
        ).map(([count, word]) => (
          <span key={word} className="flex items-baseline gap-1">
            <span className="text-base font-semibold text-fg-bright tabular-nums">{count}</span>
            <span className="text-xs text-dim">{count === 1 ? word : `${word}s`}</span>
          </span>
        ))}
        {summary.live > 0 && (
          <span className="flex items-center gap-1.5 text-xs text-fg">
            <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
            {summary.live} running now
          </span>
        )}
        {visible.length > 1 && (
          <button
            type="button"
            onClick={() => setAllVisible(!allVisibleOn)}
            className="ml-auto text-xs text-dim hover:text-fg cursor-pointer"
          >
            {allVisibleOn ? 'Select none' : 'Select all'}
          </button>
        )}
      </div>
      <div className="space-y-1.5">
        {primary.map(renderRow)}
        {rest.length > 0 && (
          <button
            type="button"
            onClick={() => setShowRest((v) => !v)}
            aria-expanded={showRest}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-dim hover:text-fg cursor-pointer"
          >
            {showRest ? <ChevronDown className="icon-xs" /> : <ChevronRight className="icon-xs" />}
            {rest.length} more, older or in temp folders
          </button>
        )}
        {showRest && rest.map(renderRow)}
      </div>

      {liveChosen > 0 && (
        <p className="mt-3 text-xs text-dim leading-relaxed">
          <span className="text-fg">
            {liveChosen === 1
              ? '1 conversation is running in another terminal.'
              : `${liveChosen} conversations are running in other terminals.`}
          </span>{' '}
          {liveChosen === 1 ? 'It keeps' : 'They keep'} running there. Open{' '}
          {liveChosen === 1 ? 'it' : 'one'} here whenever you like and Ness continues from a copy.
        </p>
      )}

      {error && (
        <p role="alert" className="mt-3 text-xs text-danger leading-relaxed">
          The import didn't finish ({error}). Some repos may already have been added. You can try again.
        </p>
      )}

      <div className="mt-4 flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={onImport}
          disabled={chosen.length === 0 || importing}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer bg-fg-bright text-app hover:bg-fg border border-fg-bright disabled:opacity-40 disabled:cursor-default"
        >
          {importing && <Loader2 className="icon-sm animate-spin" />}
          {chosen.length === 0 ? 'Choose a repo to open' : `Open ${plural(chosen.length, 'repo')} in Ness`}
        </button>
        <span className="text-xs text-dim">
          or{' '}
          <button type="button" onClick={onAddManually} className="text-fg-bright hover:underline cursor-pointer">
            add a repository manually
          </button>
          {' / '}
          <button type="button" onClick={onNewProject} className="text-fg-bright hover:underline cursor-pointer">
            start a new project
          </button>
        </span>
      </div>
    </div>
  )
}
