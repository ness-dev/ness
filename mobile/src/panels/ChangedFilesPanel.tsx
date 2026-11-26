// Port of renderer/components/ChangedFilesPanel.tsx. Also hosts the RN
// ports of the pieces AllFilesPanel shares with it on desktop:
// FileTree.tsx (view toggle, dir rows, indent), useFileListView,
// changed-files-request (in-flight dedup) and useChangedFilesSet.
//
// Desktop-only, omitted: row tap → diff tab (onOpenDiff), the "Review"
// header button (onOpenReview opens a review tab), "Open file in editor"
// (openInEditor), and drag-a-row-into-the-composer (the @ button covers it).
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, FlatList, Pressable, Text, View } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { AtSign, ChevronRight, Folder, FolderOpen, List, ListTree, RefreshCw } from 'lucide-react-native'
import type { ChangedFile } from '../../../src/renderer/types'
import { buildTree, sortChildren as sortByName, type FileListView, type TreeNode } from '../../../src/renderer/file-tree'
import { destOf } from '../../../src/shared/git-paths'
import type { NessClient } from '../ness'
import { alpha, c, fs, mono } from '../theme'
import { PanelAction, RightPanel } from './RightPanel'
import { useWatchedQuery } from './useWatchedQuery'
import type { PanelProps } from './types'

type Mode = 'working' | 'branch'

// ---------------------------------------------------------------------------
// Shared with AllFilesPanel
// ---------------------------------------------------------------------------

/** CHANGED_STATUS_LABEL / _COLOR from useChangedFilesSet.ts (ChangedFilesPanel
 *  and CommitInfoModal define the same tables). */
export const STATUS_LABEL: Record<ChangedFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U'
}
export const STATUS_COLOR: Record<ChangedFile['status'], string> = {
  added: c.success,
  modified: c.warning,
  deleted: c.danger,
  renamed: c.info,
  untracked: c.dim
}

// Port of hooks/changed-files-request.ts: in-flight-only dedup so this panel
// ('changedFiles') and useChangedFilesSet ('branchChangedFiles') don't ask the
// same branch diff twice at once. Keyed per backend too — paths can collide
// across backends.
const inFlight = new Map<string, Promise<ChangedFile[]>>()
export function requestChangedFiles(
  client: NessClient,
  path: string,
  mode: Mode,
  opts: { force?: boolean } = {}
): Promise<ChangedFile[]> {
  const key = `${client.id}::${mode}::${path}`
  if (!opts.force) {
    const existing = inFlight.get(key)
    if (existing) return existing
  }
  const promise = client.req<ChangedFile[]>('worktree:changedFiles', path, mode).finally(() => {
    if (inFlight.get(key) === promise) inFlight.delete(key)
  })
  inFlight.set(key, promise)
  return promise
}

// Port of hooks/useFileListView.ts — same key prefix, AsyncStorage instead
// of localStorage.
const VIEW_PREFIX = 'file-list-view:'
export function useFileListView(id: string, fallback: FileListView): [FileListView, () => void] {
  const [view, setView] = useState<FileListView>(fallback)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    void AsyncStorage.getItem(VIEW_PREFIX + id).then((saved) => {
      if (saved === 'list' || saved === 'tree') setView(saved)
      setLoaded(true)
    })
  }, [id])
  useEffect(() => {
    if (loaded) void AsyncStorage.setItem(VIEW_PREFIX + id, view)
  }, [id, view, loaded])
  const toggle = useCallback(() => setView((v) => (v === 'list' ? 'tree' : 'list')), [])
  return [view, toggle]
}

// Port of hooks/useChangedFilesSet.ts.
export interface ChangedFilesSetResult {
  byPath: Map<string, ChangedFile>
  folders: Set<string>
  list: ChangedFile[]
}
const EMPTY_SET: ChangedFilesSetResult = { byPath: new Map(), folders: new Set(), list: [] }
export function useChangedFilesSet(client: NessClient, worktreePath: string | null): ChangedFilesSetResult {
  const fetcher = useCallback(
    (path: string, opts: { force: boolean }) => requestChangedFiles(client, path, 'branch', opts),
    [client]
  )
  const { data } = useWatchedQuery<ChangedFile[]>({ client, worktreePath, cacheKey: 'branchChangedFiles', fetcher })
  return useMemo(() => {
    if (!data || data.length === 0) return EMPTY_SET
    const byPath = new Map<string, ChangedFile>()
    const folders = new Set<string>()
    for (const f of data) {
      byPath.set(f.path, f)
      let idx = f.path.indexOf('/')
      while (idx >= 0) {
        folders.add(f.path.slice(0, idx))
        idx = f.path.indexOf('/', idx + 1)
      }
    }
    return { byPath, folders, list: data }
  }, [data])
}

