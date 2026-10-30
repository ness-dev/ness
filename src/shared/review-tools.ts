/** The ness-control review tools.
 *
 *  These only read the diff and write Ness's own review state: comments
 *  the user can edit or delete in the Review tab, and a submitted review
 *  shown there before (or after) it is delivered. Nothing here touches
 *  the repo or the outside world.
 *
 *  ApprovalBridge auto-approves them. A reviewer that has to ask
 *  permission for each of its own tools can't review anything
 *  unattended, which is the point of request_review and the CI-green
 *  spawner. */
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
