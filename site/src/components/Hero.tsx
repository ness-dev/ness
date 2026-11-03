import React from 'react'

export function Hero() {
  return (
    <section className="max-w-6xl mx-auto px-6 pt-12 pb-20 text-center">
      {/* The bare mark, not the boxed app icon — the page is already dark, so
          a black rounded square around it just reads as a sticker. */}
      <img src="/mark.svg" alt="Ness" className="w-40 mx-auto mb-8" />
      <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight mb-6">
        Run a team
        <br />
        <span className="gradient-text">of agents.</span>
      </h1>
      <p className="text-lg md:text-xl text-ink-400 max-w-2xl mx-auto mb-3">
        Run ten Claudes<sup className="text-brand/80">*</sup> at once without losing your mind.
        Ship more, faster, with every session at your fingertips.
      </p>
      <p className="text-xs text-ink-500 mb-10">*or Codexes, if you prefer</p>
      <div className="flex flex-col sm:flex-row gap-3 justify-center items-center">
        <a
          href="#install"
          className="inline-flex items-center gap-2 px-8 py-3 bg-white text-black rounded-lg font-semibold hover:bg-ink-200 transition-colors"
        >
          <DownloadIcon />
          Download for macOS
        </a>
        <a
          href="https://github.com/ness-dev/ness"
          className="inline-flex items-center gap-2 px-8 py-3 border border-ink-700 hover:border-ink-600 rounded-lg font-semibold transition-colors"
        >
          <GitHubIcon />
          View on GitHub
        </a>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 mt-4 text-xs text-ink-500">
        <span>Supports</span>
        <span className="flex items-center gap-1.5 text-ink-400">
          <ClaudeMark />
          Claude Code
        </span>
        <span className="flex items-center gap-1.5 text-ink-400">
          <CodexMark />
          Codex
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 mt-3 text-xs text-ink-500">
        <span>Loved by engineers at</span>

        <LogoTip label="Clay">
          <LogoTipClay />
          <Bubble kind="sent">dude check this out</Bubble>
          <LinkCard body="you need this" />
          <Gap />
          <Bubble kind="rcvd">Dude</Bubble>
          <Bubble kind="rcvd">This is so sick</Bubble>
          <Bubble kind="rcvd">
            Allow me to choose between using cursor agent and codex and you could sell this
          </Bubble>
          <Gap />
          <Bubble kind="sent">I don't even want to sell it I just want people to use it</Bubble>
          <Gap />
          <ReplyCard src="/screenshot-codex.png" alt="Codex support" text="added codex" />
        </LogoTip>

        <LogoTip label="Vercel">
          <LogoTipVercel />
          <Bubble kind="sent">dude check this out</Bubble>
          <LinkCard body="you need this" />
          <Gap />
          <Bubble kind="rcvd">Nice I'm gonna try it</Bubble>
          <Bubble kind="rcvd">You should just toss it on HN</Bubble>
        </LogoTip>

        <LogoTip label="Apple">
          <LogoTipApple />
          <Bubble kind="sent">dude check this out</Bubble>
          <LinkCard body="you need this" />
          <Gap />
          <Bubble kind="rcvd">This is sick</Bubble>
          <Bubble kind="rcvd">I'll share it w my team today too</Bubble>
        </LogoTip>

        <LogoTip label="Y Combinator">
          <LogoTipYC />
          <Bubble kind="sent">dude check this out</Bubble>
          <LinkCard body="you need this" />
          <Gap />
          <Bubble kind="rcvd" style={{ opacity: 0.5 }}>
            ...
          </Bubble>
        </LogoTip>

        <LogoTip label="Stanford">
          <LogoTipStanford />
          <Bubble kind="sent">dude check this out</Bubble>
          <LinkCard body="you need this" />
          <Gap />
          <Bubble kind="rcvd">Nice, that's pretty sick</Bubble>
          <Bubble kind="rcvd">
            Hey! Just downloaded harness and have an immediate feature request. cmd+d to split my
            tab
          </Bubble>
          <Gap />
          <ReplyCard src="/screenshot-split-pane.png" alt="Split pane feature" text="added it" />
        </LogoTip>
      </div>

      <div className="mt-8 flex justify-center">
        <a
          href="https://github.com/ness-dev/ness"
          className="inline-flex items-center gap-2 px-6 py-2.5 rounded-lg font-semibold text-green-200 border border-brand/40 bg-brand/10 hover:bg-brand/20 hover:border-brand/60 hover:text-green-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 transition-colors"
        >
          <StarIcon />
          Please star us on GitHub
        </a>
      </div>
    </section>
  )
}

