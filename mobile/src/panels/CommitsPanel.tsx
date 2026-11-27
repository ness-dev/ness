// Port of renderer/components/BranchCommitsPanel.tsx plus the commit-info
// popover it opens (CommitInfoModal.tsx, with its prev/next nav). The
// popover becomes a modal sheet; ↑/↓/Esc become buttons.
//
// Desktop-only, omitted: "Open diff in tab" on a commit's files
// (onOpenCommitFileDiff), and drag-a-commit-into-the-composer.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Modal, Pressable, ScrollView, Text, View } from 'react-native'
import { ArrowUp, Check, ChevronDown, ChevronUp, Copy, GitCommitHorizontal, RefreshCw, X } from 'lucide-react-native'
import type { BranchCommit, ChangedFile, CommitMeta } from '../../../src/renderer/types'
import type { NessClient } from '../ness'
import { Spin } from '../components/Spin'
import { alpha, c, fs, mono } from '../theme'
import { PanelAction, RightPanel } from './RightPanel'
import { useWatchedQuery } from './useWatchedQuery'
import { STATUS_COLOR, STATUS_LABEL } from './ChangedFilesPanel'
import type { PanelProps } from './types'
import { copyText } from '../clipboard'

export function CommitsPanel({ client, worktreePath }: PanelProps) {
  const fetcher = useCallback((path: string) => client.api.getBranchCommits(path), [client])
  // Tracks the selected commit by index so the up/down controls can walk the list.
  const [popover, setPopover] = useState<number | null>(null)

  const { data, loading, refresh } = useWatchedQuery<BranchCommit[]>({
    client,
    worktreePath,
    cacheKey: 'branchCommits',
    fetcher
  })

  const commits = data ?? []
  const hasLoaded = !loading

  if (!worktreePath) return null

  const actions = (
    <>
      {commits.length > 0 && <Text style={{ fontSize: fs.xs, color: c.faint }}>{commits.length}</Text>}
      <PanelAction onPress={() => refresh()} label="Refresh">
        <RefreshCw color={c.faint} size={12} />
      </PanelAction>
    </>
  )

  const selected = popover !== null ? commits[popover] : undefined

  return (
    <>
      <RightPanel id="commits" title="Commits" actions={actions}>
        {commits.length === 0 && hasLoaded && (
          <Text style={{ paddingHorizontal: 16, paddingVertical: 8, fontSize: fs.xs, color: c.faint }}>No commits ahead of base</Text>
        )}
        {commits.length > 0 && (
          // max-h-56 on desktop; taller here because rows are 44pt. A plain
          // ScrollView (not FlatList) since PanelsHost already scrolls, and
          // the padding lives on the content so it can't eat into the cap
          // and push the last row under the next panel.
          <ScrollView nestedScrollEnabled style={{ maxHeight: 44 * 6 + 12 }} contentContainerStyle={{ paddingVertical: 6 }}>
            {commits.map((cm, i) => (
              <CommitRow
                key={cm.hash}
                commit={cm}
                isFirst={i === 0}
                isLast={i === commits.length - 1}
                onPress={() => setPopover(i)}
              />
            ))}
          </ScrollView>
        )}
      </RightPanel>
      {popover !== null && selected && (
        <CommitInfoSheet
          client={client}
          worktreePath={worktreePath}
          sha={selected.hash}
          nav={{
            onPrev: () => setPopover((p) => (p !== null && p > 0 ? p - 1 : p)),
            onNext: () => setPopover((p) => (p !== null && p < commits.length - 1 ? p + 1 : p)),
            hasPrev: popover > 0,
            hasNext: popover < commits.length - 1
          }}
          onClose={() => setPopover(null)}
        />
      )}
    </>
  )
}

