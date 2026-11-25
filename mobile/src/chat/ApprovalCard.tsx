// Port of JsonClaudeApprovalCard.tsx + JsonClaudeQuestionCard.tsx. Same
// modes, labels, conditions and channels; the summary text, tool display,
// permission-pattern ladder and question encoding all come from the
// shared/renderer modules the desktop card uses. Buttons use the desktop's
// mobile sizing (px-3.5 py-2.5) bumped to a 44pt minimum.
import { useMemo, useState, type ReactNode } from 'react'
import { Pressable, Text, TextInput, View } from 'react-native'
import { Check, Circle, Square, SquareCheck } from 'lucide-react-native'
import { EDIT_TOOL_NAMES, type JsonClaudePendingApproval, type JsonClaudeSession } from '../../../src/shared/state/json-claude'
import { getChatCapabilities } from '../../../src/shared/agent-registry'
import { suggestPermissionPatterns } from '../../../src/shared/permission-patterns'
import { buildQuestionResult, parseQuestions, type QuestionAnswer } from '../../../src/shared/ask-user-question'
import { formatPendingTool } from '../../../src/renderer/pending-tool'
import { extractArgs, getToolDisplay, prettyToolName } from '../../../src/renderer/components/json-mode-cards/tool-display'
import type { NessClient } from '../ness'
import { alpha, c, fs, mono } from '../theme'
import { Spin } from '../components/Spin'
import { Loader2 } from 'lucide-react-native'
import { ToolIcon } from './cards'

type Resolution = {
  behavior: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
  message?: string
  interrupt?: boolean
}

export function ApprovalSlot({
  approval,
  client,
  session
}: {
  approval: JsonClaudePendingApproval
  client: NessClient
  session: JsonClaudeSession | undefined
}) {
  const onResolve = (r: Resolution) => client.req('jsonClaude:resolveApproval', approval.requestId, r)
  if (approval.toolName === 'AskUserQuestion') return <QuestionCard approval={approval} onResolve={onResolve} />
  return <ApprovalCard approval={approval} client={client} session={session} onResolve={onResolve} />
}

type Mode = 'summary' | 'edit-input' | 'always' | 'deny' | 'edit-guidance'

