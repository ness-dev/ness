import { useEffect, useRef, useState } from 'react'
import { Check, Monitor, Smartphone } from 'lucide-react'
import {
  DEVICE_PRESETS,
  VIEWPORT_LIMITS,
  formatViewport,
  normalizeViewport,
  viewportsEqual,
  type BrowserViewport
} from '../../shared/browser-viewport'
import { Tooltip } from './Tooltip'

interface ViewportPickerProps {
  viewport: BrowserViewport | null
  onChange: (viewport: BrowserViewport | null) => void
  /** Raised while the dropdown is showing, so the host can detach the native
   *  web view — it paints above every DOM node in the window, so the menu is
   *  invisible until the view steps aside. */
  onOverlayChange: (open: boolean) => void
}

export function ViewportPicker({
  viewport,
  onChange,
  onOverlayChange
}: ViewportPickerProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [customW, setCustomW] = useState('')
  const [customH, setCustomH] = useState('')
  const [customError, setCustomError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const show = (next: boolean): void => {
    setOpen(next)
    onOverlayChange(next)
  }

  useEffect(() => {
    if (!open) return
    setCustomW(viewport ? String(viewport.width) : '')
    setCustomH(viewport ? String(viewport.height) : '')
    setCustomError(null)
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) show(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') show(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = (next: BrowserViewport | null): void => {
    show(false)
    onChange(next)
  }

  const applyCustom = (): void => {
    const parsed = normalizeViewport({
      width: Number(customW),
      height: Number(customH)
    })
    if (!parsed.viewport) {
      setCustomError(parsed.error ?? 'invalid size')
      return
    }
    pick(parsed.viewport)
  }

  const Icon = viewport?.mobile ? Smartphone : Monitor

  return (
    <div ref={rootRef} className="relative">
      <Tooltip label={viewport ? `Emulating ${formatViewport(viewport)}` : 'Viewport size'}>
        <button
          onClick={() => show(!open)}
          className={`flex items-center gap-1 h-7 px-1.5 rounded transition-colors ${
            viewport ? 'text-accent' : 'text-faint hover:text-fg'
          }`}
        >
          <Icon className="icon-sm" />
          {viewport && <span className="text-xs tabular-nums">{formatViewport(viewport)}</span>}
        </button>
      </Tooltip>
      {open && (
        <div className="absolute right-0 top-8 z-50 w-56 py-1 rounded border border-border-strong bg-panel-raised shadow-lg">
          <MenuRow checked={!viewport} onClick={() => pick(null)}>
            Fit pane
          </MenuRow>
          <div className="my-1 border-t border-border-strong" />
          {DEVICE_PRESETS.map((preset) => (
            <MenuRow
              key={preset.id}
              checked={viewportsEqual(preset.viewport, viewport)}
              onClick={() => pick(preset.viewport)}
            >
              <span className="flex-1">{preset.label}</span>
              <span className="text-faint tabular-nums">
                {preset.viewport.width}×{preset.viewport.height}
              </span>
            </MenuRow>
          ))}
          <div className="my-1 border-t border-border-strong" />
          <div className="px-3 py-1.5 space-y-1.5">
            <div className="flex items-center gap-1">
              <SizeInput value={customW} onChange={setCustomW} onEnter={applyCustom} label="W" />
              <span className="text-faint text-xs">×</span>
              <SizeInput value={customH} onChange={setCustomH} onEnter={applyCustom} label="H" />
              <button
                onClick={applyCustom}
                className="h-6 px-2 text-xs rounded border border-border-strong text-faint hover:text-fg"
              >
                Set
              </button>
            </div>
            {customError ? (
              <div className="text-xs text-red-500">{customError}</div>
            ) : (
              <div className="text-xs text-faint leading-snug">
                {VIEWPORT_LIMITS.minSize}–{VIEWPORT_LIMITS.maxSize} px. Mobile emulation (and a
                phone user agent) turn on at {'≤'}600 px wide.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function MenuRow({
  checked,
  onClick,
  children
}: {
  checked: boolean
  onClick: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-fg-bright hover:bg-panel cursor-pointer text-left"
    >
      <span className="w-3 shrink-0">{checked && <Check className="icon-2xs text-accent" />}</span>
      {children}
    </button>
  )
}

function SizeInput({
  value,
  onChange,
  onEnter,
  label
}: {
  value: string
  onChange: (v: string) => void
  onEnter: () => void
  label: string
}): JSX.Element {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, ''))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onEnter()
      }}
      aria-label={label}
      placeholder={label}
      inputMode="numeric"
      className="w-14 h-6 px-1 text-xs text-center bg-app border border-border rounded text-fg focus:outline-none focus:border-accent"
    />
  )
}
