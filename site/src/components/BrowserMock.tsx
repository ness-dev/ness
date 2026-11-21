import { ArrowLeft, ArrowRight, ChevronRight, Globe, MousePointer2, RotateCw } from 'lucide-react'
import { NessMark } from './NessMark'

/** A Ness window with an agent's Chat tab beside the browser tab it's
 *  driving. Drawn in the app's own tokens like the hero mock, so it can't
 *  go stale the way a screenshot does and shows no real repo names. On a
 *  phone only the browser pane shows; the chat column needs the width. */

const TOOL_ROWS = ['Open localhost:5173/login', 'Type into Email and Password', 'Click “Sign in”', 'Read console logs']

export function BrowserMock() {
  return (
    <div
      aria-hidden="true"
      className="rounded-xl overflow-hidden border border-border-strong shadow-2xl shadow-black/70 bg-app font-sans select-none text-fg"
    >
      {/* Title row */}
      <div className="h-10 flex items-stretch border-b border-border-strong bg-panel">
        <div className="flex items-center gap-2 px-4">
          <span className="w-3 h-3 rounded-full bg-[#ff5f57]" />
          <span className="w-3 h-3 rounded-full bg-[#febc2e]" />
          <span className="w-3 h-3 rounded-full bg-[#28c840]" />
          <NessMark className="h-3 w-auto ml-3 text-brand" />
          <span className="text-sm font-semibold gradient-text">Ness</span>
        </div>
        <div className="hidden sm:flex items-center gap-1.5 px-4 text-xs text-fg-bright border-l border-border-strong">
          <span className="w-1.5 h-1.5 rounded-full bg-success" />
          Claude · fix/sign-in
        </div>
        <div className="flex items-center gap-1.5 px-4 text-xs text-fg-bright border-l border-border-strong">
          <Globe className="w-3.5 h-3.5 text-dim" />
          Browser
        </div>
      </div>

      <div className="flex h-[22rem] sm:h-[26rem]">
        {/* Agent chat */}
        <div className="hidden sm:flex w-[42%] shrink-0 flex-col justify-end gap-3 px-5 py-4 text-sm leading-relaxed border-r border-border-strong">
          <div className="self-end max-w-[90%] rounded-xl bg-surface px-3 py-2 text-fg-bright">
            Clicking Sign in does nothing. Can you check it in the browser?
          </div>
          <div className="space-y-0.5">
            {TOOL_ROWS.map((t) => (
              <div key={t} className="flex items-center gap-1.5 text-xs text-dim">
                <ChevronRight className="w-3 h-3 shrink-0" />
                <Globe className="w-3 h-3 shrink-0" />
                <span className="truncate">{t}</span>
              </div>
            ))}
          </div>
          <p>
            The console shows{' '}
            <code className="font-mono text-xs text-fg-bright bg-surface px-1 rounded">
              Cannot read properties of undefined (reading 'token')
            </code>
            . The login API now nests the token under <code className="font-mono text-xs text-fg-bright bg-surface px-1 rounded">session</code>, so I’m updating the client and trying again.
          </p>
        </div>

        {/* Browser tab */}
        <div className="flex-1 min-w-0 flex flex-col bg-panel">
          <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-border text-dim">
            <ArrowLeft className="w-3.5 h-3.5" />
            <ArrowRight className="w-3.5 h-3.5 opacity-50" />
            <RotateCw className="w-3.5 h-3.5" />
            <span className="flex-1 min-w-0 truncate rounded bg-app border border-border px-2 py-1 text-xs font-mono text-fg">
              localhost:5173/login
            </span>
          </div>

          <div className="relative flex-1 flex items-center justify-center bg-[#f7f7f5] text-neutral-900">
            <div className="w-56 sm:w-64 rounded-lg bg-white shadow-md px-5 py-6 space-y-3">
              <div className="text-base font-semibold">Sign in to Acme</div>
              <div className="space-y-1">
                <div className="text-[11px] text-neutral-500">Email</div>
                <div className="rounded border border-neutral-300 px-2 py-1.5 text-xs">test@example.com</div>
              </div>
              <div className="space-y-1">
                <div className="text-[11px] text-neutral-500">Password</div>
                <div className="rounded border border-neutral-300 px-2 py-1.5 text-xs tracking-widest">••••••••</div>
              </div>
              <div className="relative rounded bg-neutral-900 text-white text-xs font-medium text-center py-2">
                Sign in
                <MousePointer2 className="absolute right-6 top-4 w-4 h-4 text-neutral-900 fill-white" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
