// `animate-spin` / `animate-pulse` equivalents. Native-driver animations
// run off the JS thread, so a screen full of spinners costs nothing per
// frame on the JS side.
import { useEffect, useRef } from 'react'
import { Animated, Easing, Platform } from 'react-native'

// The web has no native animated module; JS timing is fine there.
const native = Platform.OS !== 'web'

export function Spin({ children }: { children: React.ReactNode }) {
  const v = useRef(new Animated.Value(0)).current
  useEffect(() => {
    const a = Animated.loop(Animated.timing(v, { toValue: 1, duration: 1000, easing: Easing.linear, useNativeDriver: native }))
    a.start()
    return () => a.stop()
  }, [v])
  const rotate = v.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] })
  return <Animated.View style={{ transform: [{ rotate }] }}>{children}</Animated.View>
}

/** Tailwind's animate-pulse: opacity 1 → .5 → 1 over 2s. */
export function Pulse({ children, active = true }: { children: React.ReactNode; active?: boolean }) {
  const v = useRef(new Animated.Value(1)).current
  useEffect(() => {
    if (!active) {
      v.setValue(1)
      return
    }
    const a = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 0.5, duration: 1000, easing: Easing.bezier(0.4, 0, 0.6, 1), useNativeDriver: native }),
        Animated.timing(v, { toValue: 1, duration: 1000, easing: Easing.bezier(0.4, 0, 0.6, 1), useNativeDriver: native })
      ])
    )
    a.start()
    return () => a.stop()
  }, [v, active])
  return <Animated.View style={{ opacity: v }}>{children}</Animated.View>
}
