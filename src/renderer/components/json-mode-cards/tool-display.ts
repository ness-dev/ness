// Tool-name pretty-printing + icon lookup. Built-in Claude tools get
// fixed labels and lucide icons; MCP tools (mcp__<server>__<tool>) are
// parsed, server name normalized (strip claude_ai_ prefix, lowercase,
// drop separators), then matched against the brand registry to render
// as "Brand · Title Cased Action" with a brand icon when we have one.

import {
  AlarmIcon,
  AnthropicIcon,
  AsanaIcon,
  AskIcon,
  BackIcon,
  BashIcon,
  BellIcon,
  BitbucketIcon,
  BlueskyIcon,
  BranchIcon,
  BraveIcon,
  CalendarIcon,
  ClickablesIcon,
  ClickIcon,
  ConsoleIcon,
  CursorIcon,
  DomIcon,
  ForwardIcon,
  ClickupIcon,
  CloudflareIcon,
  CloudinaryIcon,
  ConfluenceIcon,
  CronIcon,
  DiscordIcon,
  DriveIcon,
  EditIcon,
  ElasticIcon,
  FigmaIcon,
  FirebaseIcon,
  GithubIcon,
  GitlabIcon,
  GlobIcon,
  GmailIcon,
  GrepIcon,
  NessIcon,
  HubspotIcon,
  HuggingfaceIcon,
  IntercomIcon,
  JiraIcon,
  LinearIcon,
  ListIcon,
  MailchimpIcon,
  McpGenericIcon,
  McpResourceIcon,
  MessageIcon,
  MongoIcon,
  MysqlIcon,
  NavigateIcon,
  NetlifyIcon,
  NewTabIcon,
  NotebookIcon,
  NotionIcon,
  OpenaiIcon,
  PaypalIcon,
  PerplexityIcon,
  PostgresIcon,
  ReadIcon,
  RedditIcon,
  RedisIcon,
  ReloadIcon,
  RenameIcon,
  SalesforceIcon,
  ScreenshotIcon,
  ScrollIcon,
  SentryIcon,
  ShellKillIcon,
  ShopifyIcon,
  SkillIcon,
  SlackIcon,
  SnowflakeIcon,
  SpotifyIcon,
  SqliteIcon,
  StripeIcon,
  SupabaseIcon,
  TabListIcon,
  TaskIcon,
  TaskOutputIcon,
  TaskStopIcon,
  TelegramIcon,
  TodoIcon,
  ToolSearchIcon,
  TrelloIcon,
  TriggerIcon,
  TwilioIcon,
  TypeIcon,
  UrlIcon,
  VercelIcon,
  WebIcon,
  WhatsappIcon,
  WorktreeIcon,
  WriteIcon,
  XIcon,
  YoutubeIcon,
  ZendeskIcon,
  ZoomIcon,
  type ToolIcon
} from './tool-icons'

const NESS_CONTROL_PREFIX = 'mcp__ness-control__'
// Tool calls already sitting in users' transcripts carry the pre-rename
// prefix. Recognised for display so old cards keep their Ness chrome.
const LEGACY_NESS_CONTROL_PREFIX = 'mcp__harness-control__'
const MCP_PREFIX = 'mcp__'

export interface ToolDisplay {
  /** Full "Brand · Action" label for the per-card chrome. */
  label: string
  /** Just "Action" for known MCP brands — the icon already conveys
   *  the brand in the collapsed ToolGroup summary, so dropping the
   *  redundant prefix buys horizontal room for more tool names. For
   *  built-ins and unknown MCPs (generic plug icon — no brand cue),
   *  this is identical to `label`. */
  compactLabel: string
  /** Brand/category icon, or null for built-ins without one. */
  icon: ToolIcon | null
}

const BUILTIN_ICONS: Record<string, ToolIcon> = {
  Read: ReadIcon,
  Edit: EditIcon,
  MultiEdit: EditIcon,
  Write: WriteIcon,
  Bash: BashIcon,
  Grep: GrepIcon,
  Glob: GlobIcon,
  TodoWrite: TodoIcon,
  Task: TaskIcon,
  Agent: TaskIcon,
  WebFetch: WebIcon,
  WebSearch: WebIcon,
  ToolSearch: ToolSearchIcon,
  Skill: SkillIcon,
  NotebookEdit: NotebookIcon,
  AskUserQuestion: AskIcon,
  ScheduleWakeup: AlarmIcon,
  CronCreate: CronIcon,
  CronList: CronIcon,
  CronDelete: CronIcon,
  EnterWorktree: WorktreeIcon,
  ExitWorktree: WorktreeIcon,
  EnterPlanMode: TodoIcon,
  ExitPlanMode: TodoIcon,
  PushNotification: BellIcon,
  RemoteTrigger: TriggerIcon,
  TaskOutput: TaskOutputIcon,
  TaskStop: TaskStopIcon,
  ListMcpResourcesTool: McpResourceIcon,
  ReadMcpResourceTool: McpResourceIcon
}

