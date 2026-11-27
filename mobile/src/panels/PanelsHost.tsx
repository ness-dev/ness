// Port of RightColumn.tsx + RightColumnToolbar.tsx as a full-screen sheet
// (the web client's MobileRightPanel shows only four panels; this shows
// the desktop's full column). Order and visibility are the repo's own
// `rightPanelOrder` / `hiddenRightPanels`, edited through `repoConfig:set`
// exactly like the desktop toolbar, so changes made here show up on the
// desktop and vice versa.
import { useCallback, useMemo, useState } from 'react'
import { Linking, Pressable, ScrollView, Switch, Text, View } from 'react-native'
import { ArrowDown, ArrowUp, Settings2, X } from 'lucide-react-native'
import {
  effectiveHiddenRightPanels,
  effectiveRightPanelOrder,
  isCustomToolPanelKey,
  toolPanelKey,
  type HiddenRightPanels,
  type RightPanelKey
} from '../../../src/shared/state/repo-configs'
import type { ToolSpec } from '../../../src/shared/tools'
import type { Worktree } from '../../../src/shared/state/worktrees'
import type { RepoConfig } from '../../../src/shared/state/repo-configs'
import { useNess, type NessClient } from '../ness'
import { c, fs } from '../theme'
import { PANELS, PANEL_LABELS } from './registry'
import { CustomToolPanel } from './CustomToolPanel'
import { useWatchedQuery } from './useWatchedQuery'
import type { PanelProps } from './types'

export function PanelsHost({
  client,
  worktree,
  focusedTabId,
  onSendToAgent,
  onClose
}: {
  client: NessClient
  worktree: Worktree
  focusedTabId: string | null
  onSendToAgent: (text: string) => void
  onClose: () => void
}) {
  const repoRoot = worktree.repoRoot
  const repoConfig = useNess(client, (s) => s.repoConfigs.byRepo[repoRoot] ?? null)
  const fetchTools = useCallback((path: string) => client.api.listTools(path), [client])
  const { data: toolsData } = useWatchedQuery<ToolSpec[]>({ client, worktreePath: worktree.path, cacheKey: 'tools', fetcher: fetchTools })
  const tools = useMemo(() => toolsData ?? [], [toolsData])
  const toolKeys = useMemo(() => tools.map((t) => toolPanelKey(t.id)), [tools])
  const hidden = effectiveHiddenRightPanels(repoConfig)
  const order = effectiveRightPanelOrder(repoConfig, toolKeys)
  const [customizing, setCustomizing] = useState(false)

  const labelFor = (key: RightPanelKey): string =>
    isCustomToolPanelKey(key) ? tools.find((t) => toolPanelKey(t.id) === key)?.title ?? key : PANEL_LABELS[key]

  // Same payloads as RightColumn's handlers (legacy fields nulled so old
  // values don't leak back through the effective-config migration).
  const setHidden = (next: HiddenRightPanels) =>
    void client.api.setRepoConfig(repoRoot, { hiddenRightPanels: next, hidePrPanel: null } as unknown as Partial<RepoConfig>)
  const setOrder = (next: RightPanelKey[]) => void client.api.setRepoConfig(repoRoot, { rightPanelOrder: next })

  const props: PanelProps = {
    client,
    worktree,
    worktreePath: worktree.path,
    focusedTabId,
    repoConfig,
    onSendToAgent,
    onOpenUrl: (url) => void Linking.openURL(url),
    onClose
  }

  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 40, backgroundColor: c.app }} accessibilityViewIsModal>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 12, borderBottomWidth: 1, borderColor: c.border, backgroundColor: c.panel }}>
        <Text style={{ flex: 1, color: c.dim, fontSize: fs.xs, fontWeight: '600', letterSpacing: 1.2 }}>
          {customizing ? 'PANELS' : 'WORKTREE'}
        </Text>
        <Pressable
          onPress={() => setCustomizing((v) => !v)}
          accessibilityLabel="Panel visibility"
          style={({ pressed }) => ({ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed || customizing ? c.surface : 'transparent' })}
        >
          <Settings2 color={customizing ? c.fgBright : c.dim} size={16} />
        </Pressable>
        <Pressable onPress={onClose} accessibilityLabel="Close worktree details" style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
          <X color={c.dim} size={16} />
        </Pressable>
      </View>
      {customizing ? (
        <ScrollView>
          {order.map((key, i) => (
            <View key={key} style={{ flexDirection: 'row', alignItems: 'center', minHeight: 48, borderBottomWidth: 1, borderColor: c.border }}>
              {/* The whole label area toggles, so the target is the full row
                  height rather than just the switch. */}
              <Pressable
                onPress={() => setHidden({ ...hidden, [key]: !hidden[key] })}
                accessibilityRole="switch"
                accessibilityState={{ checked: !hidden[key] }}
                accessibilityLabel={`Show ${labelFor(key)}`}
                style={({ pressed }) => ({
                  flex: 1,
                  alignSelf: 'stretch',
                  minHeight: 48,
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingLeft: 12,
                  backgroundColor: pressed ? c.panelRaised : 'transparent'
                })}
              >
                <View style={{ justifyContent: 'center' }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                  <Switch
                    value={!hidden[key]}
                    onValueChange={(on) => setHidden({ ...hidden, [key]: !on })}
                    trackColor={{ true: c.accent, false: c.surface }}
                    thumbColor="#fff"
                  />
                </View>
                <Text style={{ flex: 1, color: c.fg, fontSize: fs.sm, marginLeft: 12 }}>{labelFor(key)}</Text>
              </Pressable>
              <Pressable
                disabled={i === 0}
                onPress={() => setOrder(swap(order, i, i - 1))}
                accessibilityLabel={`Move ${labelFor(key)} up`}
                style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', opacity: i === 0 ? 0.3 : 1 }}
              >
                <ArrowUp color={c.dim} size={16} />
              </Pressable>
              <Pressable
                disabled={i === order.length - 1}
                onPress={() => setOrder(swap(order, i, i + 1))}
                accessibilityLabel={`Move ${labelFor(key)} down`}
                style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', opacity: i === order.length - 1 ? 0.3 : 1 }}
              >
                <ArrowDown color={c.dim} size={16} />
              </Pressable>
            </View>
          ))}
          {/* "Build a custom tool…" opens the new-worktree screen on desktop,
              which the app doesn't have yet. */}
        </ScrollView>
      ) : (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 40 }}>
          {order.map((key) => {
            if (hidden[key]) return null
            if (isCustomToolPanelKey(key)) {
              const spec = tools.find((t) => toolPanelKey(t.id) === key)
              return spec ? <CustomToolPanel key={key} {...props} spec={spec} /> : null
            }
            const Panel = PANELS[key]
            return Panel ? <Panel key={key} {...props} /> : null
          })}
        </ScrollView>
      )}
    </View>
  )
}

function swap<T>(arr: T[], a: number, b: number): T[] {
  const next = [...arr]
  ;[next[a], next[b]] = [next[b], next[a]]
  return next
}