function ApprovalCard({
  approval,
  client,
  session,
  onResolve
}: {
  approval: JsonClaudePendingApproval
  client: NessClient
  session: JsonClaudeSession | undefined
  onResolve: (r: Resolution) => Promise<unknown>
}) {
  const [mode, setMode] = useState<Mode>('summary')
  const [busy, setBusy] = useState(false)
  const display = useMemo(() => getToolDisplay(approval.toolName), [approval.toolName])
  const args = useMemo(() => extractArgs(approval.input), [approval.input])
  const caps = getChatCapabilities(session?.agentKind)
  const suggestions = useMemo(() => suggestPermissionPatterns(approval.toolName, approval.input), [approval.toolName, approval.input])
  const [selectedLabel, setSelectedLabel] = useState(() => suggestions[0]?.label ?? approval.toolName)
  const selected = suggestions.find((x) => x.label === selectedLabel) ?? suggestions[0]
  const [editJson, setEditJson] = useState(() => JSON.stringify(approval.input, null, 2))
  const [editError, setEditError] = useState<string | null>(null)
  const [denyReason, setDenyReason] = useState('')
  const [denyInterrupt, setDenyInterrupt] = useState(false)
  const savedGuidance = client.getState().settings.autoApproveSteerInstructions ?? ''
  const [guidance, setGuidance] = useState(savedGuidance)
  const [guidanceSaved, setGuidanceSaved] = useState(false)

  const isEditTool = (EDIT_TOOL_NAMES as readonly string[]).includes(approval.toolName)
  const sessionGrantLabel = isEditTool ? 'Allow edits this session' : `Allow ${prettyToolName(approval.toolName)} this session`
  // Edit tools flip the permission mode (no restart since 2.1.x), except
  // in 'auto' where that would downgrade the whole session.
  const grantViaPermissionMode = isEditTool && session?.permissionMode !== 'auto'
  const alreadyGranted = grantViaPermissionMode
    ? session?.permissionMode === 'acceptEdits'
    : !!session && session.sessionToolApprovals.includes(approval.toolName)

  const run = (fn: () => Promise<unknown>) => {
    setBusy(true)
    fn().finally(() => setBusy(false))
  }
  const allow = () => run(() => onResolve({ behavior: 'allow', updatedInput: approval.input }))
  const allowSession = () =>
    run(async () => {
      // Resolve first, so the bridge answers before any respawn.
      await onResolve({ behavior: 'allow', updatedInput: approval.input })
      if (grantViaPermissionMode) await client.req('jsonClaude:setPermissionMode', approval.sessionId, 'acceptEdits')
      else await client.req('jsonClaude:grantSessionToolApprovals', approval.sessionId, isEditTool ? [...EDIT_TOOL_NAMES] : [approval.toolName])
    })
  const alwaysAllow = () => {
    if (!selected) return
    run(async () => {
      void client.req('permissions:grant', selected.rule, session?.worktreePath)
      await onResolve({ behavior: 'allow', updatedInput: approval.input })
    })
  }
  const allowEdited = () => {
    try {
      const parsed = JSON.parse(editJson) as Record<string, unknown>
      run(() => onResolve({ behavior: 'allow', updatedInput: parsed }))
    } catch (e) {
      setEditError(`Invalid JSON: ${(e as Error).message}`)
    }
  }
  const deny = () =>
    run(() => onResolve({ behavior: 'deny', message: denyReason.trim() || 'user denied', interrupt: denyInterrupt }))

  const autoReview = approval.autoReview
  const cmd = typeof approval.input?.command === 'string' ? approval.input.command : null
  const description = typeof approval.input?.description === 'string' ? approval.input.description : null

  return (
    <View style={{ borderWidth: 1, borderColor: alpha(c.danger, 0.4), backgroundColor: alpha(c.danger, 0.05), borderRadius: 6, marginVertical: 8, overflow: 'hidden' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: alpha(c.danger, 0.1), borderBottomWidth: 1, borderColor: alpha(c.danger, 0.3) }}>
        <Text style={{ color: c.danger, fontSize: fs.xs, fontWeight: '600', letterSpacing: 0.6 }}>NEEDS APPROVAL</Text>
        <ToolIcon icon={display.icon as never} className="icon-sm text-fg-bright" />
        <Text style={{ color: c.fgBright, fontSize: fs.xs, fontFamily: mono, flex: 1 }} numberOfLines={1}>
          {formatPendingTool({ name: approval.toolName, input: approval.input })}
        </Text>
      </View>

      {autoReview?.state === 'pending' && (
        <Strip>
          <Spin>
            <Loader2 color={c.muted} size={12} />
          </Spin>
          <Text style={{ color: c.muted, fontSize: fs.xs }}>Asking auto-approver…</Text>
        </Strip>
      )}
      {autoReview?.state === 'finished' && autoReview.decision === 'ask' && (
        <Strip>
          <Text style={{ color: c.muted, fontSize: fs.xs, flex: 1 }}>
            <Text style={{ fontWeight: '600' }}>Auto-approver: </Text>
            <Text style={{ opacity: 0.8 }}>{autoReview.reason || 'deferred'}</Text>
          </Text>
          {mode !== 'edit-guidance' && (
            <Btn
              label="Edit guidance"
              small
              onPress={() => {
                setGuidance(savedGuidance)
                setGuidanceSaved(false)
                setMode('edit-guidance')
              }}
            />
          )}
        </Strip>
      )}

      <View style={{ padding: 12, gap: 10 }}>
        {mode === 'edit-guidance' && (
          <>
            <Text style={{ color: c.muted, fontSize: fs.xs }}>
              Project-specific guidance appended to the auto-approver's policy. Save to persist for future requests; "Save &
              re-review" also re-runs the reviewer on this request right now.
            </Text>
            <Field value={guidance} onChange={setGuidance} placeholder="e.g. Approve npm install. Deny any Bash that touches /etc." multiline />
            <Row>
              <Btn
                label="Save & re-review"
                primary
                disabled={busy}
                onPress={() =>
                  run(async () => {
                    setGuidanceSaved(true)
                    await client.req('config:setAutoApproveSteerInstructions', guidance)
                    await client.req('jsonClaude:rerunAutoApprovalReview', approval.requestId)
                    setMode('summary')
                  })
                }
              />
              <Btn
                label="Save only"
                disabled={busy || guidance === savedGuidance}
                onPress={() => run(async () => {
                  await client.req('config:setAutoApproveSteerInstructions', guidance)
                  setGuidanceSaved(true)
                })}
              />
              <Btn label="Cancel" onPress={() => setMode('summary')} />
              {guidanceSaved && <Text style={{ color: c.success, fontSize: fs.xs }}>Saved</Text>}
            </Row>
          </>
        )}

        {mode === 'summary' && (
          <>
            {cmd !== null ? (
              <View style={{ gap: 4 }}>
                <Code text={cmd} />
                {description && <Text style={{ color: c.muted, fontSize: fs.xs, fontStyle: 'italic' }}>{description}</Text>}
              </View>
            ) : args.length > 0 ? (
              <View style={{ gap: 4 }}>
                {args.map((a) => (
                  <View key={a.key} style={{ flexDirection: a.multiline ? 'column' : 'row', gap: 6 }}>
                    <Text style={{ color: c.dim, fontSize: fs.xs, fontFamily: mono }}>{a.key}</Text>
                    <Text selectable style={{ color: c.fg, fontSize: fs.xs, fontFamily: mono, flexShrink: 1 }}>
                      {a.value}
                    </Text>
                  </View>
                ))}
              </View>
            ) : (
              <Text style={{ color: c.muted, fontSize: fs.xs }}>No input.</Text>
            )}
            <Row>
              <Btn label="Allow once" primary disabled={busy} onPress={allow} />
              {!alreadyGranted && <Btn label={sessionGrantLabel} disabled={busy} onPress={allowSession} />}
              {caps.approvalEditInput && <Btn label="Allow with edits" disabled={busy} onPress={() => setMode('edit-input')} />}
              {suggestions.length > 0 && <Btn label="Always allow…" disabled={busy} onPress={() => setMode('always')} />}
              <Btn label="Deny" danger disabled={busy} onPress={() => setMode('deny')} />
            </Row>
          </>
        )}

        {mode === 'edit-input' && (
          <>
            <Field value={editJson} onChange={(v) => { setEditJson(v); setEditError(null) }} multiline mono />
            {editError && <Text style={{ color: c.danger, fontSize: fs.xs }}>{editError}</Text>}
            <Row>
              <Btn label="Allow edited" primary disabled={busy} onPress={allowEdited} />
              <Btn label="Cancel" onPress={() => setMode('summary')} />
            </Row>
          </>
        )}

        {mode === 'always' && (
          <>
            {suggestions.map((sg) => (
              <Pressable key={sg.label} onPress={() => setSelectedLabel(sg.label)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 }}>
                {selectedLabel === sg.label ? <Check color={c.accent} size={16} /> : <Circle color={c.dim} size={16} />}
                <Text style={{ color: c.fg, fontSize: fs.xs, fontFamily: mono, flex: 1 }}>{sg.label}</Text>
                <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1 }}>
                  <Text style={{ color: c.dim, fontSize: 10 }}>{sg.scope}</Text>
                </View>
              </Pressable>
            ))}
            <Row>
              <Btn label="Always allow this pattern" primary disabled={busy} onPress={alwaysAllow} />
              <Btn label="Cancel" onPress={() => setMode('summary')} />
            </Row>
          </>
        )}

        {mode === 'deny' && (
          <>
            {caps.approvalDenyReason && (
              <Field value={denyReason} onChange={setDenyReason} placeholder="Reason shown to Claude (optional)" multiline />
            )}
            <Pressable onPress={() => setDenyInterrupt(!denyInterrupt)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 }}>
              {denyInterrupt ? <SquareCheck color={c.accent} size={16} /> : <Square color={c.dim} size={16} />}
              <Text style={{ color: c.fg, fontSize: fs.xs, flex: 1 }}>Interrupt turn (abort the model's current response)</Text>
            </Pressable>
            <Row>
              <Btn label="Deny" danger disabled={busy} onPress={deny} />
              <Btn label="Cancel" onPress={() => setMode('summary')} />
            </Row>
          </>
        )}
      </View>
    </View>
  )
}

