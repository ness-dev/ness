import type { AppState } from './state'
import { getLeaves, type AgentKind } from './state/terminals'
import { worktreeHandle } from './state/worktrees'
import { tabLabel } from './agent-tabs'

// `@chat:<repo>/<branch>#<tab>` is what a chat mention inserts. Same reason
// as the `worktree:` prefix: without it the agent tries to Read the handle
// off disk. `<tab>` is the tab name slugged — tab names have spaces, and a
// token has to end at whitespace — unless that slug is empty or shared with
// another Chat tab in the worktree, in which case it is the tab id. So the
// token is unambiguous when inserted, and resolveChatQuery
// (main/chat-delivery.ts) refuses rather than guesses if a later rename
// makes it ambiguous.
export const CHAT_MENTION_PREFIX = 'chat:'

export function slugifyTabLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function chatMentionToken(handle: string, tabRef: string): string {
  return `${CHAT_MENTION_PREFIX}${handle}#${tabRef}`
}

/** Splits a chat token (with or without the leading `@`) into its worktree
 *  handle and tab ref, or null when it isn't one. Split on the LAST `#`: the
 *  ref is a slug or an id, neither of which contains one, while a branch
 *  name legally can. */
export function parseChatMention(query: string): { worktree: string; tab: string } | null {
  let q = query.trim()
  if (q.startsWith('@')) q = q.slice(1)
  if (!q.toLowerCase().startsWith(CHAT_MENTION_PREFIX)) return null
  q = q.slice(CHAT_MENTION_PREFIX.length)
  const hash = q.lastIndexOf('#')
  if (hash <= 0 || hash === q.length - 1) return null
  return { worktree: q.slice(0, hash).trim(), tab: q.slice(hash + 1).trim() }
}

export interface ChatMentionTarget {
  worktreePath: string
  tabId: string
  label: string
  agentKind: AgentKind
  /** Alias when set, else `<repo>/<branch>` — the row's description. A
   *  bare branch would read `main` for every repo's main checkout. */
  worktreeName: string
  alias?: string
  branch: string
  /** Token without the leading `@`. */
  token: string
}

/** Every Chat tab in the workspace as a mention target, except `selfTabId`.
 *  Terminal agent tabs are left out: send_message refuses them. */
export function listChatMentionTargets(
  worktrees: AppState['worktrees']['list'],
  panes: AppState['terminals']['panes'],
  aliasesByPath: Record<string, string>,
  selfTabId: string
): ChatMentionTarget[] {
  const out: ChatMentionTarget[] = []
  for (const w of worktrees) {
    if (w.prunable) continue
    const tree = panes[w.path]
    if (!tree) continue
    const tabs = getLeaves(tree)
      .flatMap((leaf) => leaf.tabs)
      .filter((t) => t.type === 'json-claude')
    const slugs = tabs.map((t) => slugifyTabLabel(tabLabel(t)))
    const handle = worktreeHandle(w.repoRoot, w.branch)
    const alias = aliasesByPath[w.path]
    tabs.forEach((t, i) => {
      if (t.id === selfTabId) return
      const slug = slugs[i]
      const unique = slug !== '' && slugs.indexOf(slug) === slugs.lastIndexOf(slug)
      out.push({
        worktreePath: w.path,
        tabId: t.id,
        label: tabLabel(t),
        agentKind: t.agentKind ?? 'claude',
        worktreeName: alias || handle,
        ...(alias ? { alias } : {}),
        branch: w.branch,
        token: chatMentionToken(handle, unique ? slug : t.id)
      })
    })
  }
  return out
}

export const MAX_CHAT_MENTION_RESULTS = 8

/** Substring match on the tab name and the worktree's alias and branch, so
 *  `@Site` lists the chats inside the Site worktree as well as any tab
 *  named Site. Not the repo name: one repo holds dozens of chats, and
 *  `@<repo>` would bury the worktree rows under all of them. The full
 *  token only counts once the query starts with the `chat:` prefix, which
 *  is how `@chat:` lists everything. A tab-name hit ranks above a worktree
 *  hit; ties keep list order. Returns the label match offset for highlighting (-1 when the hit
 *  wasn't on the label). */
export function matchChatMentions(
  query: string,
  targets: ChatMentionTarget[],
  limit = MAX_CHAT_MENTION_RESULTS
): { target: ChatMentionTarget; labelAt: number }[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const ranked: { rank: number; order: number; target: ChatMentionTarget; labelAt: number }[] = []
  targets.forEach((t, order) => {
    const labelAt = t.label.toLowerCase().indexOf(q)
    const worktreeHit =
      (t.alias?.toLowerCase().includes(q) ?? false) ||
      t.branch.toLowerCase().includes(q) ||
      (q.startsWith(CHAT_MENTION_PREFIX) && t.token.toLowerCase().startsWith(q))
    if (labelAt === -1 && !worktreeHit) return
    const rank = labelAt !== -1 ? labelAt : Number.MAX_SAFE_INTEGER
    ranked.push({ rank, order, target: t, labelAt })
  })
  ranked.sort((a, b) => a.rank - b.rank || a.order - b.order)
  return ranked.slice(0, limit).map(({ target, labelAt }) => ({ target, labelAt }))
}
