import { FileClock, GitMerge, MessageSquareText, MousePointerClick, ShieldCheck } from 'lucide-react'
import { BlameGutterPreview } from '../../../src/renderer/components/BlameGutterPreview'
import { SectionIntro } from './SectionIntro'

// The gutter picture is the same component the app's history-tracking
// explainer draws (the real LochBlameCard over a made-up snippet), so the
// site and the app can't drift apart. It's a few static divs with no heavy
// dependencies, so it isn't lazy-loaded.

const POINTS = [
  {
    icon: FileClock,
    title: 'Blame in the gutter',
    body: (
      <>
        Every line gets a thin bar, coloured by the agent turn that wrote it. Dashed bars are older history,
        backfilled from transcripts and commits.
      </>
    )
  },
  {
    icon: MousePointerClick,
    title: 'Hover for the story',
    body: (
      <>
        The card shows the session, the turn and when it ended, the prompt that started the conversation, and
        the prompt for that turn. Click the bar to pin it.
      </>
    )
  },
  {
    icon: MessageSquareText,
    title: 'Ask it why',
    body: (
      <>
        Ask from the pinned card and Ness forks the conversation that wrote the line into a new Chat tab,
        already asking about that line. The original session is left alone. <em>As of this turn</em> forks from the moment the line was written.
      </>
    )
  },
  {
    icon: GitMerge,
    title: 'Survives rebases',
    body: <>Lines are matched by content, not by commit, so squashes and rebases don’t lose the trail.</>
  },
  {
    icon: ShieldCheck,
    title: 'Stays on your machine',
    body: (
      <>
        Opt in per repo. It’s powered by{' '}
        <a
          href="https://github.com/ness-dev/loch"
          className="text-ink-300 underline decoration-ink-700 underline-offset-2 hover:text-ink-100"
        >
          loch
        </a>
        , which records each turn locally. Nothing is uploaded.
      </>
    )
  }
]

export function ConversationBlame() {
  return (
    <section id="blame" className="max-w-6xl mx-auto px-6 py-14 sm:py-20">
      <SectionIntro step="03" eyebrow="Conversation blame" title="Ask any line why it’s there.">
        Turn on history tracking for a repo and Ness records which Claude Code turn wrote each line. Open a file
        and you can see the conversation and the prompt behind any line, then ask that conversation what it was
        thinking.
      </SectionIntro>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] gap-x-12 gap-y-12 items-start">
        <div>
          <div
            role="img"
            aria-label="The Ness file viewer with a coloured bar beside each line. A card hovering over lines 9 and 10 shows the session “Retry flaky asset uploads”, turn 3, the prompt that started the conversation and the turn’s own prompt, with buttons to ask that conversation about the line."
            className="rounded-xl overflow-hidden border border-border-strong shadow-2xl shadow-black/70 bg-app font-sans"
          >
            <div
              aria-hidden="true"
              className="h-10 border-b border-border bg-panel flex items-center justify-center text-sm font-medium text-fg gap-2"
            >
              <span>upload.ts</span>
              <span className="text-faint">·</span>
              <span className="text-info">ness</span>
            </div>
            {/* On a phone the snippet and card are wider than the screen;
                scroll sideways rather than shrink the text past reading. */}
            <div className="overflow-x-auto">
              <div className="min-w-[34rem]">
                <BlameGutterPreview frameClassName="" />
              </div>
            </div>
          </div>
          <p className="text-xs text-ink-500 text-center mt-4">
            The file viewer in Ness, hovering the lines turn 3 wrote.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-x-8 gap-y-7">
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
      </div>
    </section>
  )
}
