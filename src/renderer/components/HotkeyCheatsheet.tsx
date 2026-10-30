import { useEffect, useRef } from 'react'
import { type Action, type HotkeyBinding, bindingToString } from '../hotkeys'
import { HotkeyBadge } from './HotkeyBadge'

interface ShortcutRow {
  label: string
  binding?: string
}

interface ShortcutGroup {
  title: string
  rows: ShortcutRow[]
}

function buildGroups(hotkeys: Record<Action, HotkeyBinding>): ShortcutGroup[] {
  const b = (action: Action): string => bindingToString(hotkeys[action])

  return [
    {
      title: 'Navigation',
      rows: [
        { label: 'Switch to worktree 1\u20139', binding: 'Cmd+1\u20139' },
        { label: 'Next worktree', binding: b('nextWorktree') },
        { label: 'Previous worktree', binding: b('prevWorktree') },
        { label: 'Open file...', binding: b('fileQuickOpen') },
        { label: 'Focus terminal', binding: 'Shift+Shift' },
      ],
    },
    {
      title: 'Tabs & Panes',
      rows: [
        { label: 'New shell tab', binding: b('newShellTab') },
        { label: 'Close tab', binding: b('closeTab') },
        { label: 'Rename tab', binding: b('renameTab') },
        { label: 'Next tab', binding: b('nextTab') },
        { label: 'Previous tab', binding: b('prevTab') },
        { label: 'Split pane right', binding: b('splitPaneRight') },
        { label: 'Split pane down', binding: b('splitPaneDown') },
      ],
    },
    {
      title: 'Panels',
      rows: [
        { label: 'Toggle sidebar', binding: b('toggleSidebar') },
        { label: 'Toggle right column', binding: b('toggleRightColumn') },
        { label: 'Toggle command center', binding: b('toggleCommandCenter') },
        { label: 'Toggle task list', binding: b('toggleTaskList') },
      ],
    },
    {
      title: 'Actions',
      rows: [
        { label: 'New worktree', binding: b('newWorktree') },
        { label: 'Refresh worktrees', binding: b('refreshWorktrees') },
        { label: 'Open PR in browser', binding: b('openPR') },
        { label: 'Open in editor', binding: b('openInEditor') },
        { label: 'Find in terminal or chat', binding: 'Cmd+F' },
        { label: 'Keyboard shortcuts', binding: b('hotkeyCheatsheet') },
      ],
    },
    {
      title: 'Chat (JSON mode)',
      rows: [
        { label: 'Approve pending tool use', binding: b('approveToolUse') },
        { label: 'Deny pending tool use', binding: b('denyToolUse') },
      ],
    },
  ]
}

interface HotkeyCheatsheetProps {
  resolvedHotkeys: Record<Action, HotkeyBinding>
  onClose: () => void
  onOpenCommandPalette: () => void
}

export function HotkeyCheatsheet({ resolvedHotkeys, onClose, onOpenCommandPalette }: HotkeyCheatsheetProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // Capture phase + stopPropagation so Esc closes the sheet and never
        // reaches the focused xterm textarea behind it — otherwise the agent
        // tab forwards Esc to the PTY and interrupts its current work.
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [onClose])

  const groups = buildGroups(resolvedHotkeys)

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh]" onClick={onClose}>
      <div
        ref={panelRef}
        className="w-full max-w-2xl bg-surface rounded-xl shadow-2xl border border-border overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
          <h2 className="text-sm font-semibold text-fg-bright">Keyboard Shortcuts</h2>
          <kbd className="text-xs text-faint bg-bg px-1.5 py-0.5 rounded border border-border font-mono">ESC</kbd>
        </div>

        <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
          <button
            className="mb-5 rounded-lg px-4 py-3.5 flex items-center justify-between w-full text-left cursor-pointer transition-opacity hover:opacity-80"
            style={{
              background: 'rgba(74, 222, 128, 0.12)',
              border: '1px solid rgba(74, 222, 128, 0.24)',
            }}
            onClick={() => {
              onClose()
              onOpenCommandPalette()
            }}
          >
            <div>
              <div className="text-sm font-semibold text-fg-bright">Command Palette</div>
              <div className="text-xs text-muted mt-0.5">Search worktrees, commands, and files</div>
            </div>
            <HotkeyBadge binding={bindingToString(resolvedHotkeys.commandPalette)} variant="strong" />
          </button>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-5">
            {groups.map((group) => (
              <div key={group.title}>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-faint mb-2">
                  {group.title}
                </h3>
                <div className="space-y-1">
                  {group.rows.map((row) => (
                    <div key={row.label} className="flex items-center justify-between py-1">
                      <span className="text-sm text-fg">{row.label}</span>
                      {row.binding && (
                        <HotkeyBadge binding={row.binding} variant="strong" className="ml-3" />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="px-5 py-2.5 border-t border-border">
          <p className="text-xs text-faint">
            Customize in Settings &rarr; Hotkeys
          </p>
        </div>
      </div>
    </div>
  )
}
