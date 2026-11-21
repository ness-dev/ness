import { HeaderNav } from './components/HeaderNav'
import { Hero } from './components/Hero'
import { HeroMock } from './components/HeroMock'
import { FeatureCallouts } from './components/FeatureCallouts'
import { Features } from './components/Features'
import { OpenSource } from './components/OpenSource'
import { Install } from './components/Install'
import { Footer } from './components/Footer'
import { ScrollDiorama } from './components/ScrollDiorama'
import { AgentsRunAgents } from './components/AgentsRunAgents'
import { ConversationBlame } from './components/ConversationBlame'

export function App() {
  return (
    <div className="min-h-screen grid-bg">
      <HeaderNav />
      <Hero />
      <HeroMock />
      <ScrollDiorama />
      <AgentsRunAgents />
      <ConversationBlame />
      <FeatureCallouts />
      <Features />
      <OpenSource />
      <Install />
      <Footer />
    </div>
  )
}
