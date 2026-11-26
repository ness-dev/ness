// RN port of renderer/components/json-mode-cards/* and the small cards
// that live in JsonModeChat.tsx. Labels, icons, intents and summaries come
// from the renderer's own tool-display / tool-timeline / turn-collapse
// modules (served to RN via the lucide shim), so they match the web
// client exactly; only the React-DOM layer is re-written.
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { structuredPatch } from 'diff'
import { Bot, Brain, ChevronDown, ChevronRight, ListChecks, Loader2, RotateCcw, Sparkles, X, Wrench } from 'lucide-react-native'
import type {
  JsonClaudeBackgroundAgent,
  JsonClaudeImageRef,
  JsonClaudeMessageBlock
} from '../../../src/shared/state/json-claude'
import { extractArgs, getToolDisplay, getToolIntent, isNessControl } from '../../../src/renderer/components/json-mode-cards/tool-display'
import { summarizeTools } from '../../../src/renderer/components/json-mode-cards/tool-timeline'
import { formatTurnDuration, type TurnSummary } from '../../../src/renderer/components/json-mode-cards/turn-collapse'
import { automationLabel } from '../../../src/renderer/components/json-mode-cards/automation-label'
import { alpha, c, mono } from '../theme'
import { tw } from '../tw'
import Svg, { G, Path, Rect } from 'react-native-svg'
import { NessIcon, McpGenericIcon } from '../../../src/renderer/components/json-mode-cards/tool-icons'
import { NESS_MARK_PATHS } from '../../../src/renderer/components/NessMark'
import { Markdown } from '../components/Markdown'
import { Spin } from '../components/Spin'
import { ROW_HIT_SLOP, useDensity, usePersistedChoice } from './density'
import { ImageStrip } from './ChatImage'

export interface ToolResultView {
  content: string
  isError: boolean
  images?: JsonClaudeImageRef[]
}

// ── chrome ─────────────────────────────────────────────────────────────

export function Chevron({ open }: { open: boolean }) {
  return open ? <ChevronDown color={c.muted} size={12} /> : <ChevronRight color={c.muted} size={12} />
}

/** Desktop icon components can draw raw <svg> (the Ness mark), which RN
 *  can't host. Fall back to a wrench rather than crash the transcript. */
class IconBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? <Wrench color={c.muted} size={12} /> : this.props.children
  }
}

type DesktopIcon = (p: { className?: string }) => ReactNode

// The two desktop tool icons that draw raw <svg> instead of a lucide glyph,
// redrawn with react-native-svg from the same data. Rendering the DOM
// versions throws "View config getter callback for component `path`" — the
// IconBoundary below only catches that after dev's LogBox has already
// taken over the screen.
const BRAND = '#4ade80' // --color-brand
function RnNessIcon({ className }: { className?: string }) {
  const size = tw(className).size ?? 12
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <G transform="translate(12,12) scale(0.42) translate(-32.2,-24.2)" fill={BRAND}>
        {NESS_MARK_PATHS.map((d) => (
          <Path key={d} d={d} />
        ))}
      </G>
    </Svg>
  )
}
function RnMcpGenericIcon({ className }: { className?: string }) {
  const t = tw(className)
  const size = t.size ?? 12
  const col = t.color ?? c.muted
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={col} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M9 3v4 M15 3v4" />
      <Rect x={6} y={7} width={12} height={6} rx={1} />
      <Path d="M12 13v4 M9 17h6" />
    </Svg>
  )
}
const RN_ICON = new Map<unknown, DesktopIcon>([
  [NessIcon, RnNessIcon],
  [McpGenericIcon, RnMcpGenericIcon]
])

export function ToolIcon({ icon, className = 'icon-xs text-muted' }: { icon: DesktopIcon | null | undefined; className?: string }) {
  if (!icon) return null
  const Icon = RN_ICON.get(icon) ?? icon
  return (
    <IconBoundary>
      <Icon className={className} />
    </IconBoundary>
  )
}

/** CHAT_ROW_CLASS + CHAT_ROW_STYLE: a full-width muted row. */
export function ChatRow({ onPress, children }: { onPress?: () => void; children: ReactNode }) {
  const d = useDensity()
  return (
    <Pressable
      onPress={onPress}
      hitSlop={ROW_HIT_SLOP}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: d.chromePy, opacity: pressed ? 0.7 : 1 })}
    >
      {children}
    </Pressable>
  )
}

