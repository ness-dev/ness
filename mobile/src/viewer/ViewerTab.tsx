// Body of a `file` or `diff` tab: ports of the desktop's FileView and
// DiffView (renderer/components/), read-only. Same requests, same
// placeholders; Monaco becomes code-html.ts's page in a WebView.
//
// Not ported: editing and save, word wrap, loch blame, and the desktop
// header's open-in-editor / reveal-in-Finder buttons.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { Image } from 'expo-image'
import { WebView } from 'react-native-webview'
import { Code2, Eye, RefreshCw } from 'lucide-react-native'
import type { TerminalTab } from '../../../src/shared/state/terminals'
import type { CommitDiff, FileDiffSides, FileReadResult } from '../../../src/renderer/types'
import type { NessClient } from '../ness'
import { c, fs, mono } from '../theme'
import { Empty } from '../components/Empty'
import { Markdown } from '../components/Markdown'
import { ChatClientContext } from '../chat/ChatImage'
import { CodeWebView } from './CodeWebView'
import { diffHtml, fileHtml } from './code-html'
import { parseGitDiff, unifiedDiff } from './diff-model'

type ViewerMode = 'text' | 'markdown' | 'image' | 'pdf'

// FileView.tsx's tables.
const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdown', 'mkd'])
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'])

function detectViewerMode(filePath: string): ViewerMode {
  const ext = (filePath.split('.').pop() || '').toLowerCase()
  if (MARKDOWN_EXTS.has(ext)) return 'markdown'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  return 'text'
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function ViewerTab({ client, worktreePath, tab }: { client: NessClient; worktreePath: string; tab: TerminalTab }) {
  if (tab.type === 'file' && tab.filePath) return <FileTabBody client={client} worktreePath={worktreePath} filePath={tab.filePath} />
  if (tab.type === 'diff' && tab.filePath) return <FileDiffBody client={client} worktreePath={worktreePath} tab={tab} filePath={tab.filePath} />
  if (tab.type === 'diff' && tab.commitHash) return <CommitDiffBody client={client} worktreePath={worktreePath} commitHash={tab.commitHash} />
  return <Empty message="Nothing to show" />
}

/** FileHeader / the diff header: path (start-truncated so the name shows),
 *  a detail on the right, and optional actions. */
function Header({ path, detail, children }: { path: string; detail?: ReactNode; children?: ReactNode }) {
  const slash = path.lastIndexOf('/')
  return (
    <View style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, borderBottomWidth: 1, borderColor: c.border, backgroundColor: c.panel }}>
      <Text style={{ flex: 1, minWidth: 0, fontFamily: mono, fontSize: fs.xs }} numberOfLines={1} ellipsizeMode="head">
        {slash >= 0 && <Text style={{ color: c.faint }}>{path.slice(0, slash + 1)}</Text>}
        <Text style={{ color: c.fg }}>{path.slice(slash + 1)}</Text>
      </Text>
      {detail}
      {children}
      {!children && <View style={{ width: 4 }} />}
    </View>
  )
}

function HeaderButton({ label, onPress, children }: { label: string; onPress: () => void; children: ReactNode }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? c.surface : 'transparent' })}
    >
      {children}
    </Pressable>
  )
}

const Detail = ({ children }: { children: ReactNode }) => <Text style={{ fontSize: fs.xs, color: c.faint }}>{children}</Text>

/** Re-runs `load` whenever the file changes on disk, via the same
 *  worktree:watchFile signal the desktop's FileView listens on. */
