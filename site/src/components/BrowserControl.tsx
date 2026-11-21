import { Eye, MonitorSmartphone, MousePointerClick, TerminalSquare } from 'lucide-react'
import { BrowserMock } from './BrowserMock'
import { SectionIntro } from './SectionIntro'

const POINTS = [
  {
    icon: MousePointerClick,
    title: 'Click, type, scroll',
    body: <>Agents open tabs and drive them through the Ness MCP, aiming clicks at real elements rather than guessing from pixels.</>
  },
  {
    icon: Eye,
    title: 'Watch it happen',
    body: <>The tab sits next to the agent’s chat, so you see each click land, and the agent screenshots its own work.</>
  },
  {
    icon: MonitorSmartphone,
    title: 'Check the phone layout',
    body: <>Agents can resize the viewport to a phone, including touch and a mobile user agent, to see the mobile site.</>
  },
  {
    icon: TerminalSquare,
    title: 'Reads the console',
    body: <>Console logs and the rendered DOM are one call away, so an agent can debug the page it just broke.</>
  }
]

export function BrowserControl() {
  return (
    <section id="browser" className="max-w-6xl mx-auto px-6 py-14 sm:py-20">
      <SectionIntro step="05" eyebrow="Browser control" title="Let your agents use a browser.">
        Give agents a real browser tab inside Ness. Useful for testing your code locally, or just ordering
        groceries.
      </SectionIntro>

      <div
        role="img"
        aria-label="Ness with an agent's chat beside a browser tab it is driving: it opened a local sign-in page, filled in the form, clicked Sign in and found the error in the console."
      >
        <BrowserMock />
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-x-8 gap-y-8 mt-14">
        {POINTS.map(({ icon: Icon, title, body }) => (
          <div key={title}>
            <Icon className="w-5 h-5 text-brand mb-3" aria-hidden="true" />
            <h3 className="font-semibold text-ink-100 mb-1.5">{title}</h3>
            <p className="text-sm text-ink-500 leading-relaxed">{body}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