export function Meta({ children, color = c.muted, style }: { children: ReactNode; color?: string; style?: object }) {
  const d = useDensity()
  return (
    <Text style={[{ fontSize: d.meta, color, textTransform: 'uppercase', letterSpacing: 0.5, opacity: color === c.muted ? 0.7 : 1 }, style]}>
      {children}
    </Text>
  )
}

export function ToolCardChrome({
  name,
  subtitle,
  isError,
  brand,
  icon,
  autoApproved,
  sessionAllowed,
  autoExpand = false,
  images,
  id,
  children
}: {
  /** Stable id (the tool_use id) so an expansion survives the row
   *  scrolling out of the virtualized transcript. */
  id?: string
  /** Tool-result images: a thumbnail strip while collapsed (the web's
   *  collapsedImages), and at the top of the body when open. */
  images?: JsonClaudeImageRef[]
  name: string
  subtitle: ReactNode
  isError?: boolean
  brand?: boolean
  icon?: DesktopIcon | null
  autoApproved?: { model: string; reason: string }
  sessionAllowed?: { toolName: string; rule?: string }
  autoExpand?: boolean
  children: ReactNode
}) {
  const d = useDensity()
  const [expanded, setExpanded] = usePersistedChoice(id ? `card:${id}` : undefined)
  const isOpen = expanded ?? autoExpand
  return (
    <View>
      <ChatRow onPress={() => setExpanded(!isOpen)}>
        <Chevron open={isOpen} />
        <ToolIcon icon={icon} />
        <Text style={{ fontSize: d.chrome, fontWeight: '500', fontFamily: d.toolFamily, color: isError ? c.danger : brand ? c.brand : c.fg }}>
          {name}
        </Text>
        <Text style={{ flex: 1, fontSize: d.chrome, color: c.muted }} numberOfLines={1}>
          {subtitle}
        </Text>
        {autoApproved && <Meta>auto · haiku</Meta>}
        {sessionAllowed && <Meta>{sessionAllowed.rule ? 'always' : 'session'}</Meta>}
        {isError && <Meta color={c.danger}>error</Meta>}
      </ChatRow>
      {!isOpen && images && images.length > 0 && <ImageStrip images={images} height={64} />}
      {isOpen && (
        <View style={{ marginTop: 2, marginBottom: 8, backgroundColor: c.panel, borderRadius: d.bubbleRadius, overflow: 'hidden' }}>
          {images && images.length > 0 && (
            <View style={{ paddingHorizontal: 8 }}>
              <ImageStrip images={images} height={120} />
            </View>
          )}
          {children}
        </View>
      )}
    </View>
  )
}

/** <pre> with a max height: scrolls inside the transcript. */
export function Pre({ text, max, color = c.fg, maxHeight = 288 }: { text: string; max?: number; color?: string; maxHeight?: number }) {
  const shown = max && text.length > max ? `${text.slice(0, max)}\n…` : text
  return (
    <ScrollView style={{ maxHeight }} nestedScrollEnabled contentContainerStyle={{ paddingHorizontal: 8, paddingVertical: 6 }}>
      <Text selectable style={{ fontFamily: mono, fontSize: 12, lineHeight: 17, color }}>
        {shown}
      </Text>
    </ScrollView>
  )
}

