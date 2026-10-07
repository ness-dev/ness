// Icon components for tool cards. Built-in Claude tools (Read, Edit, …)
// reuse lucide; MCP brand logos come from react-icons/si (the Simple
// Icons family). The Ness mark is hand-drawn since Ness isn't in
// Simple Icons — it is the mark from resources/icon.svg.

import type { ComponentType } from 'react'

import { NESS_MARK_PATHS } from '../NessMark'
import {
  AlarmClock,
  AppWindow,
  ArrowLeft,
  ArrowRight,
  Bell,
  Bot,
  CalendarClock,
  Camera,
  Code,
  Crosshair,
  Database,
  FilePen,
  FilePlus,
  FileText,
  FolderSearch,
  FolderTree,
  GitBranch,
  Globe,
  Keyboard,
  Link,
  List,
  ListChecks,
  MessageCircleQuestion,
  MessageSquare,
  MousePointer,
  MousePointerClick,
  MoveVertical,
  Navigation,
  Notebook,
  Octagon,
  Pencil,
  RotateCw,
  ScrollText,
  Search,
  Sparkles,
  SquarePlus,
  SquareTerminal,
  SquareX,
  Terminal,
  Wrench,
  Zap
} from 'lucide-react'
import {
  SiAnthropic,
  SiAsana,
  SiBitbucket,
  SiBluesky,
  SiBrave,
  SiClickup,
  SiCloudflare,
  SiCloudinary,
  SiConfluence,
  SiDiscord,
  SiElasticsearch,
  SiFigma,
  SiFirebase,
  SiGithub,
  SiGitlab,
  SiGmail,
  SiGooglecalendar,
  SiGoogledrive,
  SiHuggingface,
  SiHubspot,
  SiIntercom,
  SiJira,
  SiLinear,
  SiMailchimp,
  SiMongodb,
  SiMysql,
  SiNetlify,
  SiNotion,
  SiOpenai,
  SiPaypal,
  SiPerplexity,
  SiPostgresql,
  SiReddit,
  SiRedis,
  SiSalesforce,
  SiSentry,
  SiShopify,
  SiSlack,
  SiSnowflake,
  SiSpotify,
  SiSqlite,
  SiStripe,
  SiSupabase,
  SiTelegram,
  SiTrello,
  SiTwilio,
  SiVercel,
  SiWhatsapp,
  SiX,
  SiYoutube,
  SiZendesk,
  SiZoom
} from 'react-icons/si'

export type ToolIcon = ComponentType<{ className?: string }>

// Built-in Claude tools — lucide. Each is a thin wrapper so the
// registry lookup returns a uniform `(className) => element` shape.

export const ReadIcon: ToolIcon = ({ className }) => <FileText className={className} />
export const EditIcon: ToolIcon = ({ className }) => <FilePen className={className} />
export const WriteIcon: ToolIcon = ({ className }) => <FilePlus className={className} />
export const BashIcon: ToolIcon = ({ className }) => <Terminal className={className} />
export const GrepIcon: ToolIcon = ({ className }) => <Search className={className} />
export const GlobIcon: ToolIcon = ({ className }) => <FolderSearch className={className} />
export const TodoIcon: ToolIcon = ({ className }) => <ListChecks className={className} />
export const TaskIcon: ToolIcon = ({ className }) => <Bot className={className} />
export const WebIcon: ToolIcon = ({ className }) => <Globe className={className} />
export const ToolSearchIcon: ToolIcon = ({ className }) => <Wrench className={className} />
export const SkillIcon: ToolIcon = ({ className }) => <Sparkles className={className} />
export const AlarmIcon: ToolIcon = ({ className }) => <AlarmClock className={className} />
export const CronIcon: ToolIcon = ({ className }) => <CalendarClock className={className} />
export const AskIcon: ToolIcon = ({ className }) => <MessageCircleQuestion className={className} />
export const WorktreeIcon: ToolIcon = ({ className }) => <FolderTree className={className} />
export const NotebookIcon: ToolIcon = ({ className }) => <Notebook className={className} />
export const BellIcon: ToolIcon = ({ className }) => <Bell className={className} />
export const TriggerIcon: ToolIcon = ({ className }) => <Zap className={className} />
export const TaskOutputIcon: ToolIcon = ({ className }) => <ScrollText className={className} />
export const TaskStopIcon: ToolIcon = ({ className }) => <Octagon className={className} />
export const McpResourceIcon: ToolIcon = ({ className }) => <Database className={className} />

