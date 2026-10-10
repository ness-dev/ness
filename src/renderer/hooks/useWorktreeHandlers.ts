import { useCallback, useEffect, useState } from 'react'
import type { AddRepoResult, Worktree, PendingWorktree, PRStatus, TerminalTab, AgentKind, ForkSource } from '../types'
import { markTerminalClosing } from '../components/XTerminal'
import { useActiveBackend } from '../store'
import { useBackend } from '../backend'
import { randomUUID } from '../uuid'

interface UseWorktreeHandlersArgs {
  worktrees: Worktree[]
  pendingWorktrees: PendingWorktree[]
  repoRoots: string[]
  worktreeRepoByPath: Record<string, string>
  terminalTabs: Record<string, TerminalTab[]>
  prStatuses: Record<string, PRStatus | null>
  activeWorktreeId: string | null
  setActiveWorktreeId: React.Dispatch<React.SetStateAction<string | null>>
  setActivePaneId: React.Dispatch<React.SetStateAction<Record<string, string>>>
  setShowNewWorktree: React.Dispatch<React.SetStateAction<boolean>>
}

/** Worktree + repo + pending-creation handlers. Repo add/remove,
 * worktree creation FSM dispatch (runPending/retry/dismiss/continue),
 * single-path delete + bulk delete. Also subscribes to external-create
 * events from the ness-control MCP and routes focus to the new path. */