function basename(p: unknown): string {
  return typeof p === 'string' ? p.split('/').pop() || p : ''
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

// ── per-tool cards (dispatchToolCard) ────────────────────────────────────

export interface ToolCardProps {
  block: JsonClaudeMessageBlock
  result?: ToolResultView
  autoApproved?: { model: string; reason: string }
  sessionAllowed?: { toolName: string; rule?: string }
  subAgentBody?: ReactNode
  subAgentChildCount?: number
  subAgentDescendantHasPendingApproval?: boolean
  backgroundAgent?: JsonClaudeBackgroundAgent
}

export function dispatchToolCard(p: ToolCardProps): ReactNode {
  switch (p.block.name) {
    case 'Bash':
      return <BashCard {...p} />
    case 'Edit':
      return <EditCard {...p} />
    case 'MultiEdit':
      return <MultiEditCard {...p} />
    case 'Write':
      return <WriteCard {...p} />
    case 'Read':
      return <ReadCard {...p} />
    case 'Grep':
      return <SimpleResultCard {...p} subtitle={`/${str(p.block.input?.pattern)}/${p.block.input?.path ? ` in ${str(p.block.input.path)}` : ''}`} max={3000} />
    case 'Glob':
      return <SimpleResultCard {...p} subtitle={str(p.block.input?.pattern)} max={2000} />
    case 'TodoWrite':
      return <TodoWriteCard {...p} />
    case 'Task':
    case 'Agent':
      return <TaskCard {...p} />
    default:
      return <GenericToolCard {...p} />
  }
}

function common(p: ToolCardProps) {
  const disp = getToolDisplay(p.block.name)
  return {
    icon: disp.icon as DesktopIcon,
    id: p.block.id,
    isError: !!p.result?.isError,
    images: p.result?.images,
    autoApproved: p.autoApproved,
    sessionAllowed: p.sessionAllowed
  }
}

function ErrorOnly({ result, max = 1000 }: { result?: ToolResultView; max?: number }) {
  if (!result?.isError) return null
  return <Pre text={result.content} max={max} color={c.danger} />
}

function BashCard(p: ToolCardProps) {
  const cmd = str(p.block.input?.command)
  const intent = getToolIntent(p.block)
  const subtitle = intent ?? (cmd.length > 80 ? `${cmd.slice(0, 80)}…` : cmd)
  return (
    <ToolCardChrome name="Bash" subtitle={subtitle} {...common(p)}>
      <Pre text={`$ ${cmd}`} maxHeight={128} />
      {p.result && <Pre text={p.result.content} max={6000} color={p.result.isError ? c.danger : c.muted} />}
    </ToolCardChrome>
  )
}

function lineCount(s: string): number {
  return s ? s.split('\n').length : 0
}

function EditCard(p: ToolCardProps) {
  const path = str(p.block.input?.file_path)
  const oldS = str(p.block.input?.old_string)
  const newS = str(p.block.input?.new_string)
  return (
    <ToolCardChrome name="Edit" subtitle={`${basename(path)} (+${lineCount(newS)} −${lineCount(oldS)})`} {...common(p)}>
      <PathLine path={path} />
      <Diff oldText={oldS} newText={newS} />
      <ErrorOnly result={p.result} />
    </ToolCardChrome>
  )
}

function MultiEditCard(p: ToolCardProps) {
  const path = str(p.block.input?.file_path)
  const edits = (Array.isArray(p.block.input?.edits) ? p.block.input.edits : []) as { old_string?: string; new_string?: string }[]
  return (
    <ToolCardChrome name="MultiEdit" subtitle={`${basename(path)} (${edits.length} edit${edits.length === 1 ? '' : 's'})`} {...common(p)}>
      <PathLine path={path} />
      {edits.length === 0 && <Text style={{ color: c.muted, fontSize: 12, padding: 8 }}>No edits.</Text>}
      {edits.map((e, i) => (
        <View key={i}>
          <Text style={{ color: c.dim, fontSize: 11, paddingHorizontal: 8, paddingTop: 6 }}>
            Edit {i + 1} of {edits.length}
          </Text>
          <Diff oldText={e.old_string ?? ''} newText={e.new_string ?? ''} />
        </View>
      ))}
      <ErrorOnly result={p.result} />
    </ToolCardChrome>
  )
}

function WriteCard(p: ToolCardProps) {
  const path = str(p.block.input?.file_path)
  return (
    <ToolCardChrome name="Write" subtitle={basename(path)} {...common(p)}>
      <PathLine path={path} />
      <Pre text={str(p.block.input?.content)} max={4000} maxHeight={240} />
      <ErrorOnly result={p.result} />
    </ToolCardChrome>
  )
}

function ReadCard(p: ToolCardProps) {
  const path = str(p.block.input?.file_path)
  const off = p.block.input?.offset as number | undefined
  const lim = p.block.input?.limit as number | undefined
  const range = off !== undefined || lim !== undefined ? ` (${off ?? 1}–${(off ?? 1) + (lim ?? 0)})` : ''
  const [all, setAll] = useState(false)
  const lines = useMemo(() => (p.result && !p.result.isError ? p.result.content.split('\n') : []), [p.result])
  const shown = all ? lines : lines.slice(0, 500)
  return (
    <ToolCardChrome name="Read" subtitle={`${basename(path)}${range}`} {...common(p)}>
      <PathLine path={path} />
      {p.result?.isError ? (
        <Pre text={p.result.content} max={4000} color={c.danger} />
      ) : (
        <ScrollView style={{ maxHeight: 288 }} nestedScrollEnabled contentContainerStyle={{ paddingVertical: 6 }}>
          {shown.map((l, i) => {
            const m = /^\s*(\d+)[\t→](.*)$/.exec(l)
            return (
              <View key={i} style={{ flexDirection: 'row', paddingHorizontal: 8 }}>
                <Text style={{ fontFamily: mono, fontSize: 12, color: c.faint, width: 36, textAlign: 'right', marginRight: 8 }}>{m ? m[1] : ''}</Text>
                <Text selectable style={{ fontFamily: mono, fontSize: 12, color: c.fg, flex: 1 }}>{m ? m[2] : l}</Text>
              </View>
            )
          })}
          {!all && lines.length > 500 && (
            <Pressable onPress={() => setAll(true)} hitSlop={ROW_HIT_SLOP} style={{ padding: 8 }}>
              <Text style={{ color: c.accent, fontSize: 12 }}>+ {lines.length - 500} more lines</Text>
            </Pressable>
          )}
        </ScrollView>
      )}
    </ToolCardChrome>
  )
}

function SimpleResultCard(p: ToolCardProps & { subtitle: string; max: number }) {
  return (
    <ToolCardChrome name={p.block.name ?? 'tool'} subtitle={p.subtitle} {...common(p)}>
      {p.result ? <Pre text={p.result.content} max={p.max} color={p.result.isError ? c.danger : c.fg} /> : <Pending />}
    </ToolCardChrome>
  )
}

function TodoWriteCard(p: ToolCardProps) {
  const todos = (Array.isArray(p.block.input?.todos) ? p.block.input.todos : []) as { content?: string; status?: string; activeForm?: string }[]
  return (
    <ToolCardChrome name="TodoWrite" subtitle={`${todos.length} item${todos.length === 1 ? '' : 's'}`} {...common(p)}>
      <View style={{ padding: 8, gap: 4 }}>
        {todos.map((t, i) => {
          const done = t.status === 'completed'
          const doing = t.status === 'in_progress'
          return (
            <View key={i} style={{ flexDirection: 'row', gap: 6 }}>
              <Text style={{ color: done ? c.success : doing ? c.warning : c.faint, fontSize: 12 }}>{done ? '☑' : doing ? '◐' : '☐'}</Text>
              <Text style={{ flex: 1, fontSize: 12, color: done ? c.dim : c.fg, textDecorationLine: done ? 'line-through' : 'none' }}>{t.content}</Text>
            </View>
          )
        })}
      </View>
    </ToolCardChrome>
  )
}

function GenericToolCard(p: ToolCardProps) {
  const disp = getToolDisplay(p.block.name)
  const args = extractArgs(p.block.input)
  const [raw, setRaw] = useState(false)
  return (
    <ToolCardChrome
      name={disp.label}
      brand={isNessControl(p.block.name)}
      subtitle={args.map((a) => `${a.key} ${a.value}`).join('  ')}
      {...common(p)}
    >
      {args.length > 0 && (
        <View style={{ padding: 8, gap: 4 }}>
          <Pressable onPress={() => setRaw(!raw)} hitSlop={ROW_HIT_SLOP} style={{ alignSelf: 'flex-end' }}>
            <Text style={{ color: c.dim, fontSize: 11 }}>{raw ? 'show parsed' : 'show raw'}</Text>
          </Pressable>
          {raw ? (
            <Pre text={JSON.stringify(p.block.input, null, 2)} />
          ) : (
            args.map((a) => (
              <View key={a.key} style={{ flexDirection: a.multiline ? 'column' : 'row', gap: 6 }}>
                <Text style={{ color: c.dim, fontSize: 12, fontFamily: mono }}>{a.key}</Text>
                <Text selectable style={{ color: c.fg, fontSize: 12, fontFamily: mono, flex: a.multiline ? undefined : 1 }}>{a.value}</Text>
              </View>
            ))
          )}
        </View>
      )}
      {p.result && p.result.content.trim() !== '' && <Pre text={p.result.content} max={3000} color={p.result.isError ? c.danger : c.fg} />}
    </ToolCardChrome>
  )
}

/** TaskCard: the sub-agent runner with its nested transcript. */
function TaskCard(p: ToolCardProps) {
  const d = useDensity()
  const desc = (str(p.block.input?.description) || str(p.block.input?.subagent_type) || 'Task').slice(0, 120)
  const launchStub = !!p.result && /^Async agent launched|agentId:/m.test(p.result.content) && !!p.backgroundAgent
  const bgRunning = p.backgroundAgent ? p.backgroundAgent.status === 'running' : false
  const inFlight = (!p.result || launchStub) && (bgRunning || !p.backgroundAgent)
  const pending = !!p.subAgentDescendantHasPendingApproval
  const [userChoice, setUserChoiceRaw] = usePersistedChoice(p.block.id ? `task:${p.block.id}` : undefined)
  const setUserChoice = (v: boolean | null | ((prev: boolean | null) => boolean | null)) => {
    setUserChoiceRaw(typeof v === 'function' ? v(userChoice) : v)
  }
  const prev = useRef({ inFlight, pending })
  useEffect(() => {
    // Rising edge of "in flight" / "pending approval" opens; falling edge
    // closes unless the user picked. A new approval overrides a manual close.
    if (pending && !prev.current.pending) setUserChoice(null)
    if (!inFlight && prev.current.inFlight && !pending) setUserChoice((v) => (v === null ? null : v))
    prev.current = { inFlight, pending }
  }, [inFlight, pending])
  const open = userChoice ?? (inFlight || pending)
  const count = p.subAgentChildCount ?? 0
  const usage = count > 0 ? `${count} entr${count === 1 ? 'y' : 'ies'}` : inFlight ? 'starting…' : 'no activity'
  return (
    <View>
      <ChatRow onPress={() => setUserChoice(!open)}>
        <Chevron open={open} />
        <Sparkles color={c.muted} size={12} />
        <Text style={{ fontSize: d.chrome, fontWeight: '500', fontFamily: d.toolFamily, color: p.result?.isError ? c.danger : c.fg }}>Task</Text>
        <Text style={{ flex: 1, fontSize: d.chrome, color: c.muted }} numberOfLines={1}>
          {desc}
        </Text>
        {p.block.input?.run_in_background && p.backgroundAgent ? <Meta>background</Meta> : null}
        <Text style={{ fontSize: d.meta, color: c.dim }}>{usage}</Text>
        {pending && <Meta color={c.warning}>needs approval</Meta>}
        {inFlight && (
          <Spin>
            <Loader2 color={c.muted} size={12} />
          </Spin>
        )}
        {p.result?.isError && <Meta color={c.danger}>error</Meta>}
      </ChatRow>
      {open && (
        <View style={{ marginLeft: 6, paddingLeft: 10, borderLeftWidth: 1, borderColor: c.border, gap: 6, marginBottom: 6 }}>
          {p.subAgentBody ?? (
            <Text style={{ color: c.dim, fontSize: 12, fontStyle: 'italic' }}>{inFlight ? 'sub-agent is starting…' : 'no sub-agent activity recorded'}</Text>
          )}
          {p.result && !launchStub && <Pre text={p.result.content} max={3000} color={p.result.isError ? c.danger : c.fg} />}
        </View>
      )}
    </View>
  )
}

function PathLine({ path }: { path: string }) {
  return (
    <Text selectable numberOfLines={1} style={{ fontFamily: mono, fontSize: 11, color: c.dim, paddingHorizontal: 8, paddingTop: 6 }}>
      {path}
    </Text>
  )
}

function Pending() {
  return <Text style={{ color: c.muted, fontSize: 12, padding: 8, fontStyle: 'italic' }}>waiting for result…</Text>
}

/** Unified diff, 3 lines of context, `…` between hunks, old/new gutters. */
export function Diff({ oldText, newText }: { oldText: string; newText: string }) {
  const hunks = useMemo(() => structuredPatch('a', 'b', oldText, newText, '', '', { context: 3 }).hunks, [oldText, newText])
  return (
    <ScrollView style={{ maxHeight: 360 }} nestedScrollEnabled contentContainerStyle={{ paddingVertical: 6 }}>
      {hunks.map((h, hi) => {
        let o = h.oldStart
        let n = h.newStart
        return (
          <View key={hi}>
            {hi > 0 && <Text style={{ color: c.faint, fontSize: 11, paddingHorizontal: 8 }}>…</Text>}
            {h.lines.map((line, li) => {
              const kind = line[0]
              const on = kind === '+' ? '' : String(o++)
              const nn = kind === '-' ? '' : String(n++)
              const bg = kind === '+' ? alpha(c.success, 0.12) : kind === '-' ? alpha(c.danger, 0.12) : 'transparent'
              return (
                <View key={li} style={{ flexDirection: 'row', backgroundColor: bg }}>
                  <Text style={{ fontFamily: mono, fontSize: 11, color: c.faint, width: 30, textAlign: 'right' }}>{on}</Text>
                  <Text style={{ fontFamily: mono, fontSize: 11, color: c.faint, width: 30, textAlign: 'right', marginRight: 6 }}>{nn}</Text>
                  <Text selectable style={{ fontFamily: mono, fontSize: 12, flex: 1, color: kind === '+' ? c.success : kind === '-' ? c.danger : c.fg }}>
                    {line.slice(1) || ' '}
                  </Text>
                </View>
              )
            })}
          </View>
        )
      })}
    </ScrollView>
  )
}

// ── grouping chrome (ToolGroup / TurnGroup) ─────────────────────────────

export interface GroupRow {
  key: string
  toolName?: string
  toolIntent?: string
  isThinking?: boolean
  hasError?: boolean
  hasPendingApproval?: boolean
  images?: JsonClaudeImageRef[]
  node: ReactNode
}

export function ToolGroup({ rows }: { rows: GroupRow[] }) {
  // Keyed by the first row, the same key the group itself renders under.
  const d = useDensity()
  const hasError = rows.some((r) => r.hasError)
  const hasPending = rows.some((r) => r.hasPendingApproval)
  const [userChoice, setUserChoice] = usePersistedChoice(`group:${rows[0]?.key}`)
  const expanded = userChoice ?? hasPending
  const toolRows = rows.filter((r) => !r.isThinking)
  const thinkingCount = rows.length - toolRows.length
  const displays = toolRows.map((r) => {
    const disp = getToolDisplay(r.toolName)
    return { icon: disp.icon as DesktopIcon, text: r.toolIntent ?? disp.compactLabel }
  })
  const thinkingLabel = thinkingCount > 0 ? `${thinkingCount} thought${thinkingCount === 1 ? '' : 's'}` : ''
  const countLabel = [thinkingLabel, ...summarizeTools(toolRows as never)].filter(Boolean).join(' · ')
  return (
    <View>
      <ChatRow onPress={() => setUserChoice(!expanded)}>
        <Chevron open={expanded} />
        {thinkingCount > 0 && <Brain color={c.muted} size={12} />}
        <Text style={{ fontSize: d.chrome, color: c.muted }}>{countLabel}</Text>
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, overflow: 'hidden', opacity: 0.7 }}>
          {displays.slice(0, 6).map((x, i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              {i > 0 && <Text style={{ color: c.muted, opacity: 0.4, fontSize: d.chrome }}>·</Text>}
              <ToolIcon icon={x.icon} />
              <Text style={{ fontSize: d.chrome, color: c.muted, maxWidth: 160 }} numberOfLines={1}>
                {x.text}
              </Text>
            </View>
          ))}
        </View>
        {hasPending && <Meta color={c.warning}>needs approval</Meta>}
        {hasError && <Meta color={c.danger}>error</Meta>}
      </ChatRow>
      {!expanded && rows.some((r) => r.images?.length) && (
        <ImageStrip images={rows.flatMap((r) => r.images ?? [])} height={56} />
      )}
      {expanded && (
        <View style={{ marginTop: 2, marginBottom: 4 }}>
          {rows.map((r) => (
            <View key={r.key}>{r.node}</View>
          ))}
        </View>
      )}
    </View>
  )
}