interface McpBrand {
  label: string
  icon: ToolIcon
}

// Keyed by normalized server name (see `normalizeServerName`). Same
// brand can appear under multiple MCP server names depending on who
// packaged it (e.g. `github`, `claude_ai_GitHub`, `gh`), and the
// normalization step collapses those to one key so we don't have to
// list each spelling.
const MCP_BRANDS: Record<string, McpBrand> = {
  // Ness — kept here for completeness even though it's special-cased
  // (brand gradient implies it, so the label drops the "Ness · " bit).
  nesscontrol: { label: 'Ness', icon: NessIcon },
  // Pre-rename spelling, still present in existing transcripts.
  harnesscontrol: { label: 'Ness', icon: NessIcon },

  // Anthropic-hosted / first-party
  notion: { label: 'Notion', icon: NotionIcon },
  slack: { label: 'Slack', icon: SlackIcon },
  gmail: { label: 'Gmail', icon: GmailIcon },
  googledrive: { label: 'Google Drive', icon: DriveIcon },
  drive: { label: 'Google Drive', icon: DriveIcon },
  googlecalendar: { label: 'Google Calendar', icon: CalendarIcon },
  calendar: { label: 'Google Calendar', icon: CalendarIcon },

  // Dev & code
  github: { label: 'GitHub', icon: GithubIcon },
  gh: { label: 'GitHub', icon: GithubIcon },
  gitlab: { label: 'GitLab', icon: GitlabIcon },
  bitbucket: { label: 'Bitbucket', icon: BitbucketIcon },
  linear: { label: 'Linear', icon: LinearIcon },
  jira: { label: 'Jira', icon: JiraIcon },
  atlassian: { label: 'Atlassian', icon: JiraIcon },
  confluence: { label: 'Confluence', icon: ConfluenceIcon },
  sentry: { label: 'Sentry', icon: SentryIcon },
  vercel: { label: 'Vercel', icon: VercelIcon },
  netlify: { label: 'Netlify', icon: NetlifyIcon },
  cloudflare: { label: 'Cloudflare', icon: CloudflareIcon },
  supabase: { label: 'Supabase', icon: SupabaseIcon },
  firebase: { label: 'Firebase', icon: FirebaseIcon },

  // Databases
  postgres: { label: 'Postgres', icon: PostgresIcon },
  postgresql: { label: 'Postgres', icon: PostgresIcon },
  mysql: { label: 'MySQL', icon: MysqlIcon },
  mongo: { label: 'MongoDB', icon: MongoIcon },
  mongodb: { label: 'MongoDB', icon: MongoIcon },
  redis: { label: 'Redis', icon: RedisIcon },
  sqlite: { label: 'SQLite', icon: SqliteIcon },
  snowflake: { label: 'Snowflake', icon: SnowflakeIcon },
  elasticsearch: { label: 'Elasticsearch', icon: ElasticIcon },
  elastic: { label: 'Elasticsearch', icon: ElasticIcon },

  // Communication
  discord: { label: 'Discord', icon: DiscordIcon },
  telegram: { label: 'Telegram', icon: TelegramIcon },
  whatsapp: { label: 'WhatsApp', icon: WhatsappIcon },
  zoom: { label: 'Zoom', icon: ZoomIcon },
  mailchimp: { label: 'Mailchimp', icon: MailchimpIcon },
  twilio: { label: 'Twilio', icon: TwilioIcon },
  intercom: { label: 'Intercom', icon: IntercomIcon },

  // Productivity
  asana: { label: 'Asana', icon: AsanaIcon },
  trello: { label: 'Trello', icon: TrelloIcon },
  clickup: { label: 'ClickUp', icon: ClickupIcon },

  // Commerce & finance
  stripe: { label: 'Stripe', icon: StripeIcon },
  paypal: { label: 'PayPal', icon: PaypalIcon },
  shopify: { label: 'Shopify', icon: ShopifyIcon },
  hubspot: { label: 'HubSpot', icon: HubspotIcon },
  salesforce: { label: 'Salesforce', icon: SalesforceIcon },
  zendesk: { label: 'Zendesk', icon: ZendeskIcon },

  // AI & search
  openai: { label: 'OpenAI', icon: OpenaiIcon },
  huggingface: { label: 'Hugging Face', icon: HuggingfaceIcon },
  hf: { label: 'Hugging Face', icon: HuggingfaceIcon },
  perplexity: { label: 'Perplexity', icon: PerplexityIcon },
  brave: { label: 'Brave', icon: BraveIcon },
  bravesearch: { label: 'Brave Search', icon: BraveIcon },
  anthropic: { label: 'Anthropic', icon: AnthropicIcon },

  // Media & social
  figma: { label: 'Figma', icon: FigmaIcon },
  spotify: { label: 'Spotify', icon: SpotifyIcon },
  youtube: { label: 'YouTube', icon: YoutubeIcon },
  reddit: { label: 'Reddit', icon: RedditIcon },
  x: { label: 'X', icon: XIcon },
  twitter: { label: 'X', icon: XIcon },
  bluesky: { label: 'Bluesky', icon: BlueskyIcon },
  cloudinary: { label: 'Cloudinary', icon: CloudinaryIcon }
}

