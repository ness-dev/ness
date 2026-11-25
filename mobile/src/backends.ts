// Saved backends + one live NessClient per *enabled* backend. Disabling a
// backend closes its socket; the entry (and its token) stays saved.
import { useCallback, useEffect, useRef, useState } from 'react'
import { NessClient } from './ness'
import { labelFor, loadBackends, newId, saveBackends, type SavedBackend } from './storage'

export interface Backends {
  loaded: boolean
  saved: SavedBackend[]
  clients: NessClient[]
  add: (b: { wsUrl: string; token: string; label?: string }) => void
  setEnabled: (id: string, enabled: boolean) => void
  remove: (id: string) => void
}

export function useBackends(): Backends {
  const [saved, setSaved] = useState<SavedBackend[] | null>(null)
  const [clients, setClients] = useState<NessClient[]>([])
  const live = useRef(new Map<string, NessClient>())

  useEffect(() => {
    void loadBackends().then(setSaved)
  }, [])

  // Reconcile live clients with the enabled set.
  useEffect(() => {
    if (!saved) return
    const map = live.current
    const want = new Map(saved.filter((b) => b.enabled).map((b) => [b.id, b]))
    for (const [id, client] of map) {
      const b = want.get(id)
      // Re-create if the URL/token changed (re-pairing an existing host).
      if (!b || client.label !== b.label) {
        client.close()
        map.delete(id)
      }
    }
    for (const b of want.values()) {
      if (map.has(b.id)) continue
      const client = new NessClient(b.id, b.label, b.wsUrl, b.token)
      client.connect()
      map.set(b.id, client)
    }
    setClients(saved.filter((b) => map.has(b.id)).map((b) => map.get(b.id)!))
  }, [saved])

  useEffect(() => () => live.current.forEach((c) => c.close()), [])

  const update = useCallback((fn: (list: SavedBackend[]) => SavedBackend[]) => {
    setSaved((prev) => {
      const next = fn(prev ?? [])
      void saveBackends(next)
      return next
    })
  }, [])

  return {
    loaded: saved !== null,
    saved: saved ?? [],
    clients,
    add: ({ wsUrl, token, label }) =>
      update((list) => {
        // Same host re-paired (e.g. after a token rotate) → replace in place.
        const existing = list.find((b) => b.wsUrl === wsUrl)
        if (existing) {
          return list.map((b) =>
            b.id === existing.id ? { ...b, token, enabled: true, id: newId(), label: label || b.label } : b
          )
        }
        return [...list, { id: newId(), label: label || labelFor(wsUrl), wsUrl, token, enabled: true }]
      }),
    setEnabled: (id, enabled) => update((list) => list.map((b) => (b.id === id ? { ...b, enabled } : b))),
    remove: (id) => update((list) => list.filter((b) => b.id !== id))
  }
}
