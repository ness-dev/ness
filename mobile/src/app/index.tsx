// Home: first-run pairing when there are no backends; otherwise straight
// to a worktree — the one the phone was last on if it still exists, else
// the first. Backends snapshot at different times, so don't fall back to
// the first worktree while the saved one's host may still be connecting
// (capped at 3s so an offline host can't hold the first screen hostage).
import { useEffect, useState } from 'react'
import { ActivityIndicator } from 'react-native'
import { Redirect } from 'expo-router'
import { useWorkspace } from '../workspace'
import { useFleetEntries, useMerged } from '../fleet'
import { getLastWorktree, useNavStateLoaded } from '../navState'
import { worktreeHref } from '../routes'
import { BackendsSheet } from '../components/BackendsSheet'
import { Empty } from '../components/Empty'
import { c } from '../theme'

export default function Home() {
  const { backends } = useWorkspace()
  if (!backends.loaded) return <ActivityIndicator color={c.muted} style={{ flex: 1 }} />
  if (backends.saved.length === 0) return <BackendsSheet backends={backends} />
  return <PickWorktree />
}

function PickWorktree() {
  const { fleet } = useWorkspace()
  const worktrees = useMerged(fleet).flatWorktrees
  const navLoaded = useNavStateLoaded()
  const allSnapshotted = useFleetEntries(fleet).length === fleet.getClients().length
  const [waitedEnough, setWaitedEnough] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setWaitedEnough(true), 3000)
    return () => clearTimeout(t)
  }, [])

  if (navLoaded && worktrees.length > 0) {
    const saved = getLastWorktree()
    if (saved && worktrees.some((w) => w.path === saved)) return <Redirect href={worktreeHref(saved)} />
    if (!saved || allSnapshotted || waitedEnough) return <Redirect href={worktreeHref(worktrees[0].path)} />
  }
  return <Empty message={fleet.getEntries().length && allSnapshotted ? 'No worktrees yet.' : 'Connecting…'} />
}
