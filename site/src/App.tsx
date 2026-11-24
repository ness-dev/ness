import { HeaderNav } from './components/HeaderNav'
import { Hero } from './components/Hero'
import { HeroMock } from './components/HeroMock'
import { RemoteAndMobile } from './components/RemoteAndMobile'
import { BrowserControl } from './components/BrowserControl'
import { Features } from './components/Features'
import { OpenSource } from './components/OpenSource'
import { Install } from './components/Install'
import { Footer } from './components/Footer'
import { Highlights } from './components/Highlights'
import { ImportBanner } from './components/ImportBanner'
import { AgentsRunAgents } from './components/AgentsRunAgents'
import { ConversationBlame } from './components/ConversationBlame'

export function App() {
  return (
    <div className="min-h-screen grid-bg">
      <HeaderNav />
      <Hero />
      <HeroMock />
      <div className="max-w-6xl mx-auto px-6 pb-20">
        <ImportBanner href="#install" />
      </div>
      <Highlights />
      <AgentsRunAgents />
      <ConversationBlame />
      <RemoteAndMobile />
      <BrowserControl />
      <Features />
      <OpenSource />
      <Install />
      <Footer />
    </div>
  )
}