export function TurnGroup({ id, summary, hasError, images, children }: { id: string; summary: TurnSummary; hasError: boolean; images?: JsonClaudeImageRef[]; children: ReactNode }) {
  const d = useDensity()
  const [choice, setOpen] = usePersistedChoice(`turn:${id}`)
  const open = choice ?? false
  const parts = [
    summary.durationMs !== undefined ? `Worked for ${formatTurnDuration(summary.durationMs)}` : 'Worked',
    `${summary.toolCount} tool${summary.toolCount === 1 ? '' : 's'}`
  ]
  if (summary.editedFileCount > 0) parts.push(`${summary.editedFileCount} file${summary.editedFileCount === 1 ? '' : 's'} edited`)
  return (
    <View>
      <ChatRow onPress={() => setOpen(!open)}>
        <Chevron open={open} />
        <Text style={{ fontSize: d.chrome, color: c.muted }}>{parts.join(' · ')}</Text>
        {hasError && <Meta color={alpha(c.danger, 0.8)}>errors</Meta>}
      </ChatRow>
      {!open && images && images.length > 0 && <ImageStrip images={images} height={56} />}
      {open && <View style={{ marginTop: 2, marginBottom: 4, gap: 4 }}>{children}</View>}
    </View>
  )
}

// ── non-tool cards from JsonModeChat.tsx ────────────────────────────────

