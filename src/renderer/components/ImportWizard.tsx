import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  Loader2,
  MessageSquare,
  Check
} from 'lucide-react'
import { useBackend } from '../backend'
import type {
  RepoImportCandidate,
  RepoImportPlan,
  RepoImportSelection
} from '../../shared/repo-import-types'
import type { RepoIndexEntry } from '../../shared/repo-index-types'

/** Recreates Claude Code work the user already did outside Ness as worktrees.
 *
 *  Three questions, narrowing: which repos, which branches on them, which
 *  chats on those. Each screen's default is generous and each filter is
 *  visible, because not importing a chat costs the user nothing — all of it
 *  stays indexed and searchable in the session browser either way. Import
 *  only decides what is already on the tab strip when the worktree opens.
 *
 *  Two ways in. From the entry point the wizard starts at the repo picker.
 *  From a repo the user just added it starts at that repo's offer, since
 *  "which repos" is already answered and a checklist of forty branches is not
 *  an answer to "do you want this at all". */

interface ImportWizardProps {
  /** Set when the wizard opens right after a repo was added. */
  repoRoot?: string | null
  onDismiss: () => void
  onImported: (firstWorktreePath: string | null) => void
}

type Stage = 'repos' | 'probing' | 'offer' | 'branches' | 'chats' | 'working' | 'done'

/** A branch with more chats than this opens collapsed in the chat step. Long
 *  branches are the reason that screen needs structure at all; short ones read
 *  fine as a flat list and shouldn't cost a click. */
const COLLAPSE_ABOVE = 5

const ACTIVE_WINDOW_MS = 7 * 86_400_000

/** Windows the recency filter offers, in days. `null` is everything. */
const WINDOWS: { label: string; days: number | null }[] = [
  { label: 'Past week', days: 7 },
  { label: 'Past month', days: 30 },
  { label: 'All time', days: null }
]

/** Branch names are only unique within a repo, and the wizard can span
 *  several. NUL can't appear in either half. */
function branchKey(repoRoot: string, branch: string): string {
  return `${repoRoot}\u0000${branch}`
}

interface BranchRow {
  repoRoot: string
  repoLabel: string
  candidate: RepoImportCandidate
}

