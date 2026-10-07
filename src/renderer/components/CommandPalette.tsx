import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search, GitPullRequest, ArrowRight, FileText, Server } from 'lucide-react'
import type { Worktree, PtyStatus, PRStatus, ChangedFile } from '../types'
import type { Action, HotkeyBinding } from '../hotkeys'
import { ACTION_LABELS, bindingToString } from '../hotkeys'
import { groupWorktrees, GROUP_ORDER, GROUP_LABELS, type GroupKey } from '../../shared/worktree-sort'
import { STATUS_COLORS, STATUS_LABELS, prIconStyle } from '../worktree-row-style'
import { repoNameColor } from './RepoIcon'
import { fuzzyMatch } from '../fuzzy'
import { useBackend } from '../backend'
import { useSettings, useSnooze, useAliases, usePinned } from '../store'
import {
  CHANGED_STATUS_COLOR,
  CHANGED_STATUS_LABEL,
  useChangedFilesSet,
} from '../hooks/useChangedFilesSet'

export type PaletteMode = 'root' | 'files'

interface CommandPaletteProps {
  worktrees: Worktree[]
  worktreeStatuses: Record<string, PtyStatus>
  prStatuses: Record<string, PRStatus | null>
  mergedPaths: Record<string, boolean>
  activeWorktreeId: string | null
  resolvedHotkeys: Record<Action, HotkeyBinding>
  initialMode?: PaletteMode
  onClose: () => void
  onSelectWorktree: (path: string) => void
  onAction: (action: Action) => void
  onOpenFile: (filePath: string) => void
  onAddBackend: () => void
}

type PaletteItem =
  | { kind: 'worktree'; wt: Worktree }
  | { kind: 'action'; action: Action; label: string; hint?: string }
  | { kind: 'open-files'; label: string }
  | { kind: 'add-backend'; label: string }
  | { kind: 'heading'; label: string }
  | { kind: 'recent-worktree'; wt: Worktree }
  | { kind: 'recent-action'; action: Action; label: string; hint?: string }
  | { kind: 'recent-file'; path: string; label: string }

type FileItem = {
  path: string
  indices: number[]
  recent: boolean
  changedStatus?: ChangedFile['status']
}

interface PaletteRecent {
  id: string
  type: 'worktree' | 'action' | 'file'
  label: string
  timestamp: number
  worktreePath?: string
}

const FILE_CACHE = new Map<string, { files: string[]; ts: number }>()
const FILE_CACHE_TTL_MS = 10_000
const MAX_FILE_RESULTS = 100
const RECENTS_LIMIT = 20
const PALETTE_RECENTS_KEY = 'harness:commandPalette:recents'
const PALETTE_RECENTS_LIMIT = 3
const CHANGED_SECTION_LIMIT = 20
/** Score multiplier applied to fuzzy matches that are also in the
 *  current branch diff. Tuned by eyeballing 5–10 representative queries
 *  — high enough to surface changed files above similarly-scored
 *  unchanged ones, low enough that a clearly-better exact match still
 *  wins. */
const CHANGED_SCORE_BOOST = 1.4

function recentsKey(worktreePath: string): string {
  return `file-picker-recents:${worktreePath}`
}

function loadRecents(worktreePath: string): string[] {
  try {
    const raw = localStorage.getItem(recentsKey(worktreePath))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string') : []
  } catch {
    return []
  }
}

function loadPaletteRecents(): PaletteRecent[] {
  try {
    const raw = localStorage.getItem(PALETTE_RECENTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (r: unknown): r is PaletteRecent => {
        if (typeof r !== 'object' || r === null) return false
        const rec = r as Partial<PaletteRecent>
        return (
          typeof rec.id === 'string' &&
          (rec.type === 'worktree' || rec.type === 'action' || rec.type === 'file') &&
          typeof rec.label === 'string' &&
          typeof rec.timestamp === 'number'
        )
      }
    )
  } catch {
    return []
  }
}