// Ness-control actions. Every ness-control tool shares the Ness brand
// icon in card chrome, which is the right cue for "this drove the app"
// — but useless in the collapsed timeline, where a browser session
// would render as the same mark eight times in a row. These say what
// the step actually did.

export const ScreenshotIcon: ToolIcon = ({ className }) => <Camera className={className} />
export const ClickIcon: ToolIcon = ({ className }) => <MousePointerClick className={className} />
export const ScrollIcon: ToolIcon = ({ className }) => <MoveVertical className={className} />
export const TypeIcon: ToolIcon = ({ className }) => <Keyboard className={className} />
export const NavigateIcon: ToolIcon = ({ className }) => <Navigation className={className} />
export const ReloadIcon: ToolIcon = ({ className }) => <RotateCw className={className} />
export const BackIcon: ToolIcon = ({ className }) => <ArrowLeft className={className} />
export const ForwardIcon: ToolIcon = ({ className }) => <ArrowRight className={className} />
export const DomIcon: ToolIcon = ({ className }) => <Code className={className} />
export const ClickablesIcon: ToolIcon = ({ className }) => <Crosshair className={className} />
export const ConsoleIcon: ToolIcon = ({ className }) => <SquareTerminal className={className} />
export const UrlIcon: ToolIcon = ({ className }) => <Link className={className} />
export const NewTabIcon: ToolIcon = ({ className }) => <SquarePlus className={className} />
export const TabListIcon: ToolIcon = ({ className }) => <AppWindow className={className} />
export const CursorIcon: ToolIcon = ({ className }) => <MousePointer className={className} />
export const ShellKillIcon: ToolIcon = ({ className }) => <SquareX className={className} />
export const ListIcon: ToolIcon = ({ className }) => <List className={className} />
export const BranchIcon: ToolIcon = ({ className }) => <GitBranch className={className} />
export const RenameIcon: ToolIcon = ({ className }) => <Pencil className={className} />
export const MessageIcon: ToolIcon = ({ className }) => <MessageSquare className={className} />

// Brand icons — Simple Icons via react-icons. Brand-canonical colors
// where they read in both light and dark themes; currentColor (text
// color) for Notion since its canonical black/white logo would
// disappear against the chrome background.

const brand = (
  Icon: ComponentType<{ className?: string; color?: string }>,
  color?: string
): ToolIcon =>
  function BrandIcon({ className }: { className?: string }) {
    return <Icon className={className} color={color} />
  }

export const NotionIcon = brand(SiNotion)
export const SlackIcon = brand(SiSlack, '#E01E5A')
export const GmailIcon = brand(SiGmail, '#EA4335')
export const DriveIcon = brand(SiGoogledrive, '#34A853')
export const CalendarIcon = brand(SiGooglecalendar, '#4285F4')

// Dev & code
export const GithubIcon = brand(SiGithub)
export const GitlabIcon = brand(SiGitlab, '#FC6D26')
export const BitbucketIcon = brand(SiBitbucket, '#2684FF')
export const LinearIcon = brand(SiLinear, '#5E6AD2')
export const JiraIcon = brand(SiJira, '#2684FF')
export const ConfluenceIcon = brand(SiConfluence, '#2684FF')
export const SentryIcon = brand(SiSentry, '#B14A7C')
export const VercelIcon = brand(SiVercel)
export const NetlifyIcon = brand(SiNetlify, '#00C7B7')
export const CloudflareIcon = brand(SiCloudflare, '#F38020')
export const SupabaseIcon = brand(SiSupabase, '#3FCF8E')
export const FirebaseIcon = brand(SiFirebase, '#FFCA28')

