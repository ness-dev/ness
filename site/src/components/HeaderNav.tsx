import { useEffect, useRef, useState } from 'react'
import { Menu, X } from 'lucide-react'

export function HeaderNav() {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open) return
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Node
      if (menuRef.current?.contains(target)) return
      if (buttonRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open])

  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  useEffect(() => {
    document.body.classList.toggle('overflow-hidden', open)
    return () => {
      document.body.classList.remove('overflow-hidden')
    }
  }, [open])

  const close = () => setOpen(false)

  return (
    <nav className="max-w-6xl mx-auto px-4 sm:px-6 py-6 flex items-center justify-between gap-4 relative z-30">
      <a href="/" className="flex items-center gap-3 min-w-0 group">
        <img
          src="/mark.svg"
          alt="Ness icon"
          className="w-9 flex-shrink-0 transition-transform group-hover:scale-105"
        />
        <span className="text-xl font-bold tracking-tight">Ness</span>
      </a>

      <div className="hidden sm:flex items-center gap-4 sm:gap-6 text-sm text-ink-400 flex-shrink-0">
        <a href="#highlights" className="hover:text-ink-100 transition-colors">
          Features
        </a>
        <a href="/guide.html" className="hover:text-ink-100 transition-colors">
          Guide
        </a>
        <a href="/announcements.html" className="hover:text-ink-100 transition-colors">
          Announcements
        </a>
        <a href="#install" className="hover:text-ink-100 transition-colors">
          Install
        </a>
        <a
          href="https://github.com/ness-dev/ness"
          className="hover:text-ink-100 transition-colors"
        >
          GitHub
        </a>
      </div>

      <button
        ref={buttonRef}
        type="button"
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        aria-controls="mobile-menu"
        onClick={() => setOpen((v) => !v)}
        className="sm:hidden p-2 -mr-2 text-ink-400 hover:text-ink-100 transition-colors"
      >
        {open ? <X size={24} /> : <Menu size={24} />}
      </button>

      {open && (
        <div
          ref={menuRef}
          id="mobile-menu"
          className="sm:hidden absolute top-full left-0 right-0 mx-4 mt-1 bg-ink-950/95 backdrop-blur border border-ink-800 rounded-lg shadow-xl overflow-hidden"
        >
          <nav className="flex flex-col py-2 text-sm text-ink-400">
            <a
              href="#highlights"
              onClick={close}
              className="px-4 py-3 hover:bg-ink-800/50 hover:text-ink-100 transition-colors"
            >
              Features
            </a>
            <a
              href="/guide.html"
              onClick={close}
              className="px-4 py-3 hover:bg-ink-800/50 hover:text-ink-100 transition-colors"
            >
              Guide
            </a>
            <a
              href="/announcements.html"
              onClick={close}
              className="px-4 py-3 hover:bg-ink-800/50 hover:text-ink-100 transition-colors"
            >
              Announcements
            </a>
            <a
              href="#install"
              onClick={close}
              className="px-4 py-3 hover:bg-ink-800/50 hover:text-ink-100 transition-colors"
            >
              Install
            </a>
            <a
              href="https://github.com/ness-dev/ness"
              onClick={close}
              className="px-4 py-3 hover:bg-ink-800/50 hover:text-ink-100 transition-colors"
            >
              GitHub
            </a>
          </nav>
        </div>
      )}
    </nav>
  )
}
