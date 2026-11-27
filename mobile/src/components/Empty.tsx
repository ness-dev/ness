import { Text, View } from 'react-native'
import { c, fs } from '../theme'

/** A centred one-line state ("Connecting…", "No worktrees yet."). */
export function Empty({ message }: { message: string }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 24 }}>
      <Text style={{ color: c.dim, fontSize: fs.sm, textAlign: 'center' }}>{message}</Text>
    </View>
  )
}
