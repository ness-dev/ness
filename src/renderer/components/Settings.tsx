import { useState, useEffect, useCallback, useRef, useMemo, useLayoutEffect } from 'react'
import { ArrowLeft, Check, X, Eye, EyeOff, Star, RefreshCw, Download, RotateCw, GitPullRequest, DownloadCloud, Keyboard, RotateCcw, Terminal as TerminalIcon, Palette, BookOpen, Code2, GitBranch, Plus, Trash2, Moon, LifeBuoy, Bug, Lightbulb, FlaskConical, Copy, CopyCheck, ExternalLink, CalendarDays, FileText, FolderOpen, Search, ChevronDown, ChevronRight, SlidersHorizontal, Sparkles } from 'lucide-react'
import { openReportIssue } from './ReportIssueScreen'
import { HARNESS_ISSUES_URL, HARNESS_RELEASES_URL, harnessReleaseNotesUrl } from '../../shared/constants'
import {
  useSettings,
  useUpdater,
  useRepoConfigs,
  useRepoConfigFilename,
  useHooks
} from '../store'
import { useBackend } from '../backend'
import { LEGACY_REPO_CONFIG_FILENAME } from '../../shared/state/repo-configs'
import type { UpdaterStatus, MergeStrategy, RepoConfig, AgentKind, SidebarDensity, SidebarDetailPrefs, Worktree, PRStatus } from '../types'
import { SubtitleDetail } from './WorktreeSubtitleDetail'
import { DEFAULT_HOTKEYS, ACTION_LABELS, ACTION_CATEGORIES, bindingToString, eventToBinding, formatBindingGlyphs, resolveHotkeys, isTypeableBinding, type Action, type HotkeyBinding } from '../hotkeys'
import { Tooltip } from './Tooltip'
import { HotkeyBadge } from './HotkeyBadge'
import { AGENT_REGISTRY, agentDisplayName, CLAUDE_MODELS, CODEX_MODELS, CURSOR_MODELS } from '../../shared/agent-registry'
import { AgentIcon } from './AgentIcon'
import { InterfaceToggle } from './InterfaceToggle'
import { BUILT_IN_THEMES_BY_MODE, type ThemeOption } from '../themes'
import { SEMANTIC_KEYS } from '../theme-apply'
import { NESS_MARK_MASK } from './NessMark'
import { NESSIE_COLORS } from '../../shared/state/settings'
import type { CustomTheme, UiScale } from '../../shared/state/settings'
import { SCALES, scaleSpec } from '../../shared/state/settings'
import { isJsonClaudePermissionMode } from '../../shared/state/json-claude'
import { QRCodeSVG } from 'qrcode.react'

interface SettingsProps {
  onClose: () => void
  onOpenGuide: () => void
  onOpenMyWeek: () => void
  initialSection?: SectionId
}

type SectionId = 'general' | 'appearance' | 'agent' | 'worktrees' | 'editor' | 'github' | 'hotkeys' | 'updates' | 'support' | 'experimental'
type SubSectionId =
  | 'appearance-theme'
  | 'appearance-custom-themes'
  | 'appearance-nessie'
  | 'appearance-ui-size'
  | 'appearance-terminal-font'
  | 'appearance-sidebar'
  | 'agent-general'
  | 'agent-claude'
  | 'agent-codex'
  | 'agent-cursor'
  | 'hotkeys-navigation'
  | 'hotkeys-backends'
  | 'hotkeys-worktree-mgmt'
  | 'hotkeys-tabs'
  | 'hotkeys-layout'
  | 'hotkeys-commands'
  | 'hotkeys-overlays'
  | 'hotkeys-external'
  | 'experimental-browser-control'
  | 'experimental-conversation-fork'
  | 'experimental-worktree-messaging'
  | 'experimental-auto-approve'
  | 'experimental-web-mobile'

interface SubSection {
  id: SubSectionId
  label: string
}

interface Section {
  id: SectionId
  label: string
  icon: React.ComponentType<{ size?: number; className?: string }>
  children?: SubSection[]
}

const SECTIONS: Section[] = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'appearance', label: 'Appearance', icon: Palette, children: [
    { id: 'appearance-theme', label: 'Theme' },
    { id: 'appearance-custom-themes', label: 'Custom themes' },
    { id: 'appearance-nessie', label: "Nessie's colour" },
    { id: 'appearance-ui-size', label: 'UI size' },
    { id: 'appearance-terminal-font', label: 'Terminal font' },
    { id: 'appearance-sidebar', label: 'Sidebar' }
  ]},
  { id: 'agent', label: 'Agent', icon: TerminalIcon, children: [
    { id: 'agent-general', label: 'General' },
    { id: 'agent-claude', label: 'Claude' },
    { id: 'agent-codex', label: 'Codex' },
    { id: 'agent-cursor', label: 'Cursor Agent' }
  ]},
  { id: 'worktrees', label: 'Worktrees', icon: GitBranch },
  { id: 'editor', label: 'Editor', icon: Code2 },
  { id: 'github', label: 'GitHub', icon: GitPullRequest },
  { id: 'hotkeys', label: 'Hotkeys', icon: Keyboard, children: [
    { id: 'hotkeys-navigation', label: 'Worktree navigation' },
    { id: 'hotkeys-backends', label: 'Backends' },
    { id: 'hotkeys-worktree-mgmt', label: 'Worktree management' },
    { id: 'hotkeys-tabs', label: 'Tabs & panes' },
    { id: 'hotkeys-layout', label: 'Window layout' },
    { id: 'hotkeys-commands', label: 'Search & commands' },
    { id: 'hotkeys-overlays', label: 'App overlays' },
    { id: 'hotkeys-external', label: 'External actions' }
  ]},
  { id: 'updates', label: 'Updates', icon: DownloadCloud },
  { id: 'support', label: 'Support', icon: LifeBuoy },
  { id: 'experimental', label: 'Experimental', icon: FlaskConical, children: [
    { id: 'experimental-browser-control', label: 'Browser control' },
    { id: 'experimental-conversation-fork', label: 'Conversation fork' },
    { id: 'experimental-worktree-messaging', label: 'Worktree messaging' },
    { id: 'experimental-auto-approve', label: 'Auto-approve' },
    { id: 'experimental-web-mobile', label: 'Web & mobile' }
  ]}
]

function agentSubSectionId(kind: AgentKind): SubSectionId {
  if (kind === 'claude') return 'agent-claude'
  if (kind === 'codex') return 'agent-codex'
  return 'agent-cursor'
}

function agentSubsectionDisplayOrder(kind: AgentKind, defaultAgent: AgentKind): number {
  if (kind === defaultAgent) return 0
  const others = AGENT_REGISTRY.map((a) => a.kind).filter((k) => k !== defaultAgent)
  return 1 + others.indexOf(kind)
}

interface SearchItem {
  /** Stable per render — `${sectionId}:${kind}:${index}`. */
  key: string
  sectionId: SectionId
  /** Display text — the heading or label text. */
  title: string
  /** Section label, shown as secondary context in results. */
  context: string
  element: HTMLElement
}

function cleanText(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query) return text
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  const idx = lower.indexOf(q)
  if (idx < 0) return text
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-accent/30 text-fg-bright rounded px-0.5">
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  )
}

