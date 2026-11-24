import { ArrowRight } from 'lucide-react'

/** "Try it, your chats come with you" nudge. Shared by the homepage and
 *  announcement posts that mount site components from a Vite entry (plain
 *  public/ HTML posts can't), so it sets no outer spacing or width; the
 *  mount point decides both. The default href is root-relative so it reaches
 *  the homepage's download section from any page. */
export function ImportBanner({ href = '/#install', className = '' }: { href?: string; className?: string }) {
  return (
    <a
      href={href}
      className={`group flex flex-col sm:flex-row sm:items-center gap-x-6 gap-y-2 rounded-xl bg-brand/[0.06] hover:bg-brand/[0.1] px-5 py-4 sm:px-6 transition-colors ${className}`}
    >
      <p className="text-sm sm:text-base text-ink-400 leading-relaxed sm:flex-1">
        <span className="text-ink-200 font-semibold">It’s never been easier to try out Ness.</span> During
        setup it finds your recent Claude Code &amp; Codex chats and offers to bring them in, so you pick up right
        where you left off.
      </p>
      <span className="inline-flex items-center gap-1.5 text-sm sm:text-base font-semibold text-brand whitespace-nowrap">
        Try it risk free today
        <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
      </span>
    </a>
  )
}