type LogoTipChild = React.ReactNode

function LogoTip({ children }: { label: string; children: LogoTipChild }) {
  const [logo, ...rest] = React.Children.toArray(children)
  return (
    <div className="logo-tip">
      {logo}
      <div className="tip">{rest}</div>
    </div>
  )
}

function Bubble({
  kind,
  children,
  style
}: {
  kind: 'sent' | 'rcvd'
  children: React.ReactNode
  style?: React.CSSProperties
}) {
  return (
    <div className={`bubble ${kind}`} style={style}>
      {children}
    </div>
  )
}

function Gap() {
  return <div className="gap" />
}

function LinkCard({ body }: { body: string }) {
  return (
    <div className="link-card">
      <div className="link-preview">
        <div className="link-icon">H</div>
        <div className="link-title">Ness — run a team of agents</div>
        <div className="link-domain">getness.dev</div>
      </div>
      <div className="link-body">{body}</div>
    </div>
  )
}

function ReplyCard({ src, alt, text }: { src: string; alt: string; text: string }) {
  return (
    <div className="reply-card">
      <img src={src} alt={alt} />
      <div className="reply-text">{text}</div>
    </div>
  )
}

function LogoTipClay() {
  return <img src="/clay-logo.png" alt="Clay" height={16} className="h-4 object-contain" />
}

function LogoTipVercel() {
  return (
    <svg viewBox="2.5 3 92 20" width={58} height={13} fill="none">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M9.489 15.105 20.554 3.874a.611.611 0 0 1 .862 0l3.609 3.661a.625.625 0 0 1 0 .874L14.391 19.203a.611.611 0 0 1-.863 0l-4.04-4.098Z"
        fill="#a3a3a3"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M2.896 8.412a.625.625 0 0 1 0-.874l3.609-3.662a.611.611 0 0 1 .863 0l5.595 5.678-4.473 4.536-5.594-5.678Z"
        fill="#a3a3a3"
      />
      <path
        d="M32.932 5.755h2.208l3.483 9.398 3.483-9.398h2.208l-4.502 12.071h-2.378l-4.502-12.071Z"
        fill="#a3a3a3"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M47.78 18c2.379 0 3.483-1.466 3.483-1.466l-1.102-1.397s-.85 1.052-2.293 1.052c-1.361 0-2.175-.86-2.38-1.81h6.2s.085-.431.085-.95c0-2.296-1.655-4.175-3.984-4.223-2.118-.046-4.005 1.518-4.362 3.637C42.966 15.587 45.061 18 47.78 18Zm-.17-6.899c1.104 0 1.785.69 2.04 1.639h-4.163c.254-.95.933-1.639 2.123-1.639Z"
        fill="#a3a3a3"
      />
      <path
        d="M53.353 9.377h1.954v1.208h.085s.85-1.379 2.38-1.379h.339v2.155s-.254-.087-.68-.087c-1.189 0-2.122.95-2.122 2.415v4.139h-1.954V9.377h-.002Z"
        fill="#a3a3a3"
      />
      <path
        d="M59.338 5.755h1.954v7.33l3.312-3.708h2.379l-3.143 3.534 3.312 4.915h-2.208l-2.379-3.536-1.275 1.466v2.07h-1.954V5.755h.002Z"
        fill="#a3a3a3"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M72.846 16.706h.083v1.118h1.954v-5.26c0-1.844-1.444-3.362-3.483-3.362-2.123 0-3.312 1.724-3.312 1.724l1.19 1.207s.798-1.034 2.04-1.034c.935 0 1.614.692 1.614 1.295l-2.804.518c-1.443.258-2.462 1.294-2.462 2.673 0 1.295 1.104 2.416 2.719 2.416 1.697 0 2.462-1.295 2.462-1.295Zm-1.87-2.416 1.954-.344h.003v.258c0 1.205-.935 2.155-2.04 2.155-.764 0-1.275-.518-1.275-1.034 0-.516.34-.847 1.358-1.035Z"
        fill="#a3a3a3"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M82.666 16.619h.085v1.207h1.954V5.755h-1.954v4.828h-.085s-.765-1.38-2.719-1.38c-1.954 0-3.737 1.81-3.737 4.397s1.783 4.397 3.737 4.397c1.954 0 2.719-1.379 2.719-1.379Zm-2.209-5.434c1.275 0 2.294 1.037 2.294 2.415 0 1.381-1.019 2.415-2.294 2.415s-2.293-1.036-2.293-2.415c0-1.38 1.018-2.415 2.293-2.415Z"
        fill="#a3a3a3"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M91.246 16.706h.083v1.118h1.954v-5.26c0-1.844-1.443-3.362-3.483-3.362-2.123 0-3.312 1.724-3.312 1.724l1.19 1.207s.8-1.034 2.04-1.034c.935 0 1.614.692 1.614 1.295l-2.804.518c-1.443.258-2.462 1.294-2.462 2.673 0 1.295 1.104 2.416 2.719 2.416 1.697 0 2.462-1.295 2.462-1.295Zm-1.87-2.416 1.954-.344h.003v.258c0 1.205-.936 2.155-2.04 2.155-.765 0-1.275-.518-1.275-1.034 0-.516.34-.847 1.358-1.035Z"
        fill="#a3a3a3"
      />
    </svg>
  )
}