/** FileTree.tsx's FileListViewToggle. */
export function FileListViewToggle({ view, onToggle }: { view: FileListView; onToggle: () => void }) {
  const label = view === 'list' ? 'View as tree' : 'View as list'
  return (
    <PanelAction onPress={onToggle} label={label}>
      {view === 'list' ? <ListTree color={c.faint} size={14} /> : <List color={c.faint} size={14} />}
    </PanelAction>
  )
}

/** FileTree.tsx's fileTreeIndent: left padding for a file row at `depth`. */
export function fileTreeIndent(depth: number): number {
  return 8 + depth * 12 + 10
}

/** TreeBranch's recursion, flattened to rows so a long tree can live in a
 *  FlatList instead of one deep View hierarchy. Same visit order. */
export type TreeRow =
  | { kind: 'dir'; node: TreeNode; depth: number; open: boolean }
  | { kind: 'file'; node: TreeNode; depth: number }
export function flattenTree(
  root: TreeNode,
  isOpen: (path: string) => boolean,
  sortChildren: (node: TreeNode) => TreeNode[] = sortByName,
  depth = 0,
  out: TreeRow[] = []
): TreeRow[] {
  for (const child of sortChildren(root)) {
    if (child.isFile) {
      out.push({ kind: 'file', node: child, depth })
      continue
    }
    const open = isOpen(child.path)
    out.push({ kind: 'dir', node: child, depth, open })
    if (open) flattenTree(child, isOpen, sortChildren, depth + 1, out)
  }
  return out
}

/** FileTree.tsx's DirRow. */
export function DirRow({
  name,
  depth,
  open,
  onToggle,
  hasChangedDescendant
}: {
  name: string
  depth: number
  open: boolean
  onToggle: () => void
  hasChangedDescendant: boolean
}) {
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      style={({ pressed }) => ({
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingRight: 8,
        paddingLeft: 8 + depth * 12,
        backgroundColor: pressed ? c.panelRaised : 'transparent'
      })}
    >
      <ChevronRight color={c.faint} size={10} style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }} />
      {open ? <FolderOpen color={c.info} size={12} /> : <Folder color={c.info} size={12} />}
      <Text style={{ fontSize: fs.xs, color: c.fg, flexShrink: 1 }} numberOfLines={1}>
        {name}
      </Text>
      {hasChangedDescendant && (
        <View
          accessibilityLabel="Contains changes in this PR"
          style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: alpha(c.accent, 0.5), marginLeft: 4 }}
        />
      )}
    </Pressable>
  )
}

/** The hover-revealed "Reference in Claude" button, always visible here. */
export function AtButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel="Reference in Claude"
      style={({ pressed }) => ({
        width: 44,
        alignSelf: 'stretch',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: pressed ? c.surface : 'transparent'
      })}
    >
      <AtSign color={c.faint} size={12} />
    </Pressable>
  )
}

// ---------------------------------------------------------------------------
// ChangedFilesPanel
// ---------------------------------------------------------------------------

const EMPTY_FILES: ChangedFile[] = []

interface ChangedFilesData {
  working: ChangedFile[]
  branch: ChangedFile[]
}

/** One list (staged / unstaged / committed) has its own tree-collapse set,
 *  like each desktop ChangedFileList instance. */
type ListId = 'staged' | 'unstaged' | 'branch'

type Row =
  | { key: string; kind: 'section'; label: string; view: FileListView; onToggle: () => void; top: boolean }
  | { key: string; kind: 'subsection'; label: string }
  | { key: string; kind: 'empty'; label: string }
  | { key: string; kind: 'file'; file: ChangedFile; depth?: number }
  | { key: string; kind: 'dir'; list: ListId; node: TreeNode; depth: number; open: boolean }

