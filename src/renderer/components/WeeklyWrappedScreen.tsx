import { useEffect, useState } from 'react'
import { NessMark } from './NessMark'
import { ArrowLeft, Loader2, GitCommit, GitPullRequest, GitBranch, Timer, Sparkles } from 'lucide-react'
import type { WeeklyStats } from '../types'
import { useBackend } from '../backend'

interface WeeklyWrappedScreenProps {
  onClose: () => void
}

function formatRange(since: number, until: number): string {
  const fmt = (t: number): string => {
    const d = new Date(t)
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }
  return `${fmt(since)} – ${fmt(until)}`
}

function formatHours(mins: number): string {
  if (mins >= 60) {
    const hours = mins / 60
    if (hours >= 10) return Math.round(hours).toString()
    return hours.toFixed(1).replace(/\.0$/, '')
  }
  return (mins / 60).toFixed(1).replace(/^0\.0$/, '0')
}

function hoursUnit(mins: number): string {
  if (mins >= 60) return 'hours'
  return 'hours'
}

export function WeeklyWrappedScreen({ onClose }: WeeklyWrappedScreenProps): JSX.Element {
  const backend = useBackend()
  const [stats, setStats] = useState<WeeklyStats | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setStats(null)
    setError(null)
    backend
      .getWeeklyStats()
      .then((s) => {
        if (!cancelled) setStats(s)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-app brand-grid-bg relative overflow-hidden">
      {/* Title bar (drag region) — Settings-style Back on the left */}
      <div className="drag-region h-10 shrink-0 border-b border-border relative">
        <button
          onClick={onClose}
          className="no-drag absolute titlebar-lead-inset top-1/2 -translate-y-1/2 flex items-center gap-1.5 text-xs text-muted hover:text-fg-bright transition-colors cursor-pointer"
        >
          <ArrowLeft className="icon-sm" />
          Back
          <kbd className="text-xs text-faint bg-bg px-1.5 py-0.5 rounded border border-border font-mono">ESC</kbd>
        </button>
        <span className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 text-sm font-medium text-fg pointer-events-none">
          My week
        </span>
      </div>

      <div className="flex-1 min-h-0 flex items-center justify-center px-4 pb-4">
        {stats === null && error === null && (
          <div className="flex items-center text-dim">
            <Loader2 className="icon-lg animate-spin mr-2" />
            Crunching your week…
          </div>
        )}
        {error !== null && (
          <div className="text-center">
            <p className="text-fg-bright text-base">Couldn&rsquo;t load your week.</p>
            <p className="text-dim text-sm mt-2">{error}</p>
          </div>
        )}
        {stats !== null && <WrappedPoster stats={stats} />}
      </div>
    </div>
  )
}

function WrappedPoster({ stats }: { stats: WeeklyStats }): JSX.Element {
  const hasActivity = stats.activeMinutes > 0 || stats.commits > 0

  if (!hasActivity) {
    return (
      <div className="max-w-md text-center">
        <NessMark className="h-12 w-auto mx-auto mb-6 text-brand" />
        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-dim mb-2">
          Your week · {formatRange(stats.since, stats.until)}
        </div>
        <p className="text-fg-bright text-2xl font-bold mt-2">A quiet week.</p>
        <p className="text-dim text-sm mt-3">
          Ship something and check back — this page lights up with everything you built.
        </p>
      </div>
    )
  }

  return (
    <div className="w-full max-w-3xl flex flex-col gap-4 sm:gap-5">
      {/* Header strip */}
      <div className="flex items-center gap-3">
        <NessMark className="h-7 w-auto shrink-0 text-brand" />
        <div className="flex-1 min-w-0">
          <div className="text-xs sm:text-xs font-semibold uppercase tracking-[0.18em] text-dim">
            Your week
          </div>
          <div className="text-sm text-fg-bright font-medium truncate">
            {formatRange(stats.since, stats.until)}
          </div>
        </div>
      </div>

      {/* Rolled-up stats — 2×2 on mobile, 4-across on desktop */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <HeroTile
          icon={GitCommit}
          value={stats.commits.toLocaleString()}
          label={stats.commits === 1 ? 'commit' : 'commits'}
          caption={`+${stats.linesAdded.toLocaleString()} / -${stats.linesRemoved.toLocaleString()}`}
          primary
        />
        <HeroTile
          icon={GitPullRequest}
          value={stats.prsMerged.toLocaleString()}
          label={stats.prsMerged === 1 ? 'PR merged' : 'PRs merged'}
          caption={stats.prsOpen > 0 ? `${stats.prsOpen} still open` : 'Landed this week'}
          accent="purple"
        />
        <HeroTile
          icon={GitBranch}
          value={stats.worktreesCreated.toLocaleString()}
          label={stats.worktreesCreated === 1 ? 'worktree' : 'worktrees'}
          caption="Branches in play"
          accent="amber"
        />
        <HeroTile
          icon={Timer}
          value={formatHours(stats.activeMinutes)}
          label={hoursUnit(stats.activeMinutes)}
          caption={`${stats.approvalsHandedOut.toLocaleString()} approvals`}
          accent="amber"
        />
      </div>

      {/* Patterns + sparkline + top worktrees — compact bottom band */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* Sparkline + patterns */}
        <div className="rounded-2xl border border-border bg-panel/70 p-4 flex flex-col gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-dim">
              Daily rhythm
            </div>
            <Sparkline values={stats.dailyMinutes} />
          </div>
          <div className="grid grid-cols-2 gap-2 border-t border-border pt-3">
            <MiniStat
              caption="Busiest"
              value={stats.busiestDay ? stats.busiestDay.label.slice(0, 3) : '—'}
            />
            <MiniStat
              caption="Peak"
              value={stats.peakHour ? stats.peakHour.label : '—'}
            />
          </div>
        </div>

        {/* Top worktrees — span 2 on desktop */}
        <div className="rounded-2xl border border-border bg-panel/70 p-4 sm:col-span-2">
          <div className="text-xs font-semibold uppercase tracking-[0.16em] text-dim mb-2">
            Where the week went
          </div>
          {stats.topWorktrees.length === 0 ? (
            <div className="text-sm text-dim py-2">No recorded sessions this week.</div>
          ) : (
            <ol className="flex flex-col gap-1.5">
              {stats.topWorktrees.map((wt, i) => {
                const hours = wt.minutes >= 60 ? (wt.minutes / 60).toFixed(1).replace(/\.0$/, '') : null
                return (
                  <li key={wt.path} className="flex items-center gap-3">
                    <span className="text-lg font-extrabold text-muted tabular-nums w-5 text-right">
                      {i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-fg-bright truncate">
                        {wt.branch}
                      </div>
                      {wt.repoLabel && (
                        <div className="text-xs text-dim truncate">{wt.repoLabel}</div>
                      )}
                    </div>
                    <div className="text-sm font-bold text-fg-bright tabular-nums shrink-0">
                      {hours ? `${hours}h` : `${wt.minutes}m`}
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
        </div>
      </div>

      {/* Closing */}
      <div className="text-center">
        <div className="inline-flex items-center gap-1.5 text-xs text-dim">
          <Sparkles className="icon-xs text-amber-400/70" />
          <span>
            See you next week <span className="text-faint">– https://getness.dev/</span>
          </span>
        </div>
      </div>
    </div>
  )
}

interface HeroTileProps {
  icon: React.ComponentType<{ size?: number; className?: string }>
  value: string
  label: string
  caption: string
  primary?: boolean
  accent?: 'amber' | 'purple'
}

function HeroTile({ icon: Icon, value, label, caption, primary, accent }: HeroTileProps): JSX.Element {
  const tone = primary
    ? 'bg-gradient-to-br from-amber-500/20 via-red-500/15 to-purple-500/20 border-amber-500/30'
    : accent === 'purple'
      ? 'bg-gradient-to-br from-purple-500/15 to-purple-500/5 border-purple-500/25'
      : 'bg-gradient-to-br from-amber-500/12 to-amber-500/5 border-amber-500/25'
  return (
    <div className={`rounded-2xl border ${tone} p-4 flex flex-col gap-1 min-w-0`}>
      <Icon className={`icon-sm ${primary ? 'text-amber-300' : accent === 'purple' ? 'text-purple-300' : 'text-amber-300'}`} />
      <div
        className={
          'font-extrabold leading-none tracking-tight tabular-nums truncate ' +
          (primary ? 'brand-gradient-text' : 'text-fg-bright')
        }
        style={{ fontSize: 'clamp(2.25rem, 7vw, 4rem)' }}
      >
        {value}
      </div>
      <div className="text-xs sm:text-sm font-semibold text-fg truncate">{label}</div>
      <div className="text-xs sm:text-xs text-dim truncate">{caption}</div>
    </div>
  )
}

function MiniStat({ caption, value }: { caption: string; value: string }): JSX.Element {
  return (
    <div className="min-w-0">
      <div className="text-xs font-semibold uppercase tracking-[0.14em] text-dim">{caption}</div>
      <div className="text-base font-bold text-fg-bright truncate">{value}</div>
    </div>
  )
}

function Sparkline({ values }: { values: number[] }): JSX.Element {
  const max = Math.max(1, ...values)
  const dowLabels = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
  const todayDow = new Date().getDay()
  return (
    <div className="flex items-end gap-1 h-10 mt-1">
      {values.map((v, i) => {
        const pct = Math.max(6, (v / max) * 100)
        const dayIdx = (todayDow - (6 - i) + 7) % 7
        const isToday = i === values.length - 1
        return (
          <div key={i} className="flex-1 flex flex-col items-center gap-0.5">
            <div
              className={
                'w-full rounded-t-sm ' +
                (isToday
                  ? 'bg-gradient-to-t from-amber-500 to-amber-300'
                  : v === 0
                    ? 'bg-border'
                    : 'bg-gradient-to-t from-amber-500/40 to-amber-400/60')
              }
              style={{ height: `${pct}%` }}
              title={`${v} min`}
            />
            <div className={'text-xs font-medium ' + (isToday ? 'text-amber-300' : 'text-dim')}>
              {dowLabels[dayIdx]}
            </div>
          </div>
        )
      })}
    </div>
  )
}