function pushPaletteRecent(recent: Omit<PaletteRecent, 'timestamp'>): void {
  try {
    const existing = loadPaletteRecents().filter(
      (r) => !(r.type === recent.type && r.id === recent.id)
    )
    existing.unshift({ ...recent, timestamp: Date.now() })
    const trimmed = existing.slice(0, PALETTE_RECENTS_LIMIT)
    localStorage.setItem(PALETTE_RECENTS_KEY, JSON.stringify(trimmed))
  } catch {
    /* ignore */
  }
}

function highlightChars(
  text: string,
  indices: number[],
  offset: number
): JSX.Element[] {
  const out: JSX.Element[] = []
  const set = new Set<number>()
  for (const i of indices) {
    const local = i - offset
    if (local >= 0 && local < text.length) set.add(local)
  }
  for (let i = 0; i < text.length; i++) {
    const matched = set.has(i)
    out.push(
      <span key={i} className={matched ? 'text-accent font-semibold' : undefined}>
        {text[i]}
      </span>
    )
  }
  return out
}

function pushRecent(worktreePath: string, filePath: string): void {
  try {
    const existing = loadRecents(worktreePath).filter((p) => p !== filePath)
    existing.unshift(filePath)
    const trimmed = existing.slice(0, RECENTS_LIMIT)
    localStorage.setItem(recentsKey(worktreePath), JSON.stringify(trimmed))
  } catch {
    /* ignore */
  }
}


const EXCLUDED_ACTIONS: Set<Action> = new Set([
  'worktree1', 'worktree2', 'worktree3', 'worktree4', 'worktree5',
  'worktree6', 'worktree7', 'worktree8', 'worktree9',
  'commandPalette',
  'fileQuickOpen',
])

function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  let score = 0
  let qi = 0
  let lastMatchIdx = -1
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += 10
      if (ti === 0) score += 5
      if (lastMatchIdx === ti - 1) score += 5
      lastMatchIdx = ti
      qi++
    }
  }
  if (t.startsWith(q)) score += 20
  return qi === q.length ? score : -1
}