// ── AskUserQuestion ─────────────────────────────────────────────────────

const EMPTY: QuestionAnswer = { selected: [], custom: '' }

function QuestionCard({ approval, onResolve }: { approval: JsonClaudePendingApproval; onResolve: (r: Resolution) => Promise<unknown> }) {
  const questions = useMemo(() => parseQuestions(approval.input), [approval.input])
  const [answers, setAnswers] = useState<Record<string, QuestionAnswer>>({})
  const [replying, setReplying] = useState(false)
  const [reply, setReply] = useState('')
  const answered = questions.filter((q) => {
    const a = answers[q.question]
    return a && (a.selected.length > 0 || a.custom.trim() !== '')
  }).length
  const update = (q: string, patch: Partial<QuestionAnswer>) => setAnswers((p) => ({ ...p, [q]: { ...EMPTY, ...p[q], ...patch } }))
  const toggle = (q: string, label: string, multi: boolean) => {
    const cur = answers[q]?.selected ?? []
    update(q, { selected: multi ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label], custom: '' })
  }

  if (questions.length === 0) {
    return (
      <View style={{ borderWidth: 1, borderColor: alpha(c.accent, 0.4), borderRadius: 6, padding: 12, gap: 8 }}>
        <Text style={{ color: c.muted, fontSize: fs.xs }}>Claude asked a question this client can't read.</Text>
        <Btn label="Dismiss" onPress={() => void onResolve({ behavior: 'deny', message: 'malformed question' })} />
      </View>
    )
  }
  return (
    <View style={{ borderWidth: 1, borderColor: alpha(c.accent, 0.4), backgroundColor: alpha(c.accent, 0.05), borderRadius: 6, padding: 12, gap: 14, marginVertical: 8 }}>
      {questions.map((q) => {
        const a = answers[q.question] ?? EMPTY
        return (
          <View key={q.question} style={{ gap: 6 }}>
            {q.header && <Text style={{ color: c.accent, fontSize: 10, letterSpacing: 0.6, textTransform: 'uppercase' }}>{q.header}</Text>}
            <Text style={{ color: c.fgBright, fontSize: fs.sm, fontWeight: '500' }}>{q.question}</Text>
            {q.options.map((o) => {
              const on = a.selected.includes(o.label)
              const Icon = q.multiSelect ? (on ? SquareCheck : Square) : on ? Check : Circle
              return (
                <Pressable key={o.label} onPress={() => toggle(q.question, o.label, !!q.multiSelect)} style={{ flexDirection: 'row', gap: 8, minHeight: 44, alignItems: 'center' }}>
                  <Icon color={on ? c.accent : c.dim} size={16} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: c.fg, fontSize: fs.sm }}>{o.label}</Text>
                    {o.description && <Text style={{ color: c.muted, fontSize: fs.xs }}>{o.description}</Text>}
                  </View>
                </Pressable>
              )
            })}
            <Field value={a.custom} onChange={(v) => update(q.question, { custom: v, selected: v ? [] : a.selected })} placeholder="Other…" />
          </View>
        )
      })}
      {replying ? (
        <>
          <Field value={reply} onChange={setReply} placeholder="Reply to Claude instead of picking an option…" multiline />
          <Row>
            <Btn label="Send reply" primary disabled={!reply.trim()} onPress={() => void onResolve(buildQuestionResult(approval.input, questions, answers, reply))} />
            <Btn label="Back" onPress={() => setReplying(false)} />
          </Row>
        </>
      ) : (
        <Row>
          <Btn
            label={answered > 0 && answered < questions.length ? `Submit ${answered} of ${questions.length}` : 'Submit'}
            primary
            disabled={answered === 0}
            onPress={() => void onResolve(buildQuestionResult(approval.input, questions, answers))}
          />
          <Btn label="Reply instead" onPress={() => setReplying(true)} />
          <Btn label="Skip" onPress={() => void onResolve(buildQuestionResult(approval.input, questions, {}))} />
        </Row>
      )}
    </View>
  )
}