export function useWorktreeHandlers(args: UseWorktreeHandlersArgs) {
  const {
    worktrees,
    pendingWorktrees,
    repoRoots,
    worktreeRepoByPath,
    terminalTabs,
    prStatuses,
    activeWorktreeId,
    setActiveWorktreeId,
    setActivePaneId,
    setShowNewWorktree
  } = args

  const [repoPickerOpen, setRepoPickerOpen] = useState(false)
  const [repoAddPrompt, setRepoAddPrompt] = useState<
    | { kind: 'resolve'; picked: string; resolved: string }
    | { kind: 'error'; message: string }
    | null
  >(null)
  const activeBackend = useActiveBackend()
  const backend = useBackend()

  // Path of a freshly-created worktree we want to focus once it appears in the
  // worktrees list. Set on a successful create; the effect below switches to it
  // and closes the New worktree modal. Keying off the list (rather than the
  // create response) is deliberate: switching before the entry exists lets
  // App.tsx's reroute effect bounce focus to worktrees[0]. We hold the modal
  // open until then so the user lands directly on the ready worktree.
  const [newWorktreeFocusPath, setNewWorktreeFocusPath] = useState<string | null>(null)
  useEffect(() => {
    if (!newWorktreeFocusPath) return
    if (!worktrees.some((w) => w.path === newWorktreeFocusPath)) return
    setActiveWorktreeId(newWorktreeFocusPath)
    setShowNewWorktree(false)
    setNewWorktreeFocusPath(null)
  }, [newWorktreeFocusPath, worktrees, setActiveWorktreeId, setShowNewWorktree])

  const focusNewRepo = useCallback(
    (root: string) => {
      const added =
        worktrees.find((w) => w.repoRoot === root && w.isMain) ||
        worktrees.find((w) => w.repoRoot === root)
      if (added) setActiveWorktreeId(added.path)
    },
    [worktrees, setActiveWorktreeId]
  )

  const applyAddRepoResult = useCallback(
    (result: AddRepoResult) => {
      switch (result.kind) {
        case 'added':
          focusNewRepo(result.repoRoot)
          return
        case 'walked-up':
          setRepoAddPrompt({ kind: 'resolve', picked: result.picked, resolved: result.resolved })
          return
        case 'not-a-repo':
          setRepoAddPrompt({
            kind: 'error',
            message: result.picked
              ? `${result.picked} is not a git repository.`
              : 'That folder is not a git repository.'
          })
          return
        case 'canceled':
          return
      }
    },
    [focusNewRepo]
  )

  const handleAddRepo = useCallback(async () => {
    // Active backend is remote: the native dialog runs on the user's
    // laptop, but the repos live on the remote box (or in the web
    // client where there's no native dialog at all). Open the in-app
    // RemoteFilePicker instead and let it call repo:addAtPath when the
    // user selects. Per design §L: gate on per-backend kind, not the
    // legacy process-wide __HARNESS_WEB__ flag.
    if (activeBackend.kind === 'remote') {
      setRepoPickerOpen(true)
      return
    }
    const result = await backend.addRepo()
    applyAddRepoResult(result)
  }, [activeBackend.kind, applyAddRepoResult])

  const handleRepoPickerSelect = useCallback(
    async (path: string) => {
      const result = await backend.addRepoAtPath(path)
      setRepoPickerOpen(false)
      applyAddRepoResult(result)
    },
    [applyAddRepoResult]
  )

  const handleRepoPickerCancel = useCallback(() => {
    setRepoPickerOpen(false)
  }, [])

  const handleConfirmRepoResolve = useCallback(async () => {
    // Use functional setState as a single-shot guard: a rapid second
    // click sees null and bails out of the IPC.
    let target: string | null = null
    setRepoAddPrompt((p) => {
      if (p && p.kind === 'resolve') target = p.resolved
      return null
    })
    if (!target) return
    const result = await backend.addRepoAtPath(target)
    applyAddRepoResult(result)
  }, [applyAddRepoResult])

  const handleDismissRepoPrompt = useCallback(() => {
    setRepoAddPrompt(null)
  }, [])

  // External worktree creation (from the ness-control MCP). Main
  // refreshes the store list AND seeds default panes (with the prompt
  // embedded) before emitting this event, so we just focus the new path.
  useEffect(() => {
    const off = backend.onWorktreesExternalCreate(({ repoRoot, worktree }) => {
      if (!repoRoots.includes(repoRoot)) return
      setActiveWorktreeId(worktree.path)
    })
    return off
  }, [repoRoots, setActiveWorktreeId])

  const handleRemoveRepo = useCallback(
    async (root: string) => {
      await backend.removeRepo(root)
      // Main dispatches reposChanged + listChanged. If our current focus is
      // about to disappear, switch to whatever's first in the remaining list.
      if (activeWorktreeId) {
        const stillExists = worktrees.some(
          (w) => w.path === activeWorktreeId && w.repoRoot !== root
        )
        if (!stillExists) {
          const next = worktrees.find((w) => w.repoRoot !== root)
          setActiveWorktreeId(next?.path ?? null)
        }
      }
    },
    [activeWorktreeId, worktrees, setActiveWorktreeId]
  )

  const handleRefreshWorktrees = useCallback(async () => {
    await backend.refreshWorktreesList()
  }, [])

  const handlePruneWorktrees = useCallback(async (repoRoot: string) => {
    await backend.pruneWorktrees(repoRoot)
  }, [])

  const handleSubmitNewWorktree = useCallback(
    async (
      repoRoot: string,
      branchName: string,
      initialPrompt: string,
      teleportSessionId?: string,
      agentKind?: AgentKind,
      model?: string,
      checkoutExisting?: boolean,
      baseRef?: string,
      forkSource?: ForkSource
    ) => {
      const id = `pending:${randomUUID()}`

      // Keep the New worktree modal open while creation runs (the submit button
      // shows a "Creating…" state). We don't focus the pending id — on success
      // we switch straight to the real worktree once it lands in the list.
      //
      // Main handles everything: addWorktree → setup script → ensureInitialized
      // (with the prompt embedded in the new agent tab) → outcome.
      const result = await backend.runPendingWorktree({
        id,
        repoRoot,
        branchName,
        initialPrompt: initialPrompt || undefined,
        teleportSessionId,
        agentKind,
        model,
        forkSource,
        checkoutExisting,
        baseRef
      })

      if (result.outcome === 'success') {
        // Defer the switch to the effect above, which fires once createdPath is
        // actually in the worktrees list — and closes the modal then.
        setNewWorktreeFocusPath(result.createdPath)
      } else {
        // setup-failed / error: drop onto the pending entry's screen (setup log
        // + "Continue anyway", or the error) and close the modal.
        setActiveWorktreeId(id)
        setShowNewWorktree(false)
      }
    },
    [setActiveWorktreeId, setShowNewWorktree]
  )

  const handleSubmitNewPRWorktree = useCallback(
    async (
      repoRoot: string,
      prNumber: number,
      initialPrompt: string,
      agentKind?: AgentKind,
      model?: string
    ) => {
      const id = `pending:${randomUUID()}`

      // Same flow as handleSubmitNewWorktree: hold the modal open, switch to the
      // real worktree once it's in the list (success) or to the pending entry's
      // failure screen (otherwise).
      const result = await backend.runPendingPRWorktree({
        id,
        repoRoot,
        prNumber,
        initialPrompt: initialPrompt || undefined,
        agentKind,
        model
      })

      if (result.outcome === 'success') {
        setNewWorktreeFocusPath(result.createdPath)
      } else {
        setActiveWorktreeId(id)
        setShowNewWorktree(false)
      }
    },
    [setActiveWorktreeId, setShowNewWorktree]
  )

  const handleRetryPendingWorktree = useCallback((id: string) => {
    void backend.retryPendingWorktree(id)
  }, [])

  const handleDismissPendingWorktree = useCallback(
    (id: string) => {
      void backend.dismissPendingWorktree(id)
      setActiveWorktreeId((prev) => (prev === id ? null : prev))
    },
    [setActiveWorktreeId]
  )

  const handleContinuePendingWorktree = useCallback(
    (id: string) => {
      // "Continue anyway" from a setup-failed screen. Main already recorded
      // createdPath on the pending entry.
      const entry = pendingWorktrees.find((p) => p.id === id)
      void backend.dismissPendingWorktree(id)
      if (entry?.createdPath) {
        setActiveWorktreeId(entry.createdPath)
      } else {
        setActiveWorktreeId((prev) => (prev === id ? null : prev))
      }
    },
    [pendingWorktrees, setActiveWorktreeId]
  )

  const handleContinueWorktree = useCallback(
    async (path: string, newBranchName: string) => {
      const repoRoot = worktreeRepoByPath[path]
      if (!repoRoot) return
      const result = await backend.continueWorktree(repoRoot, path, newBranchName)
      // Main's worktree:continue handler doesn't refresh the store yet — ask
      // for a list refresh so the new branch name shows up.
      void backend.refreshWorktreesList()
      // Branch changed — re-fetch PR status for this worktree.
      void backend.refreshPRsOne(path)
      if (result.stashConflict) {
        window.alert(
          `Checked out ${newBranchName}, but your uncommitted changes did not apply cleanly and are still in the stash.\n\nRun \`git stash pop\` inside the worktree after resolving conflicts.`
        )
      }
    },
    [worktreeRepoByPath]
  )

  const handleDeleteWorktree = useCallback(
    async (path: string) => {
      const target = worktrees.find((w) => w.path === path)
      const overrideLock = Boolean(target?.locked && !target.prunable)
      if (overrideLock) {
        const reason = target?.lockedReason ? `\n\nLock reason: ${target.lockedReason}` : ''
        const confirmed = window.confirm(
          `This worktree is locked (git worktree lock), usually because another Claude session is using it.${reason}\n\nForce remove it anyway?`
        )
        if (!confirmed) return
      }

      // Check for dirty changes — git tracked + per-worktree scratchpad
      // notes are reported separately so the dialog can name exactly
      // what's about to be lost.
      const dirty = await backend.isWorktreeDirty(path)
      if (dirty.git || dirty.scratchpad) {
        const parts: string[] = []
        if (dirty.git) parts.push('uncommitted changes')
        if (dirty.scratchpad) parts.push('scratchpad notes')
        const confirmed = window.confirm(
          `This worktree has ${parts.join(' and ')} that will be lost. Delete anyway?`
        )
        if (!confirmed) return
      }

      // Kill any terminals running in this worktree and drop their history
      const tabs = terminalTabs[path] || []
      for (const tab of tabs) {
        if (tab.type !== 'diff' && tab.type !== 'file') markTerminalClosing(tab.id)
        backend.killTerminal(tab.id)
      }
      // Clean up pane state — main owns the panes map
      void backend.panesClearForWorktree(path)
      setActivePaneId((prev) => {
        const next = { ...prev }
        delete next[path]
        return next
      })

      // Fire-and-forget: the main-side WorktreeDeletionFSM streams phase +
      // teardown output through the store. We route focus off the deleted
      // path immediately so the neighbor is selectable while deletion runs
      // in the background.
      const pr = prStatuses[path]
      const repoRoot = worktreeRepoByPath[path]
      if (!repoRoot) return
      // Only git-tracked dirtiness needs `git worktree remove --force`;
      // a scratchpad note is invisible to git.
      void backend.removeWorktree(
        repoRoot,
        path,
        dirty.git,
        pr ? { prNumber: pr.number, prState: pr.state } : undefined,
        overrideLock ? { overrideLock } : undefined
      )
      if (path === activeWorktreeId) {
        const next = worktrees.find((w) => w.path !== path)
        setActiveWorktreeId(next?.path ?? null)
      }
    },
    [
      terminalTabs,
      activeWorktreeId,
      prStatuses,
      worktreeRepoByPath,
      worktrees,
      setActiveWorktreeId,
      setActivePaneId
    ]
  )

  // Bulk delete used by the Cleanup screen. Fires all deletions in parallel
  // — each one becomes its own pending-deletion entry and the main-side FSM
  // handles the lifecycle independently. The `done` progress callback fires
  // immediately after queueing; the user sees the actual teardown progress
  // via the per-worktree DeletingWorktreeScreen cards.
  const handleBulkDeleteWorktrees = useCallback(
    async (
      paths: string[],
      force: boolean,
      onProgress?: (path: string, phase: 'start' | 'done') => void
    ) => {
      for (const path of paths) {
        onProgress?.(path, 'start')
        const tabs = terminalTabs[path] || []
        for (const tab of tabs) {
          if (tab.type !== 'diff' && tab.type !== 'file') markTerminalClosing(tab.id)
          backend.killTerminal(tab.id)
        }
        void backend.panesClearForWorktree(path)
        setActivePaneId((prev) => {
          const next = { ...prev }
          delete next[path]
          return next
        })
        const pr = prStatuses[path]
        const repoRoot = worktreeRepoByPath[path]
        if (repoRoot) {
          void backend.removeWorktree(
            repoRoot,
            path,
            force,
            pr ? { prNumber: pr.number, prState: pr.state } : undefined
          )
        }
        onProgress?.(path, 'done')
      }
      if (activeWorktreeId && paths.includes(activeWorktreeId)) {
        const next = worktrees.find((w) => !paths.includes(w.path))
        setActiveWorktreeId(next?.path ?? null)
      }
    },
    [
      terminalTabs,
      activeWorktreeId,
      prStatuses,
      worktreeRepoByPath,
      worktrees,
      setActiveWorktreeId,
      setActivePaneId
    ]
  )

  const handleDismissPendingDeletion = useCallback(
    (path: string) => {
      void backend.dismissPendingDeletion(path)
      setActiveWorktreeId((prev) => {
        if (prev !== path) return prev
        const next = worktrees.find((w) => w.path !== path)
        return next?.path ?? null
      })
    },
    [worktrees, setActiveWorktreeId]
  )

  return {
    handleDismissPendingDeletion,
    handleAddRepo,
    handleRemoveRepo,
    handleRefreshWorktrees,
    handlePruneWorktrees,
    handleSubmitNewWorktree,
    handleSubmitNewPRWorktree,
    handleRetryPendingWorktree,
    handleDismissPendingWorktree,
    handleContinuePendingWorktree,
    handleContinueWorktree,
    handleDeleteWorktree,
    handleBulkDeleteWorktrees,
    repoPickerOpen,
    handleRepoPickerSelect,
    handleRepoPickerCancel,
    repoAddPrompt,
    handleConfirmRepoResolve,
    handleDismissRepoPrompt
  }
}