function LogoTipApple() {
  return (
    <svg
      viewBox="0 0 814 1000"
      width={13}
      height={16}
      className="text-ink-400"
      fill="currentColor"
    >
      <path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76.5 0-103.7 40.8-165.9 40.8s-105.6-57.8-155.5-127.4c-58.1-81-105.3-207.2-105.3-327.1 0-192.8 125.3-295.2 248.3-295.2 65.3 0 119.7 42.9 160.7 42.9 39.1 0 100-45.4 174.4-45.4 28.2 0 129.6 2.6 196.5 99.2zM554.1 159.4c31.1-36.9 53.1-88.1 53.1-139.4 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-110.8 33.7-147.1 75.8-28.2 32.4-55.8 83.6-55.8 135.7 0 7.8.6 15.6 1.3 18.2 2.5.6 6.4 1.3 10.2 1.3 45.4 0 103.3-30.4 140.2-71.5z" />
    </svg>
  )
}

function LogoTipYC() {
  return (
    <svg viewBox="0 0 20 20" width={18} height={18} fill="none">
      <rect width={20} height={20} rx={2} fill="#FF6600" />
      <text
        x={10}
        y={15}
        textAnchor="middle"
        fontFamily="system-ui, sans-serif"
        fontWeight={700}
        fontSize={14}
        fill="white"
      >
        Y
      </text>
    </svg>
  )
}

function LogoTipStanford() {
  return (
    <svg viewBox="0 0 100 20" width={80} height={16} fill="none">
      <text
        x={0}
        y={15}
        fontFamily="'Times New Roman', Georgia, serif"
        fontWeight={400}
        fontSize={16}
        letterSpacing={1.5}
        fill="#8C1515"
      >
        Stanford
      </text>
    </svg>
  )
}

