// Port of renderer/components/AllFilesPanel.tsx.
//
// Desktop-only, omitted: row tap → file tab (onOpenFile), "Open worktree in
// editor" / "Open file in editor" (openInEditor), "Reveal in Finder"
// (openPath), the quick-open hotkey hint in the footer (no Quick Open on
// phone), and drag-a-row-into-the-composer (the @ button covers it).
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Pressable, ScrollView, Text, TextInput, View, StyleSheet } from 'react-native'
import { FileText, RefreshCw } from 'lucide-react-native'
import type { ChangedFile } from '../../../src/renderer/types'
import { buildTree, sortChildren, type TreeNode } from '../../../src/renderer/file-tree'
import { c, fs, mono, themed, getThemeMode } from '../theme'
import { PanelAction, RightPanel } from './RightPanel'
import {
  AtButton,
  DirRow,
  FileListViewToggle,
  STATUS_COLOR,
  STATUS_LABEL,
  STATUS_WORD,
  fileTreeIndent,
  flattenTree,
  useChangedFilesSet,
  useFileListView
} from './ChangedFilesPanel'
import type { PanelProps } from './types'

/** List view renders every row with no virtualization, so cap it. */
const LIST_VIEW_LIMIT = 1000

/** Copied from AllFilesPanel.tsx: while filtering, changed files sort above
 *  unchanged ones; stable tiebreak by sortChildren's alphabetical order. */
function sortChildrenChangedFirst(node: TreeNode, changedByPath: Map<string, ChangedFile>, changedFolders: Set<string>): TreeNode[] {
  const base = sortChildren(node)
  if (changedByPath.size === 0) return base
  const isChanged = (n: TreeNode): boolean => (n.isFile ? changedByPath.has(n.path) : changedFolders.has(n.path))
  return base
    .map((n, i) => ({ n, i, changed: isChanged(n) }))
    .sort((a, b) => {
      if (a.n.isFile !== b.n.isFile) return a.n.isFile ? 1 : -1
      if (a.changed !== b.changed) return a.changed ? -1 : 1
      return a.i - b.i
    })
    .map((e) => e.n)
}

type Row =
  | { key: string; kind: 'dir'; node: TreeNode; depth: number; open: boolean }
  | { key: string; kind: 'file'; name: string; path: string; depth: number | null }
  | { key: string; kind: 'more'; label: string }

