#!/usr/bin/env node
// Writes the PR context run.mjs needs: { number, title, body, files, diff,
// baseSha, headSha }. Uses the gh CLI, so it works with GH_TOKEN in CI and
// with a logged-in gh locally.
//
// Usage: node collect-pr.mjs <pr-number> <out.json> [--repo owner/name]

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const [num, outFile, flag, repoArg] = process.argv.slice(2)
const repo = flag === '--repo' ? ['--repo', repoArg] : []
const gh = (...a) => execFileSync('gh', [...a, ...repo], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

const meta = JSON.parse(gh('pr', 'view', num, '--json', 'number,title,body,files,baseRefOid,headRefOid'))
const NOISE = /(^|\/)(package-lock\.json|.*\.snap|.*\.lock)$|\.(png|jpe?g|gif|webp|ico|icns)$/

const diff = gh('pr', 'diff', num)
  .split(/(?=^diff --git )/m)
  .filter((chunk) => {
    const m = chunk.match(/^diff --git a\/(\S+)/)
    return !m || !NOISE.test(m[1])
  })
  .join('')

writeFileSync(
  outFile,
  JSON.stringify(
    {
      number: meta.number,
      title: meta.title,
      body: meta.body,
      files: meta.files.map((f) => `${f.path} (+${f.additions} -${f.deletions})`),
      diff,
      baseSha: meta.baseRefOid,
      headSha: meta.headRefOid
    },
    null,
    2
  )
)