export function ChangedFilesPanel({ client, worktreePath, onSendToAgent }: PanelProps) {
  const fetcher = useCallback(
    async (path: string, opts: { force: boolean }): Promise<ChangedFilesData> => {
      const [working, branch] = await Promise.all([
        requestChangedFiles(client, path, 'working', opts),
        requestChangedFiles(client, path, 'branch', opts)
      ])
      return { working, branch }
    },
    [client]
  )

  const { data, loading, refresh } = useWatchedQuery<ChangedFilesData>({
    client,
    worktreePath,
    cacheKey: 'changedFiles',
    fetcher
  })

  const workingFiles = data?.working ?? EMPTY_FILES
  const branchFiles = data?.branch ?? EMPTY_FILES
  const hasLoaded = !loading

  const stagedFiles = useMemo(() => workingFiles.filter((f) => f.staged), [workingFiles])
  const unstagedFiles = useMemo(() => workingFiles.filter((f) => !f.staged), [workingFiles])
  const totalCount = workingFiles.length + branchFiles.length
  const [uncommittedView, toggleUncommittedView] = useFileListView('changed-files:uncommitted', 'list')
  const [committedView, toggleCommittedView] = useFileListView('changed-files:committed', 'list')

  const [collapsed, setCollapsed] = useState<Record<ListId, Set<string>>>(() => ({
    staged: new Set(),
    unstaged: new Set(),
    branch: new Set()
  }))
  useEffect(() => {
    setCollapsed({ staged: new Set(), unstaged: new Set(), branch: new Set() })
  }, [worktreePath])
  const toggleDir = useCallback((list: ListId, path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev[list])
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return { ...prev, [list]: next }
    })
  }, [])

  const rows = useMemo<Row[]>(() => {
    if (!worktreePath || !hasLoaded) return []
    const out: Row[] = []
    const pushList = (list: ListId, files: ChangedFile[], view: FileListView): void => {
      if (view !== 'tree') {
        for (const file of files) out.push({ key: `${list}:f:${file.path}`, kind: 'file', file })
        return
      }
      // Renames are "old -> new"; place them by destination so the arrow
      // doesn't split into fake folders.
      const byPath = new Map(files.map((f) => [destOf(f.path), f]))
      const shut = collapsed[list]
      for (const r of flattenTree(buildTree([...byPath.keys()]), (p) => !shut.has(p))) {
        if (r.kind === 'dir') out.push({ key: `${list}:d:${r.node.path}`, kind: 'dir', list, node: r.node, depth: r.depth, open: r.open })
        else out.push({ key: `${list}:f:${r.node.path}`, kind: 'file', file: byPath.get(r.node.path)!, depth: r.depth })
      }
    }

    out.push({ key: 's:uncommitted', kind: 'section', label: 'Uncommitted', view: uncommittedView, onToggle: toggleUncommittedView, top: true })
    if (workingFiles.length === 0) {
      out.push({ key: 'e:working', kind: 'empty', label: 'No changes' })
    } else {
      if (stagedFiles.length > 0) out.push({ key: 'ss:staged', kind: 'subsection', label: 'Staged' })
      pushList('staged', stagedFiles, uncommittedView)
      if (unstagedFiles.length > 0) out.push({ key: 'ss:unstaged', kind: 'subsection', label: 'Unstaged' })
      pushList('unstaged', unstagedFiles, uncommittedView)
    }

    out.push({ key: 's:committed', kind: 'section', label: 'Committed', view: committedView, onToggle: toggleCommittedView, top: false })
    if (branchFiles.length === 0) out.push({ key: 'e:branch', kind: 'empty', label: 'No commits on this branch yet' })
    else pushList('branch', branchFiles, committedView)
    return out
  }, [
    worktreePath,
    hasLoaded,
    workingFiles,
    branchFiles,
    stagedFiles,
    unstagedFiles,
    uncommittedView,
    committedView,
    toggleUncommittedView,
    toggleCommittedView,
    collapsed
  ])

  const actions = (
    // "Review" (onOpenReview) opens a review tab — desktop-only, omitted.
    <PanelAction onPress={() => refresh()} label="Refresh">
      <RefreshCw color={c.faint} size={12} />
    </PanelAction>
  )

  return (
    <RightPanel id="changed-files" title="Changed Files" actions={actions}>
      {!worktreePath && <Text style={{ padding: 12, fontSize: fs.xs, color: c.faint }}>No worktree selected</Text>}
      {rows.length > 0 && (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.key}
          nestedScrollEnabled
          style={{ maxHeight: 480 }}
          initialNumToRender={30}
          renderItem={({ item }) => {
            switch (item.kind) {
              case 'section':
                return (
                  <View
                    style={{
                      minHeight: 44,
                      paddingHorizontal: 12,
                      marginTop: item.top ? 0 : 4,
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      backgroundColor: alpha(c.panelRaised, 0.5)
                    }}
                  >
                    <Text style={sectionText}>{item.label}</Text>
                    <FileListViewToggle view={item.view} onToggle={item.onToggle} />
                  </View>
                )
              case 'subsection':
                return <Text style={[sectionText, { paddingHorizontal: 12, paddingVertical: 4 }]}>{item.label}</Text>
              case 'empty':
                return (
                  <Text style={{ paddingHorizontal: 12, paddingVertical: 8, fontSize: fs.xs, color: c.faint, fontStyle: 'italic' }}>
                    {item.label}
                  </Text>
                )
              case 'dir':
                return (
                  <DirRow
                    name={item.node.name}
                    depth={item.depth}
                    open={item.open}
                    onToggle={() => toggleDir(item.list, item.node.path)}
                    hasChangedDescendant={false}
                  />
                )
              case 'file':
                return <FileRow file={item.file} depth={item.depth} onSendToAgent={onSendToAgent} />
            }
          }}
        />
      )}

      {totalCount > 0 && (
        <Text style={{ paddingHorizontal: 12, paddingVertical: 6, borderTopWidth: 1, borderColor: c.border, fontSize: fs.xs, color: c.faint }}>
          {workingFiles.length > 0 && `${workingFiles.length} uncommitted`}
          {workingFiles.length > 0 && branchFiles.length > 0 && ' · '}
          {branchFiles.length > 0 && `${branchFiles.length} committed`}
        </Text>
      )}
    </RightPanel>
  )
}