interface ImportSummary {
  created: number
  attached: number
  importedChats: number
  firstWorktreePath: string | null
  createdFirst: boolean
  failures: { repoLabel: string; branch: string; error: string | null }[]
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  const days = Math.floor(diff / 86_400_000)
  if (days < 30) return `${days}d ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

function plural(n: number, word: string): string {
  if (n === 1) return `${n} ${word}`
  return `${n} ${word}${/(?:ch|sh|s|x|z)$/.test(word) ? 'es' : 's'}`
}

/** Branches already checked out — `main` above all — don't produce a worktree,
 *  they gain tabs on one that exists. Saying "creates 9 worktrees" when four of
 *  them are already in the sidebar would be a lie the user notices. */
function countScope(rows: BranchRow[]): { creates: number; attaches: number } {
  let creates = 0
  let attaches = 0
  for (const row of rows) {
    if (row.candidate.existingWorktreePath) attaches++
    else creates++
  }
  return { creates, attaches }
}

function scopeLabel(creates: number, attaches: number): string {
  if (creates === 0 && attaches === 0) return 'Nothing selected'
  if (attaches === 0) return `Creates ${plural(creates, 'worktree')}`
  if (creates === 0) return `Adds to ${plural(attaches, 'open worktree')}`
  return `Creates ${plural(creates, 'worktree')}, adds to ${attaches} already open`
}

export function ImportWizard({
  repoRoot,
  onDismiss,
  onImported
}: ImportWizardProps): JSX.Element | null {
  const backend = useBackend()
  const [stage, setStage] = useState<Stage>(repoRoot ? 'probing' : 'repos')
  const [repoIndex, setRepoIndex] = useState<RepoIndexEntry[] | null>(null)
  const [selectedRepos, setSelectedRepos] = useState<Set<string>>(new Set())
  const [plans, setPlans] = useState<RepoImportPlan[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [windowDays, setWindowDays] = useState<number | null>(30)
  const [hideMerged, setHideMerged] = useState(true)
  const [selectedChats, setSelectedChats] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [summary, setSummary] = useState<ImportSummary | null>(null)

  const probe = useCallback(
    async (roots: string[]): Promise<void> => {
      setStage('probing')
      const probed = (await Promise.all(roots.map((root) => backend.probeRepoImport(root)))).filter(
        (p): p is RepoImportPlan => p !== null && p.candidates.length > 0
      )
      setPlans(probed)
      setSelected(
        new Set(
          probed.flatMap((p) =>
            p.candidates.filter((c) => c.recommended).map((c) => branchKey(p.repoRoot, c.branch))
          )
        )
      )
    },
    [backend]
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (repoRoot) {
        const probed = await backend.probeRepoImport(repoRoot)
        if (cancelled) return
        // Nothing to offer — never make the user dismiss an empty dialog.
        if (!probed || probed.candidates.length === 0) {
          onDismiss()
          return
        }
        setPlans([probed])
        setSelected(
          new Set(
            probed.candidates
              .filter((c) => c.recommended)
              .map((c) => branchKey(probed.repoRoot, c.branch))
          )
        )
        setStage('offer')
        return
      }
      const index = await backend.listImportableRepos()
      if (cancelled) return
      setRepoIndex(index.repos)
      const cutoff = Date.now() - ACTIVE_WINDOW_MS
      setSelectedRepos(
        new Set(index.repos.filter((r) => r.lastActivityMs >= cutoff).map((r) => r.repoRoot))
      )
    })()
    return () => {
      cancelled = true
    }
  }, [repoRoot, backend, onDismiss])

  // Esc backs out, but not mid-import: the worktrees are already being
  // created on disk and closing the dialog wouldn't stop them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || stage === 'working') return
      e.preventDefault()
      onDismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDismiss, stage])

  /** Every branch on offer, newest chat first. Sorted across repos rather
   *  than within them: "what was I working on" doesn't care which repo the
   *  answer lives in. */
  const allRows = useMemo<BranchRow[]>(
    () =>
      plans
        .flatMap((p) =>
          p.candidates.map((candidate) => ({
            repoRoot: p.repoRoot,
            repoLabel: p.repoLabel,
            candidate
          }))
        )
        .sort((a, b) => b.candidate.latestActivityMs - a.candidate.latestActivityMs),
    [plans]
  )

  const multiRepo = plans.length > 1

  const visible = useMemo(() => {
    const cutoff = windowDays === null ? 0 : Date.now() - windowDays * 86_400_000
    return allRows.filter(({ repoRoot: root, candidate }) => {
      if (candidate.latestActivityMs < cutoff) return false
      // A branch the user explicitly checked always stays visible, so
      // narrowing the filter can never silently drop it from the batch.
      if (hideMerged && candidate.merged && !selected.has(branchKey(root, candidate.branch))) {
        return false
      }
      return true
    })
  }, [allRows, windowDays, hideMerged, selected])

  /** The branches the chat step asks about, in the order it shows them. */
  const chosenRows = useMemo(
    () => allRows.filter((r) => selected.has(branchKey(r.repoRoot, r.candidate.branch))),
    [allRows, selected]
  )

  // Unchecking every chat on a branch is how the user drops it at that stage.
  // Sending it anyway would hit the backend's newest-chat fallback and create
  // the worktree they just declined.
  const requestedRows = useMemo(
    () =>
      chosenRows.filter((r) => r.candidate.chats.some((c) => selectedChats.has(c.sessionId))),
    [chosenRows, selectedChats]
  )

  const requested = useMemo(() => {
    const byRepo = new Map<string, RepoImportSelection[]>()
    for (const row of requestedRows) {
      const sessionIds = row.candidate.chats
        .filter((chat) => selectedChats.has(chat.sessionId))
        .map((chat) => chat.sessionId)
      const list = byRepo.get(row.repoRoot)
      if (list) list.push({ branch: row.candidate.branch, sessionIds })
      else byRepo.set(row.repoRoot, [{ branch: row.candidate.branch, sessionIds }])
    }
    return byRepo
  }, [requestedRows, selectedChats])

  const chosenScope = useMemo(() => countScope(chosenRows), [chosenRows])
  const requestedScope = useMemo(() => countScope(requestedRows), [requestedRows])

  const toggleRepo = useCallback((root: string) => {
    setSelectedRepos((prev) => {
      const next = new Set(prev)
      if (next.has(root)) next.delete(root)
      else next.add(root)
      return next
    })
  }, [])

  const toggle = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const toggleChat = useCallback((sessionId: string) => {
    setSelectedChats((prev) => {
      const next = new Set(prev)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }, [])

  const openBranchStep = useCallback(() => {
    void (async () => {
      await probe([...selectedRepos])
      setStage('branches')
    })()
  }, [probe, selectedRepos])

  const openChatStep = useCallback(() => {
    setSelectedChats(
      new Set(
        chosenRows.flatMap((r) =>
          r.candidate.chats.filter((chat) => chat.recommended).map((chat) => chat.sessionId)
        )
      )
    )
    setExpanded(
      new Set(
        chosenRows
          .filter((r) => r.candidate.chats.length <= COLLAPSE_ABOVE)
          .map((r) => branchKey(r.repoRoot, r.candidate.branch))
      )
    )
    setStage('chats')
  }, [chosenRows])

  const runImport = useCallback(async () => {
    setStage('working')
    const labels = new Map(plans.map((p) => [p.repoRoot, p.repoLabel]))
    const acc: ImportSummary = {
      created: 0,
      attached: 0,
      importedChats: 0,
      firstWorktreePath: null,
      createdFirst: false,
      failures: []
    }
    for (const [root, branches] of requested) {
      // The picker can name a repo Ness has never been told about. Registering
      // is idempotent, so this is a no-op on the repo-just-added path.
      await backend.addRepoAtPath(root)
      const outcome = await backend.importRepoBranches({ repoRoot: root, branches })
      acc.created += outcome.created
      acc.attached += outcome.attached
      acc.importedChats += outcome.importedChats
      for (const b of outcome.branches) {
        if (b.ok) {
          // A freshly created worktree is the better landing spot than one the
          // user already had open, so it wins the focus even if it came later.
          if (!acc.firstWorktreePath || (b.createdWorktree && !acc.createdFirst)) {
            acc.firstWorktreePath = b.worktreePath
            acc.createdFirst = b.createdWorktree
          }
        } else {
          acc.failures.push({
            repoLabel: labels.get(root) ?? root,
            branch: b.branch,
            error: b.error
          })
        }
      }
    }
    setSummary(acc)
    setStage('done')
  }, [backend, plans, requested])

  // The repo-just-added path probes before it knows whether there is anything
  // to offer, so it stays invisible until there is. From the repo picker the
  // user has already clicked, and reading the transcripts takes seconds.
  if (stage === 'repos' && !repoIndex) return null
  if (stage === 'probing' && repoRoot) return null

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center pt-[12vh] bg-black/40"
      onClick={stage === 'working' ? undefined : onDismiss}
    >
      <div
        className="w-full max-w-2xl bg-surface rounded-xl shadow-2xl border border-border overflow-hidden flex flex-col max-h-[70vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {stage === 'repos' && repoIndex ? (
          <RepoStage
            repos={repoIndex}
            selected={selectedRepos}
            onToggle={toggleRepo}
            onCancel={onDismiss}
            onContinue={openBranchStep}
          />
        ) : null}

        {stage === 'probing' ? (
          <div className="px-5 py-10 flex flex-col items-center gap-3">
            <Loader2 className="icon-lg animate-spin text-accent" />
            <div className="text-sm text-fg-bright">Reading your chat history…</div>
          </div>
        ) : null}

        {stage === 'offer' && plans[0] ? (
          <OfferStage
            plan={plans[0]}
            onDismiss={onDismiss}
            onContinue={() => setStage('branches')}
          />
        ) : null}

        {stage === 'branches' ? (
          <BranchStage
            rows={visible}
            hiddenCount={allRows.length - visible.length}
            plans={plans}
            multiRepo={multiRepo}
            selected={selected}
            scope={chosenScope}
            onToggle={toggle}
            windowDays={windowDays}
            onWindowChange={setWindowDays}
            hideMerged={hideMerged}
            onHideMergedChange={setHideMerged}
            onBack={repoRoot ? () => setStage('offer') : () => setStage('repos')}
            onContinue={openChatStep}
          />
        ) : null}

        {stage === 'chats' ? (
          <ChatStage
            rows={chosenRows}
            multiRepo={multiRepo}
            selectedChats={selectedChats}
            expanded={expanded}
            scope={requestedScope}
            onToggleChat={toggleChat}
            onToggleBranch={(key) =>
              setExpanded((prev) => {
                const next = new Set(prev)
                if (next.has(key)) next.delete(key)
                else next.add(key)
                return next
              })
            }
            onBack={() => setStage('branches')}
            onConfirm={runImport}
          />
        ) : null}

        {stage === 'working' ? (
          <div className="px-5 py-10 flex flex-col items-center gap-3">
            <Loader2 className="icon-lg animate-spin text-accent" />
            <div className="text-sm text-fg-bright">Importing your work…</div>
            <div className="text-xs text-dim text-center max-w-sm">
              New worktrees check out their branch and run the repo&apos;s setup script.
              Progress shows in the sidebar.
            </div>
          </div>
        ) : null}

        {stage === 'done' && summary ? (
          <DoneStage
            summary={summary}
            onClose={() => {
              onImported(summary.firstWorktreePath)
              onDismiss()
            }}
          />
        ) : null}
      </div>
    </div>
  )
}

function RepoStage({
  repos,
  selected,
  onToggle,
  onCancel,
  onContinue
}: {
  repos: RepoIndexEntry[]
  selected: Set<string>
  onToggle: (repoRoot: string) => void
  onCancel: () => void
  onContinue: () => void
}): JSX.Element {
  const chats = repos
    .filter((r) => selected.has(r.repoRoot))
    .reduce((n, r) => n + r.chatCount, 0)

  return (
    <>
      <div className="px-5 py-3.5 border-b border-border">
        <h2 className="text-sm font-semibold text-fg-bright">Which repos?</h2>
        <p className="text-xs text-dim mt-1">
          These are the repos your Claude Code chats ran in. The ones you touched this week are
          preselected.
        </p>
      </div>

      <div className="overflow-y-auto flex-1">
        {repos.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-dim">
            No Claude Code history found on this machine.
          </div>
        ) : null}
        {repos.map((repo) => (
          <label
            key={repo.repoRoot}
            className="flex items-center gap-3 px-5 py-2.5 border-b border-border/50 cursor-pointer hover:bg-surface-hover transition-colors"
          >
            <input
              type="checkbox"
              checked={selected.has(repo.repoRoot)}
              onChange={() => onToggle(repo.repoRoot)}
              className="icon-base cursor-pointer shrink-0"
            />
            <FolderGit2 className="icon-xs text-dim shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-sm text-fg-bright truncate">{repo.repoLabel}</div>
              <div className="text-xs text-dim truncate">{repo.repoRoot}</div>
            </div>
            <div className="text-xs text-dim text-right shrink-0 flex items-center gap-2">
              <span className="flex items-center gap-1">
                <MessageSquare className="icon-2xs" />
                {repo.chatCount}
              </span>
              <span className="w-16">{relativeTime(repo.lastActivityMs)}</span>
            </div>
          </label>
        ))}
      </div>

      <div className="px-5 py-3 border-t border-border flex items-center justify-between gap-2">
        <span className="text-xs text-dim">
          {plural(chats, 'chat')} to look through
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs font-medium rounded text-dim hover:text-fg cursor-pointer transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onContinue}
            disabled={selected.size === 0}
            className="px-4 py-1.5 text-xs font-medium rounded bg-accent/20 hover:bg-accent/30 text-fg-bright border border-accent/40 cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Choose branches
          </button>
        </div>
      </div>
    </>
  )
}

function OfferStage({
  plan,
  onDismiss,
  onContinue
}: {
  plan: RepoImportPlan
  onDismiss: () => void
  onContinue: () => void
}): JSX.Element {
  return (
    <>
      <div className="px-5 py-3.5 border-b border-border">
        <h2 className="text-sm font-semibold text-fg-bright">
          Found existing work in {plan.repoLabel}
        </h2>
      </div>
      <div className="px-5 py-4 text-sm text-fg">
        <p>
          This repo already has {plural(plan.totalSessionCount, 'Claude Code chat')} across{' '}
          {plural(plan.candidates.length, 'branch')}. Ness can bring them in as worktrees so
          you pick up where you left off.
        </p>
        {plan.recommendedCount > 0 ? (
          <p className="text-xs text-dim mt-2">
            {plural(plan.recommendedCount, 'branch')} {plan.recommendedCount === 1 ? 'looks' : 'look'}{' '}
            active — those are preselected.
          </p>
        ) : null}
      </div>
      <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
        <button
          onClick={onDismiss}
          className="px-3 py-1.5 text-xs font-medium rounded text-dim hover:text-fg cursor-pointer transition-colors"
        >
          Not now
        </button>
        <button
          onClick={onContinue}
          className="px-4 py-1.5 text-xs font-medium rounded bg-accent/20 hover:bg-accent/30 text-fg-bright border border-accent/40 cursor-pointer transition-colors"
        >
          Choose branches
        </button>
      </div>
    </>
  )
}

function BranchStage({
  rows,
  hiddenCount,
  plans,
  multiRepo,
  selected,
  scope,
  onToggle,
  windowDays,
  onWindowChange,
  hideMerged,
  onHideMergedChange,
  onBack,
  onContinue
}: {
  rows: BranchRow[]
  hiddenCount: number
  plans: RepoImportPlan[]
  multiRepo: boolean
  selected: Set<string>
  scope: { creates: number; attaches: number }
  onToggle: (key: string) => void
  windowDays: number | null
  onWindowChange: (days: number | null) => void
  hideMerged: boolean
  onHideMergedChange: (hide: boolean) => void
  onBack: () => void
  onContinue: () => void
}): JSX.Element {
  const stranded = plans.reduce((n, p) => n + p.strandedSessionCount, 0)

  return (
    <>
      <div className="px-5 py-3.5 border-b border-border">
        <h2 className="text-sm font-semibold text-fg-bright">
          Which branches are you still working on?
        </h2>
        <p className="text-xs text-dim mt-1">
          Each one becomes a worktree with its chat history attached. Branches you already
          have open just get their chats back.
        </p>
      </div>

      <div className="px-5 py-2.5 border-b border-border flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1">
          {WINDOWS.map((w) => (
            <button
              key={w.label}
              onClick={() => onWindowChange(w.days)}
              className={`px-2.5 py-1 text-xs rounded cursor-pointer transition-colors ${
                windowDays === w.days
                  ? 'bg-accent/20 text-fg-bright border border-accent/40'
                  : 'text-dim hover:text-fg border border-transparent hover:bg-surface-hover'
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-dim cursor-pointer select-none">
          <input
            type="checkbox"
            checked={hideMerged}
            onChange={(e) => onHideMergedChange(e.target.checked)}
            className="icon-base cursor-pointer"
          />
          Hide merged
        </label>
        <div className="ml-auto text-xs text-dim">{plural(selected.size, 'branch')} selected</div>
      </div>

      <div className="overflow-y-auto flex-1">
        {rows.map((row) => {
          const key = branchKey(row.repoRoot, row.candidate.branch)
          return (
            <CandidateRow
              key={key}
              candidate={row.candidate}
              repoLabel={multiRepo ? row.repoLabel : null}
              checked={selected.has(key)}
              onToggle={() => onToggle(key)}
            />
          )
        })}
        {rows.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-dim">
            No branches match this filter.
          </div>
        ) : null}
      </div>

