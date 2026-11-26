// Port of renderer/components/RightPanel.tsx — the collapsible section
// every right-column panel sits in. Same collapse-key prefix as the web
// (`right-panel-collapsed:<id>`), persisted in AsyncStorage. The header is
// 44pt instead of the desktop's 36px so it's a comfortable tap target.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { ChevronRight } from 'lucide-react-native'
import { c, fs } from '../theme'

const PREFIX = 'right-panel-collapsed:'

export function RightPanel({
  id,
  title,
  children,
  actions,
  defaultCollapsed = false,
  onCollapsedChange
}: {
  id: string
  title: string
  children: ReactNode
  /** Right side of the header; taps here don't toggle collapse. */
  actions?: ReactNode
  defaultCollapsed?: boolean
  /** Fires with the resolved initial state, on every toggle, and with
   *  `true` on unmount (interest-gated panels like Cost rely on that). */
  onCollapsedChange?: (collapsed: boolean) => void
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const loaded = useRef(false)
  const cb = useRef(onCollapsedChange)
  cb.current = onCollapsedChange

  useEffect(() => {
    void AsyncStorage.getItem(PREFIX + id).then((v) => {
      if (v !== null) setCollapsed(v === '1')
      loaded.current = true
    })
  }, [id])
  useEffect(() => {
    if (loaded.current) void AsyncStorage.setItem(PREFIX + id, collapsed ? '1' : '0')
    cb.current?.(collapsed)
  }, [id, collapsed])
  useEffect(() => () => cb.current?.(true), [])

  return (
    <View style={{ borderBottomWidth: 1, borderColor: c.border, backgroundColor: c.panel }}>
      <View style={{ flexDirection: 'row', alignItems: 'stretch', borderBottomWidth: collapsed ? 0 : 1, borderColor: c.border }}>
        <Pressable
          onPress={() => setCollapsed((v) => !v)}
          // minHeight on the pressable itself (not the bordered row) so the
          // target is a full 44pt; the row's bottom border sits below it.
          style={({ pressed }) => ({ flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, backgroundColor: pressed ? c.panelRaised : 'transparent' })}
          accessibilityRole="button"
          accessibilityState={{ expanded: !collapsed }}
        >
          <ChevronRight color={c.faint} size={12} style={{ transform: [{ rotate: collapsed ? '0deg' : '90deg' }] }} />
          <Text style={{ fontSize: fs.xs, fontWeight: '500', color: c.muted, textTransform: 'uppercase', letterSpacing: 0.6 }} numberOfLines={1}>
            {title}
          </Text>
        </Pressable>
        {actions ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 8, paddingRight: 8 }}>{actions}</View> : null}
      </View>
      {!collapsed && <View>{children}</View>}
    </View>
  )
}

/** Header action button: icon-sized visually, 44x44 touch target. The
 *  negative horizontal margin keeps neighbouring actions visually tight. */
export function PanelAction({ onPress, label, children, disabled }: { onPress: () => void; label: string; children: ReactNode; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{ width: 44, height: 44, marginHorizontal: -8, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.4 : 1 }}
    >
      {({ pressed }) => <View style={{ padding: 4, borderRadius: 4, backgroundColor: pressed ? c.surface : 'transparent' }}>{children}</View>}
    </Pressable>
  )
}