// ── bits ────────────────────────────────────────────────────────────────

function Strip({ children }: { children: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: 1, borderColor: alpha(c.danger, 0.2), backgroundColor: alpha(c.app, 0.3) }}>
      {children}
    </View>
  )
}

function Row({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>{children}</View>
}

function Code({ text }: { text: string }) {
  return (
    <View style={{ backgroundColor: c.app, borderRadius: 4, borderWidth: 1, borderColor: c.border, padding: 8 }}>
      <Text selectable style={{ fontFamily: mono, fontSize: fs.xs, color: c.fgBright }}>
        {text}
      </Text>
    </View>
  )
}

function Field({ value, onChange, placeholder, multiline, mono: isMono }: { value: string; onChange: (v: string) => void; placeholder?: string; multiline?: boolean; mono?: boolean }) {
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor={c.faint}
      multiline={multiline}
      autoCapitalize="none"
      autoCorrect={!isMono}
      style={{
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.app,
        borderRadius: 4,
        color: c.fg,
        paddingHorizontal: 10,
        paddingVertical: 8,
        fontSize: 16, // ≥16 so iOS doesn't zoom, same rule as the web composer
        fontFamily: isMono ? mono : undefined,
        minHeight: multiline ? 72 : 44,
        maxHeight: 200,
        textAlignVertical: multiline ? 'top' : 'center'
      }}
    />
  )
}

export function Btn({
  label,
  onPress,
  primary,
  danger,
  disabled,
  small
}: {
  label: string
  onPress: () => void
  primary?: boolean
  danger?: boolean
  disabled?: boolean
  small?: boolean
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={small ? 8 : 0}
      style={({ pressed }) => ({
        minHeight: small ? 28 : 44,
        justifyContent: 'center',
        paddingHorizontal: small ? 8 : 14,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: primary ? c.accent : danger ? alpha(c.danger, 0.4) : c.border,
        backgroundColor: primary ? c.accent : danger ? alpha(c.danger, pressed ? 0.25 : 0.1) : pressed ? c.panelRaised : c.panel,
        opacity: disabled ? 0.4 : 1
      })}
    >
      <Text style={{ color: primary ? '#fff' : danger ? c.danger : c.fg, fontSize: fs.xs, fontWeight: '500' }}>{label}</Text>
    </Pressable>
  )
}
