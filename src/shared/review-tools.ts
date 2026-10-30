/** The ness-control review tools.
 *
 *  These only read the diff and write Ness's own review state: comments
 *  the user can edit or delete in the Review tab, and a submitted review
 *  shown there before (or after) it is delivered. Nothing here touches
 *  the repo or the outside world.
 *
 *  ApprovalBridge auto-approves them. Not because a reviewer runs
 *  unattended — a prompt only pauses it until someone approves — but
 *  because of volume: a single review calls these five to ten times, so
 *  prompting would mean a stream of approvals for every review, each one
 *  about Ness's own review state rather than the user's repo. Tools that
 *  touch anything outside it still prompt as usual. */
const REVIEW_TOOL_SUFFIXES = [
  'list_review_comments',
  'add_review_comment',
  'reply_to_comment',
  'resolve_comment',
  'submit_review',
  'request_review',
  'list_tabs'
]

/** True for a ness-control review tool, bare or MCP-prefixed. */
export function isReviewTool(toolName: string): boolean {
  return REVIEW_TOOL_SUFFIXES.some((t) => toolName === t || toolName.endsWith(`__${t}`))
}