export function AllFilesPanel({ client, worktreePath, onSendToAgent }: PanelProps) {
  const [files, setFiles] = useState<string[]>([])
  const [hasLoaded, setHasLoaded] = useState(false)
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']))
  const changed = useChangedFilesSet(client, worktreePath)

  // Route the (often fresh) callback through a ref so memoized rows keep stable props.
  const onSendToAgentRef = useRef(onSendToAgent)
  onSendToAgentRef.current = onSendToAgent
  const sendToAgent = useCallback((text: string) => onSendToAgentRef.current(text), [])
  const [view, toggleView] = useFileListView('all-files', 'tree')

  const refresh = useCallback(async () => {
    if (!worktreePath) return
    try {
      const result = await client.api.listAllFiles(worktreePath)
      setFiles(result)
    } catch (err) {
      console.error('Failed to list files:', err) // eslint-disable-line no-console
      setFiles([])
    } finally {
      setHasLoaded(true)
    }
  }, [client, worktreePath])

  useEffect(() => {
    setHasLoaded(false)
    setFilter('')
    setExpanded(new Set(['']))
  }, [worktreePath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const sortedFiles = useMemo(() => (view === 'list' ? [...files].sort((a, b) => a.localeCompare(b)) : files), [files, view])

  const filtered = useMemo(() => {
    if (!filter.trim()) return sortedFiles
    const q = filter.toLowerCase()
    return sortedFiles.filter((f) => f.toLowerCase().includes(q))
  }, [sortedFiles, filter])

  const filtering = filter.trim().length > 0

  const tree = useMemo(() => (view === 'tree' ? buildTree(filtered) : null), [filtered, view])

  // Changed files refresh on nearly every edit; only depend on them while
  // filtering, when they reorder the list.
  const changedFirstBy = filtering ? changed.byPath : null
  const listed = useMemo(() => {
    if (view !== 'list') return []
    if (!changedFirstBy || changedFirstBy.size === 0) return filtered.slice(0, LIST_VIEW_LIMIT)
    const changedFiles = filtered.filter((f) => changedFirstBy.has(f))
    const rest = filtered.filter((f) => !changedFirstBy.has(f))
    return [...changedFiles, ...rest].slice(0, LIST_VIEW_LIMIT)
  }, [filtered, view, changedFirstBy])

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const rows = useMemo<Row[]>(() => {
    if (!worktreePath) return []
    if (tree && filtered.length > 0) {
      const sorter = filtering ? (n: TreeNode) => sortChildrenChangedFirst(n, changed.byPath, changed.folders) : sortChildren
      return flattenTree(tree, (p) => filtering || expanded.has(p), sorter).map((r) =>
        r.kind === 'dir'
          ? { key: `d:${r.node.path}`, kind: 'dir', node: r.node, depth: r.depth, open: r.open }
          : { key: `f:${r.node.path}`, kind: 'file', name: r.node.name, path: r.node.path, depth: r.depth }
      )
    }
    if (view !== 'list') return []
    const out: Row[] = listed.map((path) => ({ key: `f:${path}`, kind: 'file', name: path.slice(path.lastIndexOf('/') + 1), path, depth: null }))
    if (filtered.length > listed.length) {
      out.push({ key: 'more', kind: 'more', label: `Showing first ${listed.length} of ${filtered.length} — filter to narrow` })
    }
    return out
  }, [worktreePath, tree, filtered, filtering, expanded, view, listed, changed])

  const actions = (
    <>
      <FileListViewToggle view={view} onToggle={toggleView} />
      {/* "Open worktree in editor" and "Reveal in Finder" — desktop-only, omitted. */}
      <PanelAction onPress={() => void refresh()} label="Refresh">
        <RefreshCw color={c.faint} size={12} />
      </PanelAction>
    </>
  )

  const renderRow = (item: Row) => {
    if (item.kind === 'dir') {
      return (
        <DirRow
          name={item.node.name}
          depth={item.depth}
          open={item.open}
          onToggle={() => toggle(item.node.path)}
          hasChangedDescendant={changed.folders.has(item.node.path)}
        />
      )
    }
    if (item.kind === 'more') {
      return <Text style={{ paddingHorizontal: 12, paddingVertical: 8, fontSize: fs.xs, color: c.faint, fontStyle: 'italic' }}>{item.label}</Text>
    }
    return (
      <FileRow
        name={item.name}
        path={item.path}
        depth={item.depth}
        onSendToAgent={sendToAgent}
        changedStatus={changed.byPath.get(item.path)?.status}
      />
    )
  }

  return (
    <RightPanel id="all-files" title="All Files" actions={actions} defaultCollapsed>
      <View style={{ padding: 8, borderBottomWidth: 1, borderColor: c.border }}>
        <TextInput
          keyboardAppearance={getThemeMode()}
          value={filter}
          onChangeText={setFilter}
          placeholder="Filter files..."
          placeholderTextColor={c.faint}
          autoCapitalize="none"
          autoCorrect={false}
          style={{
            minHeight: 44,
            backgroundColor: c.panelRaised,
            borderWidth: 1,
            borderColor: c.border,
            borderRadius: 4,
            paddingHorizontal: 8,
            fontSize: fs.base,
            color: c.fg
          }}
        />
      </View>
      {!worktreePath && <Text style={emptyStyles.emptyText}>No worktree selected</Text>}
      {worktreePath && hasLoaded && files.length === 0 && <Text style={emptyStyles.emptyText}>No files found</Text>}
      {worktreePath && filtering && filtered.length === 0 && files.length > 0 && <Text style={emptyStyles.emptyText}>No matches</Text>}
      {rows.length > 0 && (
        // ScrollView + map, not FlatList: PanelsHost is already a ScrollView
        // and nesting a VirtualizedList in one breaks windowing. Rows are capped
        // at the desktop's LIST_VIEW_LIMIT, so rendering them all is bounded.
        <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled" style={{ maxHeight: 480 }}>
          {rows.map((item) => (
            <Fragment key={item.key}>
              {renderRow(item)}
            </Fragment>
          ))}
        </ScrollView>
      )}
      {files.length > 0 && (
        <View style={{ paddingHorizontal: 12, paddingVertical: 6, borderTopWidth: 1, borderColor: c.border }}>
          <Text style={{ fontSize: fs.xs, color: c.faint }}>
            {filtering ? `${filtered.length} / ${files.length}` : files.length} file
            {files.length !== 1 ? 's' : ''}
          </Text>
          {/* "<hotkey> fuzzy open" hint omitted: no Quick Open on phone. */}
        </View>
      )}
    </RightPanel>
  )
}


const FileRow = memo(function FileRow({
  name,
  path,
  depth,
  onSendToAgent,
  changedStatus
}: {
  name: string
  path: string
  /** Tree indent level, or null in list view to show the full path. */
  depth: number | null
  onSendToAgent: (text: string) => void
  changedStatus?: ChangedFile['status']
}) {
  const dir = depth === null ? path.slice(0, path.length - name.length) : ''
  return (
    // Row tap opens a file tab on desktop (omitted); long-press shows the path.
    // The file info, not the row, is the VoiceOver element, so the @ button
    // stays reachable (see ChangedFilesPanel's FileRow).
    <Pressable
      onLongPress={() => Alert.alert(path)}
      accessible={false}
      style={({ pressed }) => ({
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingLeft: depth === null ? 8 : fileTreeIndent(depth),
        backgroundColor: pressed ? c.panelRaised : 'transparent'
      })}
    >
      <View
        accessible
        accessibilityLabel={changedStatus ? `${STATUS_WORD[changedStatus]} in this PR: ${path}` : path}
        style={{ flex: 1, minWidth: 0, alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: 4 }}
      >
        {changedStatus ? (
          <Text
            style={{ width: 12, fontFamily: mono, fontSize: fs.xs, textAlign: 'center', color: STATUS_COLOR[changedStatus] }}
          >
            {STATUS_LABEL[changedStatus]}
          </Text>
        ) : (
          <FileText color={c.faint} size={12} />
        )}
        {depth === null ? (
          <Text style={{ flex: 1, minWidth: 0, fontSize: fs.xs }} numberOfLines={1} ellipsizeMode="head">
            {dir ? <Text style={{ color: c.faint }}>{dir}</Text> : null}
            <Text style={{ color: c.fg }}>{name}</Text>
          </Text>
        ) : (
          <Text style={{ flex: 1, minWidth: 0, fontSize: fs.xs, color: c.fg }} numberOfLines={1}>
            {name}
          </Text>
        )}
      </View>
      <AtButton onPress={() => onSendToAgent(`@${path} `)} />
    </Pressable>
  )
})

// Read styles from this map (st.x); never pass a themed() object itself
// as a style. React freezes styles and flattens them by enumerating
// keys, and themed()'s Proxy supports neither, so the style silently
// vanished (text fell back to iOS's default black on dark themes).
const emptyStyles = themed(() =>
  StyleSheet.create({
  emptyText: { padding: 12, fontSize: fs.xs, color: c.faint }
  })
)
