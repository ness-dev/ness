// The review status icon: in progress (by the reviewer's live status) or
// the verdict it came back with, plus a dot for a review not yet sent.
// Port of renderer/components/ReviewStatusIcon.tsx. The glyph is split from
// the subscription so the worktree picker (which reads state without
// subscribing) and the nested tab rows can draw the same thing.
import { useMemo } from 'react'
import { View } from 'react-native'
import { CircleAlert, CircleCheck, ListChecks, Loader2, MessageSquare } from 'lucide-react-native'
import { useNess, type NessClient } from '../ness'
import { c } from '../theme'
import { Pulse, Spin } from '../components/Spin'
import { reviewIconSpec, worktreeReviewStatus, type ReviewIconSpec, type ReviewTone } from './review-model'

const ICONS = { Loader2, ListChecks, CircleCheck, CircleAlert, MessageSquare }

export function toneColor(tone: ReviewTone): string {
  return tone === 'dim' ? c.dim : c[tone]
}

export function ReviewStatusGlyph({ spec, size }: { spec: ReviewIconSpec; size: number }) {
  const Icon = ICONS[spec.icon]
  let el = <Icon color={toneColor(spec.tone)} size={size} style={spec.faded ? { opacity: 0.6 } : undefined} />
  if (spec.spin) el = <Spin>{el}</Spin>
  if (spec.pulse) el = <Pulse>{el}</Pulse>
  return (
    <View accessible accessibilityLabel={spec.label}>
      {el}
      {spec.unsent && (
        <View style={{ position: 'absolute', top: -2, right: -2, width: 6, height: 6, borderRadius: 3, backgroundColor: c.warning }} />
      )}
    </View>
  )
}

/** Primitive selectors, so a state frame that doesn't change the answer
 *  doesn't re-render (CLAUDE.md anti-pattern 4). */
export function useReviewIconSpec(client: NessClient, worktreePath: string, showNone = false): ReviewIconSpec | null {
  const kind = useNess(client, (s) => worktreeReviewStatus(s, worktreePath).kind)
  const unsent = useNess(client, (s) => worktreeReviewStatus(s, worktreePath).unsent)
  const reviewerStatus = useNess(client, (s) => worktreeReviewStatus(s, worktreePath).reviewerStatus)
  return useMemo(() => reviewIconSpec({ kind, unsent }, reviewerStatus, showNone), [kind, unsent, reviewerStatus, showNone])
}

export function ReviewStatusIcon({ client, worktreePath, size, showNone }: { client: NessClient; worktreePath: string; size: number; showNone?: boolean }) {
  const spec = useReviewIconSpec(client, worktreePath, showNone)
  return spec ? <ReviewStatusGlyph spec={spec} size={size} /> : null
}