      <div className="px-5 pt-2.5 text-xs text-dim flex items-center gap-3 flex-wrap">
        {hiddenCount > 0 ? <span>{hiddenCount} hidden by filters</span> : null}
      </div>
      {stranded > 0 ? (
        <div className="px-5 pt-1 text-xs text-dim">
          {plural(stranded, 'chat')} on deleted branches — still searchable, but can&apos;t become
          a worktree
        </div>
      ) : null}

      <div className="px-5 py-3 mt-2.5 border-t border-border flex items-center justify-between gap-2">
        <span className="text-xs text-dim">{scopeLabel(scope.creates, scope.attaches)}</span>
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            className="px-3 py-1.5 text-xs font-medium rounded text-dim hover:text-fg cursor-pointer transition-colors"
          >
            Back
          </button>
          <button
            onClick={onContinue}
            disabled={selected.size === 0}
            className="px-4 py-1.5 text-xs font-medium rounded bg-accent/20 hover:bg-accent/30 text-fg-bright border border-accent/40 cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Choose chats
          </button>
        </div>
      </div>
    </>
  )
}

function ChatStage({
  rows,
  multiRepo,
  selectedChats,
  expanded,
  scope,
  onToggleChat,
  onToggleBranch,
  onBack,
  onConfirm
}: {
  rows: BranchRow[]
  multiRepo: boolean
  selectedChats: Set<string>
  expanded: Set<string>
  scope: { creates: number; attaches: number }
  onToggleChat: (sessionId: string) => void
  onToggleBranch: (key: string) => void
  onBack: () => void
  onConfirm: () => void
}): JSX.Element {
  const total = rows.reduce(
    (n, r) => n + r.candidate.chats.filter((chat) => selectedChats.has(chat.sessionId)).length,
    0
  )

  return (
    <>
      <div className="px-5 py-3.5 border-b border-border">
        <h2 className="text-sm font-semibold text-fg-bright">Which chats should open?</h2>
        <p className="text-xs text-dim mt-1">
          Each becomes a tab in its worktree. Everything else stays searchable in the session
          browser.
        </p>
      </div>

      <div className="overflow-y-auto flex-1">
        {rows.map((row) => {
          const key = branchKey(row.repoRoot, row.candidate.branch)
          const open = expanded.has(key)
          const chosen = row.candidate.chats.filter((c) => selectedChats.has(c.sessionId)).length
          return (
            <div key={key} className="border-b border-border/50">
              <button
                onClick={() => onToggleBranch(key)}
                className="w-full flex items-center gap-2 px-5 py-2 text-left cursor-pointer hover:bg-surface-hover transition-colors"
              >
                {open ? (
                  <ChevronDown className="icon-xs text-dim shrink-0" />
                ) : (
                  <ChevronRight className="icon-xs text-dim shrink-0" />
                )}
                <GitBranch className="icon-xs text-dim shrink-0" />
                <span className="text-sm text-fg-bright truncate">{row.candidate.branch}</span>
                {multiRepo ? (
                  <span className="text-xs text-dim shrink-0">{row.repoLabel}</span>
                ) : null}
                <span className="ml-auto text-xs text-dim shrink-0">
                  {chosen} of {row.candidate.chats.length}
                </span>
              </button>
              {open
                ? row.candidate.chats.map((chat) => (
                    <label
                      key={chat.sessionId}
                      className="flex items-center gap-3 pl-12 pr-5 py-1.5 cursor-pointer hover:bg-surface-hover transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={selectedChats.has(chat.sessionId)}
                        onChange={() => onToggleChat(chat.sessionId)}
                        className="icon-base cursor-pointer shrink-0"
                      />
                      <span className="text-xs text-fg truncate flex-1">
                        {chat.title ?? 'Untitled chat'}
                      </span>
                      <span className="text-xs text-dim shrink-0 w-16 text-right">
                        {relativeTime(chat.lastActivityMs)}
                      </span>
                    </label>
                  ))
                : null}
            </div>
          )
        })}
      </div>

      <div className="px-5 py-3 border-t border-border flex items-center justify-between gap-2">
        <span className="text-xs text-dim">
          {scopeLabel(scope.creates, scope.attaches)} · {plural(total, 'chat')}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            className="px-3 py-1.5 text-xs font-medium rounded text-dim hover:text-fg cursor-pointer transition-colors"
          >
            Back
          </button>
          <button
            onClick={onConfirm}
            disabled={scope.creates + scope.attaches === 0}
            className="px-4 py-1.5 text-xs font-medium rounded bg-accent/20 hover:bg-accent/30 text-fg-bright border border-accent/40 cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Import
          </button>
        </div>
      </div>
    </>
  )
}