interface ParsedMcp {
  server: string
  tool: string
}

export function parseMcpToolName(name: string | undefined): ParsedMcp | null {
  if (!name || !name.startsWith(MCP_PREFIX)) return null
  const rest = name.slice(MCP_PREFIX.length)
  const sep = rest.indexOf('__')
  if (sep <= 0 || sep === rest.length - 2) return null
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) }
}

export function isNessControl(name: string | undefined): boolean {
  if (!name) return false
  return (
    name.startsWith(NESS_CONTROL_PREFIX) || name.startsWith(LEGACY_NESS_CONTROL_PREFIX)
  )
}

/** Collapse the many spellings the same brand can ship under (e.g.
 *  `GitHub`, `github`, `claude_ai_GitHub`) into one registry key. Drops
 *  the `claude_ai_` prefix Anthropic uses for hosted connectors,
 *  lowercases, and strips underscores/dashes/spaces. */
export function normalizeServerName(server: string): string {
  return server
    .replace(/^claude_ai_/i, '')
    .toLowerCase()
    .replace(/[_\-\s]+/g, '')
}

function humanizeAction(tool: string, prefixes: string[]): string {
  let cleaned = tool
  const lower = cleaned.toLowerCase()
  for (const p of prefixes) {
    if (!p) continue
    if (lower.startsWith(p + '-') || lower.startsWith(p + '_')) {
      cleaned = cleaned.slice(p.length + 1)
      break
    }
  }
  return cleaned
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
}

function titleCaseServer(server: string): string {
  return server
    .replace(/^claude_ai_/, '')
    .replace(/[_-]+/g, ' ')
    .trim()
}

export function getToolDisplay(name: string | undefined): ToolDisplay {
  if (!name) return { label: 'Tool', compactLabel: 'Tool', icon: null }

  const parsed = parseMcpToolName(name)
  if (!parsed) {
    return { label: name, compactLabel: name, icon: BUILTIN_ICONS[name] ?? null }
  }

  const normalized = normalizeServerName(parsed.server)
  const brand = MCP_BRANDS[normalized]
  if (brand) {
    // Strip both the normalized brand key and the raw server name as
    // tool prefixes (many MCP authors namespace their tools, e.g.
    // `notion-get-users`, `slack_send_message`, `github-create-issue`).
    const action = humanizeAction(parsed.tool, [
      normalized,
      parsed.server.toLowerCase()
    ])
    return {
      label: `${brand.label} · ${action}`,
      compactLabel: action,
      icon: brand.icon
    }
  }

  const serverLabel = titleCaseServer(parsed.server)
  const action = humanizeAction(parsed.tool, [parsed.server])
  const full = `${serverLabel} · ${action}`
  // Unknown MCP: the generic plug icon doesn't say which server it is,
  // so keep the server prefix even in compact form.
  return { label: full, compactLabel: full, icon: McpGenericIcon }
}

/** What a single ness-control call *did*, for surfaces that summarize a
 *  run of them rather than describe one card. */
export interface ToolAction {
  /** Action-specific icon. The Ness brand mark is right in card chrome
   *  ("this drove the app") but says nothing in a timeline of eight
   *  consecutive ness-control calls. */
  icon: ToolIcon
  /** Countable noun — "3 clicks · 2 screenshots" in a group header. */
  one: string
  many: string
}

