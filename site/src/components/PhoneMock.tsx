import { ChevronDown, Menu, PanelRightOpen, Plus, Terminal } from 'lucide-react'

/** Ness's phone layout (renderer `MobileApp`), drawn rather than screenshotted
 *  so it tracks the current UI and shows no real repo names: the worktree
 *  header and tab strip over a Chat tab that's blocked on an approval, which
 *  is the moment you reach for your phone. */
export function PhoneMock() {
  return (
    <div
      aria-hidden="true"
      className="w-[17rem] h-[34rem] shrink-0 rounded-[2.5rem] bg-[#1a1a1a] border border-border-strong p-2.5 font-sans select-none"
    >
      <div className="relative h-full rounded-[2rem] overflow-hidden bg-app flex flex-col text-fg">
        {/* Status bar + dynamic island */}
        <div className="h-8 shrink-0 flex items-center justify-between px-6 text-[10px] font-semibold text-fg-bright bg-panel">
          <span>9:41</span>
          <span className="absolute left-1/2 top-1.5 -translate-x-1/2 w-20 h-5 rounded-full bg-black" />
          <span className="flex items-center gap-1">
            <span className="w-3.5 h-2 rounded-sm border border-fg-bright/70" />
          </span>
        </div>

        <header className="shrink-0 flex items-stretch border-b border-border bg-panel h-11">
          <div className="flex items-center gap-2 px-3 min-w-0 border-r border-border">
            <Menu className="w-4 h-4 text-dim shrink-0" />
            <span className="min-w-0 flex flex-col leading-tight">
              <span className="text-[9px] uppercase tracking-wider text-dim truncate">ness</span>
              <span className="text-[11px] font-medium text-fg-bright truncate">fix/login-flash</span>
            </span>
            <ChevronDown className="w-3 h-3 text-dim shrink-0" />
          </div>
          <div className="flex-1 min-w-0 flex items-stretch">
            <span className="inline-flex items-center gap-1.5 px-3 text-[11px] text-fg-bright border-b-2 border-accent">
              <span className="w-1.5 h-1.5 rounded-full bg-danger pulse-dot" />
              Claude
            </span>
            <span className="inline-flex items-center px-2 text-dim">
              <Plus className="w-3 h-3" />
            </span>
          </div>
          <span className="inline-flex items-center px-2.5 text-dim">
            <PanelRightOpen className="w-4 h-4" />
          </span>
        </header>

        <div className="flex-1 min-h-0 flex flex-col justify-end gap-3 px-3 py-3 text-[11px] leading-relaxed">
          <div className="self-end max-w-[85%] rounded-xl bg-surface px-3 py-2 text-fg-bright">
            Logging out flashes the dashboard for a frame. Can you fix it?
          </div>
          <p className="text-fg">
            The redirect runs after the first paint. I moved the session check into the route loader, so the
            dashboard never renders signed out.
          </p>
          <p className="text-fg">Running the e2e suite to confirm.</p>

          <div className="rounded-md border border-danger/40 bg-danger/5 overflow-hidden">
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-danger/30 bg-danger/10">
              <span className="text-[9px] font-semibold uppercase tracking-wide text-danger">Needs approval</span>
              <Terminal className="w-3 h-3 shrink-0" />
            </div>
            <div className="px-2.5 py-2 space-y-2">
              <pre className="text-[10px] font-mono bg-app/40 rounded px-2 py-1.5 whitespace-pre-wrap text-fg-bright">
                npm run test:e2e -- logout
              </pre>
              <div className="grid grid-cols-2 gap-1.5">
                <span className="rounded py-1.5 text-center text-[10px] font-semibold bg-success/25 text-success border border-success/50">
                  Allow
                </span>
                <span className="rounded py-1.5 text-center text-[10px] bg-danger/20 text-danger">Deny</span>
              </div>
            </div>
          </div>
        </div>

        <div className="shrink-0 border-t border-border bg-panel px-3 pt-2 pb-5">
          <div className="rounded-lg bg-app border border-border px-3 py-2 text-[11px] text-faint">
            Reply to Claude…
          </div>
        </div>
      </div>
    </div>
  )
}