export function ThinkingCard({ id, text, isPartial }: { id?: string; text: string; isPartial: boolean }) {
  const d = useDensity()
  const [choice, setChoice] = usePersistedChoice(id ? `thinking:${id}` : undefined)
  const [auto, setAuto] = useState(isPartial)
  // Opens while streaming and closes when it finishes, unless the user
  // picked (their choice persists across virtualization).
  const open = choice ?? auto
  const setOpen = (v: boolean) => setChoice(v)
  const wasPartial = useRef(isPartial)
  useEffect(() => {
    if (wasPartial.current && !isPartial) setAuto(false)
    wasPartial.current = isPartial
  }, [isPartial])
  return (
    <View>
      <ChatRow onPress={() => setOpen(!open)}>
        <Chevron open={open} />
        <Brain color={c.muted} size={12} />
        <Text style={{ fontSize: d.chrome, color: c.muted }}>{isPartial ? 'Thinking' : 'Thought'}</Text>
        {isPartial && (
          <Spin>
            <Loader2 color={c.muted} size={12} />
          </Spin>
        )}
      </ChatRow>
      {open && (
        <View style={{ paddingLeft: 20, paddingBottom: 6 }}>
          {text ? <Markdown text={text} size={12} color={c.muted} italic /> : <Text style={{ color: c.dim, fontSize: 12, fontStyle: 'italic' }}>(hidden)</Text>}
        </View>
      )}
    </View>
  )
}