function CommitRow({ commit: cm, isFirst, isLast, onPress }: { commit: BranchCommit; isFirst: boolean; isLast: boolean; onPress: () => void }) {
  const tipSuffix = cm.pushed ? 'pushed' : 'unpushed'
  return (
    <Pressable
      onPress={onPress}
      // Long-press = the desktop's hover tooltip + right-click "Copy commit SHA".
      onLongPress={() =>
        Alert.alert(`${cm.shortHash} · ${cm.author} · ${cm.relativeDate} · ${tipSuffix}`, cm.subject, [
          { text: 'Copy commit SHA', onPress: () => copyText(cm.hash) },
          { text: 'Cancel', style: 'cancel' }
        ])
      }
      style={({ pressed }) => ({
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingLeft: 16,
        paddingRight: 12,
        backgroundColor: pressed ? c.panelRaised : 'transparent'
      })}
    >
      {/* Tree line + dot */}
      <View style={{ width: 12, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' }}>
        <View
          style={{
            position: 'absolute',
            width: 1,
            backgroundColor: c.borderStrong,
            top: isFirst ? '50%' : 0,
            bottom: isLast ? '50%' : 0
          }}
        />
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: cm.pushed ? c.borderStrong : c.warning,
            borderWidth: 2,
            borderColor: c.panel,
            boxSizing: 'content-box',
            ...(cm.pushed ? null : { boxShadow: `0 0 6px ${alpha('#eab308', 0.5)}` })
          }}
        />
      </View>
      <Text style={{ fontFamily: mono, fontSize: fs.xs, color: cm.pushed ? c.faint : c.warning }}>{cm.shortHash}</Text>
      <Text style={{ flex: 1, minWidth: 0, fontSize: fs.xs, color: cm.pushed ? c.dim : c.fg }} numberOfLines={1}>
        {cm.subject}
      </Text>
      {!cm.pushed && <ArrowUp color={c.warning} size={10} />}
    </Pressable>
  )
}

interface CommitNav {
  onPrev: () => void
  onNext: () => void
  hasPrev: boolean
  hasNext: boolean
}