function useFileWatch(client: NessClient, worktreePath: string, filePath: string | null, onChange: () => void): void {
  useEffect(() => {
    if (!filePath) return
    client.api.watchFile(worktreePath, filePath)
    const off = client.api.onFileContentChanged((wt, rel) => {
      if (wt === worktreePath && rel === filePath) onChange()
    })
    return () => {
      off()
      client.api.unwatchFile(worktreePath, filePath)
    }
    // onChange is a fresh closure each render; the subscription only
    // depends on which file it watches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, worktreePath, filePath])
}

type FileState =
  | { kind: 'loading' }
  | { kind: 'text'; result: FileReadResult }
  | { kind: 'binary'; uri: string; size: number; mime: string }
  | { kind: 'error'; message: string }

function FileTabBody({ client, worktreePath, filePath }: { client: NessClient; worktreePath: string; filePath: string }) {
  const mode = detectViewerMode(filePath)
  const needsBinary = mode === 'image' || mode === 'pdf'
  const [state, setState] = useState<FileState>({ kind: 'loading' })
  const [markdownAsCode, setMarkdownAsCode] = useState(false)
  const [reload, setReload] = useState(0)
  useFileWatch(client, worktreePath, filePath, () => setReload((n) => n + 1))

  useEffect(() => {
    let cancelled = false
    const done = (s: FileState) => !cancelled && setState(s)
    const fail = (e: unknown) => done({ kind: 'error', message: e instanceof Error ? e.message : 'Failed to read file' })
    if (needsBinary) {
      client.api.readWorktreeFileBinary(worktreePath, filePath).then(
        (r) => done(r.ok ? { kind: 'binary', uri: `data:${r.mime};base64,${r.base64}`, size: r.size, mime: r.mime } : { kind: 'error', message: r.error }),
        fail
      )
    } else {
      client.api.readWorktreeFile(worktreePath, filePath).then(
        (r) => done(r.error ? { kind: 'error', message: r.error } : { kind: 'text', result: r }),
        fail
      )
    }
    return () => {
      cancelled = true
    }
  }, [client, worktreePath, filePath, needsBinary, reload])

  const text = state.kind === 'text' && !state.result.binary && !state.result.truncated ? state.result.content ?? '' : null
  const showMarkdown = mode === 'markdown' && text !== null && !markdownAsCode
  // Building the page highlights the whole file; only redo it when the
  // text does.
  const html = useMemo(() => (text !== null && !showMarkdown ? fileHtml(text, filePath) : null), [text, showMarkdown, filePath])

  if (state.kind === 'loading') return <Empty message="Loading file..." />
  if (state.kind === 'error') return <Empty message={state.message || 'Failed to read file'} />

  if (state.kind === 'binary') {
    return (
      <View style={{ flex: 1, backgroundColor: c.app }}>
        <Header path={filePath} detail={<Detail>{formatBytes(state.size)}</Detail>} />
        {mode === 'image' ? (
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ flexGrow: 1, padding: 16 }}
            maximumZoomScale={8}
            minimumZoomScale={1}
            centerContent
          >
            <Image source={{ uri: state.uri }} contentFit="scale-down" style={{ flex: 1, minHeight: 200 }} accessibilityLabel={filePath} />
          </ScrollView>
        ) : (
          <WebView source={{ uri: state.uri }} originWhitelist={['*']} style={{ flex: 1, backgroundColor: c.app }} />
        )}
      </View>
    )
  }

  const { result } = state
  const isMarkdown = mode === 'markdown' && text !== null
  return (
    <View style={{ flex: 1, backgroundColor: c.app }}>
      <Header path={filePath} detail={<Detail>{formatBytes(result.size)}</Detail>}>
        {isMarkdown && (
          <HeaderButton label={markdownAsCode ? 'Show rendered' : 'Show source'} onPress={() => setMarkdownAsCode((v) => !v)}>
            {markdownAsCode ? <Eye color={c.dim} size={14} /> : <Code2 color={c.dim} size={14} />}
          </HeaderButton>
        )}
        <HeaderButton label="Reload" onPress={() => setReload((n) => n + 1)}>
          <RefreshCw color={c.dim} size={13} />
        </HeaderButton>
      </Header>
      {result.binary ? (
        <Text style={{ padding: 16, color: c.faint, fontSize: fs.sm }}>Binary file — not shown.</Text>
      ) : result.truncated ? (
        <Empty message="File is larger than 2 MB — not shown." />
      ) : showMarkdown ? (
        // Images resolve through this backend, as in a chat.
        <ChatClientContext.Provider value={client}>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
            <Markdown text={text} />
          </ScrollView>
        </ChatClientContext.Provider>
      ) : html !== null ? (
        <CodeWebView html={html} />
      ) : null}
    </View>
  )
}

type DiffState = { kind: 'loading' } | { kind: 'ready'; sides: FileDiffSides } | { kind: 'error'; message: string }