export function CompactCard({ trigger, pre, post }: { trigger?: string; pre?: number; post?: number }) {
  const d = useDensity()
  const k = (n: number) => `${Math.round(n / 1000)}k`
  const detail = pre && post ? `${k(pre)} → ${k(post)} tokens` : pre ? `${k(pre)} tokens summarized` : 'conversation summarized'
  return (
    <ChatRow>
      <ListChecks color={c.muted} size={12} />
      <Text style={{ fontSize: d.chrome, fontWeight: '500', color: c.fg, fontFamily: d.toolFamily }}>Compact</Text>
      <Text style={{ flex: 1, fontSize: d.chrome, color: c.muted }} numberOfLines={1}>
        {detail}
      </Text>
      {trigger && <Meta>{trigger === 'manual' ? 'via /compact' : 'auto'}</Meta>}
    </ChatRow>
  )
}

function DangerCard({ title, detail, children }: { title: string; detail?: string; children?: ReactNode }) {
  const d = useDensity()
  return (
    <View style={{ borderWidth: 1, borderColor: alpha(c.danger, 0.4), backgroundColor: alpha(c.danger, 0.05), borderRadius: d.bubbleRadius }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8 }}>
        <RotateCcw color={c.danger} size={12} />
        <Text style={{ color: c.danger, fontWeight: '700', fontFamily: mono, fontSize: d.chrome }}>{title}</Text>
        {detail ? (
          <Text style={{ color: c.muted, fontSize: d.chrome, flex: 1 }} numberOfLines={2}>
            {detail}
          </Text>
        ) : null}
      </View>
      {children ? <View style={{ paddingHorizontal: 12, paddingBottom: 10, gap: 8 }}>{children}</View> : null}
    </View>
  )
}