function CandidateRow({
  candidate,
  repoLabel,
  checked,
  onToggle
}: {
  candidate: RepoImportCandidate
  repoLabel: string | null
  checked: boolean
  onToggle: () => void
}): JSX.Element {
  return (
    <label className="flex items-start gap-3 px-5 py-2.5 border-b border-border/50 cursor-pointer hover:bg-surface-hover transition-colors">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="icon-base mt-0.5 cursor-pointer shrink-0"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <GitBranch className="icon-xs text-dim shrink-0" />
          <span className="text-sm text-fg-bright truncate">{candidate.branch}</span>
          {repoLabel ? <span className="text-xs text-dim shrink-0">{repoLabel}</span> : null}
          {candidate.existingWorktreePath ? (
            <span className="text-xs px-1.5 py-0.5 rounded bg-surface-hover text-dim shrink-0">
              open
            </span>
          ) : null}
          {candidate.merged ? (
            <span className="text-xs px-1.5 py-0.5 rounded bg-surface-hover text-dim shrink-0">
              merged
            </span>
          ) : null}
          {candidate.prNumber !== null ? (
            <span className="flex items-center gap-0.5 text-xs text-dim shrink-0">
              <GitPullRequest className="icon-2xs" />
              {candidate.prNumber}
            </span>
          ) : null}
        </div>
        {candidate.latestTitle ? (
          <div className="text-xs text-dim truncate mt-0.5">{candidate.latestTitle}</div>
        ) : null}
      </div>
      <div className="text-xs text-dim text-right shrink-0 flex items-center gap-2">
        <span className="flex items-center gap-1">
          <MessageSquare className="icon-2xs" />
          {candidate.sessionCount}
        </span>
        <span className="w-16">{relativeTime(candidate.latestActivityMs)}</span>
      </div>
    </label>
  )
}