// Keyed by the bare tool name (post-`mcp__ness-control__`). Only these
// tools get broken out; anything missing falls back to the generic
// "N tool calls" bucket, so adding a ness-control tool doesn't require
// touching this table to keep working.
//
// back/forward/navigate deliberately share the "navigation" noun — the
// distinction matters per-step (and the icons keep it) but not in a
// count. They keep separate icons for the timeline.
const NESS_ACTIONS: Record<string, ToolAction> = {
  screenshot_tab: { icon: ScreenshotIcon, one: 'screenshot', many: 'screenshots' },
  click_tab: { icon: ClickIcon, one: 'click', many: 'clicks' },
  scroll_tab: { icon: ScrollIcon, one: 'scroll', many: 'scrolls' },
  type_tab: { icon: TypeIcon, one: 'keystroke', many: 'keystrokes' },
  navigate_tab: { icon: NavigateIcon, one: 'navigation', many: 'navigations' },
  back_tab: { icon: BackIcon, one: 'navigation', many: 'navigations' },
  forward_tab: { icon: ForwardIcon, one: 'navigation', many: 'navigations' },
  reload_tab: { icon: ReloadIcon, one: 'reload', many: 'reloads' },
  get_tab_dom: { icon: DomIcon, one: 'DOM read', many: 'DOM reads' },
  get_tab_clickables: {
    icon: ClickablesIcon,
    one: 'element scan',
    many: 'element scans'
  },
  get_tab_console_logs: {
    icon: ConsoleIcon,
    one: 'console read',
    many: 'console reads'
  },
  get_tab_url: { icon: UrlIcon, one: 'URL check', many: 'URL checks' },
  create_browser_tab: { icon: NewTabIcon, one: 'new tab', many: 'new tabs' },
  list_browser_tabs: { icon: TabListIcon, one: 'tab list', many: 'tab lists' },
  show_cursor: { icon: CursorIcon, one: 'cursor move', many: 'cursor moves' },
  create_shell: { icon: BashIcon, one: 'shell', many: 'shells' },
  read_shell_output: {
    icon: TaskOutputIcon,
    one: 'shell read',
    many: 'shell reads'
  },
  list_shells: { icon: ListIcon, one: 'shell list', many: 'shell lists' },
  kill_shell: { icon: ShellKillIcon, one: 'shell kill', many: 'shell kills' },
  create_worktree: { icon: BranchIcon, one: 'worktree', many: 'worktrees' },
  list_worktrees: { icon: ListIcon, one: 'worktree list', many: 'worktree lists' },
  list_repos: { icon: ListIcon, one: 'repo list', many: 'repo lists' },
  rename_worktree: { icon: RenameIcon, one: 'rename', many: 'renames' },
  set_worktree_alias: { icon: RenameIcon, one: 'rename', many: 'renames' },
  clear_worktree_alias: { icon: RenameIcon, one: 'rename', many: 'renames' },
  send_message: { icon: MessageIcon, one: 'message', many: 'messages' }
}

/** Resolve a tool name to its action, or null when we have no
 *  per-action knowledge of it (every non-ness-control tool today). */
export function getToolAction(name: string | undefined): ToolAction | null {
  if (!isNessControl(name) || !name) return null
  const parsed = parseMcpToolName(name)
  if (!parsed) return null
  return NESS_ACTIONS[parsed.tool] ?? null
}

/** "1 click" / "4 clicks". */
export function formatActionCount(action: ToolAction, count: number): string {
  return `${count} ${count === 1 ? action.one : action.many}`
}

// Back-compat shim — earlier code called prettyToolName(name) to get
// the string only. Kept so callsites that don't need the icon stay
// terse.
export function prettyToolName(name: string | undefined): string {
  return getToolDisplay(name).label
}

export interface ArgEntry {
  key: string
  /** Stringified value: strings as-is, scalars via String(), null as
   *  "null", objects/arrays via JSON.stringify. */
  value: string
  /** True when the expanded-view renderer should treat this as a
   *  multi-line block (use a <pre>) rather than inline text — either
   *  because the value contains a newline or because it's long enough
   *  to want wrapping. */
  multiline: boolean
}

/** Flatten a tool's `input` blob into an ordered list of key/value
 *  pairs for display. Top-level keys only — nested objects/arrays
 *  collapse to a single inline JSON string. Returns [] for anything
 *  that isn't a plain object. */
export function extractArgs(input: unknown): ArgEntry[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return []
  const out: ArgEntry[] = []
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    let value: string
    if (typeof raw === 'string') {
      value = raw
    } else if (
      typeof raw === 'number' ||
      typeof raw === 'boolean' ||
      typeof raw === 'bigint'
    ) {
      value = String(raw)
    } else if (raw === null || raw === undefined) {
      value = String(raw)
    } else {
      try {
        value = JSON.stringify(raw)
      } catch {
        value = String(raw)
      }
    }
    out.push({
      key,
      value,
      multiline: value.includes('\n') || value.length > 80
    })
  }
  return out
}
