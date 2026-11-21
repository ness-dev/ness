import { BellRing, KeyRound, Server, Smartphone, SquareStack } from 'lucide-react'
import { InlineCode } from './InlineCode'
import { SectionIntro } from './SectionIntro'

const POINTS = [
  {
    icon: Server,
    title: 'One-click remote backends',
    body: (
      <>
        Pick a host from <InlineCode>~/.ssh/config</InlineCode> and click Connect. Ness installs its server there,
        starts it and tunnels to it over SSH. Close your laptop and the agents keep running.
      </>
    )
  },
  {
    icon: Smartphone,
    title: 'Your phone is a client too',
    body: (
      <>
        Every Ness serves a web client with a layout built for phones. Scan the QR code in Settings or open the
        server’s URL, then pin it to your home screen. Much better than Claude’s own remote UI.
      </>
    )
  },
  {
    icon: SquareStack,
    title: 'Every machine in one window',
    body: (
      <>
        Each backend is a chip at the bottom of the sidebar. <InlineCode as="kbd">⌘⇧1–9</InlineCode> jumps between
        them, and local is always the first.
      </>
    )
  },
  {
    icon: BellRing,
    title: 'Pinged from anywhere',
    body: <>Backends you aren’t looking at keep streaming, so an agent waiting on approval on another box still reaches you.</>
  },
  {
    icon: KeyRound,
    title: 'Locked down by default',
    body: <>Every connection needs a token, and servers listen on localhost unless you turn on LAN access.</>
  }
]

export function RemoteAndMobile() {
  return (
    <section id="remote" className="max-w-6xl mx-auto px-6 py-14 sm:py-20">
      <SectionIntro step="04" eyebrow="Remote and mobile" title="Your agents don’t live on your laptop.">
        Run Ness’s server on any machine you can SSH into and drive it from the desktop app, or from your phone.{' '}
        <a
          href="/announcements/remote-backends.html"
          className="text-ink-300 underline decoration-ink-700 underline-offset-2 hover:text-ink-100"
        >
          How remote backends work
        </a>
      </SectionIntro>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_auto] gap-x-16 gap-y-12 items-center">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-7 order-2 lg:order-1">
          {POINTS.map(({ icon: Icon, title, body }) => (
            <div key={title} className="flex gap-3">
              <Icon className="w-5 h-5 text-brand shrink-0 mt-0.5" aria-hidden="true" />
              <div>
                <h3 className="font-semibold text-ink-100 mb-1">{title}</h3>
                <p className="text-sm text-ink-500 leading-relaxed">{body}</p>
              </div>
            </div>
          ))}
        </div>

        <img
          src="/screenshot-mobile.svg"
          alt="Ness on a phone: the sidebar of agents with their status dots, above a terminal pane"
          className="block h-[28rem] sm:h-[34rem] w-auto mx-auto order-1 lg:order-2"
          loading="lazy"
        />
      </div>
    </section>
  )
}
