// Saved backends + one live NessClient per *enabled* backend. Disabling a
// backend closes its socket; the entry (and its token) stays saved.
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { NessClient } from './ness'
import { watchLiveness } from './liveness'
import { labelFor, loadBackends, newId, saveBackends, type SavedBackend } from './storage'
import { createDemoClient, demoThemeOf, loadDemoEnabled, saveDemoEnabled } from './demo/client'
import type { DemoTheme } from './demo/world'
import { DEMO_BACKEND_ID } from './demo/constants'

export interface Backends {
  loaded: boolean
  saved: SavedBackend[]
  clients: NessClient[]
  add: (b: { wsUrl: string; token: string; label?: string }) => void
  setEnabled: (id: string, enabled: boolean) => void
  remove: (id: string) => void
  /** The offline demo workspace (demo/), listed after the real backends. */
  demo: boolean
  setDemo: (on: boolean) => void
  /** Back to the demo's starting state. */
  resetDemo: () => void
}

export function useBackends(): Backends {
  const [saved, setSaved] = useState<SavedBackend[] | null>(null)
  const [clients, setClients] = useState<NessClient[]>([])
  const [demo, setDemoState] = useState<boolean | null>(null)
  const [demoGeneration, setDemoGeneration] = useState(0)
  const live = useRef(new Map<string, NessClient>())
  const demoTheme = useRef<DemoTheme | undefined>(undefined)

  useEffect(() => {
    void loadBackends().then(setSaved)
    void loadDemoEnabled().then(setDemoState)
  }, [])

  // Reconcile live clients with the enabled set.
  useEffect(() => {
    if (!saved || demo === null) return
    const map = live.current
    const want = new Map(saved.filter((b) => b.enabled).map((b) => [b.id, b]))
    for (const [id, client] of map) {
      if (id === DEMO_BACKEND_ID) continue
      const b = want.get(id)
      // Re-create if the URL, token or label changed (re-pairing a host).
      if (!b || client.wsUrl !== b.wsUrl || client.token !== b.token || client.label !== b.label) {
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
    const demoClient = map.get(DEMO_BACKEND_ID)
    if (!demo && demoClient) {
      demoClient.close()
      map.delete(DEMO_BACKEND_ID)
    } else if (demo && !demoClient) {
      const client = createDemoClient(demoTheme.current)
      client.connect()
      map.set(DEMO_BACKEND_ID, client)
    }
    const real = saved.filter((b) => map.has(b.id)).map((b) => map.get(b.id)!)
    setClients(demo ? [...real, map.get(DEMO_BACKEND_ID)!] : real)
  }, [saved, demo, demoGeneration])

  // Probe on foreground + idle heartbeat while there (liveness.ts).
  // keepOpen in wake() spares a socket already mid-handshake (iOS drops
  // sockets while suspended; its own retry may have raced us).
  useEffect(() => watchLiveness(AppState, () => live.current.values()), [])

  // Clear the map too: Fast Refresh (and any remount) runs this cleanup and
  // then the reconcile effect again. Leaving closed clients in the map made
  // reconcile keep them, so a backend sat at its last "close code 1000"
  // forever instead of reconnecting.
  useEffect(
    () => () => {
      live.current.forEach((c) => c.close())
      live.current.clear()
    },
    []
  )

  const update = useCallback((fn: (list: SavedBackend[]) => SavedBackend[]) => {
    setSaved((prev) => {
      const next = fn(prev ?? [])
      void saveBackends(next)
      return next
    })
  }, [])

  const setDemo = useCallback((on: boolean) => {
    setDemoState(on)
    void saveDemoEnabled(on)
  }, [])

  const resetDemo = useCallback(() => {
    demoTheme.current = demoThemeOf(live.current.get(DEMO_BACKEND_ID))
    live.current.get(DEMO_BACKEND_ID)?.close()
    live.current.delete(DEMO_BACKEND_ID)
    setDemoGeneration((g) => g + 1)
  }, [])

  return {
    loaded: saved !== null && demo !== null,
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
    remove: (id) => update((list) => list.filter((b) => b.id !== id)),
    demo: demo ?? false,
    setDemo,
    resetDemo
  }
}