export function DangerButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        borderWidth: 1,
        borderColor: alpha(c.danger, 0.4),
        backgroundColor: alpha(c.danger, pressed ? 0.2 : 0.1),
        borderRadius: 4,
        paddingHorizontal: 12,
        minHeight: 36
      })}
      hitSlop={4}
    >
      <RotateCcw color={c.danger} size={12} />
      <Text style={{ color: c.danger, fontSize: 12 }}>{label}</Text>
    </Pressable>
  )
}

export function ExitCard({ message, isExited, onRestart }: { message: string; isExited: boolean; onRestart: () => void }) {
  return (
    <DangerCard title="Session ended" detail={message}>
      {isExited ? <DangerButton label="Restart session" onPress={onRestart} /> : <Text style={{ color: c.dim, fontSize: 12, fontStyle: 'italic' }}>session restarted</Text>}
    </DangerCard>
  )
}

export function AuthCard({ message, onSignIn, onRetry }: { message?: string; onSignIn: () => void; onRetry: () => void }) {
  return (
    <DangerCard title="Authentication failed" detail={message}>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <DangerButton label="Sign in" onPress={onSignIn} />
        <DangerButton label="Retry" onPress={onRetry} />
      </View>
    </DangerCard>
  )
}

export function SimpleDangerCard({ title, detail }: { title: string; detail?: string }) {
  return <DangerCard title={title} detail={detail} />
}

export function NoticeCard({ title, detail, color = c.warning }: { title: string; detail?: string; color?: string }) {
  const d = useDensity()
  return (
    <ChatRow>
      <Text style={{ fontSize: d.chrome, fontWeight: '500', color }}>{title}</Text>
      {detail ? (
        <Text style={{ flex: 1, fontSize: d.chrome, color: c.muted }} numberOfLines={2}>
          {detail}
        </Text>
      ) : null}
    </ChatRow>
  )
}