/** CommitInfoModal.tsx as a modal sheet. Same requests, states and labels. */
function CommitInfoSheet({
  client,
  worktreePath,
  sha,
  nav,
  onClose
}: {
  client: NessClient
  worktreePath: string
  sha: string
  nav: CommitNav
  onClose: () => void
}) {
  const [meta, setMeta] = useState<CommitMeta | null>(null)
  const [files, setFiles] = useState<ChangedFile[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [copied, setCopied] = useState(false)
  const [copiedPath, setCopiedPath] = useState<string | null>(null)
  const pathTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (pathTimer.current !== null) clearTimeout(pathTimer.current)
  }, [])

  const copyPath = (path: string): void => {
    if (!copyText(path)) return
    setCopiedPath(path)
    if (pathTimer.current !== null) clearTimeout(pathTimer.current)
    pathTimer.current = setTimeout(() => setCopiedPath(null), 1200)
  }

  useEffect(() => {
    let cancelled = false
    setState('loading')
    void Promise.all([
      client.api.getCommitMeta(worktreePath, sha),
      client.api.getCommitChangedFiles(worktreePath, sha)
    ])
      .then(([m, f]) => {
        if (cancelled) return
        if (m) {
          setMeta(m)
          setFiles(f)
          setState('ready')
        } else {
          setState('error')
        }
      })
      .catch(() => {
        if (!cancelled) setState('error')
      })
    return () => {
      cancelled = true
    }
  }, [client, worktreePath, sha])

  const copySha = (): void => {
    if (!copyText(meta?.hash ?? sha)) return
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  const shortSha = meta?.shortHash ?? sha.slice(0, 10)

  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      {/* Full-screen catcher: tap outside closes, like the desktop overlay. */}
      <Pressable onPress={onClose} accessible={false} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 12 }}>
        <Pressable
          onPress={() => {}}
          // Not an accessibility element itself, so VoiceOver reaches each
          // header button separately instead of one flattened blob.
          accessible={false}
          style={{ maxHeight: '75%', backgroundColor: c.panelRaised, borderWidth: 1, borderColor: c.borderStrong, borderRadius: 8, overflow: 'hidden' }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, borderBottomWidth: 1, borderColor: c.border }}>
            <GitCommitHorizontal color={c.accent} size={14} />
            <Pressable onPress={copySha} accessibilityRole="button" accessibilityLabel="Copy full SHA" style={{ minHeight: 44, minWidth: 44, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Text style={{ fontFamily: mono, fontSize: fs.xs, color: c.fg }}>{shortSha}</Text>
              {copied ? <Check color={c.success} size={10} /> : <Copy color={alpha(c.fg, 0.6)} size={10} />}
            </Pressable>
            <Text style={{ flex: 1, minWidth: 0, fontSize: fs.xs, fontWeight: '500', color: c.fgBright }} numberOfLines={1}>
              {state === 'ready' && meta ? meta.subject : ''}
            </Text>
            <HeaderBtn label="Previous commit" onPress={nav.onPrev} disabled={!nav.hasPrev}>
              <ChevronUp color={c.faint} size={14} />
            </HeaderBtn>
            <HeaderBtn label="Next commit" onPress={nav.onNext} disabled={!nav.hasNext}>
              <ChevronDown color={c.faint} size={14} />
            </HeaderBtn>
            <HeaderBtn label="Close" onPress={onClose}>
              <X color={c.faint} size={14} />
            </HeaderBtn>
          </View>

          {state === 'loading' && (
            <View style={{ paddingVertical: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              <Spin>
                <RefreshCw color={c.faint} size={12} />
              </Spin>
              <Text style={{ fontSize: fs.xs, color: c.faint }}>Loading…</Text>
            </View>
          )}

          {state === 'error' && (
            <Text style={{ paddingVertical: 24, paddingHorizontal: 12, fontSize: fs.xs, color: c.faint, textAlign: 'center' }}>
              Couldn't load commit <Text style={{ fontFamily: mono, color: c.fg }}>{sha}</Text>.
            </Text>
          )}

          {state === 'ready' && meta && (
            <ScrollView nestedScrollEnabled>
              <Text style={{ paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: 1, borderColor: c.border, fontSize: fs.xs, color: c.faint }} numberOfLines={1}>
                <Text style={{ color: c.fg }}>{meta.author}</Text>
                {meta.date ? ` · ${new Date(meta.date).toLocaleString()}` : ''}
              </Text>
              {meta.body.trim() !== '' && (
                <Text selectable style={{ paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: 1, borderColor: c.border, fontSize: fs.xs, color: c.fg }}>
                  {meta.body.trim()}
                </Text>
              )}
              <View style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
                <Text style={{ fontSize: fs.xs, color: c.faint, marginBottom: 4 }}>
                  {files.length} {files.length === 1 ? 'file' : 'files'} changed
                </Text>
                {files.map((file) => (
                  <CommitFileRow key={file.path} file={file} copied={copiedPath === file.path} onCopyPath={() => copyPath(file.path)} />
                ))}
              </View>
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  )
}

function HeaderBtn({ label, onPress, disabled, children }: { label: string; onPress: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => ({
        width: 44,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.3 : 1,
        backgroundColor: pressed ? c.surfaceHover : 'transparent'
      })}
    >
      {children}
    </Pressable>
  )
}

/** CommitInfoModal's FileRow: tap copies the path. Its context menu's other
 *  item, "Open diff in tab", is desktop-only. */
function CommitFileRow({ file, copied, onCopyPath }: { file: ChangedFile; copied: boolean; onCopyPath: () => void }) {
  const lastSlash = file.path.lastIndexOf('/')
  const dir = lastSlash >= 0 ? file.path.slice(0, lastSlash + 1) : ''
  const name = lastSlash >= 0 ? file.path.slice(lastSlash + 1) : file.path
  return (
    <Pressable
      onPress={onCopyPath}
      accessibilityLabel={`Copy path ${file.path}`}
      style={({ pressed }) => ({
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        borderRadius: 4,
        backgroundColor: pressed ? c.surfaceHover : 'transparent'
      })}
    >
      <Text style={{ width: 12, fontFamily: mono, fontSize: fs.xs, color: STATUS_COLOR[file.status] }}>{STATUS_LABEL[file.status]}</Text>
      <Text style={{ flex: 1, minWidth: 0, fontFamily: mono, fontSize: fs.xs }} numberOfLines={1}>
        {dir ? <Text style={{ color: c.faint }}>{dir}</Text> : null}
        <Text style={{ color: c.fg }}>{name}</Text>
      </Text>
      {copied ? <Check color={c.success} size={10} /> : <Copy color={alpha(c.fg, 0.6)} size={10} />}
      {(file.additions || file.deletions) ? (
        <Text style={{ fontFamily: mono, fontSize: fs.xs, fontVariant: ['tabular-nums'] }}>
          {file.additions ? <Text style={{ color: c.success }}>+{file.additions}</Text> : null}
          {file.deletions ? <Text style={{ color: c.danger }}> −{file.deletions}</Text> : null}
        </Text>
      ) : null}
    </Pressable>
  )
}