function DownloadIcon() {
  return (
    <svg
      className="w-5 h-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}

function StarIcon() {
  return (
    <svg
      className="w-5 h-5"
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  )
}

function GitHubIcon() {
  return (
    <svg
      className="w-5 h-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
    </svg>
  )
}

function ClaudeMark() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14">
      <path
        fill="#ee8334"
        d="m3.127 10.604 3.135-1.76.053-.153-.053-.085H6.11l-.525-.032-1.791-.048-1.554-.065-1.505-.08-.38-.081L0 7.832l.036-.234.32-.214.455.04 1.009.069 1.513.105 1.097.064 1.626.17h.259l.036-.105-.089-.065-.068-.064-1.566-1.062-1.695-1.121-.887-.646-.48-.327-.243-.306-.104-.67.435-.48.585.04.15.04.593.456 1.267.981 1.654 1.218.242.202.097-.068.012-.049-.109-.181-.9-1.626-.96-1.655-.428-.686-.113-.411a2 2 0 0 1-.068-.484l.496-.674L4.446 0l.662.089.279.242.411.94.666 1.48 1.033 2.014.302.597.162.553.06.17h.105v-.097l.085-1.134.157-1.392.154-1.792.052-.504.25-.605.497-.327.387.186.319.456-.045.294-.19 1.23-.37 1.93-.243 1.29h.142l.161-.16.654-.868 1.097-1.372.484-.545.565-.601.363-.287h.686l.505.751-.226.775-.707.895-.585.759-.839 1.13-.524.904.048.072.125-.012 1.897-.403 1.024-.186 1.223-.21.553.258.06.263-.218.536-1.307.323-1.533.307-2.284.54-.028.02.032.04 1.029.098.44.024h1.077l2.005.15.525.346.315.424-.053.323-.807.411-3.631-.863-.872-.218h-.12v.073l.726.71 1.331 1.202 1.667 1.55.084.383-.214.302-.226-.032-1.464-1.101-.565-.497-1.28-1.077h-.084v.113l.295.432 1.557 2.34.08.718-.112.234-.404.141-.444-.08-.911-1.28-.94-1.44-.759-1.291-.093.053-.448 4.821-.21.246-.484.186-.403-.307-.214-.496.214-.98.258-1.28.21-1.016.19-1.263.112-.42-.008-.028-.092.012-.953 1.307-1.448 1.957-1.146 1.227-.274.109-.477-.247.045-.44.266-.39 1.586-2.018.956-1.25.617-.723-.004-.105h-.036l-4.212 2.736-.75.096-.324-.302.04-.496.154-.162 1.267-.871z"
      />
    </svg>
  )
}

function CodexMark() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14">
      <path
        fill="currentColor"
        d="M14.949 6.547a3.94 3.94 0 0 0-.348-3.273 4.11 4.11 0 0 0-4.4-1.934 4.1 4.1 0 0 0-1.778-.113 4.15 4.15 0 0 0-2.118.114 4.1 4.1 0 0 0-1.891.948 4.04 4.04 0 0 0-1.158 1.753 4.1 4.1 0 0 0-1.563.679 4 4 0 0 0-1.14 1.252 3.99 3.99 0 0 0 .502 4.731 3.94 3.94 0 0 0 .346 3.274 4.11 4.11 0 0 0 4.402 1.933c.382.425.852.764 1.377.995.526.231 1.095.35 1.67.346 1.78.002 3.358-1.132 3.901-2.804a4.1 4.1 0 0 0 1.563-.68 4 4 0 0 0 1.14-1.253 3.99 3.99 0 0 0-.506-4.716m-6.097 8.406a3.05 3.05 0 0 1-1.945-.694l.096-.054 3.23-1.838a.53.53 0 0 0 .265-.455v-4.49l1.366.778q.02.011.025.035v3.722c-.003 1.653-1.361 2.992-3.037 2.996m-6.53-2.75a2.95 2.95 0 0 1-.36-2.01l.095.057L5.29 12.09a.53.53 0 0 0 .527 0l3.949-2.246v1.555a.05.05 0 0 1-.022.041L6.473 13.3c-1.454.826-3.311.335-4.15-1.098m-.85-6.94A3.02 3.02 0 0 1 3.07 3.949v3.785a.51.51 0 0 0 .262.451l3.93 2.237-1.366.779a.05.05 0 0 1-.048 0L2.585 9.342a2.98 2.98 0 0 1-1.113-4.094zm11.216 2.571L8.747 5.576l1.362-.776a.05.05 0 0 1 .048 0l3.265 1.86a3 3 0 0 1 1.173 1.207 2.96 2.96 0 0 1-.27 3.2 3.05 3.05 0 0 1-1.36.997V8.279a.52.52 0 0 0-.276-.445m1.36-2.015-.097-.057-3.226-1.855a.53.53 0 0 0-.53 0L6.249 6.153V4.598a.04.04 0 0 1 .019-.04L9.533 2.7a3.07 3.07 0 0 1 3.257.139c.474.325.843.778 1.066 1.303.223.526.289 1.103.191 1.664zM5.503 8.575 4.139 7.8a.05.05 0 0 1-.026-.037V4.049c0-.57.166-1.127.476-1.607s.752-.864 1.275-1.105a3.08 3.08 0 0 1 3.234.41l-.096.054-3.23 1.838a.53.53 0 0 0-.265.455zm.742-1.577 1.758-1 1.762 1v2l-1.755 1-1.762-1z"
      />
    </svg>
  )
}
