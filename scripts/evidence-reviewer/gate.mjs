#!/usr/bin/env node
// Decides whether an evidence-review run should spend anything, before any
// PR code is checked out or any npm install / model call happens. Reads the
// triggering event, resolves the PR number and the head SHA to review, and
// writes `run`, `pr`, `sha`, `same_repo` (and `reason`) to $GITHUB_OUTPUT.
//
// Skips when the PR touches nothing under the UI paths, and, for a
// checkbox re-run (issue_comment edited), unless the edit ticked the
// re-run box in the bot's own comment and the sender can write to the repo.
//
// Usage: node gate.mjs   (env: GITHUB_EVENT_NAME, GITHUB_EVENT_PATH,
//                         GITHUB_REPOSITORY, GITHUB_OUTPUT, GH_TOKEN,
//                         INPUT_PR for workflow_dispatch)

import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const MARKER = '<!-- evidence-reviewer -->'
export const RERUN_LABEL = 'Re-run evidence review on the latest push'
export const UI_PATHS = ['src/renderer/', 'src/web-client/']
const BOT = 'github-actions[bot]'

const box = (body) => {
  const escaped = RERUN_LABEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = String(body ?? '').match(new RegExp(`^\\s*[-*] \\[([ xX])\\] ${escaped}`, 'm'))
  return m ? (m[1] === ' ' ? 'unchecked' : 'checked') : 'absent'
}

export const isEvidenceComment = (comment) =>
  comment?.user?.login === BOT && String(comment?.body ?? '').startsWith(MARKER)

export const rerunTicked = (fromBody, toBody) => box(fromBody) === 'unchecked' && box(toBody) === 'checked'

export const canWrite = (perm) =>
  ['admin', 'write'].includes(perm?.permission) || ['admin', 'maintain', 'write'].includes(perm?.role_name)

export const isSameRepo = (pr, repo) => pr?.head?.repo?.full_name === repo

export const touchesUi = (files, prefixes = UI_PATHS) =>
  files.some((f) => prefixes.some((p) => f.startsWith(p)))

// Pure decision for an issue_comment event; returns a skip reason or null.
export function rerunRejection(event, permission) {
  if (!event.issue?.pull_request) return 'comment is not on a pull request'
  if (!isEvidenceComment(event.comment)) return 'not the evidence reviewer comment'
  if (event.sender?.type === 'Bot' || event.sender?.login?.endsWith('[bot]')) return 'edited by a bot'
  if (!rerunTicked(event.changes?.body?.from, event.comment.body)) return 're-run box was not ticked by this edit'
  if (!canWrite(permission)) return `${event.sender?.login} lacks write permission`
  return null
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY
  const eventName = process.env.GITHUB_EVENT_NAME
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  const gh = (path, jq) =>
    execFileSync('gh', ['api', path, '--paginate', ...(jq ? ['--jq', jq] : [])], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    })
  const out = (fields) => {
    const lines = Object.entries(fields).map(([k, v]) => `${k}=${v}`)
    console.log(lines.join('\n'))
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n')
  }
  const skip = (reason) => out({ run: 'false', reason })

  let pr
  if (eventName === 'pull_request_target') pr = event.pull_request.number
  else if (eventName === 'issue_comment') pr = event.issue.number
  else pr = process.env.INPUT_PR
  if (!/^[1-9][0-9]*$/.test(String(pr))) return skip(`invalid PR number ${JSON.stringify(pr)}`)

  if (eventName === 'issue_comment') {
    const login = event.sender?.login ?? ''
    let permission = null
    try {
      if (/^[A-Za-z0-9-]+$/.test(login)) permission = JSON.parse(gh(`repos/${repo}/collaborators/${login}/permission`))
    } catch {
      // 404 for non-collaborators; treat as no permission.
    }
    const rejection = rerunRejection(event, permission)
    if (rejection) return skip(rejection)
  }

  const files = gh(`repos/${repo}/pulls/${pr}/files?per_page=100`, '.[].filename').split('\n').filter(Boolean)
  if (!touchesUi(files)) return skip(`no changes under ${UI_PATHS.join(' or ')}`)

  // pull_request_target pins to the push that queued the run, so approving
  // it approves exactly that commit. Other triggers review the current head.
  const prData = eventName === 'pull_request_target' ? event.pull_request : JSON.parse(gh(`repos/${repo}/pulls/${pr}`))
  const sha = prData.head.sha
  if (!/^[0-9a-f]{40}$/.test(sha)) return skip(`bad head SHA ${JSON.stringify(sha)}`)
  out({ run: 'true', pr, sha, same_repo: isSameRepo(prData, repo), reason: 'ok' })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
