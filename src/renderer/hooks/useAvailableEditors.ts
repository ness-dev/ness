import { useEffect, useState } from 'react'
import { useBackend } from '../backend'
import { useActiveBackend } from '../store'

export interface AvailableEditor {
  id: string
  name: string
}

// The editor list is a compile-time constant in main — it never changes for
// the life of a backend process. Cache the in-flight promise so N sidebar rows
// opening N context menus share a single round trip. Keyed by backend id:
// a remote may run a different Harness version with a different list, and
// serving it the local one would quietly offer editors it can't launch.
const cache = new Map<string, Promise<AvailableEditor[]>>()

/** The editors this backend knows how to launch. Returns [] until the first
 *  fetch resolves, so callers can render an empty submenu without needing a
 *  loading state. Pass `enabled: false` to skip the fetch entirely — every
 *  sidebar row mounts this, and only the one with an open menu needs it. */
export function useAvailableEditors(enabled: boolean): AvailableEditor[] {
  const backend = useBackend()
  const backendId = useActiveBackend().id
  const [editors, setEditors] = useState<AvailableEditor[]>([])

  useEffect(() => {
    if (!enabled) return
    let alive = true
    let pending = cache.get(backendId)
    if (!pending) {
      pending = backend.getAvailableEditors()
      cache.set(backendId, pending)
      // Don't cache a rejection — a transient failure would otherwise make
      // the submenu permanently empty for this backend.
      pending.catch(() => cache.delete(backendId))
    }
    pending.then(
      (list) => {
        if (alive) setEditors(list)
      },
      () => {
        if (alive) setEditors([])
      }
    )
    return () => {
      alive = false
    }
  }, [enabled, backend, backendId])

  return editors
}
