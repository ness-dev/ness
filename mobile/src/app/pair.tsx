// <scheme>://pair?url=<connection link> — what the pairing QR in Ness
// Settings encodes. Adds (or re-enables) that backend, then returns to
// where the user was (the new backend's worktrees join the list), or goes
// home when the link launched the app.
import { useEffect, useRef } from 'react'
import { router, useLocalSearchParams } from 'expo-router'
import { parseConnectionUrl } from '../../../src/shared/transport/parse-connection-url'
import { useWorkspace } from '../workspace'

export default function PairRoute() {
  const { url } = useLocalSearchParams<{ url?: string }>()
  const { backends } = useWorkspace()
  const done = useRef(false)
  useEffect(() => {
    if (!backends.loaded || done.current) return
    done.current = true
    const r = url ? parseConnectionUrl(url) : null
    if (r?.ok) backends.add({ wsUrl: r.parsed.wsUrl, token: r.parsed.token })
    if (router.canGoBack()) router.back()
    else router.replace('/')
  }, [backends, url])
  return null
}
