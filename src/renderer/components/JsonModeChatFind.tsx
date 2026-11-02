import {
  createContext,
  Fragment,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from 'react'
import { Search, X } from 'lucide-react'
import { getToolIntent } from './json-mode-cards/tool-display'
import type {
  JsonClaudeChatEntry,
  JsonClaudeMessageBlock
} from '../../shared/state/json-claude'

// -----------------------------------------------------------------------------
// Cmd+F find for the JsonModeChat surface.
//
// Design notes:
//  - The match corpus is derived from `entries[]`, not the DOM. That means
//    the counter is accurate even for content inside collapsed tool cards
//    (which aren't rendered at all — see ToolCardChrome:145 where children
//    are gated behind `expanded`).
//  - Cycling to a match whose containing block is collapsed adds that
//    block's id to a `forceOpenIds` Set carried via FindContext.
//    ToolCardChrome (and the couple of card components inside
//    JsonModeChat.tsx) treats `expanded || forceOpen` as "render children".
//  - Scroll targeting uses [data-find-block-id="..."] querySelector rather
//    than a ref map — one lookup on cycle, no prop-drilling.
// -----------------------------------------------------------------------------

/** Static body copy for the Compact card. Exported so both the renderer
 *  and the corpus reference the exact same string — searching the "Earlier
 *  conversation history was summarized…" text has to hit somewhere. If
 *  the card's copy ever changes, update this constant in the same commit
 *  or corpus/DOM alignment breaks silently. */
export const COMPACT_BODY_TEXT =
  'Earlier conversation history was summarized to free up context. New messages continue from the summary.'

export interface FindHit {
  entryId: string
  /** Stable id of the collapsible container this hit lives inside, if any.
   *  Used to force-open collapsed cards on cycle. Undefined for top-level
   *  content (user messages, assistant text blocks) that's never collapsed. */
  blockId?: string
  /** Which searchable segment (per entry) this hit came from — index into
   *  the segments array returned by getEntrySegments(). Kept so we can
   *  tell hits inside the same block apart (e.g. multiple matches in one
   *  tool_result). */
  segmentIndex: number
  /** Char offset within the segment. Retained for future inline
   *  highlighting (Phase 2); Phase 1 only uses hit position for cycle
   *  ordering. */
  offset: number
}

export interface FindSegment {
  /** Stable id of the collapsible container this segment lives inside.
   *  Undefined = not inside a collapsible; hit is always visible. */
  blockId?: string
  text: string
}

interface FindContextValue {
  /** Currently-active query. Empty string = find is idle. */
  query: string
  /** The blockId of the current hit, if any. Cards match this to render
   *  their "current hit" ring. */
  currentHitBlockId: string | undefined
  /** Set of block ids that should render as if expanded regardless of
   *  local state. Grown as the user cycles through collapsed matches. */
  forceOpenIds: ReadonlySet<string>
}

const FindContext = createContext<FindContextValue>({
  query: '',
  currentHitBlockId: undefined,
  forceOpenIds: new Set()
})

export function useFind(): FindContextValue {
  return useContext(FindContext)
}

// -----------------------------------------------------------------------------
// Corpus extraction.
// -----------------------------------------------------------------------------

/**
 * Synthesize a stable id for a collapsible container from the entry + block
 * position. Tool_use blocks have their own `id` (from Anthropic); for
 * thinking/compact/entry-level containers we mint one so the forceOpen
 * context can address them.
 */
export function blockContainerId(
  entry: JsonClaudeChatEntry,
  block: JsonClaudeMessageBlock | undefined,
  blockIndex: number,
  kindSuffix: string
): string {
  if (block?.id) return block.id
  return `${entry.entryId}:${kindSuffix}:${blockIndex}`
}

/**
 * Extract the searchable segments for a single entry.
 *
 * Every entry contributes zero or more `FindSegment`s. Each segment carries
 * the plain text to match against + the blockId of the collapsible
 * container it lives inside (undefined for content that's never collapsed).
 *
 * ------------------------------------------------------------------
 * USER CONTRIBUTION POINT — tool_use segmentation.
 * ------------------------------------------------------------------
 * The tool_use branch below currently searches the JSON-stringified
 * `input` object. That's a broad default: every key AND value ends up
 * matchable, so searching for "src/main" finds a Read whose path arg
 * contains "src/main" but ALSO finds any tool where the substring
 * "src/main" happens to appear in the JSON keys of unrelated fields.
 *
 * Alternatives to consider:
 *  (a) Values only — JSON.stringify only the leaf values, not keys.
 *      Cleaner matches, but hides tool-name info.
 *  (b) Concat all string leaves with newlines instead of stringifying.
 *      Loses JSON structure noise ({}, quotes) so matches look nicer
 *      if we ever inline-highlight, and drops key-name false positives.
 *  (c) Per-tool logic — Bash searches only .command, Read only .file_path,
 *      etc. Best match quality but a big switch statement to maintain.
 *
 * Tune segmentToolUse() below to pick your approach. Keep it small
 * (5-10 lines). Also decide: should tool NAME be searchable? Right now
 * we include it as its own segment so "Bash" surfaces every Bash call.
 */
export function getEntrySegments(entry: JsonClaudeChatEntry): FindSegment[] {
  const out: FindSegment[] = []

  // Top-level entry.text (user messages that aren't in blocks; some
  // system/error cards).
  if (entry.text) out.push({ text: entry.text })
  if (entry.errorMessage) out.push({ text: entry.errorMessage })

  // Compact card body — static string, but the card is collapsible so
  // the segment carries a blockId so cycling force-opens it.
  if (entry.kind === 'compact') {
    out.push({
      blockId: `${entry.entryId}:compact`,
      text: COMPACT_BODY_TEXT
    })
  }

  const blocks = entry.blocks ?? []
  blocks.forEach((block, i) => {
    switch (block.type) {
      case 'text':
        // Assistant/user text blocks — never collapsed, always visible.
        // Strip markdown so counter matches what rehype will mark in DOM.
        if (block.text) out.push({ text: stripMarkdown(block.text) })
        break
      case 'thinking': {
        const bid = blockContainerId(entry, block, i, 'thinking')
        if (block.text)
          out.push({ blockId: bid, text: stripMarkdown(block.text) })
        break
      }
      case 'tool_use': {
        const bid = blockContainerId(entry, block, i, 'tool_use')
        // Tool name is always visible in the collapsed header, so it's
        // in the top-level (never-collapsed) group not the block group.
        if (block.name) out.push({ text: block.name })
        for (const seg of getToolUseSegments(block, bid)) out.push(seg)
        break
      }
      case 'tool_result': {
        const bid = blockContainerId(entry, block, i, 'tool_result')
        if (block.content) out.push({ blockId: bid, text: block.content })
        break
      }
    }
  })

  return out
}

/**
 * Per-tool corpus segmentation. Each entry here must match — in ORDER
 * and CONTENT — what the corresponding tool card renders through
 * <HighlightedText>. Because the current-hit tracking is DOM-order-
 * based (see scrollToCurrent), corpus-vs-render misalignment silently
 * breaks cycling by pointing at the wrong <mark>.
 *
 * The default branch emits pretty-printed JSON to match GenericToolCard's
 * `<pre>{JSON.stringify(input, null, 2)}</pre>` render.
 *
 * Extending this for a new tool:
 *  1. Add a case here emitting one FindSegment per user-visible field.
 *  2. In the tool's card, wrap each field's render in <HighlightedText
 *     text={...} /> in the same order.
 *
 * Skipped for Phase 2b:
 *  - Edit/MultiEdit old_string/new_string (rendered through UnifiedDiff
 *    which does its own syntax highlighting).
 *  - ReadCard's file-content view (dangerouslySetInnerHTML from
 *    highlight.js — mark injection is doable but non-trivial).
 */
function getToolUseSegments(
  block: JsonClaudeMessageBlock,
  blockId: string
): FindSegment[] {
  const input = block.input ?? {}
  const seg = (text: string | undefined | null): FindSegment | null =>
    text ? { blockId, text: String(text) } : null
  const collect = (
    ...items: Array<FindSegment | null>
  ): FindSegment[] => items.filter((s): s is FindSegment => s !== null)

  switch (block.name) {
    case 'Bash':
      return collect(
        seg(getToolIntent(block)),
        seg(input.command as string | undefined)
      )
    case 'Read':
      return collect(seg(input.file_path as string | undefined))
    case 'Write': {
      // WriteCard truncates content at 4000 chars for display; keep the
      // corpus capped to match so DOM mark count stays aligned.
      const content = input.content as string | undefined
      const capped = content ? content.slice(0, 4000) : undefined
      return collect(seg(input.file_path as string | undefined), seg(capped))
    }
    case 'Edit':
      // NOTE: corpus counts old_string/new_string as raw text, but the
      // UnifiedDiff render reformats them into a diff view where context
      // lines can repeat content. Counter and DOM mark count may drift;
      // cycling falls back to the block-ring when hitIndex exceeds DOM
      // mark count.
      return collect(
        seg(input.file_path as string | undefined),
        seg(input.old_string as string | undefined),
        seg(input.new_string as string | undefined)
      )
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits)
        ? (input.edits as Array<Record<string, unknown>>)
        : []
      const editSegs: Array<FindSegment | null> = []
      for (const e of edits) {
        editSegs.push(seg(e.old_string as string | undefined))
        editSegs.push(seg(e.new_string as string | undefined))
      }
      return collect(seg(input.file_path as string | undefined), ...editSegs)
    }
    case 'Grep':
      return collect(
        seg(input.pattern as string | undefined),
        seg(input.path as string | undefined)
      )
    case 'Glob':
      return collect(seg(input.pattern as string | undefined))
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? input.todos : []
      return todos
        .map((t: unknown): FindSegment | null => {
          const content =
            typeof t === 'object' && t !== null && 'content' in t
              ? (t as { content?: unknown }).content
              : undefined
          return typeof content === 'string' && content
            ? { blockId, text: content }
            : null
        })
        .filter((s): s is FindSegment => s !== null)
    }
    default: {
      // Matches GenericToolCard's <pre>{JSON.stringify(input, null, 2)}</pre>
      try {
        return collect({ blockId, text: JSON.stringify(input, null, 2) })
      } catch {
        return []
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Match computation.
// -----------------------------------------------------------------------------

function findAll(haystack: string, needle: string): number[] {
  if (!needle) return []
  const out: number[] = []
  let from = 0
  while (from <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, from)
    if (idx < 0) break
    out.push(idx)
    from = idx + Math.max(1, needle.length)
  }
  return out
}

function computeHits(
  entries: JsonClaudeChatEntry[],
  query: string
): FindHit[] {
  if (!query) return []
  const out: FindHit[] = []
  for (const entry of entries) {
    const segments = getEntrySegments(entry)
    segments.forEach((seg, segIdx) => {
      for (const off of findAll(seg.text, query)) {
        out.push({
          entryId: entry.entryId,
          blockId: seg.blockId,
          segmentIndex: segIdx,
          offset: off
        })
      }
    })
  }
  return out
}

// -----------------------------------------------------------------------------
// Controller hook — owns query state, hit list, current index, force-open set.
// -----------------------------------------------------------------------------

export interface FindController {
  isOpen: boolean
  open(): void
  close(): void
  query: string
  setQuery(q: string): void
  hitCount: number
  hitIndex: number
  next(): void
  prev(): void
  contextValue: FindContextValue
}

/**
 * Instantiate one find controller per JsonModeChat instance.
 *
 * @param entries  live chat entries (from the store)
 * @param scrollRef  the chat scroll container — used to scroll matches
 *                    into view after cycling
 */
export function useFindController(
  entries: JsonClaudeChatEntry[],
  scrollRef: RefObject<HTMLElement | null>
): FindController {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hitIndex, setHitIndex] = useState(0)
  const forceOpenIdsRef = useRef<Set<string>>(new Set())
  // Bump this on force-open mutations so the memoized contextValue changes
  // reference and downstream consumers re-render.
  const [forceOpenTick, setForceOpenTick] = useState(0)

  const hits = useMemo(() => computeHits(entries, query), [entries, query])

  // Clamp the index when the hit list shrinks (query change, entries change).
  useEffect(() => {
    if (hitIndex >= hits.length) setHitIndex(hits.length === 0 ? 0 : 0)
  }, [hits.length, hitIndex])

  const currentHit: FindHit | undefined = hits[hitIndex]

  const scrollToCurrent = useCallback(() => {
    if (!currentHit) return
    // Force-open the container if it's a collapsible.
    if (currentHit.blockId) {
      const set = forceOpenIdsRef.current
      if (!set.has(currentHit.blockId)) {
        set.add(currentHit.blockId)
        setForceOpenTick((v) => v + 1)
      }
    }
    // Defer to next frame so the newly-expanded block has been rendered.
    // Two frames on force-open to give React time to mount the children
    // AND commit the layout — one frame sometimes lands before the new
    // <mark> elements exist.
    const runCurrentHitPass = (): void => {
      const scroll = scrollRef.current
      if (!scroll) return
      // Clear stale current class from any previous cycle.
      scroll
        .querySelectorAll<HTMLElement>('mark.find-hit-current')
        .forEach((el) => el.classList.remove('find-hit-current'))
      // Locate the mark at hitIndex among all rendered matches. Corpus
      // and render enumerate segments in the same order, so index maps
      // 1:1 for plain-text spots. Markdown-rendered content will diverge
      // once Phase 2b lands.
      const marks = scroll.querySelectorAll<HTMLElement>('mark.find-hit')
      const target = marks[hitIndex]
      if (target) {
        target.classList.add('find-hit-current')
        target.scrollIntoView({ block: 'center', behavior: 'smooth' })
        return
      }
      // Fall back to block-level scroll if we couldn't find a rendered
      // mark (e.g. corpus counted a segment that isn't wired up with
      // HighlightedText yet).
      const selector = currentHit.blockId
        ? `[data-find-block-id="${cssEscape(currentHit.blockId)}"]`
        : `[data-find-entry-id="${cssEscape(currentHit.entryId)}"]`
      const el = scroll.querySelector<HTMLElement>(selector)
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(runCurrentHitPass)
    })
  }, [currentHit, hitIndex, scrollRef])

  const open = useCallback(() => {
    setIsOpen(true)
  }, [])

  const close = useCallback(() => {
    setIsOpen(false)
    setQuery('')
    setHitIndex(0)
    forceOpenIdsRef.current = new Set()
    setForceOpenTick((v) => v + 1)
  }, [])

  const next = useCallback(() => {
    if (hits.length === 0) return
    setHitIndex((i) => (i + 1) % hits.length)
  }, [hits.length])

  const prev = useCallback(() => {
    if (hits.length === 0) return
    setHitIndex((i) => (i - 1 + hits.length) % hits.length)
  }, [hits.length])

  // Whenever hitIndex changes and we have a current hit, scroll.
  useEffect(() => {
    scrollToCurrent()
  }, [hitIndex, scrollToCurrent])

  // Also scroll when the query changes (first hit auto-focuses).
  useEffect(() => {
    if (hits.length > 0) scrollToCurrent()
  }, [query, hits.length, scrollToCurrent])

  const contextValue = useMemo<FindContextValue>(() => {
    return {
      query,
      currentHitBlockId: currentHit?.blockId,
      forceOpenIds: forceOpenIdsRef.current
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, currentHit?.blockId, forceOpenTick])

  return {
    isOpen,
    open,
    close,
    query,
    setQuery: (q) => {
      setQuery(q)
      setHitIndex(0)
    },
    hitCount: hits.length,
    hitIndex: hits.length === 0 ? 0 : hitIndex,
    next,
    prev,
    contextValue
  }
}

