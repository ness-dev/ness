import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { BlameDemo } from './components/ConversationBlame'

// Entry for site/announcements/conversation-blame.html. The post is
// hand-written static HTML like the other announcements; only the pieces
// shared with the homepage are React, mounted into placeholders by id, so
// they render from the same components instead of a copy that drifts.

function mount(id: string, node: ReactNode): void {
  const el = document.getElementById(id)
  if (el) createRoot(el).render(<StrictMode>{node}</StrictMode>)
}

mount('blame-demo', <BlameDemo />)

// TODO(import-banner): mount the homepage's import CTA banner into
// #import-banner once the site-import-banner PR lands.