const sectionText = {
  fontSize: fs.xs,
  fontWeight: '500' as const,
  color: c.dim,
  textTransform: 'uppercase' as const,
  letterSpacing: 0.6
}

function FileRow({
  file,
  depth,
  onSendToAgent
}: {
  file: ChangedFile
  /** Set in tree view: indent to this depth and show only the file name. */
  depth?: number
  onSendToAgent: (text: string) => void
}) {
  const inTree = depth !== undefined
  const lastSlash = file.path.lastIndexOf('/')
  const dir = lastSlash >= 0 && !inTree ? file.path.slice(0, lastSlash + 1) : ''
  // The tree places renames by destination, so name them by it too.
  const shown = inTree ? destOf(file.path) : file.path
  const name = shown.slice(shown.lastIndexOf('/') + 1)

  return (
    // Row tap opens a diff tab on desktop (omitted); long-press stands in
    // for the full-path hover tooltip.
    <Pressable
      onLongPress={() => Alert.alert(file.path)}
      style={({ pressed }) => ({
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: inTree ? 4 : 8,
        paddingLeft: inTree ? fileTreeIndent(depth) : 12,
        backgroundColor: pressed ? c.panelRaised : 'transparent'
      })}
    >
      <Text style={{ width: 12, fontFamily: mono, fontSize: fs.xs, textAlign: inTree ? 'center' : 'left', color: STATUS_COLOR[file.status] }}>
        {STATUS_LABEL[file.status]}
      </Text>
      {inTree ? (
        <Text style={{ flex: 1, minWidth: 0, fontSize: fs.xs, color: c.fg }} numberOfLines={1}>
          {name}
        </Text>
      ) : (
        // Desktop truncates from the left (rtl + bdi) so the name stays visible.
        <Text style={{ flex: 1, minWidth: 0, fontSize: fs.xs }} numberOfLines={1} ellipsizeMode="head">
          {dir ? <Text style={{ color: c.faint }}>{dir}</Text> : null}
          <Text style={{ color: c.fg }}>{name}</Text>
        </Text>
      )}
      {(file.additions !== undefined || file.deletions !== undefined) && (
        <Text style={{ fontFamily: mono, fontSize: fs.xs, fontVariant: ['tabular-nums'] }}>
          {file.additions !== undefined && file.additions > 0 && <Text style={{ color: c.success }}>+{file.additions}</Text>}
          {file.deletions !== undefined && file.deletions > 0 && <Text style={{ color: c.danger }}> −{file.deletions}</Text>}
        </Text>
      )}
      <AtButton onPress={() => onSendToAgent(`@${file.path} `)} />
      {/* "Open file in editor" (openInEditor) — desktop-only, omitted. */}
    </Pressable>
  )
}