export function CommandPalette({
  worktrees,
  worktreeStatuses,
  prStatuses,
  mergedPaths,
  activeWorktreeId,
  resolvedHotkeys,
  initialMode = 'root',
  onClose,
  onSelectWorktree,
  onAction,
  onOpenFile,
  onAddBackend,
}: CommandPaletteProps): JSX.Element {
  const backend = useBackend()
  const changedFiles = useChangedFilesSet(activeWorktreeId)
  const [mode, setMode] = useState<PaletteMode>(initialMode)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [files, setFiles] = useState<string[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  const [recents] = useState<PaletteRecent[]>(() => loadPaletteRecents())
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Fetch files when entering files mode (with cache).
  useEffect(() => {
    if (mode !== 'files' || !activeWorktreeId) return
    const cached = FILE_CACHE.get(activeWorktreeId)
    const now = Date.now()
    if (cached && now - cached.ts < FILE_CACHE_TTL_MS) {
      setFiles(cached.files)
      return
    }
    let cancelled = false
    setFilesLoading(true)
    backend.listAllFiles(activeWorktreeId).then((result) => {
      if (cancelled) return
      FILE_CACHE.set(activeWorktreeId, { files: result, ts: Date.now() })
      setFiles(result)
      setFilesLoading(false)
    }).catch(() => {
      if (!cancelled) setFilesLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [mode, activeWorktreeId])

  // Reset query + selection when mode changes.
  useEffect(() => {
    setQuery('')
    setSelectedIndex(0)
    inputRef.current?.focus()
  }, [mode])

  const multiRepo = useMemo(() => {
    const roots = new Set(worktrees.map((wt) => wt.repoRoot))
    return roots.size > 1
  }, [worktrees])

  const viewerLogin = useSettings().viewerLogin
  const aliases = useAliases()
  const snoozeByPath = useSnooze().byPath
  const snoozedPaths = useMemo(() => {
    const m: Record<string, true> = {}
    for (const p of Object.keys(snoozeByPath)) m[p] = true
    return m
  }, [snoozeByPath])
  const pinnedPaths = usePinned().byPath
  const groups = useMemo(
    () => groupWorktrees(worktrees, prStatuses, mergedPaths, snoozedPaths, viewerLogin, undefined, pinnedPaths),
    [worktrees, prStatuses, mergedPaths, snoozedPaths, viewerLogin, pinnedPaths]
  )

  const actionItems = useMemo(() => {
    const items: { action: Action; label: string; hint?: string }[] = []
    for (const [action, label] of Object.entries(ACTION_LABELS)) {
      if (EXCLUDED_ACTIONS.has(action as Action)) continue
      const binding = resolvedHotkeys[action as Action]
      items.push({ action: action as Action, label, hint: binding ? bindingToString(binding) : undefined })
    }
    return items
  }, [resolvedHotkeys])

  const { items: fileItems, changedSectionCount } = useMemo<{
    items: FileItem[]
    changedSectionCount: number
  }>(() => {
    if (mode !== 'files' || !activeWorktreeId) return { items: [], changedSectionCount: 0 }
    const q = query.trim()
    const recents = loadRecents(activeWorktreeId)
    const recentSet = new Set(recents)
    const changedByPath = changedFiles.byPath
    const fileSet = new Set(files)

    if (q.length === 0) {
      const items: FileItem[] = []
      const seen = new Set<string>()
      // "Changed in this PR" section: preserve git's order (newest-
      // touched first when the backend returns it that way), filtered
      // through the all-files list so deleted entries don't appear as
      // un-openable rows.
      for (const cf of changedFiles.list) {
        if (items.length >= CHANGED_SECTION_LIMIT) break
        if (!fileSet.has(cf.path)) continue
        items.push({
          path: cf.path,
          indices: [],
          recent: recentSet.has(cf.path),
          changedStatus: cf.status,
        })
        seen.add(cf.path)
      }
      const changedSectionCount = items.length
      for (const p of recents) {
        if (seen.has(p)) continue
        if (!fileSet.has(p)) continue
        items.push({ path: p, indices: [], recent: true })
        seen.add(p)
      }
      for (const p of files) {
        if (items.length >= CHANGED_SECTION_LIMIT + 50 + recents.length) break
        if (seen.has(p)) continue
        items.push({ path: p, indices: [], recent: false })
      }
      return { items, changedSectionCount }
    }

    const ranked = fuzzyMatch(q, files)
    const boosted = ranked
      .map((r) => ({
        item: r.item,
        indices: r.indices,
        score: changedByPath.has(r.item) ? r.score * CHANGED_SCORE_BOOST : r.score,
      }))
      .sort((a, b) => b.score - a.score)
    return {
      items: boosted.slice(0, MAX_FILE_RESULTS).map((r) => ({
        path: r.item,
        indices: r.indices,
        recent: recentSet.has(r.item),
        changedStatus: changedByPath.get(r.item)?.status,
      })),
      changedSectionCount: 0,
    }
  }, [mode, activeWorktreeId, query, files, changedFiles])

  const { items: flatItems, selectableCount } = useMemo(() => {
    if (mode === 'files') {
      const items: PaletteItem[] = []
      // Use a synthetic encoding: we render file rows inline via fileItems,
      // but to share the keyboard nav infra we represent each file as a
      // lightweight selectable item. We piggyback the 'action' shape with a
      // distinct kind below.
      return { items, selectableCount: fileItems.length }
    }
    const isSearching = query.trim().length > 0
    const items: PaletteItem[] = []
    let selectable = 0

    if (isSearching) {
      const scoredWts = worktrees
        .map((wt) => {
          const branch = wt.branch || wt.path.split('/').pop() || ''
          const repo = wt.repoRoot.split('/').pop() || ''
          const alias = aliases.byPath[wt.path] ?? ''
          return {
            wt,
            score: Math.max(
              fuzzyScore(query, branch),
              fuzzyScore(query, repo),
              alias ? fuzzyScore(query, alias) : 0
            ),
          }
        })
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)

      const scoredActions = actionItems
        .map((a) => ({ ...a, score: fuzzyScore(query, a.label) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)

      if (scoredWts.length > 0) {
        items.push({ kind: 'heading', label: 'Worktrees' })
        for (const { wt } of scoredWts) {
          items.push({ kind: 'worktree', wt })
          selectable++
        }
      }
      if (scoredActions.length > 0) {
        items.push({ kind: 'heading', label: 'Commands' })
        for (const { action, label, hint } of scoredActions) {
          items.push({ kind: 'action', action, label, hint })
          selectable++
        }
      }
      // "Open File..." virtual action, matches any query containing "open" or "file"
      if (/open|file/i.test(query)) {
        items.push({ kind: 'open-files', label: 'Open File…' })
        selectable++
      }
      // "Add Backend…" virtual action — fuzzy-matches "add backend" /
      // "remote" / "connect" so users typing any of those find it.
      if (fuzzyScore(query, 'Add backend') > 0 || /remote|connect|backend/i.test(query)) {
        items.push({ kind: 'add-backend', label: 'Add Backend…' })
        selectable++
      }
    } else {
      const recentPaletteItems: PaletteItem[] = []
      for (const r of recents) {
        if (r.type === 'worktree') {
          if (r.id === activeWorktreeId) continue
          const wt = worktrees.find((w) => w.path === r.id)
          if (wt) recentPaletteItems.push({ kind: 'recent-worktree', wt })
        } else if (r.type === 'action') {
          const action = r.id as Action
          if (ACTION_LABELS[action] && !EXCLUDED_ACTIONS.has(action)) {
            const binding = resolvedHotkeys[action]
            recentPaletteItems.push({
              kind: 'recent-action',
              action,
              label: ACTION_LABELS[action],
              hint: binding ? bindingToString(binding) : undefined,
            })
          }
        } else if (r.type === 'file') {
          if (r.worktreePath && r.worktreePath === activeWorktreeId) {
            recentPaletteItems.push({ kind: 'recent-file', path: r.id, label: r.label })
          }
        }
      }
      if (recentPaletteItems.length > 0) {
        items.push({ kind: 'heading', label: 'Recents' })
        for (const item of recentPaletteItems) {
          items.push(item)
          selectable++
        }
      }

      for (const group of groups) {
        items.push({ kind: 'heading', label: GROUP_LABELS[group.key] })
        for (const wt of group.worktrees) {
          items.push({ kind: 'worktree', wt })
          selectable++
        }
      }
      items.push({ kind: 'heading', label: 'Commands' })
      items.push({ kind: 'open-files', label: 'Open File…' })
      selectable++
      items.push({ kind: 'add-backend', label: 'Add Backend…' })
      selectable++
      for (const a of actionItems) {
        items.push({ kind: 'action', ...a })
        selectable++
      }
    }

    return { items, selectableCount: selectable }
  }, [mode, fileItems, query, worktrees, groups, actionItems, recents, resolvedHotkeys, activeWorktreeId, aliases])

  // Map from selectable index → flat index
  const selectableIndices = useMemo(() => {
    const indices: number[] = []
    for (let i = 0; i < flatItems.length; i++) {
      if (flatItems[i].kind !== 'heading') indices.push(i)
    }
    return indices
  }, [flatItems])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query, mode])

  const openFile = useCallback(
    (filePath: string) => {
      if (activeWorktreeId) {
        pushRecent(activeWorktreeId, filePath)
        const lastSlash = filePath.lastIndexOf('/')
        const name = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath
        pushPaletteRecent({
          id: filePath,
          type: 'file',
          label: name,
          worktreePath: activeWorktreeId,
        })
      }
      onOpenFile(filePath)
      onClose()
    },
    [activeWorktreeId, onOpenFile, onClose]
  )

  const execute = useCallback(
    (item: PaletteItem) => {
      if (item.kind === 'worktree' || item.kind === 'recent-worktree') {
        const wt = item.wt
        pushPaletteRecent({
          id: wt.path,
          type: 'worktree',
          label: aliases.byPath[wt.path] ?? (wt.branch || wt.path.split('/').pop() || wt.path),
        })
        onSelectWorktree(wt.path)
      } else if (item.kind === 'action' || item.kind === 'recent-action') {
        pushPaletteRecent({ id: item.action, type: 'action', label: item.label })
        onAction(item.action)
      } else if (item.kind === 'open-files') {
        setMode('files')
        return
      } else if (item.kind === 'add-backend') {
        onAddBackend()
      } else if (item.kind === 'recent-file') {
        if (activeWorktreeId) pushRecent(activeWorktreeId, item.path)
        pushPaletteRecent({
          id: item.path,
          type: 'file',
          label: item.label,
          worktreePath: activeWorktreeId ?? undefined,
        })
        onOpenFile(item.path)
      }
      onClose()
    },
    [onClose, onSelectWorktree, onAction, onOpenFile, onAddBackend, activeWorktreeId]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (mode === 'files') {
          setMode('root')
        } else {
          onClose()
        }
      } else if (e.key === 'Backspace' && mode === 'files' && query.length === 0) {
        e.preventDefault()
        setMode('root')
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((i) => Math.min(i + 1, selectableCount - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (mode === 'files') {
          const file = fileItems[selectedIndex]
          if (file) openFile(file.path)
          return
        }
        const flatIdx = selectableIndices[selectedIndex]
        if (flatIdx !== undefined) execute(flatItems[flatIdx])
      }
    },
    [mode, query, fileItems, openFile, flatItems, selectableIndices, selectedIndex, selectableCount, execute, onClose]
  )

  useEffect(() => {
    const target =
      mode === 'files' ? selectedIndex : selectableIndices[selectedIndex]
    if (target === undefined) return
    const el = listRef.current?.querySelector(`[data-idx="${target}"]`) as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex, selectableIndices, mode])

  let selectableIdx = -1

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[15vh]" onClick={onClose}>
      <div
        className="w-full max-w-lg bg-surface rounded-xl shadow-2xl border border-border overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Search className="icon-base text-dim shrink-0" />
          {mode === 'files' && (
            <span className="inline-flex items-center gap-1 text-xs bg-accent/15 text-accent px-1.5 py-0.5 rounded font-medium shrink-0">
              <FileText className="icon-xs" />
              Open File
            </span>
          )}
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={mode === 'files' ? 'Search files…' : 'Search worktrees and commands...'}
            className="flex-1 bg-transparent text-fg-bright text-sm outline-none placeholder:text-faint"
          />
          <kbd className="text-xs text-faint bg-bg px-1.5 py-0.5 rounded border border-border font-mono">ESC</kbd>
        </div>

        <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
          {mode === 'files' && filesLoading && files.length === 0 && (
            <div className="px-4 py-8 text-center text-dim text-sm">Loading files…</div>
          )}
          {mode === 'files' && !filesLoading && fileItems.length === 0 && (
            <div className="px-4 py-8 text-center text-dim text-sm">No files match</div>
          )}
          {mode === 'files' &&
            fileItems.map((f, idx) => {
              const isSelected = idx === selectedIndex
              const lastSlash = f.path.lastIndexOf('/')
              const dir = lastSlash >= 0 ? f.path.slice(0, lastSlash) : ''
              const name = lastSlash >= 0 ? f.path.slice(lastSlash + 1) : f.path
              const nameStart = lastSlash + 1
              const showChangedHeading = !query && changedSectionCount > 0 && idx === 0
              const showAllFilesHeading =
                !query && changedSectionCount > 0 && idx === changedSectionCount &&
                fileItems.length > changedSectionCount
              return (
                <Fragment key={f.path}>
                  {showChangedHeading && (
                    <div className="px-3 pt-2 pb-1 text-xs font-semibold uppercase tracking-wider text-faint">
                      Changed in this PR
                    </div>
                  )}
                  {showAllFilesHeading && (
                    <div className="px-3 pt-2 pb-1 text-xs font-semibold uppercase tracking-wider text-faint">
                      All files
                    </div>
                  )}
                  <button
                    data-idx={idx}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer transition-colors ${
                      isSelected ? 'bg-accent/15 text-fg-bright' : 'text-fg hover:bg-surface-hover'
                    }`}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    onClick={() => openFile(f.path)}
                  >
                    {f.changedStatus ? (
                      <span
                        className={`shrink-0 w-3 font-mono text-center text-xs ${CHANGED_STATUS_COLOR[f.changedStatus]}`}
                        title={`${f.changedStatus} in this PR`}
                      >
                        {CHANGED_STATUS_LABEL[f.changedStatus]}
                      </span>
                    ) : (
                      <FileText className="icon-sm text-dim shrink-0" />
                    )}
                    <span className="truncate text-left text-fg-bright">
                      {highlightChars(name, f.indices, nameStart)}
                    </span>
                    {dir && (
                      <span className="truncate text-left text-faint text-xs min-w-0 flex-1">
                        {highlightChars(dir, f.indices, 0)}
                      </span>
                    )}
                    {f.recent && !query && !f.changedStatus && (
                      <span className="text-xs text-faint shrink-0">recent</span>
                    )}
                  </button>
                </Fragment>
              )
            })}
          {mode === 'root' && selectableCount === 0 && (
            <div className="px-4 py-8 text-center text-dim text-sm">No results</div>
          )}

          {flatItems.map((item, flatIdx) => {
            if (item.kind === 'heading') {
              return (
                <div
                  key={`h-${flatIdx}`}
                  className="px-3 pt-2 pb-1 text-xs font-semibold uppercase tracking-wider text-faint"
                >
                  {item.label}
                </div>
              )
            }

            selectableIdx++
            const mySelectableIdx = selectableIdx
            const isSelected = mySelectableIdx === selectedIndex

            if (item.kind === 'worktree' || item.kind === 'recent-worktree') {
              const { wt } = item
              const status = worktreeStatuses[wt.path] || 'idle'
              const isMerged = !!mergedPaths[wt.path]
              const displayStatus: PtyStatus | 'merged' = isMerged ? 'merged' : status
              const pr = prStatuses[wt.path]
              const isActive = wt.path === activeWorktreeId
              const repoName = multiRepo ? (wt.repoRoot.split('/').pop() || wt.repoRoot) : undefined

              const { iconColor } = prIconStyle(pr)

              const key = item.kind === 'recent-worktree' ? `recent-wt-${wt.path}` : wt.path

              return (
                <button
                  key={key}
                  data-idx={flatIdx}
                  className={`w-full flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors ${
                    isSelected ? 'bg-accent/15 text-fg-bright' : 'text-fg hover:bg-surface-hover'
                  }`}
                  onMouseEnter={() => setSelectedIndex(mySelectableIdx)}
                  onClick={() => execute(item)}
                >
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS[displayStatus]}`}
                    title={STATUS_LABELS[displayStatus]}
                  />
                  {pr && (
                    <GitPullRequest className={`icon-sm shrink-0 ${iconColor}`} />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate text-left">
                      {aliases.byPath[wt.path] ?? wt.branch}
                    </div>
                    <div className="text-xs text-faint truncate text-left">
                      {aliases.byPath[wt.path] && (
                        <>
                          <span className="font-mono">{wt.branch}</span>
                          <span className="mx-1">&middot;</span>
                        </>
                      )}
                      {repoName ? (
                        <span className="inline-flex items-center gap-1">
                          <span className={repoNameColor(repoName)}>{repoName}</span>
                          <span className="mx-0.5">&middot;</span>
                          {wt.path.split('/').pop()}
                        </span>
                      ) : (
                        wt.path.split('/').slice(-2).join('/')
                      )}
                    </div>
                  </div>
                  {isActive && (
                    <span className="text-xs text-accent font-medium shrink-0">current</span>
                  )}
                </button>
              )
            }

            if (item.kind === 'recent-file') {
              const lastSlash = item.path.lastIndexOf('/')
              const dir = lastSlash >= 0 ? item.path.slice(0, lastSlash) : ''
              const name = lastSlash >= 0 ? item.path.slice(lastSlash + 1) : item.path
              return (
                <button
                  key={`recent-file-${item.path}`}
                  data-idx={flatIdx}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer transition-colors ${
                    isSelected ? 'bg-accent/15 text-fg-bright' : 'text-fg hover:bg-surface-hover'
                  }`}
                  onMouseEnter={() => setSelectedIndex(mySelectableIdx)}
                  onClick={() => execute(item)}
                >
                  <FileText className="icon-sm text-dim shrink-0" />
                  <span className="truncate text-left text-fg-bright">{name}</span>
                  {dir && (
                    <span className="truncate text-left text-faint text-xs min-w-0 flex-1">
                      {dir}
                    </span>
                  )}
                </button>
              )
            }

            if (item.kind === 'open-files') {
              const openBinding = resolvedHotkeys['fileQuickOpen' as Action]
              return (
                <button
                  key={`open-files-${flatIdx}`}
                  data-idx={flatIdx}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-sm cursor-pointer transition-colors ${
                    isSelected ? 'bg-accent/15 text-fg-bright' : 'text-fg hover:bg-surface-hover'
                  }`}
                  onMouseEnter={() => setSelectedIndex(mySelectableIdx)}
                  onClick={() => execute(item)}
                >
                  <FileText className="icon-sm text-dim shrink-0" />
                  <span className="truncate flex-1 text-left">{item.label}</span>
                  {openBinding && (
                    <kbd className="text-xs text-faint bg-bg px-1.5 py-0.5 rounded border border-border font-mono shrink-0">
                      {bindingToString(openBinding)}
                    </kbd>
                  )}
                </button>
              )
            }

            if (item.kind === 'add-backend') {
              return (
                <button
                  key={`add-backend-${flatIdx}`}
                  data-idx={flatIdx}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-sm cursor-pointer transition-colors ${
                    isSelected ? 'bg-accent/15 text-fg-bright' : 'text-fg hover:bg-surface-hover'
                  }`}
                  onMouseEnter={() => setSelectedIndex(mySelectableIdx)}
                  onClick={() => execute(item)}
                >
                  <Server className="icon-sm text-dim shrink-0" />
                  <span className="truncate flex-1 text-left">{item.label}</span>
                </button>
              )
            }

            const actionKey =
              item.kind === 'recent-action' ? `recent-act-${item.action}` : item.action
            return (
              <button
                key={actionKey}
                data-idx={flatIdx}
                className={`w-full flex items-center gap-2 px-3 py-2 text-sm cursor-pointer transition-colors ${
                  isSelected ? 'bg-accent/15 text-fg-bright' : 'text-fg hover:bg-surface-hover'
                }`}
                onMouseEnter={() => setSelectedIndex(mySelectableIdx)}
                onClick={() => execute(item)}
              >
                <ArrowRight className="icon-sm text-dim shrink-0" />
                <span className="truncate flex-1 text-left">{item.label}</span>
                {item.hint && (
                  <kbd className="text-xs text-faint bg-bg px-1.5 py-0.5 rounded border border-border font-mono shrink-0">
                    {item.hint}
                  </kbd>
                )}
              </button>
            )
          })}
        </div>
        {mode === 'files' && files.length > 0 && (
          <div className="px-3 py-1.5 border-t border-border text-xs text-faint flex items-center justify-between">
            <span>{files.length} files · {fileItems.length} shown</span>
            <span className="font-mono">↵ open · esc back</span>
          </div>
        )}
      </div>
    </div>
  )
}
