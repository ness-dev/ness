import { useEffect, useRef, useState } from 'react'
import * as monaco from 'monaco-editor'
import { detectMonacoLanguage } from '../monaco-setup'
import { assignTurnColors, hunkAtLine, type LochHunk, type LochSessionInfo } from '../../shared/loch'
import { LochBlameCard } from './LochBlameCard'

export interface MonacoBlame {
  hunks: LochHunk[]
  sessions?: Record<string, LochSessionInfo>
}

interface MonacoEditorProps {
  value: string
  filePath?: string
  readOnly?: boolean
  fontFamily?: string
  fontSize?: number
  wordWrap?: boolean
  onChange?: (value: string) => void
  onSave?: () => void
  onReferenceLine?: (lineNumber: number) => void
  /** loch conversation blame, drawn as bars in the line-decorations lane. */
  blame?: MonacoBlame | null
  /** Open a chat on the conversation that wrote this line. */
  onAskLine?: (lineNumber: number, opts: { atTurn: boolean }) => void
}

interface BlameHover {
  hunk: LochHunk
  top: number
  left: number
  /** Near the bottom of the editor the card opens upward instead. */
  above: boolean
  /** The line the card was opened from — what an Ask from the card targets. */
  line: number
  /** Opened by a click: stays put, takes pointer input, and offers Ask.
   *  A plain hover card is pointer-transparent and vanishes on mouse-out. */
  pinned: boolean
}