function FileDiffBody({ client, worktreePath, tab, filePath }: { client: NessClient; worktreePath: string; tab: TerminalTab; filePath: string }) {
  const [state, setState] = useState<DiffState>({ kind: 'loading' })
  const [reload, setReload] = useState(0)
  const { commitHash, staged, branchDiff } = tab
  // A commit's diff never changes; working and branch diffs follow the file
  // on disk, as the desktop's ReviewDiffPane does.
  useFileWatch(client, worktreePath, commitHash ? null : filePath, () => setReload((n) => n + 1))

  useEffect(() => {
    let cancelled = false
    const request = commitHash
      ? client.api.getCommitFileDiffSides(worktreePath, commitHash, filePath)
      : client.api.getFileDiffSides(worktreePath, filePath, staged ?? false, branchDiff ? 'branch' : 'working')
    request.then(
      (sides) => !cancelled && setState({ kind: 'ready', sides }),
      (e: unknown) => !cancelled && setState({ kind: 'error', message: e instanceof Error ? e.message : 'No diff available' })
    )
    return () => {
      cancelled = true
    }
  }, [client, worktreePath, filePath, commitHash, staged, branchDiff, reload])

  const sides = state.kind === 'ready' ? state.sides : null
  const shown = sides && !sides.binary && !sides.tooLarge && !sides.error
  const diff = useMemo(() => (shown && sides ? unifiedDiff(sides.original, sides.modified) : null), [shown, sides])
  const html = useMemo(
    () => (diff && sides && diff.rows.length > 0 ? diffHtml(diff, { original: sides.original, modified: sides.modified, filePath }) : null),
    [diff, sides, filePath]
  )

  if (state.kind === 'loading') return <Empty message="Loading diff..." />
  if (state.kind === 'error' || !sides) return <Empty message={state.kind === 'error' ? state.message : 'No diff available'} />

  const scope = commitHash ? commitHash.slice(0, 7) : branchDiff ? 'Branch' : staged ? 'Staged' : 'Unstaged'
  return (
    <View style={{ flex: 1, backgroundColor: c.app }}>
      <Header
        path={filePath}
        detail={
          <Text style={{ fontFamily: mono, fontSize: fs.xs, fontVariant: ['tabular-nums'] }}>
            {diff && diff.additions > 0 && <Text style={{ color: c.success }}>+{diff.additions} </Text>}
            {diff && diff.deletions > 0 && <Text style={{ color: c.danger }}>−{diff.deletions} </Text>}
            <Text style={{ color: c.faint }}>{scope}</Text>
          </Text>
        }
      >
        {!commitHash && (
          <HeaderButton label="Reload" onPress={() => setReload((n) => n + 1)}>
            <RefreshCw color={c.dim} size={13} />
          </HeaderButton>
        )}
      </Header>
      {sides.error ? (
        <Empty message={sides.error} />
      ) : sides.binary || sides.tooLarge ? (
        <Empty message={sides.binary ? 'Binary file — diff not shown.' : 'File too large — diff not shown.'} />
      ) : html ? (
        <CodeWebView html={html} />
      ) : (
        <Empty message="No changes" />
      )}
    </View>
  )
}

/** DiffView's CommitDiffView: a whole commit's patch, under its subject. */
function CommitDiffBody({ client, worktreePath, commitHash }: { client: NessClient; worktreePath: string; commitHash: string }) {
  const [commit, setCommit] = useState<CommitDiff | null | 'loading'>('loading')
  useEffect(() => {
    let cancelled = false
    client.api.getCommitDiff(worktreePath, commitHash).then(
      (r) => !cancelled && setCommit(r),
      () => !cancelled && setCommit(null)
    )
    return () => {
      cancelled = true
    }
  }, [client, worktreePath, commitHash])
  const html = useMemo(() => (commit && commit !== 'loading' ? diffHtml(parseGitDiff(commit.diff)) : null), [commit])

  if (commit === 'loading') return <Empty message="Loading diff..." />
  if (!commit || !html) return <Empty message="No diff available" />
  return (
    <View style={{ flex: 1, backgroundColor: c.app }}>
      <View style={{ paddingHorizontal: 12, paddingVertical: 8, gap: 2, borderBottomWidth: 1, borderColor: c.border, backgroundColor: c.panel }}>
        <Text style={{ color: c.fgBright, fontSize: fs.sm, fontWeight: '500' }} numberOfLines={2}>
          {commit.subject}
        </Text>
        <Text style={{ color: c.faint, fontSize: fs.xs }} numberOfLines={1}>
          <Text style={{ fontFamily: mono, color: c.dim }}>{commit.shortHash}</Text> · {commit.author}
          {commit.date ? ` · ${new Date(commit.date).toLocaleString()}` : ''}
        </Text>
      </View>
      <CodeWebView html={html} />
    </View>
  )
}
