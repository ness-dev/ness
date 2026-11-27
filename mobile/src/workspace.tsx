// What every screen shares, owned by the root layout so it outlives
// navigation: the saved backends and their live connections, the Fleet
// that merges them, and the active colour theme.
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { useColorScheme } from 'react-native'
import { useBackends } from './backends'
import { Fleet, useFleetEntries } from './fleet'
import { applyTheme, themeKey } from './theme'

type Backends = ReturnType<typeof useBackends>

interface Workspace {
  backends: Backends
  fleet: Fleet
  /** Changes whenever the effective theme does; the root Stack remounts
   *  each screen's contents on it. */
  themeKey: string
}

const WorkspaceContext = createContext<Workspace | null>(null)

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const backends = useBackends()
  const fleet = useMemo(() => new Fleet(), [])
  // In an effect, not during render: setClients notifies subscribers.
  useEffect(() => fleet.setClients(backends.clients), [fleet, backends.clients])
  const theme = useThemeFromSettings(fleet)
  useRefreshOnJoin(fleet)
  const value = useMemo(() => ({ backends, fleet, themeKey: theme }), [backends, fleet, theme])
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}

export function useWorkspace(): Workspace {
  const w = useContext(WorkspaceContext)
  if (!w) throw new Error('useWorkspace outside WorkspaceProvider')
  return w
}

// Ness's colour theme is a client-owned setting; the phone follows the
// first connected backend's (normally the user's own desktop), with
// 'system' resolved against the phone's appearance. The palette is applied
// during render, before any screen reads `c`.
function useThemeFromSettings(fleet: Fleet): string {
  const entries = useFleetEntries(fleet)
  const settings = entries[0]?.state.settings
  const systemScheme = useColorScheme()
  return useMemo(() => {
    const inputs = {
      themeMode: settings?.themeMode ?? 'dark',
      themeLight: settings?.themeLight ?? '',
      themeDark: settings?.themeDark ?? '',
      customThemes: settings?.customThemes ?? [],
      nessieColor: settings?.nessieColor ?? '',
      systemScheme
    }
    applyTheme(inputs)
    return themeKey(inputs)
  }, [settings, systemScheme])
}

/** Once per backend as it joins, like the web MobileApp's mount effect. */
function useRefreshOnJoin(fleet: Fleet): void {
  const entries = useFleetEntries(fleet)
  const refreshed = useRef(new Set<string>())
  useEffect(() => {
    for (const cl of fleet.getClients()) {
      if (refreshed.current.has(cl.id) || !cl.getConn().hasSnapshot) continue
      refreshed.current.add(cl.id)
      void cl.api.refreshWorktreesList()
      void cl.api.refreshPRsAllIfStale()
    }
  }, [fleet, entries])
}