export function MonacoEditor({
  value,
  filePath,
  readOnly = false,
  fontFamily,
  fontSize,
  wordWrap = false,
  onChange,
  onSave,
  onReferenceLine,
  blame,
  onAskLine
}: MonacoEditorProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const onRefRef = useRef(onReferenceLine)
  const onAskRef = useRef(onAskLine)
  onChangeRef.current = onChange
  onSaveRef.current = onSave
  onRefRef.current = onReferenceLine
  onAskRef.current = onAskLine
  const blameRef = useRef<MonacoBlame | null>(blame ?? null)
  blameRef.current = blame ?? null
  const blameCollectionRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const attributedKeyRef = useRef<monaco.editor.IContextKey<boolean> | null>(null)
  const [blameHover, setBlameHover] = useState<BlameHover | null>(null)
  const hoverHunkRef = useRef<LochHunk | null>(null)
  const pinnedRef = useRef(false)
  const hideBlameHoverRef = useRef<() => void>(() => {})
  const cardRef = useRef<HTMLDivElement | null>(null)

  // Construct the editor once and tear it down on unmount. Subsequent
  // prop updates are pushed imperatively so we don't recreate the model
  // (and lose undo history) on every render.
  useEffect(() => {
    if (!hostRef.current) return
    const editor = monaco.editor.create(hostRef.current, {
      value,
      language: detectMonacoLanguage(filePath),
      readOnly,
      theme: 'harness',
      fontFamily: fontFamily || undefined,
      fontSize: fontSize || 13,
      wordWrap: wordWrap ? 'on' : 'off',
      automaticLayout: true,
      glyphMargin: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      tabSize: 2,
      fixedOverflowWidgets: true,
      scrollbar: {
        verticalScrollbarSize: 10,
        horizontalScrollbarSize: 10,
        useShadows: false
      }
    })
    editorRef.current = editor

    const changeSub = editor.onDidChangeModelContent(() => {
      onChangeRef.current?.(editor.getValue())
    })

    // Cmd-S / Ctrl-S → onSave. Using addCommand lets Monaco own the
    // keybinding scope so it doesn't fire while focus is elsewhere.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSaveRef.current?.()
    })

    // Hover-tracked glyph-margin button for "reference line in Claude".
    const glyphCollection = editor.createDecorationsCollection()
    const setHoverLine = (lineNumber: number | null): void => {
      if (!onRefRef.current || lineNumber == null) {
        glyphCollection.clear()
        return
      }
      glyphCollection.set([
        {
          range: new monaco.Range(lineNumber, 1, lineNumber, 1),
          options: {
            glyphMarginClassName: 'ref-line-glyph',
            glyphMarginHoverMessage: { value: 'Reference this line in Claude' }
          }
        }
      ])
    }
    const moveSub = editor.onMouseMove((e) => {
      if (!onRefRef.current) return
      const ln = e.target.position?.lineNumber ?? null
      setHoverLine(ln)
    })
    const leaveSub = editor.onMouseLeave(() => setHoverLine(null))
    const downSub = editor.onMouseDown((e) => {
      if (!onRefRef.current) return
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return
      const ln = e.target.position?.lineNumber
      if (ln != null) onRefRef.current(ln)
    })

    // loch blame: its own collection in the line-decorations lane, so it
    // never fights the glyph-margin reference button above for a slot.
    blameCollectionRef.current = editor.createDecorationsCollection()
    const attributedAt = (ln: number | undefined | null): LochHunk | null => {
      const b = blameRef.current
      if (!b || ln == null) return null
      const h = hunkAtLine(b.hunks, ln)
      return h?.conversation ? h : null
    }
    const hideBlameHover = (opts?: { evenPinned?: boolean }): void => {
      if (hoverHunkRef.current === null) return
      if (pinnedRef.current && !opts?.evenPinned) return
      hoverHunkRef.current = null
      pinnedRef.current = false
      setBlameHover(null)
    }
    hideBlameHoverRef.current = () => hideBlameHover({ evenPinned: true })
    const showBlameCard = (hunk: LochHunk, ln: number, pinned: boolean): void => {
      hoverHunkRef.current = hunk
      pinnedRef.current = pinned
      const layout = editor.getLayoutInfo()
      const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight)
      const lineTop = editor.getTopForLineNumber(ln) - editor.getScrollTop()
      const above = lineTop > layout.height - 420
      setBlameHover({
        hunk,
        top: above ? lineTop : lineTop + lineHeight,
        left: layout.decorationsLeft + layout.decorationsWidth + 4,
        above,
        line: ln,
        pinned
      })
    }
    const blameMoveSub = editor.onMouseMove((e) => {
      if (pinnedRef.current) return
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) {
        hideBlameHover()
        return
      }
      const ln = e.target.position?.lineNumber
      const hunk = attributedAt(ln)
      if (!hunk || ln == null) {
        hideBlameHover()
        return
      }
      if (hoverHunkRef.current === hunk) return
      showBlameCard(hunk, ln, false)
    })
    const blameLeaveSub = editor.onMouseLeave(() => hideBlameHover())
    const blameScrollSub = editor.onDidScrollChange(() => hideBlameHover({ evenPinned: true }))
    // A click on a bar only pins its card. Forking writes a transcript and
    // spends a turn, so it waits for the card's explicit Ask button (or the
    // context-menu action) rather than riding on a gutter click.
    const blameDownSub = editor.onMouseDown((e) => {
      const onBar = e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS
      const ln = e.target.position?.lineNumber
      const hunk = onBar ? attributedAt(ln) : null
      if (!hunk || ln == null || !e.event.leftButton) {
        hideBlameHover({ evenPinned: true })
        return
      }
      if (pinnedRef.current && hoverHunkRef.current === hunk) {
        hideBlameHover({ evenPinned: true })
        return
      }
      showBlameCard(hunk, ln, true)
    })
    const blameKeySub = editor.onKeyDown((e) => {
      if (e.keyCode === monaco.KeyCode.Escape && pinnedRef.current) {
        hideBlameHover({ evenPinned: true })
        e.preventDefault()
        e.stopPropagation()
      }
    })

    // Context-menu actions act on the cursor line (a right-click moves the
    // cursor there first). The context key greys them out on lines no
    // conversation wrote.
    attributedKeyRef.current = editor.createContextKey<boolean>('lochLineAttributed', false)
    const syncAttributedKey = (): void => {
      const ln = editor.getPosition()?.lineNumber
      const h = attributedAt(ln)
      attributedKeyRef.current?.set(!!h?.conversation?.available && !!onAskRef.current)
    }
    const cursorSub = editor.onDidChangeCursorPosition(syncAttributedKey)
    const askAction = editor.addAction({
      id: 'loch.askConversation',
      label: 'Ask the conversation that wrote this',
      contextMenuGroupId: '0_loch',
      contextMenuOrder: 1,
      precondition: 'lochLineAttributed',
      run: (ed) => {
        const ln = ed.getPosition()?.lineNumber
        if (ln != null) onAskRef.current?.(ln, { atTurn: false })
      }
    })
    const askAtTurnAction = editor.addAction({
      id: 'loch.askConversationAtTurn',
      label: 'Ask the conversation, as of the turn that wrote this',
      contextMenuGroupId: '0_loch',
      contextMenuOrder: 2,
      precondition: 'lochLineAttributed',
      run: (ed) => {
        const ln = ed.getPosition()?.lineNumber
        if (ln != null) onAskRef.current?.(ln, { atTurn: true })
      }
    })

    return () => {
      changeSub.dispose()
      moveSub.dispose()
      leaveSub.dispose()
      downSub.dispose()
      blameMoveSub.dispose()
      blameLeaveSub.dispose()
      blameScrollSub.dispose()
      blameDownSub.dispose()
      blameKeySub.dispose()
      cursorSub.dispose()
      askAction.dispose()
      askAtTurnAction.dispose()
      blameCollectionRef.current?.clear()
      blameCollectionRef.current = null
      glyphCollection.clear()
      // Dispose the editor before its model — reversing this order fires
      // "TextModel got disposed before ..." from Monaco's listeners.
      const model = editor.getModel()
      editor.dispose()
      model?.dispose()
      editorRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Sync value when it changes externally (e.g. reload). Skip if the
  // editor already has the same content to avoid cursor resets.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    if (editor.getValue() !== value) {
      editor.setValue(value)
    }
  }, [value])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const model = editor.getModel()
    if (model) {
      monaco.editor.setModelLanguage(model, detectMonacoLanguage(filePath))
    }
  }, [filePath])

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly })
  }, [readOnly])

  useEffect(() => {
    editorRef.current?.updateOptions({
      fontFamily: fontFamily || undefined,
      fontSize: fontSize || 13
    })
  }, [fontFamily, fontSize])

  useEffect(() => {
    editorRef.current?.updateOptions({ wordWrap: wordWrap ? 'on' : 'off' })
  }, [wordWrap])

  const blameColors = useRef<Map<string, number>>(new Map())
  useEffect(() => {
    const editor = editorRef.current
    const collection = blameCollectionRef.current
    if (!editor || !collection) return
    hoverHunkRef.current = null
    setBlameHover(null)
    if (!blame) {
      blameColors.current = new Map()
      collection.clear()
      attributedKeyRef.current?.set(false)
      return
    }
    const colors = assignTurnColors(blame.hunks)
    blameColors.current = colors
    const decorations: monaco.editor.IModelDeltaDecoration[] = []
    for (const h of blame.hunks) {
      const c = h.conversation
      if (!c) continue
      const slot = colors.get(c.turn) ?? 0
      decorations.push({
        range: new monaco.Range(h.start, 1, h.end, 1),
        options: {
          isWholeLine: true,
          linesDecorationsClassName: `loch-bar loch-c${slot}${c.backfilled ? ' loch-backfilled' : ''}${c.available ? ' loch-askable' : ''}`
        }
      })
    }
    collection.set(decorations)
    const ln = editor.getPosition()?.lineNumber
    const h = ln != null ? hunkAtLine(blame.hunks, ln) : null
    attributedKeyRef.current?.set(!!h?.conversation?.available && !!onAskRef.current)
  }, [blame])

  // A pinned card closes on any press outside it — including outside the
  // editor, where Monaco's own mouse events can't see the click.
  const pinned = !!blameHover?.pinned
  useEffect(() => {
    if (!pinned) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node | null
      if (t && cardRef.current?.contains(t)) return
      if (t && hostRef.current?.contains(t)) return // Monaco's onMouseDown decides
      hideBlameHoverRef.current()
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [pinned])

  const hoverConv = blameHover?.hunk.conversation
  const askFromCard = (atTurn: boolean): void => {
    if (!blameHover) return
    const ln = blameHover.line
    hideBlameHoverRef.current()
    onAskRef.current?.(ln, { atTurn })
  }
  return (
    <div className="h-full w-full relative">
      <div ref={hostRef} className="h-full w-full" />
      {blameHover && hoverConv && (
        <div
          ref={cardRef}
          className={`absolute z-20 ${blameHover.pinned ? '' : 'pointer-events-none'}`}
          style={{
            top: blameHover.top,
            left: blameHover.left,
            transform: blameHover.above ? 'translateY(-100%)' : undefined
          }}
        >
          <LochBlameCard
            conversation={hoverConv}
            start={blameHover.hunk.start}
            end={blameHover.hunk.end}
            colorSlot={blameColors.current.get(hoverConv.turn) ?? 0}
            session={blame?.sessions?.[hoverConv.session]}
            pinned={blameHover.pinned}
            onAsk={blameHover.pinned && onAskLine ? askFromCard : undefined}
          />
        </div>
      )}
    </div>
  )
}
