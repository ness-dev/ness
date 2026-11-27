// Port of JsonModeChat's composer: state dot + text, the permission-mode
// pill (tap cycles, mid-turn), interrupt / interrupt & send while busy,
// Send, first-keystroke wake for an asleep tab, the debounced
// touchLastActive, and the `/` command popover with the two-stage
// `/model` picker. Differences on purpose: no hotkey hints (no keyboard),
// and Return inserts a newline unless the user turned on send-on-Enter,
// matching the web's default.
import { useMemo, useRef, useState } from 'react'
import { haptic } from '../haptics'
import { Keyboard, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { Square } from 'lucide-react-native'
import type { JsonClaudeSession } from '../../../src/shared/state/json-claude'
import { CLAUDE_MODELS, getAgentInfo, getChatCapabilities } from '../../../src/shared/agent-registry'
import { fuzzyMatch } from '../../../src/renderer/fuzzy'
import type { NessClient } from '../ness'
import { useNess } from '../ness'
import { alpha, c, fs, themed, getThemeMode } from '../theme'

const MODES = ['default', 'acceptEdits', 'plan', 'auto'] as const
const MODE_STYLE: Record<string, { label: string; color: string | null }> = themed(() => ({
  default: { label: 'ask every time', color: null },
  acceptEdits: { label: 'accept edits', color: c.success },
  plan: { label: 'plan', color: c.accent },
  auto: { label: 'auto', color: c.warning }
}))
const BUILTIN_DESCRIPTIONS: Record<string, string> = {
  clear: 'Reset the conversation context',
  compact: 'Summarize and compact prior messages',
  context: 'Show context window usage'
}

interface PopItem {
  key: string
  title: string
  detail?: string
  pick: () => void
}

export function Composer({
  client,
  session,
  sessionId,
  worktreePath,
  mode,
  onSent
}: {
  client: NessClient
  session: JsonClaudeSession | undefined
  sessionId: string
  worktreePath: string
  mode: 'awake' | 'asleep'
  /** Fired on every send, like the web's takeDraft: the transcript snaps
   *  back to the bottom so your own message is in view. */
  onSent?: () => void
}) {
  const sendOnEnter = useNess(client, (s) => !!s.settings.jsonModeSendOnEnter)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<React.ComponentRef<typeof TextInput>>(null)
  const [focused, setFocused] = useState(false)
  const [popDismissed, setPopDismissed] = useState<string | null>(null)
  const woke = useRef(false)
  const lastTouch = useRef(0)
  const caps = getChatCapabilities(session?.agentKind)
  // The web says "Message Claude", not the registry's "Claude Code".
  const agentName = (session?.agentKind ?? 'claude') === 'claude' ? 'Claude' : getAgentInfo(session!.agentKind!).displayName

  const state = session?.state ?? (mode === 'asleep' ? 'asleep' : 'connecting')
  const exited = session?.state === 'exited'
  const stateDot = state === 'running' ? c.success : state === 'connecting' ? c.warning : state === 'exited' ? c.danger : c.faint
  const busy = !!session?.busy
  const permissionMode = session?.permissionMode ?? 'default'
  const ms = MODE_STYLE[permissionMode] ?? MODE_STYLE.default

  if (mode !== 'asleep') woke.current = false

  const onChange = (t: string) => {
    setDraft(t)
    setPopDismissed(null)
    // First keystroke into an asleep tab wakes it (re-armed on next sleep).
    if (mode === 'asleep' && !woke.current) {
      woke.current = true
      void client.api.panesWakeTab(worktreePath, sessionId)
    }
    const now = Date.now()
    if (now - lastTouch.current > 5000) {
      lastTouch.current = now
      void client.api.touchWorktreeLastActive(worktreePath)
    }
  }

  // Collapse the composer once a message is away: dropping the keyboard
  // brings the box back to the bottom edge and the transcript into view.
  // Slash-popover picks that only change the draft don't come through here.
  const afterSend = () => {
    haptic.tap()
    // Blur the field itself (not just Keyboard.dismiss) and do it after
    // the cleared draft has rendered, so the re-render can't leave focus —
    // and the keyboard — on the composer.
    requestAnimationFrame(() => {
      inputRef.current?.blur()
      Keyboard.dismiss()
    })
    onSent?.()
  }

  const sendText = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || exited) return false
    const model = /^\/model\s+(\S+)\s*$/.exec(trimmed)
    if (model && caps.modelPicker) {
      void client.api.setJsonClaudeTabModel(sessionId, model[1])
    } else {
      client.api.sendJsonClaudeMessage(sessionId, trimmed)
    }
    setDraft('')
    afterSend()
    return true
  }

  // ── slash popover ──
  const slash = /(^|\s)\/([a-zA-Z0-9:-]*)$/.exec(draft)
  const modelStage = /^\/model\s+(\S*)$/.exec(draft)
  const popItems = useMemo<PopItem[]>(() => {
    if (exited || !session) return []
    if (modelStage && caps.modelPicker) {
      const models = session.availableModels ?? CLAUDE_MODELS
      const q = modelStage[1]
      const ranked = q ? fuzzyMatch(q, models.map((m) => m.id)).map((r) => models.find((m) => m.id === r.item)!) : models
      const pickModel = (id: string) => {
        void client.api.setJsonClaudeTabModel(sessionId, id)
        setDraft('')
      }
      return [
        { key: '(default)', title: '(Default)', pick: () => pickModel('') },
        ...ranked.slice(0, 50).map((m) => ({
          key: m.id,
          title: m.displayName ?? m.id,
          detail: `${m.id}${m.id === session.currentModel ? ' · current' : ''}${(m as { tier?: string }).tier === 'legacy' ? ' · legacy' : ''}`,
          pick: () => pickModel(m.id)
        }))
      ]
    }
    if (!slash) return []
    const q = slash[2]
    const names = session.slashCommands ?? []
    const ranked = q ? fuzzyMatch(q, names).map((r) => r.item) : names
    const out: PopItem[] = []
    if (caps.modelPicker && (!q || 'model'.startsWith(q))) {
      out.push({ key: '/model', title: '/model', detail: `Change model — currently ${session.currentModel ?? 'default'}`, pick: () => setDraft('/model ') })
    }
    for (const name of ranked.slice(0, 50)) {
      out.push({
        key: name,
        title: `/${name}`,
        detail: BUILTIN_DESCRIPTIONS[name],
        pick: () => {
          // Whole draft is the command → send it; otherwise insert.
          if (draft.trim() === `/${q}`) sendText(`/${name}`)
          else setDraft(draft.replace(/\/[a-zA-Z0-9:-]*$/, `/${name} `))
        }
      })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, session?.slashCommands, session?.availableModels, session?.currentModel, exited])
  const showPop = popItems.length > 0 && popDismissed !== draft

  const canSend = draft.trim().length > 0 && !exited
  const placeholder = mode === 'asleep' ? 'Type to wake this session…' : `Message ${agentName}`

  return (
    <View style={{ borderTopWidth: 1, borderColor: c.border, backgroundColor: c.app }}>
      {showPop && (
        <View style={{ maxHeight: 240, borderBottomWidth: 1, borderColor: c.border, backgroundColor: c.panelRaised }}>
          <ScrollView keyboardShouldPersistTaps="always">
            {popItems.map((it) => (
              <Pressable
                key={it.key}
                onPress={() => {
                  it.pick()
                  // Keep typing after a pick (the tap took focus).
                  inputRef.current?.focus()
                }}
                style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, backgroundColor: pressed ? c.surface : 'transparent' })}
              >
                <Text style={{ color: c.fgBright, fontSize: fs.sm, fontFamily: 'Menlo' }}>{it.title}</Text>
                {it.detail ? (
                  <Text style={{ color: c.dim, fontSize: fs.xs }} numberOfLines={1}>
                    {it.detail}
                  </Text>
                ) : null}
              </Pressable>
            ))}
          </ScrollView>
          <Pressable onPress={() => setPopDismissed(draft)} style={{ position: 'absolute', right: 8, top: 6 }} hitSlop={12}>
            <Text style={{ color: c.dim, fontSize: 11 }}>esc</Text>
          </Pressable>
        </View>
      )}
      <View style={{ padding: 12 }}>
        <View style={{ borderWidth: 1, borderColor: focused ? c.accent : c.border, backgroundColor: c.panel, borderRadius: 6 }}>
          <TextInput
            keyboardAppearance={getThemeMode()}
            ref={inputRef}
            style={{
              color: c.fg,
              // 16px, like the web below `sm`: iOS zooms smaller inputs.
              fontSize: 16,
              minHeight: 48,
              maxHeight: 160,
              paddingHorizontal: 12,
              paddingTop: 10,
              paddingBottom: 6,
              textAlignVertical: 'top'
            }}
            multiline
            placeholder={placeholder}
            placeholderTextColor={c.dim}
            value={draft}
            onChangeText={onChange}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            submitBehavior={sendOnEnter ? 'submit' : 'newline'}
            returnKeyType={sendOnEnter ? 'send' : 'default'}
            onSubmitEditing={sendOnEnter ? () => sendText(draft) : undefined}
          />
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingLeft: 10, paddingRight: 6, paddingBottom: 6 }}>
            {/* State + permission pill sit on the bottom edge of the row,
                level with the bottom of the 44pt Send / interrupt buttons,
                instead of floating mid-height beside them. */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: stateDot }} />
            <Text style={{ color: c.muted, fontSize: fs.xs }}>{state}</Text>
            {caps.permissionModes && session && (
              <Pressable
                hitSlop={12}
                accessibilityLabel={`Permission mode: ${ms.label}. Tap to cycle.`}
                onPress={() => {
                  const next = MODES[(MODES.indexOf(permissionMode as (typeof MODES)[number]) + 1) % MODES.length]
                  haptic.select()
                  void client.api.setJsonClaudePermissionMode(sessionId, next)
                }}
                style={{
                  borderWidth: 1,
                  borderRadius: 4,
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                  backgroundColor: ms.color ? alpha(ms.color, 0.15) : c.surface,
                  borderColor: ms.color ? alpha(ms.color, 0.3) : c.border
                }}
              >
                <Text style={{ color: ms.color ?? c.muted, fontSize: fs.xs }}>{ms.label}</Text>
              </Pressable>
            )}
            </View>
            <View style={{ flex: 1 }} />
            {busy && (
              <Pressable
                onPress={() => {
                  if (draft.trim()) {
                    void client.api.interruptAndSendJsonClaude(sessionId, draft.trim(), [])
                    setDraft('')
                    afterSend()
                  } else {
                    haptic.tap()
                    void client.api.interruptJsonClaude(sessionId)
                  }
                }}
                style={({ pressed }) => [btn, { backgroundColor: pressed ? c.surfaceHover : c.surface }]}
              >
                <Square color={c.fg} fill={c.fg} size={9} />
                <Text style={{ color: c.fg, fontSize: fs.xs, fontWeight: '500' }}>{draft.trim() ? 'interrupt & send' : 'interrupt'}</Text>
              </Pressable>
            )}
            <Pressable onPress={() => sendText(draft)} disabled={!canSend} style={[btn, { backgroundColor: c.accent, opacity: canSend ? 1 : 0.4 }]}>
              <Text style={{ color: '#fff', fontSize: fs.xs, fontWeight: '500' }}>Send</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  )
}

// The web's px-2.5 py-0.5 pill, at a 44pt thumb-sized height.
const btn = { flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'center' as const, gap: 5, borderRadius: 6, paddingHorizontal: 14, minHeight: 44, minWidth: 64 }
