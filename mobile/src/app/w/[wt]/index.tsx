import { useLocalSearchParams } from 'expo-router'
import { WorktreeScreen } from '../../../screens/WorktreeScreen'

export default function WorktreeRoute() {
  const { wt, tab } = useLocalSearchParams<{ wt: string; tab?: string }>()
  return <WorktreeScreen wtPath={wt} tabParam={tab} />
}
