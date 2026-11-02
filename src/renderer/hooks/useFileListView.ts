import { useCallback, useEffect, useState } from 'react'
import type { FileListView } from '../file-tree'

const STORAGE_PREFIX = 'file-list-view:'

/** Per-client list/tree preference for a file list, persisted like
 *  RightPanel's collapse state. */
export function useFileListView(id: string, fallback: FileListView): [FileListView, () => void] {
  const [view, setView] = useState<FileListView>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_PREFIX + id)
      if (saved === 'list' || saved === 'tree') return saved
    } catch {
      /* ignore */
    }
    return fallback
  })

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_PREFIX + id, view)
    } catch {
      /* ignore */
    }
  }, [id, view])

  const toggle = useCallback(() => setView((v) => (v === 'list' ? 'tree' : 'list')), [])
  return [view, toggle]
}
