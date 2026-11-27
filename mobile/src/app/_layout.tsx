// Root layout: the providers every screen shares, around one Stack.
//
// Routes:
//   /               home — restores the last worktree, or first-run pairing
//   /w/[wt]         a worktree (path, encoded): header, tab strip, chat
//   /w/[wt]/tools   the tools panel (the desktop's right column)
//   /backends       backends sheet (modal)
//   /pair?url=      pairing link → adds the backend, then back (or home)
//   /open?wt=&tab=  link alias, rewritten to /w/[wt]?tab= by +native-intent
//
// Per-client UI focus that isn't a route (the picker dropdown, Select
// Text, the convert menu) stays component state on its screen.
import { Fragment } from 'react'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { KeyboardAvoidingView, KeyboardProvider } from 'react-native-keyboard-controller'
import { WorkspaceProvider, useWorkspace } from '../workspace'
import { c, getThemeMode } from '../theme'

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <KeyboardProvider>
        <WorkspaceProvider>
          <Shell />
        </WorkspaceProvider>
      </KeyboardProvider>
    </SafeAreaProvider>
  )
}

// keyboard-controller's KeyboardAvoidingView animates frame-by-frame with
// the keyboard on the UI thread (RN's own one ran a LayoutAnimation that
// moved the composer's button row and its text box at different speeds).
//
// Bottom edge: deliberately ignores the bottom safe area, so with the
// keyboard down the composer sits on the screen's bottom edge (only its own
// 12pt padding below it, over the home indicator) instead of 34pt higher.
// The KAV spans to the screen bottom, so its padding is exactly the
// keyboard height and the composer still rests 12pt above the keyboard.
//
// Theme: a theme change remounts every screen's contents (screenLayout,
// keyed on the theme) so all components and themed() styles pick up the
// new palette, without resetting navigation. This component reads the
// workspace, so it re-renders with the new background too.
function Shell() {
  const { themeKey } = useWorkspace()
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.app }} edges={['top', 'left', 'right']}>
      <StatusBar style={getThemeMode() === 'light' ? 'dark' : 'light'} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        <Stack
          screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.app } }}
          screenLayout={({ children }) => <Fragment key={themeKey}>{children}</Fragment>}
        >
          {/* Home only ever redirects; no transition into or out of it. */}
          <Stack.Screen name="index" options={{ animation: 'none' }} />
          {/* One worktree screen, ever: worktrees are peers, not history, so
              opening another (the picker, an /open link) reuses this screen
              with the new path instead of stacking a second one that
              swipe-back would return to. No slide either: switching
              worktrees is instant, like the web's picker. */}
          <Stack.Screen name="w/[wt]/index" dangerouslySingular={() => 'worktree'} options={{ animation: 'none' }} />
          <Stack.Screen name="backends" options={{ presentation: 'modal' }} />
        </Stack>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}