// Databases
export const PostgresIcon = brand(SiPostgresql, '#4169E1')
export const MysqlIcon = brand(SiMysql, '#00758F')
export const MongoIcon = brand(SiMongodb, '#47A248')
export const RedisIcon = brand(SiRedis, '#DC382D')
export const SqliteIcon = brand(SiSqlite)
export const SnowflakeIcon = brand(SiSnowflake, '#29B5E8')
export const ElasticIcon = brand(SiElasticsearch, '#00BFB3')

// Communication
export const DiscordIcon = brand(SiDiscord, '#5865F2')
export const TelegramIcon = brand(SiTelegram, '#26A5E4')
export const WhatsappIcon = brand(SiWhatsapp, '#25D366')
export const ZoomIcon = brand(SiZoom, '#2D8CFF')
export const MailchimpIcon = brand(SiMailchimp, '#FFE01B')
export const TwilioIcon = brand(SiTwilio, '#F22F46')
export const IntercomIcon = brand(SiIntercom, '#1F8DED')

// Productivity
export const AsanaIcon = brand(SiAsana, '#F06A6A')
export const TrelloIcon = brand(SiTrello, '#2684FF')
export const ClickupIcon = brand(SiClickup, '#7B68EE')

// Commerce & finance
export const StripeIcon = brand(SiStripe, '#635BFF')
export const PaypalIcon = brand(SiPaypal, '#0070BA')
export const ShopifyIcon = brand(SiShopify, '#7AB55C')
export const HubspotIcon = brand(SiHubspot, '#FF7A59')
export const SalesforceIcon = brand(SiSalesforce, '#00A1E0')
export const ZendeskIcon = brand(SiZendesk)

// AI & search
export const OpenaiIcon = brand(SiOpenai)
export const HuggingfaceIcon = brand(SiHuggingface, '#FFD21E')
export const PerplexityIcon = brand(SiPerplexity, '#20A8B0')
export const BraveIcon = brand(SiBrave, '#FB542B')
export const AnthropicIcon = brand(SiAnthropic)

// Media & social
export const FigmaIcon = brand(SiFigma, '#F24E1E')
export const SpotifyIcon = brand(SiSpotify, '#1DB954')
export const YoutubeIcon = brand(SiYoutube, '#FF0000')
export const RedditIcon = brand(SiReddit, '#FF4500')
export const XIcon = brand(SiX)
export const BlueskyIcon = brand(SiBluesky, '#0285FF')
export const CloudinaryIcon = brand(SiCloudinary, '#3448C5')

// Ness mark — the creature, Simple-Icons-style silhouette (no background
// rect) so it sits next to the other brand logos without reading as a
// miniature app icon. One flat fill, and deliberately NOT a
// <linearGradient> + url(#id): Chromium resolves SVG fragment refs against
// the document base URI, which differs between dev (http://localhost) and
// prod (file://), and the gradient version of this icon rendered blank in
// packaged builds because of it. Keep it single-fill.
//
// Path data comes from NessMark so the mark lives in one place; the transform
// maps its bounding box (x 7.6–56.8, y 10.4–38) onto the 24-unit viewBox the
// rest of this file uses. Fill is a literal, not currentColor: these sit in a
// row of brand logos whose parent sets an unrelated text colour.
export const NessIcon: ToolIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <g transform="translate(12,12) scale(0.42) translate(-32.2,-24.2)" fill="var(--color-brand)">
      {NESS_MARK_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
    </g>
  </svg>
)

// Generic MCP fallback — plug shape, no brand association.
export const McpGenericIcon: ToolIcon = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    className={className}
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M9 3v4 M15 3v4" />
    <rect x="6" y="7" width="12" height="6" rx="1" />
    <path d="M12 13v4 M9 17h6" />
  </svg>
)
