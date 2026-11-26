// Port of renderer/components/ScratchpadPanel.tsx: local text mirrors the
// scratchpad slice, edits flush to `scratchpad:setText` after 400ms idle,
// on blur, on worktree switch and on unmount.
import { useEffect, useRef, useState } from 'react'
import { TextInput } from 'react-native'
import { useNess } from '../ness'
import { c, fs } from '../theme'
import { RightPanel } from './RightPanel'
import type { PanelProps } from './types'

const FLUSH_DEBOUNCE_MS = 400

export function ScratchpadPanel({ client, worktreePath }: PanelProps) {
  // Same selector as the renderer's useScratchpad(worktreePath).
  const sliceText = useNess(client, (s) => (worktreePath ? s.scratchpad.byWorktreePath[worktreePath] ?? '' : ''))

  const [localText, setLocalText] = useState<string>(sliceText)
  const lastSyncedPathRef = useRef<string | null>(worktreePath)
  const pendingRef = useRef<{ path: string; text: string } | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clientRef = useRef(client)
  clientRef.current = client

  const flush = (): void => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const pending = pendingRef.current
    if (!pending) return
    pendingRef.current = null
    void clientRef.current.req('scratchpad:setText', pending.path, pending.text)
  }

  // When the active worktree changes, flush the previous worktree's
  // pending edit (so we don't lose it) and re-seed local state from
  // the slice for the new worktree.
  useEffect(() => {
    if (lastSyncedPathRef.current !== worktreePath) {
      flush()
      lastSyncedPathRef.current = worktreePath
      setLocalText(sliceText)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreePath])

  // If the slice value changes from elsewhere (another client, initial
  // hydration completing) AND we have no pending local edit, mirror it.
  useEffect(() => {
    if (pendingRef.current) return
    if (lastSyncedPathRef.current !== worktreePath) return
    setLocalText(sliceText)
  }, [sliceText, worktreePath])

  // Flush any pending edit on unmount so a panel close doesn't lose it.
  useEffect(() => {
    return () => {
      flush()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleChange = (next: string): void => {
    setLocalText(next)
    if (!worktreePath) return
    pendingRef.current = { path: worktreePath, text: next }
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(flush, FLUSH_DEBOUNCE_MS)
  }

  const disabled = !worktreePath

  return (
    <RightPanel id="scratchpad" title="Scratchpad">
      <TextInput
        multiline
        textAlignVertical="top"
        placeholder="Notes for this worktree…"
        placeholderTextColor={c.faint}
        spellCheck={false}
        autoCorrect={false}
        value={localText}
        editable={!disabled}
        onChangeText={handleChange}
        onBlur={flush}
        // Fixed height + its own scroll: a growing multiline input makes the
        // sheet's ScrollView chase the caret and slide text under the header.
        scrollEnabled
        // fontSize 16 (not the desktop's text-xs) so iOS doesn't zoom on focus.
        style={{ height: 200, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: c.panel, color: c.fg, fontSize: fs.base }}
      />
    </RightPanel>
  )
}