export function Settings({ onClose, onOpenGuide, onOpenMyWeek, initialSection }: SettingsProps): JSX.Element {
  const backend = useBackend()
  const [activeSection, setActiveSection] = useState<SectionId>(initialSection ?? 'appearance')
  const [activeSubSection, setActiveSubSection] = useState<SubSectionId | null>(null)
  const [sectionSearch, setSectionSearch] = useState('')
  const [searchIndex, setSearchIndex] = useState<SearchItem[]>([])
  const searchInputRef = useRef<HTMLInputElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef<Record<SectionId, HTMLElement | null>>({
    general: null,
    appearance: null,
    agent: null,
    worktrees: null,
    editor: null,
    github: null,
    hotkeys: null,
    updates: null,
    support: null,
    experimental: null
  })
  const subSectionRefs = useRef<Record<SubSectionId, HTMLElement | null>>({
    'appearance-theme': null,
    'appearance-custom-themes': null,
    'appearance-nessie': null,
    'appearance-ui-size': null,
    'appearance-terminal-font': null,
    'appearance-sidebar': null,
    'agent-general': null,
    'agent-claude': null,
    'agent-codex': null,
    'agent-cursor': null,
    'hotkeys-navigation': null,
    'hotkeys-backends': null,
    'hotkeys-worktree-mgmt': null,
    'hotkeys-tabs': null,
    'hotkeys-layout': null,
    'hotkeys-commands': null,
    'hotkeys-overlays': null,
    'hotkeys-external': null,
    'experimental-browser-control': null,
    'experimental-conversation-fork': null,
    'experimental-worktree-messaging': null,
    'experimental-auto-approve': null,
    'experimental-web-mobile': null
  })
  const isProgrammaticScroll = useRef(false)

  const scrollToSection = useCallback((id: SectionId) => {
    setActiveSection(id)
    const section = SECTIONS.find((s) => s.id === id)
    setActiveSubSection(section?.children?.[0]?.id ?? null)
    isProgrammaticScroll.current = true
    const el = sectionRefs.current[id]
    if (el && scrollRef.current) {
      scrollRef.current.scrollTo({ top: el.offsetTop - 24, behavior: 'smooth' })
    }
  }, [])

  const scrollToSubSection = useCallback((id: SubSectionId) => {
    setActiveSubSection(id)
    isProgrammaticScroll.current = true
    const el = subSectionRefs.current[id]
    if (el && scrollRef.current) {
      scrollRef.current.scrollTo({ top: el.offsetTop - 24, behavior: 'smooth' })
    }
  }, [])

  // Honor `initialSection` once the section refs are wired up.
  useEffect(() => {
    if (!initialSection) return
    const el = sectionRefs.current[initialSection]
    if (el && scrollRef.current) {
      scrollRef.current.scrollTo({ top: el.offsetTop - 24 })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Build the searchable index from the actual rendered DOM. We use a
  // layout effect so the headings/labels exist before we read them; the
  // empty dep array is intentional — the section structure is static,
  // and dynamic content (theme list, custom themes) doesn't add new
  // searchable headings. If that changes, gate this on a version bump.
  useLayoutEffect(() => {
    const items: SearchItem[] = []
    for (const section of SECTIONS) {
      const sectionEl = sectionRefs.current[section.id]
      if (!sectionEl) continue
      // h2 — the section heading itself. Drop it if it duplicates the
      // sidebar label (always does, but cheap to keep for ranking).
      const h2 = sectionEl.querySelector('h2')
      if (h2) {
        items.push({
          key: `${section.id}:h2`,
          sectionId: section.id,
          title: cleanText(h2),
          context: section.label,
          element: h2
        })
      }
      // h3 — sub-headings inside the section.
      sectionEl.querySelectorAll('h3').forEach((h3, i) => {
        const text = cleanText(h3)
        if (!text) return
        items.push({
          key: `${section.id}:h3:${i}`,
          sectionId: section.id,
          title: text,
          context: section.label,
          element: h3 as HTMLElement
        })
      })
      // labels — typically the title of a single setting/toggle. Skip
      // ones that wrap inputs whose label text is itself a control
      // (very long blocks) by capping length. Compound labels that pair
      // a short title with a long description opt into indexing via
      // `data-search-title` — otherwise the description bloats the label
      // text past the 90-char cap and the setting is unfindable.
      sectionEl.querySelectorAll('label').forEach((label, i) => {
        const attrTitle = label.getAttribute('data-search-title')
        const text = attrTitle || cleanText(label).split('\n')[0]
        if (!text || text.length > 90) return
        items.push({
          key: `${section.id}:label:${i}`,
          sectionId: section.id,
          title: text,
          context: section.label,
          element: label as HTMLElement
        })
      })
    }
    setSearchIndex(items)
  }, [])

  useEffect(() => {
    const container = scrollRef.current
    if (!container) return

    const onScrollEnd = (): void => { isProgrammaticScroll.current = false }

    const onScroll = (): void => {
      if (isProgrammaticScroll.current) return
      const scrollTop = container.scrollTop
      let current: SectionId = 'general'
      for (const section of SECTIONS) {
        const el = sectionRefs.current[section.id]
        if (el && el.offsetTop - 48 <= scrollTop) {
          current = section.id
        }
      }
      setActiveSection(current)

      const currentSection = SECTIONS.find((s) => s.id === current)
      if (currentSection?.children) {
        let currentSub: SubSectionId | null = currentSection.children[0].id
        for (const child of currentSection.children) {
          const el = subSectionRefs.current[child.id]
          if (el && el.offsetTop - 48 <= scrollTop) {
            currentSub = child.id
          }
        }
        setActiveSubSection(currentSub)
      } else {
        setActiveSubSection(null)
      }
    }

    container.addEventListener('scroll', onScroll)
    container.addEventListener('scrollend', onScrollEnd)
    return () => {
      container.removeEventListener('scroll', onScroll)
      container.removeEventListener('scrollend', onScrollEnd)
    }
  }, [])

  // GitHub state
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [saving, setSaving] = useState(false)
  const [tokenResult, setTokenResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [showPatForm, setShowPatForm] = useState(false)

  // Updates state — updaterStatus lives in the main-process store
  const [version, setVersion] = useState<string>('')
  const updaterStatus = useUpdater().status
  const [checking, setChecking] = useState(false)

  // All long-lived settings live in the main-process store; this hook
  // re-renders Settings whenever any client updates any of them.
  const settings = useSettings()
  const {
    themeMode,
    themeLight,
    themeDark,
    customThemes,
    hotkeys: hotkeyOverrides,
    defaultAgent,
    claudeCommand,
    codexCommand,
    cursorCommand,
    harnessMcpEnabled,
    claudeEnvVars,
    codexEnvVars,
    cursorEnvVars,
    nameClaudeSessions,
    claudeModel,
    codexModel,
    cursorModel,
    terminalFontFamily,
    terminalFontSize,
    editor: editorId,
    worktreeBase,
    mergeStrategy,
    sidebarDensity,
    sidebarDetails,
    hasGithubToken: settingsHasToken,
    githubAuthSource: authSource,
    harnessStarred,
    worktreeScripts,
    shareClaudeSettings,
    autoUpdateEnabled,
    warnBeforeQuitting,
    harnessSystemPromptEnabled,
    harnessSystemPrompt,
    harnessSystemPromptMain,
    prReviewPrompt,
    claudeTuiFullscreen,
    browserToolsEnabled,
    browserToolsMode,
    conversationForkEnabled,
    worktreeMessagingEnabled,
    wsTransportEnabled,
    wsTransportPort,
    wsTransportHost,
    defaultClaudeTabType,
    jsonModeChatDensity,
    uiScale,
    nessieColor,
    jsonModeSendOnEnter,
    autoScrollToBottom,
    jsonModeDefaultPermissionMode,
    autoSleepMinutes,
    autoApprovePermissions,
    autoApproveSteerInstructions,
    snoozeDefaultDays,
    notifyChatOnCiFailure,
    expandedDiagnosticLoggingEnabled,
    showAssignedPRs,
    openPrInBrowserTab,
    terminalPlainClickOpensInApp,
    preventSleepMode,
    preventSleepUntil
  } = settings
  const setupScript = worktreeScripts.setup
  const teardownScript = worktreeScripts.teardown

  const [rebindingAction, setRebindingAction] = useState<Action | null>(null)
  const [expandedFamilies, setExpandedFamilies] = useState<Set<string>>(new Set())
  const [defaultClaudeCommand, setDefaultClaudeCommand] = useState<string>('')
  const [claudeSaveResult, setClaudeSaveResult] = useState<{ ok: boolean; message: string } | null>(null)
  // Alias settings.hasGithubToken to the legacy local name so existing JSX
  // stays unchanged.
  const hasToken = settingsHasToken

  // Claude env var state. Stored as an ordered list of [key, value] pairs so
  // the user can edit a blank row without it collapsing in a Record. Seeded
  // from settings on mount; edits live locally until "Save" dispatches through
  // the setter IPC.
  const [claudeEnvRows, setClaudeEnvRows] = useState<{ key: string; value: string }[]>(() =>
    Object.entries(claudeEnvVars).map(([key, value]) => ({ key, value }))
  )
  const [envSaveResult, setEnvSaveResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [revealedEnvRows, setRevealedEnvRows] = useState<Set<number>>(new Set())

  // Custom Claude endpoint helper — drafts for ANTHROPIC_BASE_URL/_AUTH_TOKEN.
  // Saves by patching claudeEnvRows + persisting via setClaudeEnvVars, so the
  // env-vars editor below shares one source of truth with this helper.
  const [litellmBaseUrl, setLitellmBaseUrl] = useState<string>(
    () => claudeEnvVars['ANTHROPIC_BASE_URL'] ?? ''
  )
  const [litellmAuthToken, setLitellmAuthToken] = useState<string>(
    () => claudeEnvVars['ANTHROPIC_AUTH_TOKEN'] ?? ''
  )
  const [litellmAuthRevealed, setLitellmAuthRevealed] = useState(false)
  const [litellmSaveResult, setLitellmSaveResult] = useState<{ ok: boolean; message: string } | null>(null)

  const [codexCommandDraft, setCodexCommandDraft] = useState<string>(codexCommand)
  useEffect(() => { setCodexCommandDraft(codexCommand) }, [codexCommand])
  const [cursorCommandDraft, setCursorCommandDraft] = useState<string>(cursorCommand)
  useEffect(() => { setCursorCommandDraft(cursorCommand) }, [cursorCommand])
  const [codexSaveResult, setCodexSaveResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [cursorSaveResult, setCursorSaveResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [codexEnvRows, setCodexEnvRows] = useState<{ key: string; value: string }[]>(() =>
    Object.entries(codexEnvVars).map(([key, value]) => ({ key, value }))
  )
  const [cursorEnvRows, setCursorEnvRows] = useState<{ key: string; value: string }[]>(() =>
    Object.entries(cursorEnvVars).map(([key, value]) => ({ key, value }))
  )
  const [codexEnvSaveResult, setCodexEnvSaveResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [cursorEnvSaveResult, setCursorEnvSaveResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [codexRevealedEnvRows, setCodexRevealedEnvRows] = useState<Set<number>>(new Set())
  const [cursorRevealedEnvRows, setCursorRevealedEnvRows] = useState<Set<number>>(new Set())

  const [systemPromptDraft, setSystemPromptDraft] = useState<string>(harnessSystemPrompt)
  useEffect(() => { setSystemPromptDraft(harnessSystemPrompt) }, [harnessSystemPrompt])
  const [systemPromptMainDraft, setSystemPromptMainDraft] = useState<string>(harnessSystemPromptMain)
  useEffect(() => { setSystemPromptMainDraft(harnessSystemPromptMain) }, [harnessSystemPromptMain])
  const [systemPromptSaveResult, setSystemPromptSaveResult] = useState<{ ok: boolean; message: string } | null>(null)

  const [prReviewPromptDraft, setPrReviewPromptDraft] = useState<string>(prReviewPrompt)
  useEffect(() => { setPrReviewPromptDraft(prReviewPrompt) }, [prReviewPrompt])
  const [prReviewPromptSaveResult, setPrReviewPromptSaveResult] = useState<{ ok: boolean; message: string } | null>(null)

  const [defaultTerminalFontFamily, setDefaultTerminalFontFamily] = useState<string>('')
  const [availableEditors, setAvailableEditors] = useState<{ id: string; name: string }[]>([])
  const [scriptsSaveResult, setScriptsSaveResult] = useState<{ ok: boolean; message: string } | null>(null)

  // Per-repo scope state for scopable worktree settings. scopeRepoRoot === null
  // means the controls bind to global config; otherwise they bind to the
  // repo-scoped config file at that repoRoot. The configs map itself
  // lives in the main-process store.
  const repoConfigs = useRepoConfigs()
  const repoList = useMemo(() => Object.keys(repoConfigs), [repoConfigs])
  const [scopeRepoRoot, setScopeRepoRoot] = useState<string | null>(null)
  const scopeConfigFilename = useRepoConfigFilename(scopeRepoRoot)

  // Hooks consent — drives the copy in the "Status hooks" card below.
  const { consent: hooksConsent } = useHooks()

  // WS transport: wsInfo reflects the live server (null when off or not
  // yet started after enabling — the server only binds at app launch).
  const [wsInfo, setWsInfo] = useState<{ port: number; token: string; host: string } | null>(null)
  const [showWsToken, setShowWsToken] = useState(false)
  const [wsUrlCopied, setWsUrlCopied] = useState(false)
  // True after the user rotates the token in this session. The running
  // servers still use the old token until the app relaunches, so we
  // surface a relaunch hint — same pattern as changing port/host.
  const [wsTokenRotated, setWsTokenRotated] = useState(false)
  const [wsPortDraft, setWsPortDraft] = useState<string>(String(wsTransportPort))
  useEffect(() => { setWsPortDraft(String(wsTransportPort)) }, [wsTransportPort])

  // LAN addresses for QR-code / scannable URL generation. A machine can
  // have several (WiFi + ethernet + VPN), so we surface a picker when
  // more than one is present and default to the first.
  const [lanAddresses, setLanAddresses] = useState<Array<{ iface: string; address: string }>>([])
  const [selectedLanAddress, setSelectedLanAddress] = useState<string | null>(null)

  const [debugLogError, setDebugLogError] = useState<string | null>(null)

  // Constants and non-settings state load once; live settings are already
  // hydrated via useSettings() above.
  useEffect(() => {
    void backend.getVersion().then(setVersion).catch(() => setVersion(''))
    backend.getDefaultClaudeCommand().then(setDefaultClaudeCommand)
    backend.getDefaultTerminalFontFamily().then(setDefaultTerminalFontFamily)
    backend.getAvailableEditors().then(setAvailableEditors)
    backend.getWsTransportInfo().then(setWsInfo)
    backend.getLanAddresses().then((addrs) => {
      setLanAddresses(addrs)
      if (addrs.length > 0) setSelectedLanAddress(addrs[0].address)
    })
  }, [])

  useEffect(() => {
    backend.getWsTransportInfo().then(setWsInfo)
  }, [wsTransportEnabled])

  // Whenever claudeEnvVars in the store changes (e.g. another window saved),
  // re-seed the local editable rows. Local edits between loads are lost —
  // same as before the migration, where Settings only read on mount.
  useEffect(() => {
    setClaudeEnvRows(Object.entries(claudeEnvVars).map(([key, value]) => ({ key, value })))
    setLitellmBaseUrl(claudeEnvVars['ANTHROPIC_BASE_URL'] ?? '')
    setLitellmAuthToken(claudeEnvVars['ANTHROPIC_AUTH_TOKEN'] ?? '')
  }, [claudeEnvVars])

  const updateRepoConfig = useCallback(
    async (repoRoot: string, patch: Record<string, unknown>) => {
      // Main dispatches repoConfigs/changed after saveRepoConfig commits;
      // useRepoConfigs() re-renders us automatically.
      await backend.setRepoConfig(repoRoot, patch)
    },
    []
  )

  const repoBasename = useCallback((repoRoot: string): string => {
    const parts = repoRoot.split('/').filter(Boolean)
    return parts[parts.length - 1] || repoRoot
  }, [])

  const [setupDraft, setSetupDraft] = useState<string>('')
  const [teardownDraft, setTeardownDraft] = useState<string>('')

  // Editable draft for the Claude command input. Hydrated from the store and
  // re-synced whenever the store value changes (e.g. another window edited it).
  // The `Save` button commits the draft via the setter IPC.
  const [claudeCommandDraft, setClaudeCommandDraft] = useState<string>(claudeCommand)
  useEffect(() => {
    setClaudeCommandDraft(claudeCommand)
  }, [claudeCommand])

  const handleSelectThemeMode = useCallback((mode: 'light' | 'dark' | 'system') => {
    void backend.setThemeMode(mode)
  }, [backend])

  // UI scale draft. A live slider that resized the whole app on each drag
  // tick would be disorienting; instead we hold a local draft and a small
  // scoped preview (below) shows what the chosen rung looks like. Save
  // commits via IPC; closing Settings without saving drops the draft.
  const [draftUiScale, setDraftUiScale] = useState<UiScale>(uiScale)
  // Resync if the persisted value changes from another client or the
  // Cmd+= / Cmd+- hotkeys while Settings is open.
  useEffect(() => { setDraftUiScale(uiScale) }, [uiScale])
  const uiScaleDirty = draftUiScale !== uiScale
  const draftScaleSpec = scaleSpec(draftUiScale)
  const handleSelectUiScale = useCallback((value: UiScale) => {
    setDraftUiScale(value)
  }, [])
  const handleSaveUiScale = useCallback(() => {
    void backend.setUiScale(draftUiScale)
  }, [backend, draftUiScale])
  const handleRevertUiScale = useCallback(() => {
    setDraftUiScale(uiScale)
  }, [uiScale])

  // When the persisted uiScale changes the root font-size shifts and the
  // whole Settings page reflows — the user's scroll position no longer
  // points at the section they were reading. Re-anchor to the active
  // subsection (or section, if no subsection is active) on the next
  // frame after App.tsx's font-size effect runs.
  const activeSectionRef = useRef(activeSection)
  useEffect(() => { activeSectionRef.current = activeSection }, [activeSection])
  const activeSubSectionRef = useRef(activeSubSection)
  useEffect(() => { activeSubSectionRef.current = activeSubSection }, [activeSubSection])
  const prevUiScaleRef = useRef(uiScale)
  useEffect(() => {
    if (uiScale === prevUiScaleRef.current) return
    prevUiScaleRef.current = uiScale
    requestAnimationFrame(() => {
      const sub = activeSubSectionRef.current
      if (sub) scrollToSubSection(sub)
      else scrollToSection(activeSectionRef.current)
    })
  }, [uiScale, scrollToSection, scrollToSubSection])

  const handleSelectLightTheme = useCallback((id: string) => {
    void backend.setThemeLight(id)
  }, [backend])

  const handleSelectDarkTheme = useCallback((id: string) => {
    void backend.setThemeDark(id)
  }, [backend])

  const handleTerminalFontFamilyChange = useCallback((value: string) => {
    void backend.setTerminalFontFamily(value)
  }, [])

  const handleResetTerminalFontFamily = useCallback(() => {
    void backend.setTerminalFontFamily(defaultTerminalFontFamily)
  }, [defaultTerminalFontFamily])

  const handleTerminalFontSizeChange = useCallback((value: number) => {
    if (!Number.isFinite(value)) return
    const clamped = Math.max(8, Math.min(48, Math.round(value)))
    void backend.setTerminalFontSize(clamped)
  }, [])

  const [autoSleepDraft, setAutoSleepDraft] = useState<string>(
    String(autoSleepMinutes)
  )
  useEffect(() => {
    setAutoSleepDraft(String(autoSleepMinutes))
  }, [autoSleepMinutes])
  const commitAutoSleepMinutes = useCallback(() => {
    const n = Number(autoSleepDraft)
    if (!Number.isFinite(n) || n < 0) {
      setAutoSleepDraft(String(autoSleepMinutes))
      return
    }
    const clamped = Math.max(0, Math.min(24 * 60, Math.floor(n)))
    if (clamped !== autoSleepMinutes) {
      void backend.setAutoSleepMinutes(clamped)
    } else {
      setAutoSleepDraft(String(clamped))
    }
  }, [autoSleepDraft, autoSleepMinutes])

  // Live clock used only to refresh the temporary-timer countdown while one
  // is running. Idle (no timer) → no interval.
  const [nowTick, setNowTick] = useState(() => Date.now())
  useEffect(() => {
    if (preventSleepUntil === null) return
    const t = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(t)
  }, [preventSleepUntil])
  const timerActive = preventSleepUntil !== null && preventSleepUntil > nowTick
  const timerMinutesLeft = timerActive
    ? Math.max(0, Math.ceil((preventSleepUntil! - nowTick) / 60000))
    : 0

  const handleSelectEditor = useCallback(async (id: string) => {
    await backend.setEditor(id)
  }, [])

  const handleSelectWorktreeBase = useCallback(async (mode: 'remote' | 'local') => {
    await backend.setWorktreeBase(mode)
  }, [])

  const handleSelectMergeStrategy = useCallback(
    async (strategy: MergeStrategy) => {
      if (scopeRepoRoot) {
        await updateRepoConfig(scopeRepoRoot, { mergeStrategy: strategy })
      } else {
        await backend.setMergeStrategy(strategy)
      }
    },
    [scopeRepoRoot, updateRepoConfig]
  )

  // Resolve what each control should display for the active scope.
  const scopedRepoCfg = scopeRepoRoot ? repoConfigs[scopeRepoRoot] || {} : null
  const displayedMergeStrategy: MergeStrategy = scopedRepoCfg
    ? (scopedRepoCfg.mergeStrategy || mergeStrategy)
    : mergeStrategy
  const scopedMergeStrategyIsOverride = !!(scopedRepoCfg && scopedRepoCfg.mergeStrategy)
  const displayedSetupScript = scopedRepoCfg
    ? (scopedRepoCfg.setupCommand ?? '')
    : setupScript
  const displayedTeardownScript = scopedRepoCfg
    ? (scopedRepoCfg.teardownCommand ?? '')
    : teardownScript
  const scopedSetupIsOverride = !!(scopedRepoCfg && scopedRepoCfg.setupCommand)
  const scopedTeardownIsOverride = !!(scopedRepoCfg && scopedRepoCfg.teardownCommand)

  // Reset the scoped script drafts whenever the active scope (or persisted
  // value for that scope) changes, so the textareas show what's on disk.
  useEffect(() => {
    setSetupDraft(displayedSetupScript)
    setTeardownDraft(displayedTeardownScript)
  }, [scopeRepoRoot, displayedSetupScript, displayedTeardownScript])

  const handleSaveWorktreeScripts = useCallback(async () => {
    if (scopeRepoRoot) {
      await updateRepoConfig(scopeRepoRoot, {
        setupCommand: setupDraft.trim() || null,
        teardownCommand: teardownDraft.trim() || null
      })
    } else {
      await backend.setWorktreeScripts({ setup: setupDraft, teardown: teardownDraft })
    }
    setScriptsSaveResult({ ok: true, message: 'Saved' })
    setTimeout(() => setScriptsSaveResult(null), 2000)
  }, [scopeRepoRoot, setupDraft, teardownDraft, updateRepoConfig])

  const handleResetSetupToGlobal = useCallback(async () => {
    if (!scopeRepoRoot) return
    await updateRepoConfig(scopeRepoRoot, { setupCommand: null })
    setSetupDraft('')
  }, [scopeRepoRoot, updateRepoConfig])

  const handleResetTeardownToGlobal = useCallback(async () => {
    if (!scopeRepoRoot) return
    await updateRepoConfig(scopeRepoRoot, { teardownCommand: null })
    setTeardownDraft('')
  }, [scopeRepoRoot, updateRepoConfig])

  const handleResetMergeStrategyToGlobal = useCallback(async () => {
    if (!scopeRepoRoot) return
    await updateRepoConfig(scopeRepoRoot, { mergeStrategy: null })
  }, [scopeRepoRoot, updateRepoConfig])

  // Repos that override a given key — used to decorate global-scope controls
  // with a "Overridden in N repo(s)" badge.
  const reposOverridingKey = useCallback(
    (key: keyof RepoConfig): string[] => {
      return repoList.filter((r) => {
        const cfg = repoConfigs[r]
        if (!cfg) return false
        const v = cfg[key]
        return typeof v === 'string' ? v.length > 0 : v != null
      })
    },
    [repoList, repoConfigs]
  )

  const handleSave = useCallback(async () => {
    setSaving(true)
    setTokenResult(null)
    try {
      const res = await backend.setGithubToken(token)
      if (res.ok) {
        const message = res.username ? `Connected as @${res.username}` : 'Token saved'
        setTokenResult({ ok: true, message })
        setToken('')
      } else {
        setTokenResult({ ok: false, message: `Invalid token: ${res.error || 'unknown error'}` })
      }
    } finally {
      setSaving(false)
    }
  }, [token])

  const handleClear = useCallback(async () => {
    await backend.clearGithubToken()
    setTokenResult({ ok: true, message: 'Token removed' })
  }, [])

  const handleCheckForUpdates = useCallback(async () => {
    setChecking(true)
    try {
      // Main dispatches the resulting updater/statusChanged event itself —
      // we just await the call so we know when to clear the spinner.
      await backend.checkForUpdates()
    } finally {
      setChecking(false)
    }
  }, [])

  const handleRestart = useCallback(() => {
    backend.quitAndInstall()
  }, [])

  // Capture a key press while rebinding
  useEffect(() => {
    if (!rebindingAction) return

    const handler = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()

      if (e.key === 'Escape') {
        setRebindingAction(null)
        return
      }

      const binding = eventToBinding(e)
      if (!binding) return // ignore pure modifier presses

      const shortcut = bindingToString(binding)
      const next = { ...(hotkeyOverrides || {}), [rebindingAction]: shortcut }
      void backend.setHotkeyOverrides(next)
      setRebindingAction(null)
    }

    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [rebindingAction, hotkeyOverrides])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (e.defaultPrevented) return
      onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const resolvedHotkeys = resolveHotkeys(hotkeyOverrides || undefined)

  const handleResetHotkey = useCallback(async (action: Action) => {
    const next = { ...(hotkeyOverrides || {}) }
    delete next[action]
    await backend.setHotkeyOverrides(next)
  }, [hotkeyOverrides])

  const handleResetAllHotkeys = useCallback(async () => {
    await backend.resetHotkeyOverrides()
  }, [])

  const handleSaveClaudeCommand = useCallback(async () => {
    setClaudeSaveResult(null)
    await backend.setClaudeCommand(claudeCommandDraft)
    setClaudeSaveResult({ ok: true, message: 'Saved · new tabs will use this command' })
  }, [claudeCommandDraft])

  const handleToggleHarnessMcp = useCallback(async (enabled: boolean) => {
    await backend.setHarnessMcpEnabled(enabled)
  }, [])

  const handleToggleAutoApprovePermissions = useCallback(async (enabled: boolean) => {
    await backend.setAutoApprovePermissions(enabled)
  }, [])

  const [autoApproveSteerDraft, setAutoApproveSteerDraft] = useState<string>(autoApproveSteerInstructions)
  useEffect(() => {
    setAutoApproveSteerDraft(autoApproveSteerInstructions)
  }, [autoApproveSteerInstructions])
  const [autoApproveSteerSaveResult, setAutoApproveSteerSaveResult] = useState<
    { ok: boolean; message: string } | null
  >(null)
  const handleSaveAutoApproveSteer = useCallback(async () => {
    setAutoApproveSteerSaveResult(null)
    await backend.setAutoApproveSteerInstructions(autoApproveSteerDraft)
    setAutoApproveSteerSaveResult({ ok: true, message: 'Saved · used on next auto-review' })
  }, [autoApproveSteerDraft])

  const handleToggleAutoUpdate = useCallback(async (enabled: boolean) => {
    await backend.setAutoUpdateEnabled(enabled)
  }, [])

  const handleToggleWarnBeforeQuitting = useCallback(async (enabled: boolean) => {
    await backend.setWarnBeforeQuitting(enabled)
  }, [])

  const handleToggleTerminalPlainClickOpensInApp = useCallback(async (enabled: boolean) => {
    await backend.setTerminalPlainClickOpensInApp(enabled)
  }, [])

  const handleToggleShowAssignedPRs = useCallback(async (enabled: boolean) => {
    await backend.setShowAssignedPRs(enabled)
  }, [])

  const handleToggleOpenPrInBrowserTab = useCallback(async (enabled: boolean) => {
    await backend.setOpenPrInBrowserTab(enabled)
  }, [])

  const handleToggleWsTransport = useCallback(async (enabled: boolean) => {
    await backend.setWsTransportEnabled(enabled)
  }, [])

  const handleSaveWsPort = useCallback(async () => {
    const parsed = Number.parseInt(wsPortDraft, 10)
    if (!Number.isFinite(parsed)) return
    await backend.setWsTransportPort(parsed)
  }, [wsPortDraft])

  const handleSelectWsHost = useCallback(async (host: string) => {
    await backend.setWsTransportHost(host)
  }, [])

  // Build the display URL from the live server when it's running; fall back
  // to the configured host/port (with a blank token) so the user can see
  // roughly what the URL *will* be after restart.
  const effectiveWsHost = wsInfo?.host ?? wsTransportHost
  const effectiveWsPort = wsInfo?.port ?? wsTransportPort
  const effectiveWsToken = wsInfo?.token ?? ''
  const wsUrl = `http://${effectiveWsHost}:${effectiveWsPort}/?token=${effectiveWsToken}`
  const wsUrlMasked = `http://${effectiveWsHost}:${effectiveWsPort}/?token=${'•'.repeat(8)}`

  // URL aimed at a phone/other device: substitutes the machine's actual
  // LAN IP for 0.0.0.0 so scanning the QR actually resolves. Only usable
  // once the server is running (needs the real token).
  const scannableLanUrl = selectedLanAddress && wsInfo
    ? `http://${selectedLanAddress}:${wsInfo.port}/?token=${wsInfo.token}`
    : null

  const handleCopyWsUrl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(wsUrl)
      setWsUrlCopied(true)
      setTimeout(() => setWsUrlCopied(false), 1500)
    } catch {
      // clipboard writes can reject when the window isn't focused
    }
  }, [wsUrl])

  const handleOpenWsUrl = useCallback(() => {
    backend.openExternal(wsUrl)
  }, [wsUrl])

  // The WS server is only constructed at app launch, so any divergence
  // between config and the live wsInfo surfaces as "relaunch required".
  const wsNeedsRestart = ((): string | null => {
    if (wsTransportEnabled && !wsInfo) return 'Quit and relaunch Ness to start the server.'
    if (!wsTransportEnabled && wsInfo) return 'Server is still running — quit and relaunch Ness to stop it.'
    if (wsInfo && wsTransportEnabled) {
      if (wsInfo.port !== wsTransportPort) return `Quit and relaunch Ness to switch to port ${wsTransportPort}.`
      if (wsInfo.host !== wsTransportHost) return 'Quit and relaunch Ness to rebind the server.'
      if (wsTokenRotated) return 'Token rotated — quit and relaunch Ness. Any pinned/bookmarked URLs will need to be replaced.'
    }
    return null
  })()

  const handleRotateWsToken = useCallback(async () => {
    const ok = window.confirm(
      'Rotate the web-client auth token?\n\nAll existing URLs — bookmarks, home-screen pins, open browser tabs — will stop working after you quit and relaunch Ness. You will need to re-share the new URL with any device you want to reconnect.'
    )
    if (!ok) return
    await backend.rotateWsToken()
    setWsTokenRotated(true)
  }, [])

  const handleSaveSystemPrompt = useCallback(async () => {
    await backend.setHarnessSystemPrompt(systemPromptDraft)
    await backend.setHarnessSystemPromptMain(systemPromptMainDraft)
    setSystemPromptSaveResult({ ok: true, message: 'Saved · new sessions will use this prompt' })
    setTimeout(() => setSystemPromptSaveResult(null), 2000)
  }, [systemPromptDraft, systemPromptMainDraft])

  const handleResetSystemPrompt = useCallback(async () => {
    await backend.setHarnessSystemPrompt('')
    await backend.setHarnessSystemPromptMain('')
    setSystemPromptSaveResult({ ok: true, message: 'Reset to defaults' })
    setTimeout(() => setSystemPromptSaveResult(null), 2000)
  }, [])

  const handleSavePrReviewPrompt = useCallback(async () => {
    await backend.setPrReviewPrompt(prReviewPromptDraft)
    setPrReviewPromptSaveResult({ ok: true, message: 'Saved' })
    setTimeout(() => setPrReviewPromptSaveResult(null), 2000)
  }, [prReviewPromptDraft])

  const handleResetPrReviewPrompt = useCallback(async () => {
    await backend.setPrReviewPrompt('')
    setPrReviewPromptSaveResult({ ok: true, message: 'Reset to default' })
    setTimeout(() => setPrReviewPromptSaveResult(null), 2000)
  }, [])

  const effectiveClaudeCommand = claudeCommandDraft.trim() || defaultClaudeCommand
  const modelPart = claudeModel && !effectiveClaudeCommand.includes('--model') ? ` --model ${claudeModel}` : ''
  const mcpPart = harnessMcpEnabled ? ' --mcp-config <per-session>' : ''
  const previewInner = `${effectiveClaudeCommand}${modelPart}${mcpPart} --session-id <uuid>`
  const commandPreview = `<shell> -ilc "${previewInner}"`

  const handleResetClaudeCommand = useCallback(async () => {
    setClaudeCommandDraft(defaultClaudeCommand)
    await backend.setClaudeCommand(defaultClaudeCommand)
    setClaudeSaveResult({ ok: true, message: 'Reset to default' })
  }, [defaultClaudeCommand])

  const handleAddEnvRow = useCallback(() => {
    setClaudeEnvRows((prev) => [...prev, { key: '', value: '' }])
    setEnvSaveResult(null)
  }, [])

  const handleRemoveEnvRow = useCallback((index: number) => {
    setClaudeEnvRows((prev) => prev.filter((_, i) => i !== index))
    setRevealedEnvRows((prev) => {
      const next = new Set<number>()
      prev.forEach((i) => { if (i < index) next.add(i); else if (i > index) next.add(i - 1) })
      return next
    })
    setEnvSaveResult(null)
  }, [])

  const handleUpdateEnvRow = useCallback((index: number, field: 'key' | 'value', value: string) => {
    setClaudeEnvRows((prev) => prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)))
    setEnvSaveResult(null)
  }, [])

  const handleToggleRevealEnvRow = useCallback((index: number) => {
    setRevealedEnvRows((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index); else next.add(index)
      return next
    })
  }, [])

  const handleSaveClaudeEnvVars = useCallback(async () => {
    const vars: Record<string, string> = {}
    const seen = new Set<string>()
    const invalidNames: string[] = []
    const duplicates: string[] = []
    for (const { key, value } of claudeEnvRows) {
      const k = key.trim()
      if (!k) continue
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
        invalidNames.push(k)
        continue
      }
      if (seen.has(k)) {
        duplicates.push(k)
        continue
      }
      seen.add(k)
      vars[k] = value
    }
    if (invalidNames.length > 0) {
      setEnvSaveResult({ ok: false, message: `Invalid name(s): ${invalidNames.join(', ')}` })
      return
    }
    if (duplicates.length > 0) {
      setEnvSaveResult({ ok: false, message: `Duplicate name(s): ${duplicates.join(', ')}` })
      return
    }
    await backend.setClaudeEnvVars(vars)
    setEnvSaveResult({ ok: true, message: 'Saved · new Claude tabs will see these' })
  }, [claudeEnvRows])

  const handleSaveLitellm = useCallback(async () => {
    const url = litellmBaseUrl.trim()
    const token = litellmAuthToken.trim()
    if (!url) {
      setLitellmSaveResult({ ok: false, message: 'Base URL is required' })
      return
    }
    const filtered = claudeEnvRows.filter(({ key }) => {
      const k = key.trim()
      return k !== 'ANTHROPIC_BASE_URL' && k !== 'ANTHROPIC_AUTH_TOKEN'
    })
    const newRows: { key: string; value: string }[] = [
      ...filtered,
      { key: 'ANTHROPIC_BASE_URL', value: url }
    ]
    if (token) newRows.push({ key: 'ANTHROPIC_AUTH_TOKEN', value: token })
    setClaudeEnvRows(newRows)
    const vars: Record<string, string> = {}
    const seen = new Set<string>()
    for (const { key, value } of newRows) {
      const k = key.trim()
      if (!k || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || seen.has(k)) continue
      seen.add(k)
      vars[k] = value
    }
    await backend.setClaudeEnvVars(vars)
    setLitellmSaveResult({ ok: true, message: 'Saved · new Claude tabs will use this endpoint' })
    setEnvSaveResult(null)
  }, [litellmBaseUrl, litellmAuthToken, claudeEnvRows])

  const handleClearLitellm = useCallback(async () => {
    setLitellmBaseUrl('')
    setLitellmAuthToken('')
    const newRows = claudeEnvRows.filter(({ key }) => {
      const k = key.trim()
      return k !== 'ANTHROPIC_BASE_URL' && k !== 'ANTHROPIC_AUTH_TOKEN'
    })
    setClaudeEnvRows(newRows)
    const vars: Record<string, string> = {}
    const seen = new Set<string>()
    for (const { key, value } of newRows) {
      const k = key.trim()
      if (!k || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || seen.has(k)) continue
      seen.add(k)
      vars[k] = value
    }
    await backend.setClaudeEnvVars(vars)
    setLitellmSaveResult({ ok: true, message: 'Cleared' })
    setEnvSaveResult(null)
  }, [claudeEnvRows])

  const handleSaveCodexCommand = useCallback(async () => {
    setCodexSaveResult(null)
    await backend.setCodexCommand(codexCommandDraft)
    setCodexSaveResult({ ok: true, message: 'Saved · new tabs will use this command' })
  }, [codexCommandDraft])

  const handleResetCodexCommand = useCallback(async () => {
    setCodexCommandDraft('codex')
    await backend.setCodexCommand('codex')
    setCodexSaveResult({ ok: true, message: 'Reset to default' })
  }, [])

  const handleSaveCursorCommand = useCallback(async () => {
    setCursorSaveResult(null)
    await backend.setCursorCommand(cursorCommandDraft)
    setCursorSaveResult({ ok: true, message: 'Saved · new tabs will use this command' })
  }, [cursorCommandDraft])

  const handleResetCursorCommand = useCallback(async () => {
    setCursorCommandDraft('agent')
    await backend.setCursorCommand('agent')
    setCursorSaveResult({ ok: true, message: 'Reset to default' })
  }, [])

  const handleSaveCodexEnvVars = useCallback(async () => {
    const vars: Record<string, string> = {}
    const seen = new Set<string>()
    const invalidNames: string[] = []
    const duplicates: string[] = []
    for (const { key, value } of codexEnvRows) {
      const k = key.trim()
      if (!k) continue
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) { invalidNames.push(k); continue }
      if (seen.has(k)) { duplicates.push(k); continue }
      seen.add(k)
      vars[k] = value
    }
    if (invalidNames.length > 0) { setCodexEnvSaveResult({ ok: false, message: `Invalid name(s): ${invalidNames.join(', ')}` }); return }
    if (duplicates.length > 0) { setCodexEnvSaveResult({ ok: false, message: `Duplicate name(s): ${duplicates.join(', ')}` }); return }
    await backend.setCodexEnvVars(vars)
    setCodexEnvSaveResult({ ok: true, message: 'Saved · new Codex tabs will see these' })
  }, [codexEnvRows])

  const handleSaveCursorEnvVars = useCallback(async () => {
    const vars: Record<string, string> = {}
    const seen = new Set<string>()
    const invalidNames: string[] = []
    const duplicates: string[] = []
    for (const { key, value } of cursorEnvRows) {
      const k = key.trim()
      if (!k) continue
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) { invalidNames.push(k); continue }
      if (seen.has(k)) { duplicates.push(k); continue }
      seen.add(k)
      vars[k] = value
    }
    if (invalidNames.length > 0) { setCursorEnvSaveResult({ ok: false, message: `Invalid name(s): ${invalidNames.join(', ')}` }); return }
    if (duplicates.length > 0) { setCursorEnvSaveResult({ ok: false, message: `Duplicate name(s): ${duplicates.join(', ')}` }); return }
    await backend.setCursorEnvVars(vars)
    setCursorEnvSaveResult({ ok: true, message: 'Saved · new Cursor Agent tabs will see these' })
  }, [cursorEnvRows])

  const isOverridden = (action: Action): boolean => {
    if (!hotkeyOverrides || !(action in hotkeyOverrides)) return false
    const defaultStr = bindingToString(DEFAULT_HOTKEYS[action])
    return hotkeyOverrides[action] !== defaultStr
  }

  const renderUpdaterStatus = (): JSX.Element | null => {
    if (!updaterStatus) return null
    switch (updaterStatus.state) {
      case 'checking':
        return (
          <div className="flex items-center gap-2 text-xs text-muted">
            <RefreshCw className="icon-xs animate-spin" />
            Checking for updates...
          </div>
        )
      case 'not-available':
        return (
          <div className="flex items-center gap-2 text-xs text-success">
            <Check className="icon-xs" />
            You&apos;re up to date
          </div>
        )
      case 'available':
        return (
          <div className="flex items-center gap-2 text-xs text-warning">
            <Download className="icon-xs" />
            <span>
              <a
                onClick={() => backend.openExternal(harnessReleaseNotesUrl(updaterStatus.version))}
                className="underline hover:text-fg-bright cursor-pointer"
              >
                Ness {updaterStatus.version}
              </a>{' '}
              available — downloading...
            </span>
          </div>
        )
      case 'downloading':
        return (
          <div className="flex items-center gap-2 text-xs text-warning">
            <Download className="icon-xs" />
            <span>
              Downloading{' '}
              <a
                onClick={() => backend.openExternal(harnessReleaseNotesUrl(updaterStatus.version))}
                className="underline hover:text-fg-bright cursor-pointer"
              >
                Ness {updaterStatus.version}
              </a>
              ... {Math.round(updaterStatus.percent)}%
            </span>
          </div>
        )
      case 'downloaded':
        return (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-xs text-success">
              <Check className="icon-xs" />
              <span>
                <a
                  onClick={() => backend.openExternal(harnessReleaseNotesUrl(updaterStatus.version))}
                  className="underline hover:text-fg-bright cursor-pointer"
                >
                  Ness {updaterStatus.version}
                </a>{' '}
                ready to install
              </span>
            </div>
            <button
              onClick={handleRestart}
              className="self-start flex items-center gap-1.5 px-3 py-1.5 bg-success/20 hover:bg-success/30 rounded text-xs text-success transition-colors cursor-pointer"
            >
              <RotateCw className="icon-xs" />
              Restart &amp; install
            </button>
          </div>
        )
      case 'error':
        return (
          <div className="flex items-center gap-2 text-xs text-danger">
            <X className="icon-xs" />
            {updaterStatus.error}
          </div>
        )
    }
  }

  const sectionQuery = sectionSearch.trim().toLowerCase()
  const searchResults = useMemo(() => {
    if (!sectionQuery) return [] as SearchItem[]
    const out: { item: SearchItem; score: number }[] = []
    for (const item of searchIndex) {
      const titleHit = item.title.toLowerCase().indexOf(sectionQuery)
      const contextHit = item.context.toLowerCase().indexOf(sectionQuery)
      if (titleHit < 0 && contextHit < 0) continue
      // Lower is better: title hits beat context hits, earlier positions
      // beat later ones. Adding the title-position lets `Diagnostics`
      // sort above a `Diagnostic logging` paragraph match.
      const score = titleHit >= 0 ? titleHit : 1000 + contextHit
      out.push({ item, score })
    }
    out.sort((a, b) => a.score - b.score)
    return out.slice(0, 50).map((r) => r.item)
  }, [sectionQuery, searchIndex])

  const focusNavItemByOffset = useCallback((current: HTMLElement | null, dir: 1 | -1) => {
    if (!sidebarRef.current) return
    const items = Array.from(
      sidebarRef.current.querySelectorAll<HTMLElement>('[data-nav]')
    )
    if (items.length === 0) return
    const idx = current ? items.indexOf(current) : -1
    let next = idx + dir
    if (next < 0) {
      // Moving up off the top item — return to the search input so the
      // user can keep typing without grabbing the mouse.
      searchInputRef.current?.focus()
      return
    }
    if (next >= items.length) next = items.length - 1
    items[next]?.focus()
  }, [])

  const handleSearchResultClick = useCallback((item: SearchItem) => {
    const el = item.element
    if (!el.isConnected) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    // Brief highlight ring so the user can spot the destination after
    // the scroll lands. Toggled via a class — animation lives in
    // styles.css (see `.harness-settings-flash`).
    el.classList.remove('harness-settings-flash')
    // Force reflow so re-adding the class restarts the animation.
    void el.offsetHeight
    el.classList.add('harness-settings-flash')
    window.setTimeout(() => el.classList.remove('harness-settings-flash'), 1600)
  }, [])

  return (
    <div className="flex flex-col h-full bg-panel">
      {/* Title bar (drag region) */}
      <div className="drag-region h-10 shrink-0 border-b border-border relative">
        <button
          onClick={onClose}
          className="no-drag absolute left-20 top-1/2 -translate-y-1/2 flex items-center gap-1.5 text-xs text-muted hover:text-fg-bright transition-colors cursor-pointer"
        >
          <ArrowLeft className="icon-sm" />
          Back
          <kbd className="text-xs text-faint bg-bg px-1.5 py-0.5 rounded border border-border font-mono">ESC</kbd>
        </button>
        <span className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 text-sm font-medium text-fg pointer-events-none">
          Settings
        </span>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Left sidebar */}
        <div
          ref={sidebarRef}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
            const target = e.target as HTMLElement
            if (!target.hasAttribute('data-nav')) return
            e.preventDefault()
            focusNavItemByOffset(target, e.key === 'ArrowDown' ? 1 : -1)
          }}
          className="w-56 border-r border-border bg-panel flex flex-col shrink-0"
        >
          <div className="px-3 py-2 flex items-center justify-between">
            <span className="text-xs font-medium text-dim">SECTIONS</span>
          </div>
          <div className="px-3 pb-2">
            <div className="relative">
              <Search
                className="icon-xs absolute left-2 top-1/2 -translate-y-1/2 text-faint pointer-events-none"
              />
              <input
                ref={searchInputRef}
                type="text"
                value={sectionSearch}
                onChange={(e) => setSectionSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    // Keep the global Settings-Escape handler from closing the
                    // panel: a search-focused Escape should clear the query
                    // (or blur if already empty), not bounce out of Settings.
                    e.preventDefault()
                    e.stopPropagation()
                    if (sectionSearch) setSectionSearch('')
                    else e.currentTarget.blur()
                    return
                  }
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    const first = sidebarRef.current?.querySelector<HTMLElement>('[data-nav]')
                    first?.focus()
                  }
                }}
                placeholder="Search settings…"
                className="w-full bg-app border border-border rounded pl-7 pr-6 py-1 text-xs text-fg-bright placeholder-faint outline-none focus:border-accent"
              />
              {sectionSearch && (
                <button
                  onClick={() => setSectionSearch('')}
                  aria-label="Clear search"
                  className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-faint hover:text-fg cursor-pointer"
                >
                  <X className="icon-2xs" />
                </button>
              )}
            </div>
          </div>
          {sectionQuery ? (
            <div className="overflow-y-auto flex-1">
              {searchResults.length === 0 && (
                <div className="px-3 py-2 text-xs text-faint">No matches</div>
              )}
              {searchResults.map((item) => (
                <button
                  key={item.key}
                  data-nav=""
                  onClick={() => handleSearchResultClick(item)}
                  className="w-full px-3 py-1.5 text-left text-xs text-muted hover:bg-panel-raised hover:text-fg-bright transition-colors cursor-pointer flex flex-col gap-0.5 focus:bg-surface focus:text-fg-bright outline-none"
                >
                  <span className="text-fg-bright truncate">
                    {highlightMatch(item.title, sectionQuery)}
                  </span>
                  <span className="text-faint text-xs truncate">{item.context}</span>
                </button>
              ))}
            </div>
          ) : (
            SECTIONS.map((section) => {
            const Icon = section.icon
            const isActive = activeSection === section.id
            const needsAttention = section.id === 'github' && !hasToken && authSource !== 'gh-cli'
            const className = needsAttention
              ? `flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors cursor-pointer ${
                  isActive ? 'bg-info/25 text-info' : 'bg-info/10 text-info hover:bg-info/20'
                }`
              : `flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors cursor-pointer ${
                  isActive
                    ? 'bg-surface text-fg-bright'
                    : 'text-muted hover:bg-panel-raised hover:text-fg-bright'
                }`
            return (
              <div key={section.id}>
                <button
                  data-nav=""
                  onClick={() => scrollToSection(section.id)}
                  className={`w-full ${className} focus:bg-surface outline-none`}
                >
                  <Icon className="icon-sm shrink-0" />
                  <span>{section.label}</span>
                </button>
                {section.children && (
                  <div
                    className="overflow-hidden transition-all duration-200"
                    style={{
                      maxHeight: isActive ? `${section.children.length * 36}px` : '0px',
                      opacity: isActive ? 1 : 0
                    }}
                  >
                    {section.children.map((child) => {
                      const isSubActive = activeSubSection === child.id
                      return (
                        <button
                          key={child.id}
                          // Only navigable when the parent is expanded —
                          // hidden subsections shouldn't trap arrow focus.
                          data-nav={isActive ? '' : undefined}
                          tabIndex={isActive ? 0 : -1}
                          onClick={() => scrollToSubSection(child.id)}
                          className={`w-full pl-9 pr-3 py-1.5 text-left text-xs transition-colors cursor-pointer focus:bg-surface focus:text-fg-bright outline-none ${
                            isSubActive
                              ? 'text-fg-bright bg-surface/60'
                              : 'text-muted hover:text-fg-bright hover:bg-panel-raised'
                          }`}
                        >
                          {child.label}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          }))}

          <div className="mt-auto border-t border-border px-3 py-2">
            <span className="text-xs font-medium text-dim">HELP</span>
          </div>
          <button
            onClick={onOpenGuide}
            className="flex items-center gap-2 px-3 py-2 text-left text-sm text-muted hover:bg-panel-raised hover:text-fg-bright transition-colors cursor-pointer"
          >
            <BookOpen className="icon-sm shrink-0" />
            <span>Worktree Guide</span>
          </button>
          <button
            onClick={onOpenMyWeek}
            className="flex items-center gap-2 px-3 py-2 text-left text-sm text-muted hover:bg-panel-raised hover:text-fg-bright transition-colors cursor-pointer"
          >
            <CalendarDays className="icon-sm shrink-0" />
            <span>My week</span>
          </button>
        </div>

        {/* Main scrollable content */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <div className="max-w-2xl p-8 pb-[60vh] space-y-12">
            {/* General section */}
            <section ref={(el) => { sectionRefs.current.general = el }} id="general">
              <h2 className="text-lg font-semibold text-fg-bright mb-1">General</h2>
              <p className="text-sm text-dim mb-4">
                App-wide behavior.
              </p>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={warnBeforeQuitting}
                  onChange={(e) => handleToggleWarnBeforeQuitting(e.target.checked)}
                  className="mt-0.5 cursor-pointer icon-base" />
                <div className="flex-1">
                  <div className="text-sm text-fg-bright">Warn before quitting (⌘Q)</div>
                  <div className="text-xs text-dim mt-0.5">
                    When enabled, you must hold ⌘Q briefly to quit — a tap shows a
                    reminder and does nothing, so you don&apos;t lose running agents
                    and terminals by accident. Disable to quit immediately on ⌘Q.
                  </div>
                </div>
              </label>
            </section>

            {/* Appearance section */}
            <section ref={(el) => { sectionRefs.current.appearance = el }} id="appearance">
              <h2 className="text-lg font-semibold text-fg-bright mb-1">Appearance</h2>
              <p className="text-sm text-dim mb-4">
                Size, theme, and terminal font for the whole app.
              </p>

              <div ref={(el) => { subSectionRefs.current['appearance-theme'] = el }} id="appearance-theme" />
              {/* Mode picker — native radio inputs styled as a segmented
                   control. Radios give us proper keyboard semantics for free
                   (arrow keys move focus, space activates) */}
              <fieldset className="mb-6">
                <legend className="text-sm font-semibold text-fg-bright mb-2">Mode</legend>
                <div className="grid grid-cols-3 gap-2">
                  {([
                    { id: 'light', label: 'Light' },
                    { id: 'dark', label: 'Dark' },
                    { id: 'system', label: 'Follow system' }
                  ] as const).map((opt) => {
                    const isActive = themeMode === opt.id
                    return (
                      <label
                        key={opt.id}
                        className={`px-3 py-2 rounded-lg border text-sm text-center cursor-pointer transition-colors ${
                          isActive
                            ? 'bg-surface text-fg-bright border-fg'
                            : 'bg-panel-raised text-muted border-border hover:text-fg hover:border-border-strong'
                        }`}
                      >
                        <input
                          type="radio"
                          name="theme-mode"
                          value={opt.id}
                          checked={isActive}
                          onChange={() => handleSelectThemeMode(opt.id)}
                          className="sr-only"
                        />
                        {opt.label}
                      </label>
                    )
                  })}
                </div>
              </fieldset>

              <ThemeModePicker
                title="Light theme"
                hint="Used when mode is Light, or when System resolves to light."
                builtIns={BUILT_IN_THEMES_BY_MODE.light}
                customs={customThemes.filter((t) => t.mode === 'light')}
                activeId={themeLight}
                disabled={themeMode === 'dark'}
                onSelect={handleSelectLightTheme}
              />

              <div className="mt-6" />

              <ThemeModePicker
                title="Dark theme"
                hint="Used when mode is Dark, or when System resolves to dark."
                builtIns={BUILT_IN_THEMES_BY_MODE.dark}
                customs={customThemes.filter((t) => t.mode === 'dark')}
                activeId={themeDark}
                disabled={themeMode === 'light'}
                onSelect={handleSelectDarkTheme}
              />

              <div ref={(el) => { subSectionRefs.current['appearance-custom-themes'] = el }} id="appearance-custom-themes" className="mt-8">
                <h3 className="text-sm font-semibold text-fg-bright mb-1">Custom themes</h3>
                <p className="text-xs text-dim mb-3">
                  Drop <code className="text-fg">{'<name>.json'}</code> files into your themes folder. They show up in the pickers above, filtered by their <code className="text-fg">mode</code>. {customThemes.length === 0 ? 'None loaded yet.' : `${customThemes.length} loaded.`}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={async () => { await backend.openThemesFolder() }}
                    className="px-3 py-1.5 rounded-md border border-border text-sm text-fg bg-panel-raised hover:bg-surface cursor-pointer"
                  >
                    Open themes folder
                  </button>
                  <button
                    type="button"
                    onClick={async () => { await backend.reloadCustomThemes() }}
                    className="px-3 py-1.5 rounded-md border border-border text-sm text-fg bg-panel-raised hover:bg-surface cursor-pointer"
                  >
                    Reload from disk
                  </button>
                </div>
              </div>

              <div ref={(el) => { subSectionRefs.current['appearance-nessie'] = el }} id="appearance-nessie" />
              {/* Nessie's colour — the app's primary. Swatches paint from the
                  preset's own gradient string, so `legacy` previews as the real
                  three-stop sweep rather than a flat approximation of it. */}
              <fieldset className="mt-6 mb-6">
                <legend className="text-sm font-semibold text-fg-bright mb-1">Nessie&rsquo;s colour</legend>
                <p className="text-sm text-dim mb-3">
                  Colours the mark, the wordmark, and Ness&rsquo;s own tool cards. Your theme still
                  owns everything else — message bubbles, links and focus rings stay on its
                  secondary colour, so this doesn&rsquo;t flatten the palette. A custom theme can
                  override it with{' '}
                  <code className="bg-app/50 px-1 rounded">brand</code>,{' '}
                  <code className="bg-app/50 px-1 rounded">brand-mid</code> or{' '}
                  <code className="bg-app/50 px-1 rounded">brand-deep</code>.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {NESSIE_COLORS.map((c) => {
                    const isActive = nessieColor === c.id
                    return (
                      <label
                        key={c.id}
                        className={`flex items-center gap-3 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                          isActive
                            ? 'border-brand bg-surface'
                            : 'border-border bg-panel-raised hover:bg-surface'
                        }`}
                      >
                        <input
                          type="radio"
                          name="nessie-color"
                          className="sr-only"
                          checked={isActive}
                          onChange={() => { void backend.setNessieColor(c.id) }}
                        />
                        {/* Nessie herself, not a colour chip — the preset's
                            background is painted through her silhouette with a
                            mask, so `legacy` previews as its real gradient. */}
                        <span
                          aria-hidden="true"
                          className="w-10 h-6 shrink-0"
                          style={{
                            backgroundImage: c.gradient,
                            WebkitMaskImage: NESS_MARK_MASK,
                            maskImage: NESS_MARK_MASK,
                            WebkitMaskSize: 'contain',
                            maskSize: 'contain',
                            WebkitMaskRepeat: 'no-repeat',
                            maskRepeat: 'no-repeat',
                            WebkitMaskPosition: 'center',
                            maskPosition: 'center'
                          }}
                        />
                        <span className="min-w-0">
                          <span className="block text-sm text-fg-bright truncate">{c.label}</span>
                          <span className="block text-xs text-dim truncate">{c.blurb}</span>
                        </span>
                      </label>
                    )
                  })}
                </div>
              </fieldset>

              <div ref={(el) => { subSectionRefs.current['appearance-ui-size'] = el }} id="appearance-ui-size" />
              {/* UI scale — drives the root html font-size, so every rem
                  unit (text-xs/sm/base/lg, w-N/h-N icons, padding-*, gap-*)
                  scales in lockstep. Native range gives free keyboard
                  semantics; the four notches are also clickable labels.
                  Drag is staged in draftUiScale so the whole app doesn't
                  reflow on every tick — Save commits, Cancel reverts,
                  and closing Settings without saving drops the draft. */}
              <h3 className="text-sm font-semibold text-fg-bright mt-6 mb-1">UI size</h3>
              <p className="text-xs text-dim mb-3">
                Scales the entire app — affects sidebar, panels, dialogs.
                Larger sizes are friendlier for screen-sharing; small packs
                more on screen.
              </p>
              {(() => {
                const idx = SCALES.findIndex((s) => s.id === draftUiScale)
                return (
                  <>
                    <input
                      type="range"
                      min={0}
                      max={SCALES.length - 1}
                      step={1}
                      value={idx < 0 ? 0 : idx}
                      onChange={(e) => {
                        const v = Number(e.target.value)
                        const next = SCALES[v]
                        if (next) handleSelectUiScale(next.id)
                      }}
                      aria-label="UI size"
                      className="w-full accent-accent cursor-pointer"
                    />
                    <div className="mt-1 flex justify-between text-xs text-dim select-none">
                      {SCALES.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => handleSelectUiScale(s.id)}
                          className={`cursor-pointer transition-colors ${
                            draftUiScale === s.id ? 'text-fg-bright' : 'hover:text-fg'
                          }`}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                  </>
                )
              })()}

              {/* Scoped preview — inline em-based sizes anchored to the
                  draft rung, so dragging only resizes this box. The real
                  UI shifts on Save (App.tsx watches settings.uiScale). */}
              <div
                className="mt-3 rounded border border-border bg-panel/60"
                style={{
                  fontSize: `${draftScaleSpec.rootPx}px`,
                  padding: '0.75em',
                  lineHeight: 1.4
                }}
              >
                <div
                  style={{
                    fontSize: '0.625em',
                    color: 'var(--color-dim)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    fontWeight: 500
                  }}
                >
                  Preview · {draftScaleSpec.label} ({draftScaleSpec.rootPx}px)
                </div>
                <div
                  style={{
                    marginTop: '0.5em',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5em'
                  }}
                >
                  <span
                    style={{
                      width: '0.5em',
                      height: '0.5em',
                      borderRadius: '50%',
                      background: 'var(--color-success)',
                      flexShrink: 0
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.875em', color: 'var(--color-fg-bright)' }}>
                      my-branch
                    </div>
                    <div style={{ fontSize: '0.6875em', color: 'var(--color-faint)' }}>
                      last touched 3m ago
                    </div>
                  </div>
                  <button
                    type="button"
                    tabIndex={-1}
                    style={{
                      fontSize: '0.6875em',
                      padding: '0.25em 0.5em',
                      borderRadius: '0.25em',
                      background:
                        'color-mix(in srgb, var(--color-accent) 20%, transparent)',
                      color: 'var(--color-fg-bright)',
                      border:
                        '1px solid color-mix(in srgb, var(--color-accent) 40%, transparent)',
                      cursor: 'default'
                    }}
                  >
                    Action
                  </button>
                </div>
              </div>

              {uiScaleDirty && (
                <div className="mt-3 flex items-center justify-end gap-2 text-xs">
                  <button
                    type="button"
                    onClick={handleSaveUiScale}
                    className="px-2.5 py-1 rounded bg-accent/20 hover:bg-accent/30 text-fg-bright border border-accent/40 cursor-pointer transition-colors"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={handleRevertUiScale}
                    className="px-2.5 py-1 rounded text-dim hover:text-fg cursor-pointer transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              )}

              <div ref={(el) => { subSectionRefs.current['appearance-terminal-font'] = el }} id="appearance-terminal-font" />
              <h3 className="text-sm font-semibold text-fg-bright mt-6 mb-1">Terminal font</h3>
              <p className="text-xs text-dim mb-3">
                Used by every Claude and shell tab. Provide any CSS font-family value
                — install the font on your system first (e.g.{' '}
                <code className="bg-panel-raised px-1 rounded">Hack</code>,{' '}
                <code className="bg-panel-raised px-1 rounded">'JetBrains Mono'</code>,{' '}
                <code className="bg-panel-raised px-1 rounded">'Fira Code'</code>).
                Changes apply immediately to all open terminals.
              </p>

              <div className="bg-panel-raised border border-border rounded-lg p-4 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-fg mb-1">Font family</label>
                  <input
                    type="text"
                    value={terminalFontFamily}
                    onChange={(e) => handleTerminalFontFamilyChange(e.target.value)}
                    spellCheck={false}
                    className="w-full bg-panel border border-border-strong rounded px-3 py-2 text-xs text-fg-bright placeholder-faint outline-none focus:border-fg font-mono"
                    placeholder={defaultTerminalFontFamily}
                  />
                  {terminalFontFamily !== defaultTerminalFontFamily && defaultTerminalFontFamily && (
                    <button
                      onClick={handleResetTerminalFontFamily}
                      className="mt-2 flex items-center gap-1 px-2 py-1 text-xs text-dim hover:text-fg transition-colors cursor-pointer"
                    >
                      <RotateCcw className="icon-xs" />
                      Reset to default
                    </button>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-fg mb-1">
                    Font size <span className="text-dim font-normal">({terminalFontSize}px)</span>
                  </label>
                  <input
                    type="range"
                    min={8}
                    max={24}
                    step={1}
                    value={terminalFontSize}
                    onChange={(e) => handleTerminalFontSizeChange(Number(e.target.value))}
                    className="w-full accent-fg cursor-pointer"
                  />
                </div>

                <div
                  className="rounded border border-border-strong bg-panel px-3 py-2 text-fg-bright"
                  style={{
                    fontFamily: terminalFontFamily || defaultTerminalFontFamily,
                    fontSize: `${terminalFontSize}px`,
                    lineHeight: 1.4
                  }}
                >
                  the quick brown fox 0123 =&gt; != &lt;= -&gt;
                </div>
              </div>

              <div ref={(el) => { subSectionRefs.current['appearance-sidebar'] = el }} id="appearance-sidebar" />
              <h3 className="text-sm font-semibold text-fg-bright mt-6 mb-1">Sidebar row preview</h3>
              <p className="text-xs text-dim mb-3">
                Live preview using mock data — every detail item is present so
                the checkboxes below have something to toggle. Real rows only
                include items with actual data (e.g. milestone hides when the
                PR has none).
              </p>
              <SidebarRowPreview density={sidebarDensity} prefs={sidebarDetails[sidebarDensity]} />

              <h3 className="text-sm font-semibold text-fg-bright mt-6 mb-1">Sidebar row density</h3>
              <p className="text-xs text-dim mb-3">
                Comfy stacks the label and detail cluster on two lines. Compact
                folds it all onto a single line. Rows waiting on approval always
                switch to two lines so the pending-tool alert stays visible.
              </p>
              <div className="space-y-2 mb-6">
                {(
                  [
                    {
                      id: 'comfy' as const,
                      label: 'Comfy',
                      description: 'Two lines — label on top, detail cluster below'
                    },
                    {
                      id: 'compact' as const,
                      label: 'Compact',
                      description: 'Single line — detail cluster on the right'
                    }
                  ]
                ).map((opt) => {
                  const isActive = sidebarDensity === opt.id
                  return (
                    <button
                      key={opt.id}
                      onClick={() => void backend.setSidebarDensity(opt.id)}
                      className={`w-full text-left rounded border px-3 py-2 transition-colors cursor-pointer ${
                        isActive
                          ? 'border-accent bg-panel-raised'
                          : 'border-border hover:border-border-strong'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <div
                          className={`w-3 h-3 rounded-full border ${
                            isActive ? 'border-accent bg-accent' : 'border-border-strong'
                          }`}
                        />
                        <span className="text-sm text-fg-bright">{opt.label}</span>
                      </div>
                      <p className="text-xs text-dim mt-1 ml-5">{opt.description}</p>
                    </button>
                  )
                })}
              </div>

              <h3 className="text-sm font-semibold text-fg-bright mt-6 mb-1">
                Worktree details <span className="text-dim font-normal">— {sidebarDensity === 'compact' ? 'Compact' : 'Comfy'} mode</span>
              </h3>
              <p className="text-xs text-dim mb-3">
                Which items to include in the detail cluster for the currently
                selected density. Each mode has its own independent toggles —
                switch density above to configure the other set. Items only
                render when they have data (e.g. milestone won't show if the
                PR has none).
              </p>
              <div className="bg-panel-raised border border-border rounded-lg p-4 space-y-2">
                {(
                  [
                    { id: 'repoLabel' as const, label: 'Repo label', description: 'Which repository (shown in multi-repo mode)' },
                    { id: 'branch' as const, label: 'Branch name', description: 'Original branch when a worktree has an alias' },
                    { id: 'age' as const, label: 'Age', description: 'How long the worktree has existed' },
                    { id: 'diff' as const, label: 'Diff stats', description: 'PR additions/deletions (+X/−Y)' },
                    { id: 'milestone' as const, label: 'Milestone', description: 'GitHub milestone title if set' },
                    { id: 'prNumber' as const, label: 'PR number', description: 'The #123 badge for the associated PR' },
                    { id: 'assignee' as const, label: 'Assignee avatar', description: 'Avatar of the PR’s first assignee' }
                  ]
                ).map((opt) => (
                  <label key={opt.id} className="flex items-start gap-3 cursor-pointer py-1">
                    <input
                      type="checkbox"
                      checked={sidebarDetails[sidebarDensity][opt.id]}
                      onChange={() => void backend.setSidebarDetails({
                        ...sidebarDetails,
                        [sidebarDensity]: {
                          ...sidebarDetails[sidebarDensity],
                          [opt.id]: !sidebarDetails[sidebarDensity][opt.id]
                        }
                      })}
                      className="mt-0.5 w-4 h-4 accent-accent cursor-pointer"
                    />
                    <div className="flex-1">
                      <div className="text-sm text-fg-bright">{opt.label}</div>
                      <p className="text-xs text-dim mt-0.5">{opt.description}</p>
                    </div>
                  </label>
                ))}
              </div>

            </section>

            {/* Agent section */}
            <section ref={(el) => { sectionRefs.current.agent = el }} id="agent">
              <h2 className="text-lg font-semibold text-fg-bright mb-1">Agent</h2>
              <p className="text-sm text-dim mb-4">
                Choose which AI coding agent Ness launches in new tabs.
              </p>

              {/* ── General subsection ── */}
              <div ref={(el) => { subSectionRefs.current['agent-general'] = el }} id="agent-general">
              <div className="bg-panel-raised border border-border rounded-lg p-4 mb-6">
                <label className="block text-sm font-medium text-fg mb-3">Default agent</label>
                <div className="flex gap-2">
                  {AGENT_REGISTRY.map((agent) => (
                    <button
                      key={agent.kind}
                      onClick={() => {
                        void backend.setDefaultAgent(agent.kind)
                        scrollToSubSection(agentSubSectionId(agent.kind))
                      }}
                      className={`flex items-center gap-2 px-4 py-2 rounded text-sm font-medium transition-colors cursor-pointer ${
                        defaultAgent === agent.kind
                          ? 'bg-surface text-fg-bright border border-fg'
                          : 'bg-panel border border-border text-dim hover:text-fg hover:border-border-strong'
                      }`}
                    >
                      <AgentIcon kind={agent.kind} className="icon-sm" />
                      {agent.displayName}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-xs text-faint">
                  New agent tabs will use the selected default. Existing tabs are unaffected.
                </p>

                {defaultAgent === 'claude' && (
                  <div className="mt-4 pt-4 border-t border-border pl-4 border-l-2 border-l-border ml-1">
                    <label className="block text-sm font-medium text-fg mb-2">Interface</label>
                    <p className="text-xs text-dim mb-3">
                      Which interface new Claude tabs spawn in. Switch any
                      existing tab from its right-click menu or the chip in
                      the tab header.
                    </p>
                    <InterfaceToggle
                      value={defaultClaudeTabType}
                      onChange={(value) => { void backend.setDefaultClaudeTabType(value) }}
                    />
                  </div>
                )}
              </div>

              <h3 className="text-sm font-semibold text-fg-bright mt-6 mb-3">
                Status hooks
              </h3>
              <div className="bg-panel-raised border border-border rounded-lg p-4">
                <p className="text-xs text-dim mb-3">
                  Ness installs a small hook at{' '}
                  <code className="bg-panel px-1 rounded">~/.claude/settings.json</code>,{' '}
                  <code className="bg-panel px-1 rounded">~/.codex/hooks.json</code>, and{' '}
                  <code className="bg-panel px-1 rounded">~/.cursor/hooks.json</code> so it can
                  detect when each agent tab is processing, waiting, or awaiting approval.
                  The hook only emits when <code className="bg-panel px-1 rounded">$HARNESS_TERMINAL_ID</code>{' '}
                  is set — sessions you launch outside Ness are untouched.
                </p>
                <div className="flex items-center gap-2">
                  {hooksConsent === 'accepted' ? (
                    <>
                      <span className="text-xs text-success flex items-center gap-1"><Check className="icon-xs" />Installed</span>
                      <button
                        onClick={() => void backend.uninstallHooks()}
                        className="ml-auto px-3 py-1.5 bg-surface hover:bg-surface-hover rounded text-sm text-fg-bright transition-colors cursor-pointer"
                      >
                        Remove hooks
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="text-xs text-dim">
                        {hooksConsent === 'declined' ? 'Declined' : 'Not installed'}
                      </span>
                      <button
                        onClick={() => void backend.acceptHooks()}
                        className="ml-auto px-3 py-1.5 bg-surface hover:bg-surface-hover rounded text-sm text-fg-bright transition-colors cursor-pointer"
                      >
                        Install hooks
                      </button>
                    </>
                  )}
                </div>
              </div>
              </div>

              <div className="flex flex-col">
              {/* ── Claude subsection ── */}
              <div ref={(el) => { subSectionRefs.current['agent-claude'] = el }} id="agent-claude" className="mt-8" style={{ order: agentSubsectionDisplayOrder('claude', defaultAgent) }}>
              <h3 className="text-sm font-semibold text-fg-bright mb-3 flex items-center gap-2">
                Claude Code
                {defaultAgent === 'claude' && <span className="text-xs font-normal text-dim bg-panel px-1.5 py-0.5 rounded">default</span>}
              </h3>

              <div className="bg-panel-raised border border-border rounded-lg p-4 mb-4">
                <label className="block text-sm font-medium text-fg mb-1">Model</label>
                <p className="text-xs text-dim mb-2">
                  Appends <code className="bg-panel px-1 rounded">--model</code> to the launch command. Leave on default to let the CLI choose. Auto-updating entries track Anthropic's releases; pinned versions stay put.
                </p>
                <select
                  value={claudeModel || ''}
                  onChange={(e) => { void backend.setClaudeModel(e.target.value || null) }}
                  className="w-full bg-panel border border-border-strong rounded px-3 py-2 text-sm text-fg-bright outline-none focus:border-fg cursor-pointer"
                >
                  <option value="">(Default — let CLI choose)</option>
                  <optgroup label="Auto-updating">
                    {CLAUDE_MODELS.filter((m) => m.tier === 'alias').map((m) => (
                      <option key={m.id} value={m.id}>{m.displayName}</option>
                    ))}
                  </optgroup>
                  <optgroup label="Pinned version">
                    {CLAUDE_MODELS.filter((m) => m.tier === 'current').map((m) => (
                      <option key={m.id} value={m.id}>{m.displayName}</option>
                    ))}
                  </optgroup>
                  <optgroup label="Legacy">
                    {CLAUDE_MODELS.filter((m) => m.tier === 'legacy').map((m) => (
                      <option key={m.id} value={m.id}>{m.displayName}</option>
                    ))}
                  </optgroup>
                </select>
              </div>

              <div className="bg-panel-raised border border-border rounded-lg p-4">
                <label className="block text-sm font-medium text-fg mb-1">Launch command</label>
                <p className="text-xs text-dim mb-2">
                  Ness appends <code className="bg-panel px-1 rounded">--session-id &lt;uuid&gt;</code> so each tab has its own stable, resumable session.
                </p>
                <textarea
                  value={claudeCommandDraft}
                  onChange={(e) => setClaudeCommandDraft(e.target.value)}
                  rows={2}
                  spellCheck={false}
                  className="w-full bg-panel border border-border-strong rounded px-3 py-2 text-xs text-fg-bright placeholder-faint outline-none focus:border-fg font-mono resize-y"
                  placeholder={defaultClaudeCommand}
                />
                <div className="flex items-center gap-2 mt-3">
                  <button onClick={handleSaveClaudeCommand} disabled={!claudeCommandDraft.trim()} className="px-3 py-1.5 bg-surface hover:bg-surface-hover disabled:opacity-40 rounded text-sm text-fg-bright transition-colors cursor-pointer">Save</button>
                  {claudeCommandDraft !== defaultClaudeCommand && defaultClaudeCommand && (
                    <button onClick={handleResetClaudeCommand} className="flex items-center gap-1 px-3 py-1.5 text-sm text-dim hover:text-fg transition-colors cursor-pointer"><RotateCcw className="icon-xs" />Reset</button>
                  )}
                </div>
                {claudeSaveResult && (
                  <div className={`mt-3 text-xs flex items-center gap-1.5 ${claudeSaveResult.ok ? 'text-success' : 'text-danger'}`}>
                    {claudeSaveResult.ok ? <Check className="icon-xs" /> : <X className="icon-xs" />}{claudeSaveResult.message}
                  </div>
                )}

                <div className="mt-4 pt-3 border-t border-border">
                  <label className="block text-xs font-medium text-fg mb-1">Full command preview</label>
                  <div className="bg-panel border border-border rounded px-3 py-2 text-xs text-fg-bright font-mono break-all">{commandPreview}</div>
                  <p className="text-xs text-dim mt-1">where <code className="bg-panel px-1 rounded">{`<shell>`}</code> is your <code className="bg-panel px-1 rounded">$SHELL</code> (typically <code className="bg-panel px-1 rounded">/bin/bash</code> or <code className="bg-panel px-1 rounded">/bin/zsh</code>).</p>
                </div>

                <div className="mt-4 pt-3 border-t border-border">
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input type="checkbox" checked={harnessMcpEnabled} onChange={(e) => handleToggleHarnessMcp(e.target.checked)} className="mt-0.5 cursor-pointer icon-base" />
                    <div className="flex-1">
                      <div className="text-sm text-fg-bright">Enable Ness MCP</div>
                      <div className="text-xs text-dim mt-0.5">
                        Injects <code className="bg-panel px-1 rounded text-xs">ness-control</code> MCP server via <code className="bg-panel px-1 rounded text-xs">--mcp-config</code>.
                      </div>
                    </div>
                  </label>
                </div>


                <div className="mt-4 pt-3 border-t border-border">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input type="checkbox" checked={nameClaudeSessions} onChange={(e) => { void backend.setNameClaudeSessions(e.target.checked) }} className="accent-current icon-base cursor-pointer" />
                    <div>
                      <span className="text-sm font-medium text-fg">Name sessions by worktree</span>
                      <p className="text-xs text-dim mt-0.5">Passes <code className="bg-panel px-1 rounded">--name &quot;repo/branch&quot;</code> to Claude.</p>
                    </div>
                  </label>
                </div>

                <div className="mt-4 pt-3 border-t border-border">
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input type="checkbox" checked={claudeTuiFullscreen} onChange={(e) => { void backend.setClaudeTuiFullscreen(e.target.checked) }} className="mt-0.5 cursor-pointer icon-base" />
                    <div className="flex-1">
                      <div className="text-sm text-fg-bright">Fullscreen TUI by default</div>
                      <div className="text-xs text-dim mt-0.5">
                        Sets <code className="bg-panel px-1 rounded text-xs">CLAUDE_CODE_NO_FLICKER=1</code> so Claude runs in fullscreen TUI mode instead of taking over your scrollback.
                      </div>
                    </div>
                  </label>
                </div>
              </div>

              <div className="mt-4 bg-panel-raised border border-border rounded-lg p-4">
                <label className="block text-sm font-medium text-fg mb-1">Custom Claude API endpoint</label>
                <p className="text-xs text-dim mb-3">
                  Point Claude at a LiteLLM proxy, AWS Bedrock proxy, or another OpenAI/Anthropic-compatible gateway. Sets the <code className="bg-panel px-1 rounded">ANTHROPIC_BASE_URL</code> and <code className="bg-panel px-1 rounded">ANTHROPIC_AUTH_TOKEN</code> env vars under the hood — leave blank to talk to Anthropic directly.
                </p>
                <div className="space-y-2">
                  <div>
                    <label className="block text-xs font-medium text-dim mb-1">Base URL</label>
                    <input
                      type="text"
                      value={litellmBaseUrl}
                      onChange={(e) => { setLitellmBaseUrl(e.target.value); setLitellmSaveResult(null) }}
                      placeholder="http://localhost:4000"
                      spellCheck={false}
                      className="w-full bg-panel border border-border-strong rounded px-2 py-1.5 text-xs text-fg-bright placeholder-faint outline-none focus:border-fg font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-dim mb-1">Auth token <span className="text-faint">(optional)</span></label>
                    <div className="flex items-center gap-2">
                      <input
                        type={litellmAuthRevealed ? 'text' : 'password'}
                        value={litellmAuthToken}
                        onChange={(e) => { setLitellmAuthToken(e.target.value); setLitellmSaveResult(null) }}
                        placeholder="sk-..."
                        spellCheck={false}
                        className="flex-1 bg-panel border border-border-strong rounded px-2 py-1.5 text-xs text-fg-bright placeholder-faint outline-none focus:border-fg font-mono"
                      />
                      <Tooltip label={litellmAuthRevealed ? 'Hide token' : 'Reveal token'}>
                        <button onClick={() => setLitellmAuthRevealed((v) => !v)} className="p-1.5 text-dim hover:text-fg transition-colors cursor-pointer">
                          {litellmAuthRevealed ? <EyeOff className="icon-sm" /> : <Eye className="icon-sm" />}
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 mt-3">
                  <button onClick={handleSaveLitellm} disabled={!litellmBaseUrl.trim()} className="px-3 py-1.5 bg-surface hover:bg-surface-hover disabled:opacity-40 rounded text-sm text-fg-bright transition-colors cursor-pointer">Save endpoint</button>
                  {(claudeEnvVars['ANTHROPIC_BASE_URL'] || claudeEnvVars['ANTHROPIC_AUTH_TOKEN']) && (
                    <button onClick={handleClearLitellm} className="px-3 py-1.5 text-sm text-dim hover:text-fg transition-colors cursor-pointer">Clear</button>
                  )}
                </div>
                {litellmSaveResult && (
                  <div className={`mt-3 text-xs flex items-center gap-1.5 ${litellmSaveResult.ok ? 'text-success' : 'text-danger'}`}>
                    {litellmSaveResult.ok ? <Check className="icon-xs" /> : <X className="icon-xs" />}{litellmSaveResult.message}
                  </div>
                )}
              </div>

              <div className="mt-4 bg-panel-raised border border-border rounded-lg p-4">
                <label className="block text-sm font-medium text-fg mb-1">Environment variables</label>
                <p className="text-xs text-dim mb-3">
                  Injected into Claude tabs. Use for <code className="bg-panel px-1 rounded">ANTHROPIC_API_KEY</code> etc.
                </p>
                {claudeEnvRows.length > 0 && (
                  <div className="space-y-2 mb-3">
                    {claudeEnvRows.map((row, index) => {
                      const revealed = revealedEnvRows.has(index)
                      return (
                        <div key={index} className="flex items-center gap-2">
                          <input type="text" value={row.key} onChange={(e) => handleUpdateEnvRow(index, 'key', e.target.value)} placeholder="NAME" spellCheck={false} className="w-44 bg-panel border border-border-strong rounded px-2 py-1.5 text-xs text-fg-bright placeholder-faint outline-none focus:border-fg font-mono" />
                          <span className="text-dim text-xs">=</span>
                          <input type={revealed ? 'text' : 'password'} value={row.value} onChange={(e) => handleUpdateEnvRow(index, 'value', e.target.value)} placeholder="value" spellCheck={false} className="flex-1 bg-panel border border-border-strong rounded px-2 py-1.5 text-xs text-fg-bright placeholder-faint outline-none focus:border-fg font-mono" />
                          <Tooltip label={revealed ? 'Hide value' : 'Reveal value'}><button onClick={() => handleToggleRevealEnvRow(index)} className="p-1.5 text-dim hover:text-fg transition-colors cursor-pointer">{revealed ? <EyeOff className="icon-sm" /> : <Eye className="icon-sm" />}</button></Tooltip>
                          <Tooltip label="Remove"><button onClick={() => handleRemoveEnvRow(index)} className="p-1.5 text-dim hover:text-danger transition-colors cursor-pointer"><Trash2 className="icon-sm" /></button></Tooltip>
                        </div>
                      )
                    })}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <button onClick={handleAddEnvRow} className="flex items-center gap-1 px-3 py-1.5 bg-surface hover:bg-surface-hover rounded text-sm text-fg-bright transition-colors cursor-pointer"><Plus className="icon-xs" />Add variable</button>
                  <button onClick={handleSaveClaudeEnvVars} className="px-3 py-1.5 bg-surface hover:bg-surface-hover rounded text-sm text-fg-bright transition-colors cursor-pointer">Save</button>
                </div>
                {envSaveResult && (
                  <div className={`mt-3 text-xs flex items-center gap-1.5 ${envSaveResult.ok ? 'text-success' : 'text-danger'}`}>
                    {envSaveResult.ok ? <Check className="icon-xs" /> : <X className="icon-xs" />}{envSaveResult.message}
                  </div>
                )}
              </div>

              {/* Chat interface settings — only relevant when running
                  Chat tabs, but always visible so the controls are findable. */}
              <div className="mt-4 bg-panel-raised border border-border rounded-lg p-4">
                <label className="block text-sm font-medium text-fg mb-1">Chat interface</label>
                <p className="text-xs text-dim mb-3">
                  Behavior for Claude tabs running the Chat interface
                  (inline tool cards, approval flows). No effect on
                  Terminal tabs.
                </p>

                <div className="pt-3 border-t border-border">
                  <label className="block text-xs font-medium text-fg mb-1">
                    Default permission mode for new chats
                  </label>
                  <div className="text-xs text-dim mb-2">
                    New Chat tabs start in this mode. Change per-chat
                    anytime via the statusline picker.
                  </div>
                  <select
                    value={jsonModeDefaultPermissionMode}
                    onChange={(e) => {
                      const v = e.target.value
                      void backend.setJsonModeDefaultPermissionMode(
                        isJsonClaudePermissionMode(v) ? v : 'acceptEdits'
                      )
                    }}
                    className="bg-panel border border-border-strong rounded px-2 py-1 text-xs text-fg-bright outline-none focus:border-fg cursor-pointer"
                  >
                    <option value="acceptEdits">
                      Accept edits — auto-allow Edit/Write, ask for Bash and other tools
                    </option>
                    <option value="default">
                      Ask every time — surface every tool call for approval
                    </option>
                    <option value="plan">
                      Plan mode — read-only, the agent proposes but doesn't act
                    </option>
                    <option value="auto">
                      Auto — Claude decides what's safe to run and only asks about risky calls
                    </option>
                  </select>
                </div>

                <div className="mt-4 pt-3 border-t border-border">
                  <label className="block text-xs font-medium text-fg mb-1">
                    Auto-sleep idle chats after
                  </label>
                  <div className="text-xs text-dim mb-2">
                    A Chat tab waiting for your reply for this long
                    (yellow dot) gets its subprocess torn down to free
                    RAM. Click the tab to wake — history is intact. Set
                    to 0 to disable.
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      max={24 * 60}
                      step={1}
                      value={autoSleepDraft}
                      onChange={(e) => setAutoSleepDraft(e.target.value)}
                      onBlur={commitAutoSleepMinutes}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.currentTarget.blur()
                        }
                      }}
                      className="bg-panel border border-border-strong rounded px-2 py-1 text-xs text-fg-bright outline-none focus:border-fg w-24"
                    />
                    <span className="text-xs text-dim">minutes</span>
                  </div>
                </div>

                <div className="mt-4 pt-3 border-t border-border">
                  <label className="block text-xs font-medium text-fg mb-1">
                    Chat density
                  </label>
                  <div
                    className="text-xs text-dim mb-2"
                    title="Larger text and padding, intended for new users or screen-sharing."
                  >
                    Larger text and padding for new users or
                    screen-sharing.
                  </div>
                  <div className="inline-flex rounded border border-border-strong overflow-hidden">
                    <button
                      type="button"
                      onClick={() => {
                        void backend.setJsonModeChatDensity('compact')
                      }}
                      className={`px-3 py-1 text-xs cursor-pointer transition-colors ${
                        jsonModeChatDensity === 'compact'
                          ? 'bg-accent/20 text-fg-bright'
                          : 'bg-panel text-muted hover:bg-panel-raised'
                      }`}
                    >
                      Compact
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void backend.setJsonModeChatDensity('comfy')
                      }}
                      className={`px-3 py-1 text-xs cursor-pointer transition-colors border-l border-border-strong ${
                        jsonModeChatDensity === 'comfy'
                          ? 'bg-accent/20 text-fg-bright'
                          : 'bg-panel text-muted hover:bg-panel-raised'
                      }`}
                    >
                      Comfy
                    </button>
                  </div>
                </div>

                <div className="mt-4 pt-3 border-t border-border">
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={jsonModeSendOnEnter}
                      onChange={(e) => {
                        void backend.setJsonModeSendOnEnter(e.target.checked)
                      }}
                      className="mt-0.5 cursor-pointer icon-base" />
                    <div className="flex-1">
                      <div className="text-sm text-fg-bright">
                        Send messages with Enter
                      </div>
                      <div className="text-xs text-dim mt-0.5">
                        Plain Enter sends; Shift+Enter inserts a newline. When
                        off, Cmd/Ctrl+Enter sends.
                      </div>
                    </div>
                  </label>
                </div>

                <div className="mt-4 pt-3 border-t border-border">
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoScrollToBottom}
                      onChange={(e) => {
                        void backend.setAutoScrollToBottom(e.target.checked)
                      }}
                      className="mt-0.5 cursor-pointer icon-base" />
                    <div className="flex-1">
                      <div className="text-sm text-fg-bright">
                        Auto scroll to bottom
                      </div>
                      <div className="text-xs text-dim mt-0.5">
                        When on, chat follows the streaming response. When off, the most recent prompt pins to the top and a "Jump to prompt" button appears if you scroll away.
                      </div>
                    </div>
                  </label>
                </div>
              </div>

              </div>

              {/* ── Codex subsection ── */}
              <div ref={(el) => { subSectionRefs.current['agent-codex'] = el }} id="agent-codex" className="mt-8" style={{ order: agentSubsectionDisplayOrder('codex', defaultAgent) }}>
              <h3 className="text-sm font-semibold text-fg-bright mb-3 flex items-center gap-2">
                Codex
                {defaultAgent === 'codex' && <span className="text-xs font-normal text-dim bg-panel px-1.5 py-0.5 rounded">default</span>}
              </h3>

              <div className="bg-panel-raised border border-border rounded-lg p-4 mb-4">
                <label className="block text-sm font-medium text-fg mb-1">Model</label>
                <p className="text-xs text-dim mb-2">
                  Appends <code className="bg-panel px-1 rounded">--model</code> to the launch command. Leave on default to let the CLI choose.
                </p>
                <select
                  value={codexModel || ''}
                  onChange={(e) => { void backend.setCodexModel(e.target.value || null) }}
                  className="w-full bg-panel border border-border-strong rounded px-3 py-2 text-sm text-fg-bright outline-none focus:border-fg cursor-pointer"
                >
                  <option value="">(Default — let CLI choose)</option>
                  <optgroup label="Current">
                    {CODEX_MODELS.filter((m) => m.tier === 'current').map((m) => (
                      <option key={m.id} value={m.id}>{m.displayName}</option>
                    ))}
                  </optgroup>
                  <optgroup label="Legacy">
                    {CODEX_MODELS.filter((m) => m.tier === 'legacy').map((m) => (
                      <option key={m.id} value={m.id}>{m.displayName}</option>
                    ))}
                  </optgroup>
                </select>
              </div>

              <div className="bg-panel-raised border border-border rounded-lg p-4">
                <label className="block text-sm font-medium text-fg mb-1">Launch command</label>
                <p className="text-xs text-dim mb-2">
                  The Codex CLI command. Ness manages session resume automatically.
                </p>
                <textarea
                  value={codexCommandDraft}
                  onChange={(e) => setCodexCommandDraft(e.target.value)}
                  rows={2}
                  spellCheck={false}
                  className="w-full bg-panel border border-border-strong rounded px-3 py-2 text-xs text-fg-bright placeholder-faint outline-none focus:border-fg font-mono resize-y"
                  placeholder="codex"
                />
                <div className="flex items-center gap-2 mt-3">
                  <button onClick={handleSaveCodexCommand} disabled={!codexCommandDraft.trim()} className="px-3 py-1.5 bg-surface hover:bg-surface-hover disabled:opacity-40 rounded text-sm text-fg-bright transition-colors cursor-pointer">Save</button>
                  {codexCommandDraft !== 'codex' && (
                    <button onClick={handleResetCodexCommand} className="flex items-center gap-1 px-3 py-1.5 text-sm text-dim hover:text-fg transition-colors cursor-pointer"><RotateCcw className="icon-xs" />Reset</button>
                  )}
                </div>
                {codexSaveResult && (
                  <div className={`mt-3 text-xs flex items-center gap-1.5 ${codexSaveResult.ok ? 'text-success' : 'text-danger'}`}>
                    {codexSaveResult.ok ? <Check className="icon-xs" /> : <X className="icon-xs" />}{codexSaveResult.message}
                  </div>
                )}
                {(() => {
                  const effectiveCodexCommand = codexCommandDraft.trim() || 'codex'
                  const codexModelPart = codexModel && !effectiveCodexCommand.includes('--model') && !effectiveCodexCommand.includes('-m ') ? ` --model ${codexModel}` : ''
                  const codexPreviewInner = `${effectiveCodexCommand}${codexModelPart}`
                  return (
                    <div className="mt-4 pt-3 border-t border-border">
                      <label className="block text-xs font-medium text-fg mb-1">Full command preview</label>
                      <div className="bg-panel border border-border rounded px-3 py-2 text-xs text-fg-bright font-mono break-all">{`<shell> -ilc "${codexPreviewInner}"`}</div>
                      <p className="text-xs text-dim mt-1">where <code className="bg-panel px-1 rounded">{`<shell>`}</code> is your <code className="bg-panel px-1 rounded">$SHELL</code> (typically <code className="bg-panel px-1 rounded">/bin/bash</code> or <code className="bg-panel px-1 rounded">/bin/zsh</code>).</p>
                    </div>
                  )
                })()}
              </div>

              <div className="mt-4 bg-panel-raised border border-border rounded-lg p-4">
                <label className="block text-sm font-medium text-fg mb-1">Environment variables</label>
                <p className="text-xs text-dim mb-3">
                  Injected into Codex tabs. Use for <code className="bg-panel px-1 rounded">OPENAI_API_KEY</code> etc.
                </p>
                {codexEnvRows.length > 0 && (
                  <div className="space-y-2 mb-3">
                    {codexEnvRows.map((row, index) => {
                      const revealed = codexRevealedEnvRows.has(index)
                      return (
                        <div key={index} className="flex items-center gap-2">
                          <input type="text" value={row.key} onChange={(e) => { setCodexEnvRows((prev) => prev.map((r, i) => (i === index ? { ...r, key: e.target.value } : r))); setCodexEnvSaveResult(null) }} placeholder="NAME" spellCheck={false} className="w-44 bg-panel border border-border-strong rounded px-2 py-1.5 text-xs text-fg-bright placeholder-faint outline-none focus:border-fg font-mono" />
                          <span className="text-dim text-xs">=</span>
                          <input type={revealed ? 'text' : 'password'} value={row.value} onChange={(e) => { setCodexEnvRows((prev) => prev.map((r, i) => (i === index ? { ...r, value: e.target.value } : r))); setCodexEnvSaveResult(null) }} placeholder="value" spellCheck={false} className="flex-1 bg-panel border border-border-strong rounded px-2 py-1.5 text-xs text-fg-bright placeholder-faint outline-none focus:border-fg font-mono" />
                          <Tooltip label={revealed ? 'Hide value' : 'Reveal value'}><button onClick={() => setCodexRevealedEnvRows((prev) => { const next = new Set(prev); if (next.has(index)) next.delete(index); else next.add(index); return next })} className="p-1.5 text-dim hover:text-fg transition-colors cursor-pointer">{revealed ? <EyeOff className="icon-sm" /> : <Eye className="icon-sm" />}</button></Tooltip>
                          <Tooltip label="Remove"><button onClick={() => { setCodexEnvRows((prev) => prev.filter((_, i) => i !== index)); setCodexEnvSaveResult(null) }} className="p-1.5 text-dim hover:text-danger transition-colors cursor-pointer"><Trash2 className="icon-sm" /></button></Tooltip>
                        </div>
                      )
                    })}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <button onClick={() => { setCodexEnvRows((prev) => [...prev, { key: '', value: '' }]); setCodexEnvSaveResult(null) }} className="flex items-center gap-1 px-3 py-1.5 bg-surface hover:bg-surface-hover rounded text-sm text-fg-bright transition-colors cursor-pointer"><Plus className="icon-xs" />Add variable</button>
                  <button onClick={handleSaveCodexEnvVars} className="px-3 py-1.5 bg-surface hover:bg-surface-hover rounded text-sm text-fg-bright transition-colors cursor-pointer">Save</button>
                </div>
                {codexEnvSaveResult && (
                  <div className={`mt-3 text-xs flex items-center gap-1.5 ${codexEnvSaveResult.ok ? 'text-success' : 'text-danger'}`}>
                    {codexEnvSaveResult.ok ? <Check className="icon-xs" /> : <X className="icon-xs" />}{codexEnvSaveResult.message}
                  </div>
                )}
              </div>
              </div>

              {/* ── Cursor Agent subsection ── */}
              <div ref={(el) => { subSectionRefs.current['agent-cursor'] = el }} id="agent-cursor" className="mt-8" style={{ order: agentSubsectionDisplayOrder('cursor', defaultAgent) }}>
              <h3 className="text-sm font-semibold text-fg-bright mb-3 flex items-center gap-2">
                Cursor Agent
                {defaultAgent === 'cursor' && <span className="text-xs font-normal text-dim bg-panel px-1.5 py-0.5 rounded">default</span>}
              </h3>

              <div className="bg-panel-raised border border-border rounded-lg p-4 mb-4">
                <label className="block text-sm font-medium text-fg mb-1">Model</label>
                <p className="text-xs text-dim mb-2">
                  Appends <code className="bg-panel px-1 rounded">--model</code> to the launch command. Leave on default to let the CLI choose.
                </p>
                <select
                  value={cursorModel || ''}
                  onChange={(e) => { void backend.setCursorModel(e.target.value || null) }}
                  className="w-full bg-panel border border-border-strong rounded px-3 py-2 text-sm text-fg-bright outline-none focus:border-fg cursor-pointer"
                >
                  <option value="">(Default — let CLI choose)</option>
                  <optgroup label="Current">
                    {CURSOR_MODELS.filter((m) => m.tier === 'current').map((m) => (
                      <option key={m.id} value={m.id}>{m.displayName}</option>
                    ))}
                  </optgroup>
                  <optgroup label="Legacy">
                    {CURSOR_MODELS.filter((m) => m.tier === 'legacy').map((m) => (
                      <option key={m.id} value={m.id}>{m.displayName}</option>
                    ))}
                  </optgroup>
                </select>
              </div>

              <div className="bg-panel-raised border border-border rounded-lg p-4">
                <label className="block text-sm font-medium text-fg mb-1">Launch command</label>
                <p className="text-xs text-dim mb-2">
                  The Cursor Agent CLI command. Ness manages session resume via{' '}
                  <code className="bg-panel px-1 rounded">--resume</code> automatically.
                </p>
                <textarea
                  value={cursorCommandDraft}
                  onChange={(e) => setCursorCommandDraft(e.target.value)}
                  rows={2}
                  spellCheck={false}
                  className="w-full bg-panel border border-border-strong rounded px-3 py-2 text-xs text-fg-bright placeholder-faint outline-none focus:border-fg font-mono resize-y"
                  placeholder="agent"
                />
                <div className="flex items-center gap-2 mt-3">
                  <button onClick={handleSaveCursorCommand} disabled={!cursorCommandDraft.trim()} className="px-3 py-1.5 bg-surface hover:bg-surface-hover disabled:opacity-40 rounded text-sm text-fg-bright transition-colors cursor-pointer">Save</button>
                  {cursorCommandDraft !== 'agent' && (
                    <button onClick={handleResetCursorCommand} className="flex items-center gap-1 px-3 py-1.5 text-sm text-dim hover:text-fg transition-colors cursor-pointer"><RotateCcw className="icon-xs" />Reset</button>
                  )}
                </div>
                {cursorSaveResult && (
                  <div className={`mt-3 text-xs flex items-center gap-1.5 ${cursorSaveResult.ok ? 'text-success' : 'text-danger'}`}>
                    {cursorSaveResult.ok ? <Check className="icon-xs" /> : <X className="icon-xs" />}{cursorSaveResult.message}
                  </div>
                )}
                {(() => {
                  const effectiveCursorCommand = cursorCommandDraft.trim() || 'agent'
                  const cursorModelPart = cursorModel && !effectiveCursorCommand.includes('--model') ? ` --model ${cursorModel}` : ''
                  const cursorPreviewInner = `${effectiveCursorCommand}${cursorModelPart}`
                  return (
                    <div className="mt-4 pt-3 border-t border-border">
                      <label className="block text-xs font-medium text-fg mb-1">Full command preview</label>
                      <div className="bg-panel border border-border rounded px-3 py-2 text-xs text-fg-bright font-mono break-all">{`<shell> -ilc "${cursorPreviewInner}"`}</div>
                      <p className="text-xs text-dim mt-1">where <code className="bg-panel px-1 rounded">{`<shell>`}</code> is your <code className="bg-panel px-1 rounded">$SHELL</code> (typically <code className="bg-panel px-1 rounded">/bin/bash</code> or <code className="bg-panel px-1 rounded">/bin/zsh</code>).</p>
                    </div>
                  )
                })()}
              </div>

              <div className="mt-4 bg-panel-raised border border-border rounded-lg p-4">
                <label className="block text-sm font-medium text-fg mb-1">Environment variables</label>
                <p className="text-xs text-dim mb-3">
                  Injected into Cursor Agent tabs. Use for <code className="bg-panel px-1 rounded">CURSOR_API_KEY</code> etc.
                </p>
                {cursorEnvRows.length > 0 && (
                  <div className="space-y-2 mb-3">
                    {cursorEnvRows.map((row, index) => {
                      const revealed = cursorRevealedEnvRows.has(index)
                      return (
                        <div key={index} className="flex items-center gap-2">
                          <input type="text" value={row.key} onChange={(e) => { setCursorEnvRows((prev) => prev.map((r, i) => (i === index ? { ...r, key: e.target.value } : r))); setCursorEnvSaveResult(null) }} placeholder="NAME" spellCheck={false} className="w-44 bg-panel border border-border-strong rounded px-2 py-1.5 text-xs text-fg-bright placeholder-faint outline-none focus:border-fg font-mono" />
                          <span className="text-dim text-xs">=</span>
                          <input type={revealed ? 'text' : 'password'} value={row.value} onChange={(e) => { setCursorEnvRows((prev) => prev.map((r, i) => (i === index ? { ...r, value: e.target.value } : r))); setCursorEnvSaveResult(null) }} placeholder="value" spellCheck={false} className="flex-1 bg-panel border border-border-strong rounded px-2 py-1.5 text-xs text-fg-bright placeholder-faint outline-none focus:border-fg font-mono" />
                          <Tooltip label={revealed ? 'Hide value' : 'Reveal value'}><button onClick={() => setCursorRevealedEnvRows((prev) => { const next = new Set(prev); if (next.has(index)) next.delete(index); else next.add(index); return next })} className="p-1.5 text-dim hover:text-fg transition-colors cursor-pointer">{revealed ? <EyeOff className="icon-sm" /> : <Eye className="icon-sm" />}</button></Tooltip>
                          <Tooltip label="Remove"><button onClick={() => { setCursorEnvRows((prev) => prev.filter((_, i) => i !== index)); setCursorEnvSaveResult(null) }} className="p-1.5 text-dim hover:text-danger transition-colors cursor-pointer"><Trash2 className="icon-sm" /></button></Tooltip>
                        </div>
                      )
                    })}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <button onClick={() => { setCursorEnvRows((prev) => [...prev, { key: '', value: '' }]); setCursorEnvSaveResult(null) }} className="flex items-center gap-1 px-3 py-1.5 bg-surface hover:bg-surface-hover rounded text-sm text-fg-bright transition-colors cursor-pointer"><Plus className="icon-xs" />Add variable</button>
                  <button onClick={handleSaveCursorEnvVars} className="px-3 py-1.5 bg-surface hover:bg-surface-hover rounded text-sm text-fg-bright transition-colors cursor-pointer">Save</button>
                </div>
                {cursorEnvSaveResult && (
                  <div className={`mt-3 text-xs flex items-center gap-1.5 ${cursorEnvSaveResult.ok ? 'text-success' : 'text-danger'}`}>
                    {cursorEnvSaveResult.ok ? <Check className="icon-xs" /> : <X className="icon-xs" />}{cursorEnvSaveResult.message}
                  </div>
                )}
              </div>
              </div>
              </div>

              {/* ── System prompt subsection ── */}
              <h3 className="text-sm font-semibold text-fg-bright mt-6 mb-3">
                System prompt
              </h3>
              <div className="bg-panel-raised border border-border rounded-lg p-4">
                <label className="flex items-start gap-2 cursor-pointer mb-4">
                  <input
                    type="checkbox"
                    checked={harnessSystemPromptEnabled}
                    onChange={(e) => { void backend.setHarnessSystemPromptEnabled(e.target.checked) }}
                    className="mt-0.5 cursor-pointer icon-base" />
                  <div className="flex-1">
                    <div className="text-sm text-fg-bright">Inject Ness context into Claude sessions</div>
                    <div className="text-xs text-dim mt-0.5">
                      Appends <code className="bg-panel px-1 rounded text-xs">--append-system-prompt</code> with context about Ness and MCP tools.
                    </div>
                  </div>
                </label>

                {harnessSystemPromptEnabled && (
                  <>
                    <div className="mb-4">
                      <label className="block text-xs font-medium text-fg mb-1">Base prompt</label>
                      <p className="text-xs text-dim mb-2">Sent to every Claude session.</p>
                      <textarea
                        value={systemPromptDraft}
                        onChange={(e) => setSystemPromptDraft(e.target.value)}
                        rows={6}
                        spellCheck={false}
                        className="w-full bg-panel border border-border-strong rounded px-3 py-2 text-xs text-fg-bright placeholder-faint outline-none focus:border-fg font-mono resize-y"
                      />
                    </div>

                    <div className="mb-4">
                      <label className="block text-xs font-medium text-fg mb-1">Main worktree addition</label>
                      <p className="text-xs text-dim mb-2">Appended when Claude is running on the main/primary worktree.</p>
                      <textarea
                        value={systemPromptMainDraft}
                        onChange={(e) => setSystemPromptMainDraft(e.target.value)}
                        rows={4}
                        spellCheck={false}
                        className="w-full bg-panel border border-border-strong rounded px-3 py-2 text-xs text-fg-bright placeholder-faint outline-none focus:border-fg font-mono resize-y"
                      />
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleSaveSystemPrompt}
                        className="px-3 py-1.5 bg-surface hover:bg-surface-hover rounded text-sm text-fg-bright transition-colors cursor-pointer"
                      >
                        Save
                      </button>
                      <button
                        onClick={handleResetSystemPrompt}
                        className="flex items-center gap-1 px-3 py-1.5 text-sm text-dim hover:text-fg transition-colors cursor-pointer"
                      >
                        <RotateCcw className="icon-xs" />
                        Reset to defaults
                      </button>
                    </div>
                    {systemPromptSaveResult && (
                      <div className={`mt-3 text-xs flex items-center gap-1.5 ${systemPromptSaveResult.ok ? 'text-success' : 'text-danger'}`}>
                        {systemPromptSaveResult.ok ? <Check className="icon-xs" /> : <X className="icon-xs" />}{systemPromptSaveResult.message}
                      </div>
                    )}
                    <p className="mt-3 text-xs text-faint">Changes apply to new sessions only.</p>
                  </>
                )}
              </div>

              <h3 className="text-sm font-semibold text-fg-bright mt-6 mb-3">
                Prevent system sleep
              </h3>
              <div className="bg-panel-raised border border-border rounded-lg p-4">
                <p className="text-xs text-dim mb-3">
                  Keeps your computer awake (the display can still sleep) so unattended
                  agent runs aren&apos;t paused by idle sleep. Cycle modes anytime
                  with{' '}
                  <HotkeyBadge binding={bindingToString(resolvedHotkeys.cyclePreventSleep)} />.
                </p>
                <select
                  value={preventSleepMode}
                  onChange={(e) =>
                    void backend.setPreventSleepMode(e.target.value as typeof preventSleepMode)
                  }
                  className="bg-panel border border-border-strong rounded px-2 py-1 text-xs text-fg-bright outline-none focus:border-fg cursor-pointer"
                >
                  <option value="off">Off — allow normal sleep</option>
                  <option value="while-agents-running">
                    While agents are running — awake whenever a session is processing
                  </option>
                  <option value="always">Always — awake while Ness is running</option>
                </select>

                <div className="mt-3 pt-3 border-t border-border">
                  <label className="block text-xs font-medium text-fg mb-2">
                    Keep awake temporarily
                  </label>
                  {timerActive ? (
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-accent">
                        Awake for {timerMinutesLeft} more minute{timerMinutesLeft === 1 ? '' : 's'}
                      </span>
                      <button
                        type="button"
                        onClick={() => void backend.setPreventSleepUntil(null)}
                        className="px-3 py-1 bg-panel border border-border rounded text-xs text-dim hover:text-fg hover:border-border-strong cursor-pointer transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      {[1, 3, 8].map((hours) => (
                        <button
                          key={hours}
                          type="button"
                          onClick={() =>
                            void backend.setPreventSleepUntil(Date.now() + hours * 60 * 60 * 1000)
                          }
                          className="px-3 py-1 bg-panel border border-border rounded text-xs text-fg hover:border-border-strong cursor-pointer transition-colors"
                        >
                          +{hours}h
                        </button>
                      ))}
                    </div>
                  )}
                  <p className="text-xs text-faint mt-2">
                    A one-off hold that keeps the computer awake regardless of the
                    setting above. Automatically clears.
                  </p>
                </div>
              </div>
            </section>

            {/* Worktrees section */}
            <section ref={(el) => { sectionRefs.current.worktrees = el }} id="worktrees">
              <h2 className="text-lg font-semibold text-fg-bright mb-1">Worktrees</h2>
              <p className="text-sm text-dim mb-4">
                Controls how new worktrees are created from the sidebar.
              </p>

              {repoList.length > 0 && (
                <div className="mb-4">
                  <div className="flex items-center gap-1 text-xs text-faint mb-1.5 uppercase tracking-wide">
                    Scope
                  </div>
                  <div className="flex flex-wrap gap-1 bg-panel-raised border border-border rounded p-1">
                    <button
                      onClick={() => setScopeRepoRoot(null)}
                      className={`px-2.5 py-1 rounded text-xs transition-colors cursor-pointer ${
                        scopeRepoRoot === null
                          ? 'bg-surface text-fg-bright'
                          : 'text-dim hover:text-fg'
                      }`}
                    >
                      Global
                    </button>
                    {repoList.map((r) => (
                      <button
                        key={r}
                        onClick={() => setScopeRepoRoot(r)}
                        className={`px-2.5 py-1 rounded text-xs font-mono transition-colors cursor-pointer ${
                          scopeRepoRoot === r
                            ? 'bg-surface text-fg-bright'
                            : 'text-dim hover:text-fg'
                        }`}
                        title={r}
                      >
                        {repoBasename(r)}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-faint mt-1.5">
                    {scopeRepoRoot
                      ? <>Editing <code className="bg-panel-raised px-1 rounded">{scopeConfigFilename}</code> in <span className="font-mono">{repoBasename(scopeRepoRoot)}</span>. Unset fields inherit from global. You can commit this file to share settings with teammates.</>
                      : 'Editing global settings. Individual repos can override these values via their .ness.json file.'}
                  </p>
                  {scopeRepoRoot && scopeConfigFilename === LEGACY_REPO_CONFIG_FILENAME && (
                    <div className="mt-2 flex items-start gap-2.5 bg-panel border border-border-strong rounded-lg p-3">
                      <Sparkles className="icon-sm text-accent shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-fg-bright">
                          Harness is now Ness — this repo still uses{' '}
                          <code className="bg-panel-raised px-1 rounded">
                            {LEGACY_REPO_CONFIG_FILENAME}
                          </code>
                          .
                        </div>
                        <div className="text-xs text-dim mt-0.5">
                          Both names keep working. Converting renames the file to{' '}
                          <code className="bg-panel-raised px-1 rounded">.ness.json</code>, which
                          shows up as a rename in git — commit it so teammates pick it up, and make
                          sure they&apos;re on a Ness build that reads the new name.
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          void backend.migrateRepoConfigFilename(scopeRepoRoot)
                        }}
                        className="shrink-0 px-3 py-1.5 rounded-md bg-info text-white text-xs font-medium hover:bg-info/90 transition-colors cursor-pointer"
                      >
                        Convert
                      </button>
                    </div>
                  )}
                </div>
              )}
              {scopeRepoRoot === null && (
              <div className="space-y-2">
                {(
                  [
                    {
                      id: 'remote' as const,
                      label: 'Branch from the latest remote main',
                      description:
                        'Fetches origin before creating the worktree so you start from the tip of the remote default branch. Falls back to local HEAD if the fetch fails (e.g. offline).'
                    },
                    {
                      id: 'local' as const,
                      label: 'Branch from the current local HEAD',
                      description:
                        "Uses whatever is checked out in the main repo right now. Fastest, but you'll inherit any stale local main or unpushed commits."
                    }
                  ]
                ).map((opt) => {
                  const isActive = worktreeBase === opt.id
                  return (
                    <button
                      key={opt.id}
                      onClick={() => handleSelectWorktreeBase(opt.id)}
                      className={`w-full text-left rounded border px-3 py-2 transition-colors cursor-pointer ${
                        isActive
                          ? 'border-accent bg-panel-raised'
                          : 'border-border hover:border-border-strong'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <div
                          className={`w-3 h-3 rounded-full border ${
                            isActive ? 'border-accent bg-accent' : 'border-border-strong'
                          }`}
                        />
                        <span className="text-sm text-fg-bright">{opt.label}</span>
                      </div>
                      <p className="text-xs text-dim mt-1 ml-5">{opt.description}</p>
                    </button>
                  )
                })}
              </div>
              )}

              <div className="flex items-center justify-between mt-6 mb-1">
                <h3 className="text-sm font-semibold text-fg-bright">Default merge strategy</h3>
                {scopeRepoRoot === null && reposOverridingKey('mergeStrategy').length > 0 && (
                  <span className="text-xs text-warning bg-warning/10 border border-warning/30 rounded px-1.5 py-0.5">
                    Overridden in {reposOverridingKey('mergeStrategy').map(repoBasename).join(', ')}
                  </span>
                )}
                {scopeRepoRoot !== null && scopedMergeStrategyIsOverride && (
                  <button
                    onClick={handleResetMergeStrategyToGlobal}
                    className="text-xs text-dim hover:text-fg underline cursor-pointer"
                  >
                    Reset to global
                  </button>
                )}
              </div>
              <p className="text-xs text-dim mb-3">
                Used when you run "Merge locally" on a worktree. The dropdown on
                that button also writes back to this setting so your most recent
                choice becomes the new default.
              </p>
              <div className="space-y-2">
                {(
                  [
                    {
                      id: 'squash' as const,
                      label: 'Squash',
                      description:
                        "Combine all branch commits into one commit on the base branch. GitHub's \"Squash and merge\"."
                    },
                    {
                      id: 'merge-commit' as const,
                      label: 'Merge commit',
                      description:
                        'Always create a merge commit (--no-ff), preserving the branch as a visible bubble in history.'
                    },
                    {
                      id: 'fast-forward' as const,
                      label: 'Fast-forward only',
                      description:
                        'Only merge if the base can fast-forward (--ff-only). Fails on divergent history.'
                    }
                  ]
                ).map((opt) => {
                  const isActive = displayedMergeStrategy === opt.id
                  return (
                    <button
                      key={opt.id}
                      onClick={() => handleSelectMergeStrategy(opt.id)}
                      className={`w-full text-left rounded border px-3 py-2 transition-colors cursor-pointer ${
                        isActive
                          ? 'border-accent bg-panel-raised'
                          : 'border-border hover:border-border-strong'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <div
                          className={`w-3 h-3 rounded-full border ${
                            isActive ? 'border-accent bg-accent' : 'border-border-strong'
                          }`}
                        />
                        <span className="text-sm text-fg-bright">{opt.label}</span>
                      </div>
                      <p className="text-xs text-dim mt-1 ml-5">{opt.description}</p>
                    </button>
                  )
                })}
              </div>

              <h3 className="text-sm font-semibold text-fg-bright mt-6 mb-1">Setup & teardown scripts</h3>
              <p className="text-xs text-dim mb-3">
                Optional shell commands run via a login shell
                (<code className="bg-panel-raised px-1 rounded text-xs">zsh -ilc</code>) with
                the worktree as <code className="bg-panel-raised px-1 rounded text-xs">cwd</code>.
                Setup runs after a worktree is created; teardown runs before it's removed.
                The env vars{' '}
                <code className="bg-panel-raised px-1 rounded text-xs">HARNESS_WORKTREE_PATH</code>,{' '}
                <code className="bg-panel-raised px-1 rounded text-xs">HARNESS_BRANCH</code>, and{' '}
                <code className="bg-panel-raised px-1 rounded text-xs">HARNESS_REPO_ROOT</code>{' '}
                are available to the command.
              </p>

              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs text-dim">Setup command</label>
                {scopeRepoRoot === null && reposOverridingKey('setupCommand').length > 0 && (
                  <span className="text-xs text-warning bg-warning/10 border border-warning/30 rounded px-1.5 py-0.5">
                    Overridden in {reposOverridingKey('setupCommand').map(repoBasename).join(', ')}
                  </span>
                )}
                {scopeRepoRoot !== null && scopedSetupIsOverride && (
                  <button
                    onClick={handleResetSetupToGlobal}
                    className="text-xs text-dim hover:text-fg underline cursor-pointer"
                  >
                    Reset to global
                  </button>
                )}
              </div>
              <textarea
                value={setupDraft}
                onChange={(e) => setSetupDraft(e.target.value)}
                placeholder={
                  scopeRepoRoot && setupScript
                    ? `Inherits from global: ${setupScript}`
                    : 'e.g. npm install --legacy-peer-deps'
                }
                rows={3}
                className="w-full bg-panel border border-border-strong rounded px-3 py-2 text-sm text-fg-bright placeholder-faint outline-none focus:border-fg font-mono resize-y"
              />

              <div className="flex items-center justify-between mt-3 mb-1">
                <label className="block text-xs text-dim">Teardown command</label>
                {scopeRepoRoot === null && reposOverridingKey('teardownCommand').length > 0 && (
                  <span className="text-xs text-warning bg-warning/10 border border-warning/30 rounded px-1.5 py-0.5">
                    Overridden in {reposOverridingKey('teardownCommand').map(repoBasename).join(', ')}
                  </span>
                )}
                {scopeRepoRoot !== null && scopedTeardownIsOverride && (
                  <button
                    onClick={handleResetTeardownToGlobal}
                    className="text-xs text-dim hover:text-fg underline cursor-pointer"
                  >
                    Reset to global
                  </button>
                )}
              </div>
              <textarea
                value={teardownDraft}
                onChange={(e) => setTeardownDraft(e.target.value)}
                placeholder={
                  scopeRepoRoot && teardownScript
                    ? `Inherits from global: ${teardownScript}`
                    : 'e.g. docker compose down'
                }
                rows={3}
                className="w-full bg-panel border border-border-strong rounded px-3 py-2 text-sm text-fg-bright placeholder-faint outline-none focus:border-fg font-mono resize-y"
              />

              <div className="flex items-center gap-2 mt-3">
                <button
                  onClick={handleSaveWorktreeScripts}
                  className="px-3 py-1.5 bg-surface hover:bg-surface-hover rounded text-sm text-fg-bright transition-colors cursor-pointer"
                >
                  Save
                </button>
                {scriptsSaveResult && (
                  <span className={`text-xs flex items-center gap-1.5 ${scriptsSaveResult.ok ? 'text-success' : 'text-danger'}`}>
                    {scriptsSaveResult.ok ? <Check className="icon-xs" /> : <X className="icon-xs" />}
                    {scriptsSaveResult.message}
                  </span>
                )}
              </div>
              <p className="mt-2 text-xs text-faint">
                Failures are logged but don't block the worktree operation. Leave blank to disable.
              </p>

              {scopeRepoRoot === null && (
                <>
                  <h3 className="text-sm font-semibold text-fg-bright mt-6 mb-1">Default snooze duration</h3>
                  <p className="text-xs text-dim mb-3">
                    How many days a worktree snoozes by default. ⌥-click the
                    snooze button to pick a specific date or Never.
                  </p>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={snoozeDefaultDays}
                      onChange={(e) => {
                        const n = Math.max(1, Math.floor(Number(e.target.value) || 1))
                        void backend.setSnoozeDefaultDays(n)
                      }}
                      className="w-20 bg-panel border border-border-strong rounded px-2 py-1 text-sm text-fg-bright outline-none focus:border-fg"
                    />
                    <span className="text-xs text-dim">days</span>
                  </div>

                  <h3 className="text-sm font-semibold text-fg-bright mt-6 mb-1">Notify chat on CI failure</h3>
                  <p className="text-xs text-dim mb-3">
                    When a worktree's PR checks start failing, post a message
                    naming the failing checks into its agent chat so the agent
                    can start investigating. Fires once per failing commit, and
                    only for worktrees with a live chat tab. Individual
                    worktrees can opt in or out from the PR panel.
                  </p>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={notifyChatOnCiFailure}
                      onChange={(e) => { void backend.setNotifyChatOnCiFailure(e.target.checked) }}
                      className="accent-current icon-base cursor-pointer" />
                    <span className="text-sm text-fg">
                      Tell the agent when CI fails
                    </span>
                  </label>

                  <h3 className="text-sm font-semibold text-fg-bright mt-6 mb-1">Share Claude Code permissions</h3>
                  <p className="text-xs text-dim mb-3">
                    Symlink each worktree's{' '}
                    <code className="bg-panel-raised px-1 rounded text-xs">.claude/settings.local.json</code>{' '}
                    to the main worktree's copy so "Don't ask again"
                    permissions granted in any worktree apply everywhere.
                    Only takes effect for worktrees created while enabled
                    (plus a one-shot boot migration of existing ones).
                  </p>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={shareClaudeSettings}
                      onChange={(e) => { void backend.setShareClaudeSettings(e.target.checked) }}
                      className="accent-current icon-base cursor-pointer" />
                    <span className="text-sm text-fg">
                      Share settings.local.json across worktrees
                    </span>
                  </label>

                  <h3 className="text-sm font-semibold text-fg-bright mt-6 mb-1">PR review prompt</h3>
                  <p className="text-xs text-dim mb-3">
                    Default kickoff prompt sent to Claude when you open a PR as a worktree (or when the MCP{' '}
                    <code className="bg-panel-raised px-1 rounded text-xs">create_worktree</code> tool is invoked
                    with <code className="bg-panel-raised px-1 rounded text-xs">prNumber</code> and no explicit
                    prompt). You can edit the prompt per-PR from the New Worktree screen.
                  </p>
                  <textarea
                    value={prReviewPromptDraft}
                    onChange={(e) => setPrReviewPromptDraft(e.target.value)}
                    rows={5}
                    spellCheck={false}
                    className="w-full bg-panel border border-border-strong rounded px-3 py-2 text-xs text-fg-bright placeholder-faint outline-none focus:border-fg font-mono resize-y"
                  />
                  <div className="flex items-center gap-2 mt-3">
                    <button
                      onClick={handleSavePrReviewPrompt}
                      className="px-3 py-1.5 bg-surface hover:bg-surface-hover rounded text-sm text-fg-bright transition-colors cursor-pointer"
                    >
                      Save
                    </button>
                    <button
                      onClick={handleResetPrReviewPrompt}
                      className="flex items-center gap-1 px-3 py-1.5 text-sm text-dim hover:text-fg transition-colors cursor-pointer"
                    >
                      <RotateCcw className="icon-xs" />
                      Reset to default
                    </button>
                  </div>
                  {prReviewPromptSaveResult && (
                    <div className={`mt-3 text-xs flex items-center gap-1.5 ${prReviewPromptSaveResult.ok ? 'text-success' : 'text-danger'}`}>
                      {prReviewPromptSaveResult.ok ? <Check className="icon-xs" /> : <X className="icon-xs" />}{prReviewPromptSaveResult.message}
                    </div>
                  )}
                </>
              )}

              {scopeRepoRoot !== null && (
                <div className="mt-6 pt-5 border-t border-border">
                  <label className="block text-sm text-fg-bright mb-1">Right-panel visibility</label>
                  <p className="text-xs text-dim">
                    Toggle individual panels from the right-column toolbar in the main window.
                  </p>
                </div>
              )}
            </section>

            {/* Editor section */}
            <section ref={(el) => { sectionRefs.current.editor = el }} id="editor">
              <h2 className="text-lg font-semibold text-fg-bright mb-1">Editor</h2>
              <p className="text-sm text-dim mb-4">
                Your preferred code editor. Ness uses this when you click
                "Open in editor" on a worktree, click the edit icon on a
                changed file, or click a file path in a terminal. The editor's
                CLI must be installed and on your shell PATH.
              </p>
              <div className="grid grid-cols-2 gap-2 mb-3">
                {availableEditors.map((ed) => {
                  const isActive = editorId === ed.id
                  return (
                    <button
                      key={ed.id}
                      onClick={() => handleSelectEditor(ed.id)}
                      className={`flex items-center gap-2 text-left rounded border px-3 py-2 text-sm transition-colors cursor-pointer ${
                        isActive
                          ? 'border-accent bg-panel-raised text-fg-bright'
                          : 'border-border hover:border-border-strong text-muted hover:text-fg'
                      }`}
                    >
                      <Code2 className={`icon-sm ${isActive ? 'text-accent' : 'text-faint'}`} />
                      <span className="flex-1">{ed.name}</span>
                      {isActive && <Check className="icon-xs text-accent" />}
                    </button>
                  )
                })}
              </div>
              <p className="text-xs text-faint">
                Ness spawns the editor via a login shell (<code className="bg-panel-raised px-1 rounded text-xs">zsh -ilc</code>)
                so homebrew and nvm paths are picked up automatically. If nothing
                happens when you click "Open in editor", check that the selected
                editor's CLI is installed (e.g. VS Code's{' '}
                <code className="bg-panel-raised px-1 rounded text-xs">code</code> command,
                installed via <em>Shell Command: Install 'code' command in PATH</em> from
                the command palette).
              </p>

              <label
                className="mt-6 flex items-start gap-2 cursor-pointer"
                data-search-title="Swap click and ⌘-click on terminal links"
              >
                <input
                  type="checkbox"
                  checked={terminalPlainClickOpensInApp}
                  onChange={(e) => handleToggleTerminalPlainClickOpensInApp(e.target.checked)}
                  className="mt-0.5 cursor-pointer icon-base" />
                <div className="flex-1">
                  <div className="text-sm text-fg-bright">
                    Swap click and ⌘-click on terminal links
                  </div>
                  <div className="text-xs text-dim mt-0.5">
                    By default a plain click on a link in a terminal hands it off
                    — file paths to the editor above, URLs to your system browser
                    — and ⌘-click keeps it inside Ness in a file or browser tab.
                    Enable this to swap them, so ⌘-click is what leaves Ness.
                    Matches terminals where ⌘-click is the gesture for opening a
                    link for real. <code className="bg-panel-raised px-1 rounded text-xs">mailto:</code>{' '}
                    and other OS-handled schemes always go external.
                  </div>
                </div>
              </label>
            </section>

            {/* GitHub section */}
            <section ref={(el) => { sectionRefs.current.github = el }} id="github">
              {(() => {
                const authed = hasToken || authSource === 'gh-cli'
                return (
              <>
              <h2 className={`text-lg font-semibold mb-1 ${!authed ? 'text-info' : 'text-fg-bright'}`}>GitHub</h2>
              <p className={`text-sm mb-4 ${!authed ? 'text-info/80' : 'text-dim'}`}>
                Ness fetches PR status and check results from GitHub. If you have the
                {' '}<code className="bg-panel-raised px-1 rounded">gh</code> CLI installed and authenticated,
                it'll be used automatically. Otherwise, paste a personal access token below — it'll be
                encrypted and stored locally using your macOS keychain.
              </p>

              {authed && harnessStarred !== null && (
                <label className="mb-4 flex items-center gap-2 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={harnessStarred}
                    onChange={(e) => { void backend.setHarnessStarred(e.target.checked) }}
                    className="icon-base accent-warning cursor-pointer" />
                  <Star
                    className={`icon-sm ${harnessStarred ? 'text-warning fill-warning shrink-0' : 'text-warning shrink-0'}`} />
                  <span className="text-sm text-fg group-hover:text-fg-bright transition-colors">
                    Star Ness on GitHub
                  </span>
                </label>
              )}

              {authSource === 'gh-cli' && !hasToken && (
                <div className="mb-4 rounded-lg p-4 border bg-success/10 border-success/30">
                  <div className="flex items-center gap-2 text-sm text-success">
                    <Check className="icon-sm" />
                    <span>Using <code className="bg-panel-raised px-1 rounded">gh</code> CLI token (auto-detected)</span>
                  </div>
                  {!showPatForm && (
                    <button
                      onClick={() => setShowPatForm(true)}
                      className="mt-3 text-xs text-muted hover:text-fg-bright underline cursor-pointer"
                    >
                      Use a personal access token instead
                    </button>
                  )}
                </div>
              )}

              {(authSource !== 'gh-cli' || hasToken || showPatForm) && (
              <div className={`rounded-lg p-4 border ${!authed ? 'bg-info/10 border-info/30' : 'bg-panel-raised border-border'}`}>
                <label className="block text-sm font-medium text-fg mb-2">
                  Personal Access Token
                </label>

                {hasToken && (
                  <div className="flex items-center gap-2 mb-3 text-xs text-success">
                    <Check className="icon-sm" />
                    <span>A token is currently saved {authSource === 'pat' ? '(in use)' : ''}</span>
                  </div>
                )}

                <div className="relative mb-3">
                  <input
                    type={showToken ? 'text' : 'password'}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder={hasToken ? 'Enter a new token to replace the existing one' : 'ghp_... or github_pat_...'}
                    className="w-full bg-panel border border-border-strong rounded px-3 py-2 pr-10 text-sm text-fg-bright placeholder-faint outline-none focus:border-fg font-mono"
                  />
                  <button
                    onClick={() => setShowToken(!showToken)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-dim hover:text-fg transition-colors cursor-pointer"
                  >
                    {showToken ? <EyeOff className="icon-sm" /> : <Eye className="icon-sm" />}
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={handleSave}
                    disabled={saving || !token.trim()}
                    className="px-3 py-1.5 bg-surface hover:bg-surface-hover disabled:opacity-40 rounded text-sm text-fg-bright transition-colors cursor-pointer"
                  >
                    {saving ? 'Validating...' : 'Save'}
                  </button>
                  {hasToken && (
                    <button
                      onClick={handleClear}
                      className="px-3 py-1.5 text-sm text-danger hover:text-danger transition-colors cursor-pointer"
                    >
                      Remove
                    </button>
                  )}
                </div>

                {tokenResult && (
                  <div className={`mt-3 text-xs flex items-center gap-1.5 ${tokenResult.ok ? 'text-success' : 'text-danger'}`}>
                    {tokenResult.ok ? <Check className="icon-xs" /> : <X className="icon-xs" />}
                    {tokenResult.message}
                  </div>
                )}
              </div>
              )}

              {(authSource !== 'gh-cli' || hasToken || showPatForm) && (
              <div className="mt-4 text-xs text-dim space-y-2">
                <p>
                  Create a token at{' '}
                  <a
                    onClick={() => backend.openExternal('https://github.com/settings/tokens?type=beta')}
                    className="text-muted hover:text-fg-bright underline cursor-pointer"
                  >
                    github.com/settings/tokens
                  </a>
                  {' '}(fine-grained) or{' '}
                  <a
                    onClick={() => backend.openExternal('https://github.com/settings/tokens')}
                    className="text-muted hover:text-fg-bright underline cursor-pointer"
                  >
                    classic tokens
                  </a>
                  .
                </p>
                <p>
                  Required scopes: <code className="bg-panel-raised px-1 rounded">repo</code> for private repos,
                  or <code className="bg-panel-raised px-1 rounded">public_repo</code> for public only.
                </p>
              </div>
              )}

              <label
                className="mt-6 flex items-start gap-2 cursor-pointer"
                data-search-title="Show PRs assigned to me for review"
              >
                <input
                  type="checkbox"
                  checked={showAssignedPRs}
                  onChange={(e) => handleToggleShowAssignedPRs(e.target.checked)}
                  className="mt-0.5 cursor-pointer icon-base" />
                <div className="flex-1">
                  <div className="text-sm text-fg-bright">Show PRs assigned to me for review</div>
                  <div className="text-xs text-dim mt-0.5">
                    Adds PRs where you&apos;re a requested reviewer (across every repo
                    added to Ness) as phantom entries in the sidebar&apos;s
                    Reviewing group. Click one to open the &ldquo;new worktree from PR&rdquo;
                    screen with that PR pre-selected.
                  </div>
                </div>
              </label>

              <label
                className="mt-6 flex items-start gap-2 cursor-pointer"
                data-search-title="Open PRs in a Ness browser tab"
              >
                <input
                  type="checkbox"
                  checked={openPrInBrowserTab}
                  onChange={(e) => handleToggleOpenPrInBrowserTab(e.target.checked)}
                  className="mt-0.5 cursor-pointer icon-base" />
                <div className="flex-1">
                  <div className="text-sm text-fg-bright">Open PRs in a Ness browser tab</div>
                  <div className="text-xs text-dim mt-0.5">
                    ⌘⇧G and the PR panel&apos;s number, title, and pull-request
                    button open the review in a browser tab beside your terminals
                    instead of handing it to your system browser. Opening the same
                    PR again focuses the tab it already opened.
                  </div>
                </div>
              </label>

              </>
                )
              })()}
            </section>

            {/* Hotkeys section */}
            <section ref={(el) => { sectionRefs.current.hotkeys = el }} id="hotkeys">
              <div className="flex items-start justify-between mb-1">
                <h2 className="text-lg font-semibold text-fg-bright">Hotkeys</h2>
                {hotkeyOverrides && Object.keys(hotkeyOverrides).length > 0 && (
                  <button
                    onClick={handleResetAllHotkeys}
                    className="flex items-center gap-1 text-xs text-dim hover:text-fg transition-colors cursor-pointer"
                  >
                    <RotateCcw className="icon-xs" />
                    Reset all to defaults
                  </button>
                )}
              </div>
              <p className="text-sm text-dim mb-4">
                Click a shortcut to rebind it. Press <kbd className="bg-panel-raised px-1 rounded text-xs">Esc</kbd> to cancel.
              </p>

              {(() => {
                const renderRow = (action: Action, indent = false): JSX.Element => {
                  const binding: HotkeyBinding = resolvedHotkeys[action]
                  const isRebinding = rebindingAction === action
                  const overridden = isOverridden(action)
                  return (
                    <div key={action} className={`flex items-center justify-between px-3 py-2 ${indent ? 'pl-9' : ''}`}>
                      <span className="flex flex-col gap-0.5 pr-3">
                        <span className="text-sm text-fg">{ACTION_LABELS[action]}</span>
                        {isTypeableBinding(binding) && (
                          <span className="text-xs text-faint">
                            No ⌘/⌃ — types instead of firing while an input has focus. Press ⎋ to leave the chat composer first.
                          </span>
                        )}
                      </span>
                      <div className="flex items-center gap-2">
                        {overridden && (
                          <Tooltip label="Reset to default">
                            <button
                              onClick={() => handleResetHotkey(action)}
                              className="text-xs text-dim hover:text-fg transition-colors cursor-pointer"
                            >
                              <RotateCcw className="icon-xs" />
                            </button>
                          </Tooltip>
                        )}
                        <button
                          onClick={() => setRebindingAction(isRebinding ? null : action)}
                          className={`min-w-[100px] px-2.5 py-1 rounded text-xs transition-colors cursor-pointer ${
                            isRebinding
                              ? 'bg-warning/20 text-warning border border-warning/50 animate-pulse'
                              : 'bg-panel text-fg border border-border-strong hover:border-fg'
                          }`}
                        >
                          {isRebinding ? 'Press keys...' : formatBindingGlyphs(bindingToString(binding))}
                        </button>
                      </div>
                    </div>
                  )
                }

                return (
                  <div className="space-y-6">
                    {ACTION_CATEGORIES.map((cat) => {
                      const subId = `hotkeys-${cat.id}` as SubSectionId
                      return (
                        <div
                          key={cat.id}
                          ref={(el) => { subSectionRefs.current[subId] = el }}
                          id={subId}
                        >
                          <h3 className="text-xs font-medium uppercase tracking-wide text-dim mb-2">{cat.label}</h3>
                          <div className="bg-panel-raised border border-border rounded-lg divide-y divide-border">
                            {cat.actions.map((a) => renderRow(a))}
                            {cat.families?.map((family) => {
                              const familyKey = `${cat.id}:${family.label}`
                              const expanded = expandedFamilies.has(familyKey)
                              return (
                                <div key={familyKey}>
                                  <button
                                    onClick={() => {
                                      setExpandedFamilies((prev) => {
                                        const next = new Set(prev)
                                        if (next.has(familyKey)) next.delete(familyKey)
                                        else next.add(familyKey)
                                        return next
                                      })
                                    }}
                                    className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-panel cursor-pointer"
                                  >
                                    <span className="flex items-center gap-1.5 text-sm text-fg">
                                      {expanded ? <ChevronDown className="icon-xs text-dim" /> : <ChevronRight className="icon-xs text-dim" />}
                                      {family.label}
                                      <span className="text-xs text-faint">({family.actions.length})</span>
                                    </span>
                                    <span className="min-w-[100px] px-2.5 py-1 text-xs text-dim text-center">
                                      {family.summary}
                                    </span>
                                  </button>
                                  {expanded && family.actions.map((a) => renderRow(a, true))}
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )
              })()}
            </section>

            {/* Updates section */}
            <section ref={(el) => { sectionRefs.current.updates = el }} id="updates">
              <h2 className="text-lg font-semibold text-fg-bright mb-1">Updates</h2>
              <p className="text-sm text-dim mb-4">
                {autoUpdateEnabled
                  ? 'Ness checks for updates automatically on startup and every 10 minutes.'
                  : 'Automatic update checks are disabled. Use the button below to check manually.'}
              </p>

              <div className="bg-panel-raised border border-border rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <div className="text-sm text-fg">Current version</div>
                    <div className="text-xs text-dim font-mono mt-0.5">
                      {version ? (
                        <a
                          onClick={() => backend.openExternal(harnessReleaseNotesUrl(version))}
                          className="underline hover:text-fg-bright cursor-pointer"
                        >
                          {version}
                        </a>
                      ) : (
                        '...'
                      )}
                    </div>
                  </div>
                  <button
                    onClick={handleCheckForUpdates}
                    disabled={checking || updaterStatus?.state === 'checking' || updaterStatus?.state === 'downloading'}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-surface hover:bg-surface-hover disabled:opacity-40 rounded text-sm text-fg-bright transition-colors cursor-pointer"
                  >
                    <RefreshCw className={`icon-xs ${checking ? 'animate-spin' : ''}`} />
                    Check for updates
                  </button>
                </div>

                {renderUpdaterStatus() && (
                  <div className="pt-3 border-t border-border">
                    {renderUpdaterStatus()}
                  </div>
                )}

                {import.meta.env.DEV && (
                  <div className="mt-3 pt-3 border-t border-border">
                    <div className="text-xs uppercase tracking-wide text-faint mb-1.5">
                      Dev: simulate updater state
                    </div>
                    <div className="flex gap-1.5">
                      {(['available', 'downloading', 'downloaded', 'clear'] as const).map((s) => (
                        <button
                          key={s}
                          onClick={() => backend.devSimulateUpdate(s)}
                          className="px-2 py-1 bg-surface hover:bg-surface-hover rounded text-xs text-fg transition-colors cursor-pointer"
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="mt-4 pt-3 border-t border-border">
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoUpdateEnabled}
                      onChange={(e) => handleToggleAutoUpdate(e.target.checked)}
                      className="mt-0.5 cursor-pointer icon-base" />
                    <div className="flex-1">
                      <div className="text-sm text-fg-bright">Check for updates automatically</div>
                      <div className="text-xs text-dim mt-0.5">
                        When enabled, Ness checks for new releases on startup and every
                        10 minutes. Disable to only check when you press the button above.
                      </div>
                    </div>
                  </label>
                </div>
              </div>

              <div className="mt-3 text-xs text-dim">
                <a
                  onClick={() => backend.openExternal(HARNESS_RELEASES_URL)}
                  className="text-muted hover:text-fg-bright underline cursor-pointer"
                >
                  View all releases on GitHub
                </a>
              </div>
            </section>

            {/* Support section */}
            <section ref={(el) => { sectionRefs.current.support = el }} id="support">
              <h2 className="text-lg font-semibold text-fg-bright mb-1">Support</h2>
              <p className="text-sm text-dim mb-4">
                Found a bug or want to request a feature? Let us know on GitHub.
              </p>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => openReportIssue({ kind: 'bug' })}
                  className="flex items-center gap-2 px-3 py-2 bg-panel-raised border border-border rounded-lg text-sm text-fg-bright hover:bg-surface transition-colors cursor-pointer"
                >
                  <Bug className="icon-sm" />
                  Report a bug
                </button>
                <button
                  type="button"
                  onClick={() => openReportIssue({ kind: 'feature' })}
                  className="flex items-center gap-2 px-3 py-2 bg-panel-raised border border-border rounded-lg text-sm text-fg-bright hover:bg-surface transition-colors cursor-pointer"
                >
                  <Lightbulb className="icon-sm" />
                  Request a feature
                </button>
              </div>

              <p className="mt-3 text-xs text-dim">
                Opens a prefilled GitHub issue in your browser. No data is sent from Ness directly.
              </p>

              <div className="mt-6 bg-panel-raised border border-border rounded-lg p-4">
                <label className="block text-sm font-medium text-fg mb-1">Diagnostics</label>
                <p className="text-xs text-dim mb-3">
                  Open the Ness debug log in your default editor. Useful when reporting issues or
                  diagnosing flaky behavior.
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={async () => {
                      setDebugLogError(null)
                      const result = await backend.openDebugLog()
                      if (!result.ok) setDebugLogError(result.message)
                    }}
                    className="flex items-center gap-2 px-3 py-2 bg-panel border border-border rounded-lg text-sm text-fg-bright hover:bg-surface transition-colors cursor-pointer"
                  >
                    <FileText className="icon-sm" />
                    Open debug log
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDebugLogError(null)
                      void backend.showDebugLogInFolder()
                    }}
                    className="flex items-center gap-2 px-3 py-2 bg-panel border border-border rounded-lg text-sm text-fg-bright hover:bg-surface transition-colors cursor-pointer"
                  >
                    <FolderOpen className="icon-sm" />
                    Show in Finder
                  </button>
                </div>
                {debugLogError && (
                  <p className="mt-2 text-xs text-danger">{debugLogError}</p>
                )}

                <label className="mt-4 pt-3 border-t border-border flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={expandedDiagnosticLoggingEnabled}
                    onChange={(e) => { void backend.setExpandedDiagnosticLoggingEnabled(e.target.checked) }}
                    className="mt-0.5 cursor-pointer icon-base" />
                  <div className="flex-1">
                    <div className="text-sm text-fg-bright">Expanded diagnostic logging</div>
                    <div className="text-xs text-dim mt-0.5">
                      Writes a <code className="bg-panel px-1 rounded">[github-api]</code> line to{' '}
                      <code className="bg-panel px-1 rounded">debug.log</code> for every GitHub API call
                      (URL, method, status, duration). Off by default — the per-call volume is high
                      during PR-refresh bursts. The HUD's "GH API" rate metric is always on regardless.
                    </div>
                  </div>
                </label>
              </div>
            </section>

            {/* Experimental section */}
            <section ref={(el) => { sectionRefs.current.experimental = el }} id="experimental">
              <h2 className="text-lg font-semibold text-fg-bright mb-1 flex items-center gap-2">
                <FlaskConical className="w-[1.125rem] h-[1.125rem] text-warning" />
                Experimental
              </h2>
              <p className="text-sm text-dim mb-4">
                These features are in active development. APIs and UI may change,
                and you should expect rough edges. Each one is opt-in below.{' '}
                <a
                  onClick={() => backend.openExternal(HARNESS_ISSUES_URL)}
                  className="text-muted hover:text-fg-bright underline cursor-pointer"
                >
                  File an issue
                </a>{' '}
                if something breaks.
              </p>

              {/* Browser control sub-card */}
              <div
                ref={(el) => { subSectionRefs.current['experimental-browser-control'] = el }}
                id="experimental-browser-control"
                className="bg-panel-raised border border-warning/30 rounded-lg p-4 mb-4"
              >
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="text-sm font-semibold text-fg-bright">Browser control</h3>
                  <span className="text-xs font-medium text-warning bg-warning/10 border border-warning/30 rounded px-1.5 py-0.5">
                    Experimental
                  </span>
                </div>
                <p className="text-xs text-dim mb-3">
                  Lets agents see and drive the embedded browser tabs in each
                  worktree — screenshotting, clicking, typing, navigating.
                  Only takes effect on the next agent session.
                </p>

                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    id="browser-tools-enabled"
                    checked={browserToolsEnabled}
                    onChange={(e) => { void backend.setBrowserToolsEnabled(e.target.checked) }}
                    className="mt-0.5 cursor-pointer icon-base" />
                  <div className="flex-1">
                    <label htmlFor="browser-tools-enabled" className="text-sm text-fg-bright cursor-pointer">Enable browser tools</label>
                    <div className="text-xs text-dim mt-0.5 mb-2">
                      Exposes <code className="bg-panel px-1 rounded text-xs">ness-control</code> MCP browser_* tools to the agent.
                    </div>
                    <select
                      value={browserToolsMode}
                      onChange={(e) => { void backend.setBrowserToolsMode(e.target.value === 'view' ? 'view' : 'full') }}
                      disabled={!browserToolsEnabled}
                      className="bg-panel border border-border-strong rounded px-2 py-1 text-xs text-fg-bright outline-none focus:border-fg cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <option value="view">View Only — inspect &amp; navigate, no clicks/typing/scrolling</option>
                      <option value="full">Full Control — click, type, scroll, and move the cursor</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Conversation fork sub-card */}
              <div
                ref={(el) => { subSectionRefs.current['experimental-conversation-fork'] = el }}
                id="experimental-conversation-fork"
                className="bg-panel-raised border border-warning/30 rounded-lg p-4 mb-4"
              >
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="text-sm font-semibold text-fg-bright">Conversation fork</h3>
                  <span className="text-xs font-medium text-warning bg-warning/10 border border-warning/30 rounded px-1.5 py-0.5">
                    Experimental
                  </span>
                </div>
                <p className="text-xs text-dim mb-3">
                  Lets a new worktree be seeded with a copy of an existing Chat
                  conversation, so the new agent resumes it instead of reading a
                  hand-written briefing. Claude Code only — no other agent can
                  resume a forked transcript.
                </p>

                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={conversationForkEnabled}
                    onChange={(e) => { void backend.setConversationForkEnabled(e.target.checked) }}
                    className="mt-0.5 cursor-pointer icon-base" />
                  <div className="flex-1">
                    <div className="text-sm text-fg-bright">Enable conversation fork</div>
                    <div className="text-xs text-dim mt-0.5">
                      Adds &quot;Fork into new worktree…&quot; to the Chat tab menu and a{' '}
                      <code className="bg-panel px-1 rounded text-xs">forkConversation</code>{' '}
                      option to the <code className="bg-panel px-1 rounded text-xs">create_worktree</code>{' '}
                      MCP tool. Only takes effect on the next agent session.
                    </div>
                  </div>
                </label>
              </div>

              {/* Worktree messaging sub-card */}
              <div
                ref={(el) => { subSectionRefs.current['experimental-worktree-messaging'] = el }}
                id="experimental-worktree-messaging"
                className="bg-panel-raised border border-warning/30 rounded-lg p-4 mb-4"
              >
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="text-sm font-semibold text-fg-bright">Worktree messaging</h3>
                  <span className="text-xs font-medium text-warning bg-warning/10 border border-warning/30 rounded px-1.5 py-0.5">
                    Experimental
                  </span>
                </div>
                <p className="text-xs text-dim mb-3">
                  Lets an agent send a message straight into another worktree&apos;s
                  Chat tab — handing off work, or telling a waiting worktree that
                  the thing it needed is done. Unlike the browser and shell tools,
                  this deliberately crosses the worktree boundary. Messages arrive
                  labelled with the sending worktree, and waking a sleeping Chat
                  tab counts as activity. Only takes effect on the next agent
                  session.
                </p>

                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={worktreeMessagingEnabled}
                    onChange={(e) => { void backend.setWorktreeMessagingEnabled(e.target.checked) }}
                    className="mt-0.5 cursor-pointer icon-base" />
                  <div className="flex-1">
                    <div className="text-sm text-fg-bright">Enable worktree messaging</div>
                    <div className="text-xs text-dim mt-0.5">
                      Exposes the <code className="bg-panel px-1 rounded text-xs">send_message</code> MCP tool. Senders can&apos;t forge who a message came from — the name is taken from the calling worktree.
                    </div>
                  </div>
                </label>
              </div>

              {/* Auto-approve safe tool calls sub-card */}
              <div
                ref={(el) => { subSectionRefs.current['experimental-auto-approve'] = el }}
                id="experimental-auto-approve"
                className="bg-panel-raised border border-warning/30 rounded-lg p-4 mb-4"
              >
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="text-sm font-semibold text-fg-bright">Auto-approve safe tool calls</h3>
                  <span className="text-xs font-medium text-warning bg-warning/10 border border-warning/30 rounded px-1.5 py-0.5">
                    Experimental
                  </span>
                </div>
                <p className="text-xs text-dim mb-3">
                  In Chat tabs, spawns a Haiku oneshot to approve obviously-safe tool calls (Read, Grep, Edit, …) instead of prompting you. A hardcoded deny-list catches risky calls (<code className="bg-panel px-1 rounded text-xs">rm -rf</code>, <code className="bg-panel px-1 rounded text-xs">git push</code>, <code className="bg-panel px-1 rounded text-xs">WebFetch</code>, …) before Haiku is consulted. Productivity feature only — an LLM judging another LLM is not a security boundary. Has no effect on Terminal tabs.
                </p>

                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={autoApprovePermissions}
                    onChange={(e) => handleToggleAutoApprovePermissions(e.target.checked)}
                    className="mt-0.5 cursor-pointer icon-base" />
                  <div className="flex-1">
                    <div className="text-sm text-fg-bright">Enable auto-approve</div>
                    <div className="text-xs text-dim mt-0.5">
                      Manual Allow/Deny still works at any time and wins the race against the reviewer.
                    </div>
                  </div>
                </label>

                {autoApprovePermissions && (
                  <div className="mt-4 pt-3 border-t border-border">
                    <label className="block text-xs font-medium text-fg mb-1">
                      Project-specific guidance <span className="text-faint font-normal">(optional)</span>
                    </label>
                    <p className="text-xs text-dim mb-2">
                      Free-text instructions appended to the reviewer's policy prompt. Use to add carve-outs (e.g. <em>&quot;approve <code className="bg-panel px-1 rounded text-xs">npm install</code> for this project&quot;</em>) or extra strictness (e.g. <em>&quot;deny any Bash that writes outside src/&quot;</em>). The hardcoded safety bullets always run first; this is purely additive guidance. You can also edit + re-review from any rejected approval card.
                    </p>
                    <textarea
                      value={autoApproveSteerDraft}
                      onChange={(e) => setAutoApproveSteerDraft(e.target.value)}
                      placeholder="e.g. Approve npm install. Deny any Bash command that touches /etc."
                      spellCheck={false}
                      className="w-full bg-panel border border-border-strong rounded p-2 text-xs text-fg-bright placeholder-faint outline-none focus:border-fg font-mono min-h-[80px] resize-y"
                    />
                    <div className="mt-2 flex items-center gap-2">
                      <button
                        onClick={handleSaveAutoApproveSteer}
                        disabled={autoApproveSteerDraft === autoApproveSteerInstructions}
                        className="px-2.5 py-1 text-xs rounded bg-success/20 hover:bg-success/30 text-success transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Save guidance
                      </button>
                      {autoApproveSteerSaveResult && (
                        <span
                          className={`text-xs flex items-center gap-1 ${autoApproveSteerSaveResult.ok ? 'text-success' : 'text-danger'}`}
                        >
                          {autoApproveSteerSaveResult.ok ? <Check className="icon-xs" /> : <X className="icon-xs" />}
                          {autoApproveSteerSaveResult.message}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Web / mobile client sub-card */}
              <div
                ref={(el) => { subSectionRefs.current['experimental-web-mobile'] = el }}
                id="experimental-web-mobile"
                className="bg-panel-raised border border-warning/30 rounded-lg p-4"
              >
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="text-sm font-semibold text-fg-bright">Web &amp; mobile client</h3>
                  <span className="text-xs font-medium text-warning bg-warning/10 border border-warning/30 rounded px-1.5 py-0.5">
                    Experimental
                  </span>
                </div>
                <p className="text-xs text-dim mb-3">
                  Runs an HTTP + WebSocket server alongside the desktop app so
                  you can open the same workspace from a browser — useful for a
                  second laptop or a phone on the same network. Token-gated;
                  no TLS yet.
                </p>

                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={wsTransportEnabled}
                    onChange={(e) => { void handleToggleWsTransport(e.target.checked) }}
                    className="mt-0.5 cursor-pointer icon-base" />
                  <div className="flex-1">
                    <div className="text-sm text-fg-bright">Enable web / mobile client</div>
                    <div className="text-xs text-dim mt-0.5">
                      Changes apply on the next app launch.
                    </div>
                  </div>
                </label>

                {wsTransportEnabled && (
                  <>
                    <div className="mt-4 pt-3 border-t border-border grid grid-cols-[1fr_auto] gap-3">
                      <div>
                        <label className="block text-xs font-medium text-fg mb-1">Port</label>
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min={1024}
                            max={65535}
                            value={wsPortDraft}
                            onChange={(e) => setWsPortDraft(e.target.value)}
                            onBlur={handleSaveWsPort}
                            className="w-28 bg-panel border border-border-strong rounded px-2 py-1 text-xs text-fg-bright outline-none focus:border-fg font-mono"
                          />
                          <span className="text-xs text-faint">default 37291</span>
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-fg mb-1">Bind to</label>
                        <select
                          value={wsTransportHost}
                          onChange={(e) => { void handleSelectWsHost(e.target.value) }}
                          className="bg-panel border border-border-strong rounded px-2 py-1 text-xs text-fg-bright outline-none focus:border-fg cursor-pointer"
                        >
                          <option value="127.0.0.1">This machine only (loopback)</option>
                          <option value="0.0.0.0">LAN — other devices on this network</option>
                        </select>
                      </div>
                    </div>

                    <div className="mt-4 pt-3 border-t border-border">
                      <label className="block text-xs font-medium text-fg mb-1">Connection URL</label>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 bg-panel border border-border rounded px-2 py-1.5 text-xs text-fg-bright font-mono truncate">
                          {showWsToken ? wsUrl : wsUrlMasked}
                        </code>
                        <Tooltip label={showWsToken ? 'Hide token' : 'Show token'}>
                          <button
                            onClick={() => setShowWsToken((v) => !v)}
                            disabled={!wsInfo}
                            className="p-1.5 text-dim hover:text-fg transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            {showWsToken ? <EyeOff className="icon-sm" /> : <Eye className="icon-sm" />}
                          </button>
                        </Tooltip>
                        <Tooltip label={wsUrlCopied ? 'Copied' : 'Copy URL'}>
                          <button
                            onClick={handleCopyWsUrl}
                            disabled={!wsInfo}
                            className="p-1.5 text-dim hover:text-fg transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            {wsUrlCopied ? <Check className="icon-sm text-success" /> : <Copy className="icon-sm" />}
                          </button>
                        </Tooltip>
                        <Tooltip label="Open in browser">
                          <button
                            onClick={handleOpenWsUrl}
                            disabled={!wsInfo}
                            className="p-1.5 text-dim hover:text-fg transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <ExternalLink className="icon-sm" />
                          </button>
                        </Tooltip>
                        <Tooltip label="Rotate token (invalidates existing URLs)">
                          <button
                            onClick={() => { void handleRotateWsToken() }}
                            disabled={!wsInfo}
                            className="p-1.5 text-dim hover:text-warning transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <RotateCcw className="icon-sm" />
                          </button>
                        </Tooltip>
                      </div>
                    </div>

                    {wsTransportHost === '0.0.0.0' && (
                      <div className="mt-4 pt-3 border-t border-border">
                        <p className="text-xs text-fg mb-3">
                          <span className="font-medium text-warning">LAN mode:</span>{' '}
                          any device on your network can connect if they have
                          the URL below. The 32-byte token is the only thing
                          gating access — only enable on trusted networks,
                          never over the public internet.
                        </p>

                        {scannableLanUrl ? (
                          <div className="flex gap-4 items-start">
                            <div className="bg-white p-2 rounded shrink-0">
                              <QRCodeSVG value={scannableLanUrl} size={128} level="M" />
                            </div>
                            <div className="flex-1 min-w-0 text-xs text-dim space-y-2">
                              <p>
                                Scan with your phone's camera to open in
                                Safari or your default browser.
                              </p>
                              {lanAddresses.length > 1 && (
                                <div>
                                  <label className="block text-xs font-medium text-fg mb-1">Interface</label>
                                  <select
                                    value={selectedLanAddress ?? ''}
                                    onChange={(e) => setSelectedLanAddress(e.target.value)}
                                    className="w-full bg-panel border border-border-strong rounded px-2 py-1 text-xs text-fg-bright outline-none focus:border-fg cursor-pointer font-mono"
                                  >
                                    {lanAddresses.map((a) => (
                                      <option key={a.iface + a.address} value={a.address}>
                                        {a.iface} — {a.address}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                              )}
                              <p className="font-mono text-xs break-all text-fg">
                                http://{selectedLanAddress}:{wsInfo?.port}/
                              </p>
                            </div>
                          </div>
                        ) : wsInfo ? (
                          <p className="text-xs text-dim italic">
                            No LAN network interface detected on this machine.
                          </p>
                        ) : (
                          <p className="text-xs text-dim italic">
                            QR code will appear here after you relaunch
                            Ness with the server enabled.
                          </p>
                        )}
                      </div>
                    )}
                  </>
                )}

                {wsNeedsRestart && (
                  <div className="mt-4 pt-3 border-t border-border flex items-center gap-2">
                    <RefreshCw className="icon-xs text-warning shrink-0" />
                    <p className="text-xs text-warning">{wsNeedsRestart}</p>
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}

interface ThemeModePickerProps {
  title: string
  hint: string
  builtIns: ThemeOption[]
  customs: CustomTheme[]
  activeId: string
  disabled: boolean
  onSelect: (id: string) => void
}

/** A swatch carrying a stable identifier — used as the React key so
 *  duplicate hexes (e.g. when a theme has the same color for two roles)
 *  don't collide, and reordering can't shuffle component state. */
interface Swatch {
  /** Stable semantic role: 'app' | 'surface' | 'fg' | 'accent' for
   *  built-ins; arbitrary semantic color key for customs. */
  role: string
  color: string
}

/** Mock worktree + PR used by the Sidebar row preview so every detail
 *  item has something to render. The avatar is a self-contained SVG data
 *  URI so the preview doesn't hit the network. */
const PREVIEW_WORKTREE: Worktree = {
  path: '/Users/you/Projects/harness-worktrees/feat/example',
  branch: 'feat/example-branch',
  head: '',
  isBare: false,
  isMain: false,
  createdAt: 0,
  repoRoot: '/Users/you/Projects/harness'
}

const PREVIEW_PR: PRStatus = {
  number: 123,
  title: 'Example pull request',
  state: 'open',
  url: '',
  branch: 'feat/example-branch',
  author: null,
  checks: [],
  checksOverall: 'success',
  hasConflict: false,
  reviews: [],
  reviewDecision: 'none',
  additions: 42,
  deletions: 7,
  baseBranch: 'main',
  isDefaultBase: true,
  milestone: { title: 'v2.13.0', url: '', state: 'open' },
  assignees: [
    {
      login: 'octocat',
      avatarUrl:
        "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='8' r='8' fill='%234a90e2'/><text x='8' y='11' font-family='sans-serif' font-size='9' fill='white' text-anchor='middle'>O</text></svg>"
    }
  ],
  linkedIssues: [],
  labels: []
}

interface SidebarRowPreviewProps {
  density: SidebarDensity
  prefs: SidebarDetailPrefs
}

function SidebarRowPreview({ density, prefs }: SidebarRowPreviewProps): JSX.Element {
  // Compute a live "3 days ago" createdAt so the age item always shows
  // something reasonable in the preview.
  const worktree: Worktree = { ...PREVIEW_WORKTREE, createdAt: Date.now() - 3 * 24 * 60 * 60 * 1000 }
  return (
    <div className="rounded border border-border bg-panel p-2 max-w-[26rem]">
      <div className="group flex items-center gap-2 px-3 py-2 bg-surface rounded">
        <span
          className="w-2 h-2 rounded-full shrink-0 bg-success"
          title="Working..."
        />
        <GitPullRequest className="icon-sm text-success shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-fg-bright truncate">
            example-alias
          </div>
          {density === 'comfy' && (
            <SubtitleDetail
              worktree={worktree}
              repoLabel="harness"
              aliased
              prStatus={PREVIEW_PR}
              prefs={prefs}
            />
          )}
        </div>
        {density === 'compact' && (
          <SubtitleDetail
            worktree={worktree}
            repoLabel="harness"
            aliased
            prStatus={PREVIEW_PR}
            prefs={prefs}
            inline
          />
        )}
      </div>
    </div>
  )
}

/** Roles shown in the small swatch row next to each theme name. Stable
 *  across themes so a reorder doesn't shuffle keys. */
const SWATCH_ROLES = ['app', 'surface', 'fg', 'accent'] as const

function builtInSwatches(opt: ThemeOption): Swatch[] {
  // THEME_OPTIONS.swatches is positional: [app, surface, fg, accent].
  const out: Swatch[] = []
  SWATCH_ROLES.forEach((role, i) => {
    const color = opt.swatches[i]
    if (typeof color === 'string') out.push({ role, color })
  })
  return out
}

function customSwatches(c: CustomTheme): Swatch[] {
  const out: Swatch[] = []
  for (const role of SWATCH_ROLES) {
    const v = c.colors[role]
    if (typeof v === 'string') out.push({ role, color: v })
  }
  return out
}

function readBuiltInThemeJson(opt: ThemeOption): string {
  const probe = document.createElement('div')
  probe.dataset.theme = opt.id
  probe.style.display = 'none'
  document.body.appendChild(probe)
  try {
    const cs = getComputedStyle(probe)
    const colors: Record<string, string> = {}
    for (const key of SEMANTIC_KEYS) {
      const v = cs.getPropertyValue(`--color-${key}`).trim()
      if (v) colors[key] = v
    }
    return JSON.stringify({ name: opt.label, mode: opt.mode, colors }, null, 2) + '\n'
  } finally {
    probe.remove()
  }
}

function ThemeRow({
  id,
  label,
  description,
  swatches,
  isActive,
  onSelect,
  onCopy,
  copied
}: {
  id: string
  label: string
  description: string
  swatches: Swatch[]
  isActive: boolean
  onSelect: (id: string) => void
  onCopy?: () => void
  copied?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      className={`group w-full flex items-center gap-3 px-4 py-3 text-left transition-colors cursor-pointer ${
        isActive ? 'bg-surface' : 'hover:bg-surface/60'
      }`}
    >
      <div className="flex gap-1 shrink-0">
        {swatches.length === 0 ? (
          <span className="w-4 h-4 rounded border border-border-strong bg-panel" />
        ) : (
          swatches.map((s) => (
            <span
              key={s.role}
              className="w-4 h-4 rounded border border-border-strong"
              style={{ backgroundColor: s.color }}
            />
          ))
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-fg">{label}</div>
        <div className="text-xs text-dim truncate">{description}</div>
      </div>
      {onCopy && (
        <Tooltip label={copied ? 'Copied!' : 'Copy as JSON'} side="left">
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onCopy() }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onCopy() } }}
            className={`shrink-0 text-dim hover:text-fg transition-opacity cursor-pointer p-1 ${
              copied ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'
            }`}
          >
            {copied ? <CopyCheck className="icon-sm" /> : <Copy className="icon-sm" />}
          </span>
        </Tooltip>
      )}
      {isActive && <Check className="icon-sm text-success shrink-0" />}
    </button>
  )
}

function ThemeModePicker({
  title,
  hint,
  builtIns,
  customs,
  activeId,
  disabled,
  onSelect
}: ThemeModePickerProps): JSX.Element {
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
    }
  }, [])
  const handleCopy = (opt: ThemeOption): void => {
    const json = readBuiltInThemeJson(opt)
    void navigator.clipboard.writeText(json)
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
    setCopiedId(opt.id)
    copiedTimerRef.current = setTimeout(() => {
      setCopiedId(null)
      copiedTimerRef.current = null
    }, 1500)
  }
  return (
    <div className={disabled ? 'opacity-50' : ''}>
      <h3 className="text-sm font-semibold text-fg-bright mb-1">{title}</h3>
      <p className="text-xs text-dim mb-2">{hint}</p>
      <div className="bg-panel-raised border border-border rounded-lg divide-y divide-border">
        {builtIns.map((opt) => (
          <ThemeRow
            key={opt.id}
            id={opt.id}
            label={opt.label}
            description={opt.description}
            swatches={builtInSwatches(opt)}
            isActive={activeId === opt.id}
            onSelect={onSelect}
            onCopy={() => handleCopy(opt)}
            copied={copiedId === opt.id}
          />
        ))}
        {customs.map((c) => (
          <ThemeRow
            key={c.id}
            id={c.id}
            label={c.name}
            description={`Custom theme · ${c.id}`}
            swatches={customSwatches(c)}
            isActive={activeId === c.id}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  )
}