function cssEscape(s: string): string {
  // Minimal CSS.escape polyfill sufficient for our synthesized ids
  // (contain ':' and other punctuation).
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(s)
  }
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`)
}

// -----------------------------------------------------------------------------
// Overlay UI.
// -----------------------------------------------------------------------------

/** Pure presentational find bar. Both JsonModeChat and XTerminal use it
 *  so Cmd+F looks identical regardless of tab type. Positioning is the
 *  caller's responsibility — wrap this in an absolute-positioned parent.
 *  State is the caller's too — each backend (React-state model for chat,
 *  SearchAddon callbacks for terminal) drives the props. */
export interface FindBarProps {
  query: string
  hitIndex: number
  hitCount: number
  placeholder?: string
  inputRef: RefObject<HTMLInputElement | null>
  onQueryChange: (q: string) => void
  onNext: () => void
  onPrev: () => void
  onClose: () => void
}

export function FindBar({
  query,
  hitIndex,
  hitCount,
  placeholder = 'Find',
  inputRef,
  onQueryChange,
  onNext,
  onPrev,
  onClose
}: FindBarProps): JSX.Element {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) onPrev()
      else onNext()
    }
  }

  const counter =
    query.length > 0 ? (hitCount > 0 ? `${hitIndex + 1}/${hitCount}` : '0/0') : ''
  const hasMatches = query.length > 0 && hitCount > 0
  const zeroMatches = query.length > 0 && hitCount === 0

  return (
    <div
      className={`flex items-center gap-2 pl-2.5 pr-1.5 py-1.5 rounded-lg bg-panel-raised border-2 shadow-2xl ring-1 ring-black/40 backdrop-blur-sm ${
        zeroMatches ? 'border-danger/70' : 'border-accent/60'
      }`}
    >
      <Search
        className={`icon-sm shrink-0 ${zeroMatches ? 'text-danger' : 'text-accent'}`}
      />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className="bg-transparent text-sm text-fg-bright outline-none placeholder:text-muted w-56 font-medium"
      />
      <span
        className={`text-xs tabular-nums min-w-[3.5rem] text-right shrink-0 ${
          hasMatches ? 'text-fg-bright' : 'text-muted'
        }`}
      >
        {counter}
      </span>
      <button
        type="button"
        onClick={onClose}
        className="p-1 rounded text-muted hover:text-fg-bright hover:bg-border cursor-pointer transition-colors"
        aria-label="Close find"
        title="Close (Esc)"
      >
        <X className="icon-sm" />
      </button>
    </div>
  )
}

interface FindOverlayProps {
  controller: FindController
  inputRef: RefObject<HTMLInputElement | null>
}

/** Thin adapter that pulls FindBar props out of a FindController. Used
 *  by JsonModeChat; XTerminal builds its own props from the xterm
 *  SearchAddon state and uses FindBar directly. */
export function FindOverlay({
  controller,
  inputRef
}: FindOverlayProps): JSX.Element | null {
  if (!controller.isOpen) return null
  return (
    <FindBar
      query={controller.query}
      hitIndex={controller.hitIndex}
      hitCount={controller.hitCount}
      placeholder="Find in chat"
      inputRef={inputRef}
      onQueryChange={controller.setQuery}
      onNext={controller.next}
      onPrev={controller.prev}
      onClose={controller.close}
    />
  )
}

// -----------------------------------------------------------------------------
// Inline match highlighting.
// -----------------------------------------------------------------------------

/**
 * Wrap `text` in `<mark class="find-hit">` spans around every occurrence
 * of the current find query. Case-sensitive to match the controller.
 * When the query is empty this is a bare passthrough — cheap enough to
 * scatter across the tool cards without conditional wrappers at the
 * call site.
 *
 * The "current match" (orange) class is applied imperatively by the
 * controller on cycle (see scrollToCurrent) rather than statically here
 * — avoids threading per-mark identity through props while still giving
 * Chrome-style two-color feedback.
 *
 * Supports an optional `as` override so callers can render into `<pre>`
 * or `<code>` contexts without extra span wrappers breaking layout.
 * Default `<>` (Fragment) means matches sit inline in the parent's text
 * flow.
 */
export function HighlightedText({
  text,
  as = 'span'
}: {
  text: string
  as?: keyof JSX.IntrinsicElements | 'fragment'
}): JSX.Element {
  const { query } = useFind()
  if (!query || !text) {
    return as === 'fragment'
      ? createElement(Fragment, null, text)
      : createElement(as, null, text)
  }
  const parts: ReactNode[] = []
  let cursor = 0
  let markKey = 0
  while (cursor <= text.length - query.length) {
    const idx = text.indexOf(query, cursor)
    if (idx < 0) break
    if (idx > cursor) parts.push(text.slice(cursor, idx))
    parts.push(
      createElement(
        'mark',
        { key: `m${markKey++}`, className: 'find-hit' },
        text.slice(idx, idx + query.length)
      )
    )
    cursor = idx + Math.max(1, query.length)
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return as === 'fragment'
    ? createElement(Fragment, null, ...parts)
    : createElement(as, null, ...parts)
}

// -----------------------------------------------------------------------------
// Markdown handling — rehype plugin for inline mark injection + a matching
// source-strip so the corpus counts what the user sees, not raw source.
// -----------------------------------------------------------------------------

/**
 * Strip common markdown syntax so the corpus counts against text the
 * user actually sees after ReactMarkdown renders it. Approximate: covers
 * bold/italic/inline-code/fences/headings/links/images/list markers/
 * blockquotes. Edge cases (nested formatting, escapes, HTML, tables)
 * leak through and cause corpus/DOM counter drift, but the common-case
 * prose search stays aligned.
 */
export function stripMarkdown(md: string): string {
  return md
    // Fenced code blocks — keep body, drop the fence + language.
    .replace(/```[^\n`]*\n([\s\S]*?)```/g, '$1')
    // Inline code.
    .replace(/`([^`]+)`/g, '$1')
    // Images → alt text.
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    // Links → visible text.
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Bold / italic / strikethrough.
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    // Leading heading / blockquote / list markers on each line.
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
}

interface HastNode {
  type: string
  value?: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

/**
 * Rehype plugin factory. Walks the HAST tree and splits every text node
 * on occurrences of `query`, wrapping each match in a `<mark
 * class="find-hit">` element. No-op when query is empty.
 *
 * Note: `<code>` and `<pre>` children are highlighted normally — nesting
 * `<mark>` inside rehype-highlight's spans works because both use inline
 * elements and CSS doesn't care about the intermediate wrappers.
 */
export function createFindRehypePlugin(query: string) {
  return function findPlugin() {
    return (tree: HastNode): void => {
      if (!query) return
      walk(tree)
      function walk(node: HastNode): void {
        if (!node.children || node.children.length === 0) return
        const next: HastNode[] = []
        for (const child of node.children) {
          if (child.type === 'text' && typeof child.value === 'string') {
            const parts = splitTextNode(child.value, query)
            next.push(...parts)
          } else {
            walk(child)
            next.push(child)
          }
        }
        node.children = next
      }
    }
  }
}

function splitTextNode(text: string, query: string): HastNode[] {
  const out: HastNode[] = []
  let cursor = 0
  while (cursor <= text.length - query.length) {
    const idx = text.indexOf(query, cursor)
    if (idx < 0) break
    if (idx > cursor) out.push({ type: 'text', value: text.slice(cursor, idx) })
    out.push({
      type: 'element',
      tagName: 'mark',
      properties: { className: ['find-hit'] },
      children: [{ type: 'text', value: query }]
    })
    cursor = idx + Math.max(1, query.length)
  }
  if (out.length === 0) return [{ type: 'text', value: text }]
  if (cursor < text.length) out.push({ type: 'text', value: text.slice(cursor) })
  return out
}

// -----------------------------------------------------------------------------
// Provider export so JsonModeChat can wrap its rendered messages.
// -----------------------------------------------------------------------------

export { FindContext }
