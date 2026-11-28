import { router } from 'expo-router'
import { SettingsSheet } from '../components/SettingsSheet'

export default function SettingsRoute() {
  return <SettingsSheet onClose={() => router.back()} />
}
