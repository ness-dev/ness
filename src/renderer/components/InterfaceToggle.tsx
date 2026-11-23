// Reused in Settings + Onboarding — single source of UI truth for the
// Terminal/Chat choice. The underlying setting value stays `'xterm' | 'json'`
// to keep internal code paths untouched.
import type { JSX } from 'react'
import { Terminal as TerminalIcon, MessageSquare } from 'lucide-react'

export type ClaudeTabType = 'xterm' | 'json'

interface InterfaceToggleProps {
  value: ClaudeTabType
  onChange: (next: ClaudeTabType) => void
  /** Rendered inside Settings (wider, descriptions visible) or in a
   *  narrower spot (descriptions trimmed). */
  size?: 'normal' | 'compact'
}

const OPTIONS: Array<{
  value: ClaudeTabType
  label: string
  description: string
  Icon: typeof TerminalIcon
  badge?: 'new'
}> = [
  {
    value: 'xterm',
    label: 'Terminal mode',
    description: "Claude Code's TUI in a shell tab.",
    Icon: TerminalIcon
  },
  {
    value: 'json',
    label: 'Chat mode',
    description:
      'Native interface with inline tool cards and approval flows.',
    Icon: MessageSquare,
    badge: 'new'
  }
]

export function InterfaceToggle({
  value,
  onChange,
  size = 'normal'
}: InterfaceToggleProps): JSX.Element {
  return (
    <div className="space-y-2" role="radiogroup" aria-label="Claude interface">
      {OPTIONS.map((opt) => {
        const selected = value === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(opt.value)}
            className={`w-full flex items-start gap-3 text-left rounded-lg border transition-colors cursor-pointer ${
              size === 'compact' ? 'px-3 py-2' : 'px-3 py-2.5'
            } ${
              selected
                ? 'border-fg bg-surface text-fg-bright'
                : 'border-border bg-panel hover:border-border-strong text-fg'
            }`}
          >
            <span
              className={`mt-0.5 w-3.5 h-3.5 rounded-full border-2 shrink-0 ${
                selected
                  ? 'border-fg-bright bg-fg-bright/30'
                  : 'border-border-strong'
              }`}
              aria-hidden
            />
            <opt.Icon className={`${size === 'compact' ? 'icon-xs' : 'icon-sm'} mt-0.5 shrink-0`} />
            <span className="flex-1 min-w-0">
              <span className={`flex items-center gap-1.5 text-sm font-medium ${selected ? 'text-fg-bright' : 'text-fg'}`}>
                <span>{opt.label}</span>
                {opt.badge === 'new' && (
                  <span className="brand-gradient-bg text-white text-xs font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full leading-none">
                    New
                  </span>
                )}
              </span>
              <span className={`block ${size === 'compact' ? 'text-xs' : 'text-xs'} text-dim mt-0.5`}>
                {opt.description}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
