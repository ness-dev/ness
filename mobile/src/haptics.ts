// Haptic feedback, by intent, so the same kind of action feels the same
// everywhere. expo-haptics ships in Expo Go; on web (and devices without a
// Taptic Engine) the calls reject or no-op, which is swallowed here.
import * as Haptics from 'expo-haptics'

const fire = (p: Promise<void>): void => void p.catch(() => {})

export const haptic = {
  /** A discrete choice changed: tab, worktree, permission mode. */
  select: () => fire(Haptics.selectionAsync()),
  /** Something was sent or stopped. */
  tap: () => fire(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  /** An approval was granted or a question answered. */
  success: () => fire(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  /** Claude is waiting on you, or you denied something. */
  warning: () => fire(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning))
}