/** Right-aligned prompt bubble; also the queued variant. */
export function UserBubble({ text, queued, onCancel, images }: { text: string; queued?: boolean; onCancel?: () => void; images?: JsonClaudeImageRef[] }) {
  const d = useDensity()
  return (
    <View style={{ alignItems: 'flex-end' }}>
      <View
        style={{
          maxWidth: d.bubbleMax,
          backgroundColor: alpha(c.accent, queued ? 0.05 : 0.1),
          borderRadius: d.promptRadius,
          paddingLeft: 16,
          paddingRight: queued ? 6 : 16,
          paddingVertical: 10,
          opacity: queued ? 0.7 : 1,
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: 8
        }}
      >
        <View style={{ flexShrink: 1 }}>
          <Markdown text={text} size={d.body} preserveNewlines />
          {images && images.length > 0 && (
            <View style={{ marginTop: 8 }}>
              <ImageStrip images={images} height={72} />
            </View>
          )}
        </View>
        {queued && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
            <View style={{ borderWidth: 1, borderColor: c.border, backgroundColor: alpha(c.panel, 0.6), borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}>
              <Meta>queued</Meta>
            </View>
            <Pressable onPress={onCancel} hitSlop={12} accessibilityLabel="Cancel queued message" style={{ padding: 6 }}>
              <X color={c.muted} size={12} />
            </Pressable>
          </View>
        )}
      </View>
    </View>
  )
}

export function AutomatedTurnCard({
  source,
  from,
  text,
  queued,
  onCancel
}: {
  source: Parameters<typeof automationLabel>[0]
  from?: string
  text: string
  queued: boolean
  onCancel: () => void
}) {
  const d = useDensity()
  const { label, note, brand, collapsed } = automationLabel(source, from)
  const [open, setOpen] = useState(!collapsed)
  return (
    <View style={{ backgroundColor: c.panel, borderRadius: d.promptRadius, paddingHorizontal: 16, paddingVertical: 10, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {brand ? <ToolIcon icon={NessIcon as DesktopIcon} className="icon-sm" /> : <Bot color={c.warning} size={12} />}
        <Text style={{ fontSize: d.chrome, fontWeight: '600', color: brand ? c.brand : c.warning, fontFamily: d.toolFamily }}>{label}</Text>
        <Text style={{ flex: 1, fontSize: d.chrome, color: c.muted }} numberOfLines={1}>
          {note}
        </Text>
        {collapsed && (
          <Pressable onPress={() => setOpen(!open)} hitSlop={12}>
            <Text style={{ fontSize: d.chrome, color: c.muted }}>{open ? 'Hide prompt' : 'Show prompt'}</Text>
          </Pressable>
        )}
        {queued && (
          <Pressable onPress={onCancel} hitSlop={12} accessibilityLabel="Cancel queued message">
            <X color={c.muted} size={12} />
          </Pressable>
        )}
      </View>
      {open && <Markdown text={text} size={d.body} preserveNewlines />}
    </View>
  )
}

export function HeldNoticesCard({ notices }: { notices: { source: Parameters<typeof automationLabel>[0]; from?: string; body: string }[] }) {
  const d = useDensity()
  const [open, setOpen] = useState(false)
  return (
    <View style={{ alignItems: 'flex-end' }}>
      <View style={{ maxWidth: d.bubbleMax, backgroundColor: c.panel, borderRadius: d.promptRadius }}>
        <Pressable onPress={() => setOpen(!open)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 10 }}>
          <Chevron open={open} />
          <ToolIcon icon={NessIcon as DesktopIcon} className="icon-sm" />
          <Text style={{ fontSize: d.chrome, fontWeight: '600', color: c.brand }}>
            {notices.length === 1 ? '1 held notification' : `${notices.length} held notifications`}
          </Text>
          <Text style={{ fontSize: d.chrome, color: c.muted, flexShrink: 1 }} numberOfLines={1}>
            delivered with this turn
          </Text>
        </Pressable>
        {open && (
          <View style={{ paddingHorizontal: 16, paddingBottom: 10, gap: 12 }}>
            {notices.map((n, i) => (
              <View key={i}>
                <Text style={{ fontSize: d.meta, color: c.muted, marginBottom: 4 }}>{automationLabel(n.source, n.from).label}</Text>
                <Markdown text={n.body} size={d.body} preserveNewlines />
              </View>
            ))}
          </View>
        )}
      </View>
    </View>
  )
}