function DoneStage({
  summary,
  onClose
}: {
  summary: ImportSummary
  onClose: () => void
}): JSX.Element {
  return (
    <>
      <div className="px-5 py-3.5 border-b border-border flex items-center gap-2">
        <Check className="icon-sm text-accent" />
        <h2 className="text-sm font-semibold text-fg-bright">
          Imported {plural(summary.importedChats, 'chat')}
        </h2>
      </div>
      <div className="px-5 py-4 text-sm text-fg overflow-y-auto">
        <p>
          {summary.created > 0
            ? `${plural(summary.created, 'new worktree')} ready to resume`
            : 'Ready to resume'}
          {summary.attached > 0
            ? `, plus ${plural(summary.attached, 'branch')} you already had open`
            : ''}
          .
        </p>
        {summary.failures.length > 0 ? (
          <div className="mt-3">
            <p className="text-xs text-dim mb-1.5">
              {plural(summary.failures.length, 'branch')} couldn&apos;t be imported:
            </p>
            <ul className="text-xs text-dim space-y-1">
              {summary.failures.map((f) => (
                <li key={`${f.repoLabel}/${f.branch}`} className="truncate">
                  <span className="text-fg">{f.branch}</span> — {f.error}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <div className="px-5 py-3 border-t border-border flex items-center justify-end">
        <button
          onClick={onClose}
          className="px-4 py-1.5 text-xs font-medium rounded bg-accent/20 hover:bg-accent/30 text-fg-bright border border-accent/40 cursor-pointer transition-colors"
        >
          Done
        </button>
      </div>
    </>
  )
}
