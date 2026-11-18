#!/usr/bin/env node
// Writes the PR context run.mjs needs: { number, title, body, files,
// fileDiffs, baseSha, headSha }. fileDiffs maps each path to its own diff so
// run.mjs can budget the prompt and fetch the rest on demand. Uses the gh
// CLI, so it works with GH_TOKEN in CI and with a logged-in gh locally.
//
// Usage: node collect-pr.mjs <pr-number> <out.json> [--repo owner/name]

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const [num, outFile, flag, repoArg] = process.argv.slice(2)
const repo = flag === '--repo' ? ['--repo', repoArg] : []
const gh = (...a) => execFileSync('gh', [...a, ...repo], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

const meta = JSON.parse(gh('pr', 'view', num, '--json', 'number,title,body,files,baseRefOid,headRefOid'))
const NOISE = /(^|\/)(package-lock\.json|.*\.snap|.*\.lock)$|\.(png|jpe?g|gif|webp|ico|icns)$/

const fileDiffs = {}
for (const chunk of gh('pr', 'diff', num).split(/(?=^diff --git )/m)) {
  const m = chunk.match(/^diff --git a\/\S+ b\/(\S+)/)
  if (m && !NOISE.test(m[1])) fileDiffs[m[1]] = chunk
}

writeFileSync(
  outFile,
  JSON.stringify(
    {
      number: meta.number,
      title: meta.title,
      body: meta.body,
      files: meta.files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions })),
      fileDiffs,
      baseSha: meta.baseRefOid,
      headSha: meta.headRefOid
    },
    null,
    2
  )
)
