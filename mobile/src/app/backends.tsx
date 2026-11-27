import { router } from 'expo-router'
import { useWorkspace } from '../workspace'
import { BackendsSheet } from '../components/BackendsSheet'

export default function BackendsRoute() {
  const { backends } = useWorkspace()
  return <BackendsSheet backends={backends} onClose={() => router.back()} />
}
