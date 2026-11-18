// One-shot walker over ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl that
// produces a per-session cost summary list for the Activity > Costs tab.
//
// Cache is in-memory only and keyed by absolute file path; an entry hits when
// the on-disk mtime hasn't moved since we last parsed. First call after boot
// pays the full parse cost (1-5s for hundreds of sessions); subsequent calls
// only re-parse files that grew. Lost on restart — acceptable for v1.
//
// Project dir name is the worktree path with every non-alphanumeric char
// collapsed to '-' (see json-claude-manager.ts seedFromTranscript). The
// reverse is lossy, so for display we prefer the `cwd` field that Claude
// Code writes onto every assistant/user line and fall back to the encoded
// dir name only if no line carried one.
//
// Parsing reuses the same fold logic CostTracker does (jsonl-fold.ts) so
// per-session breakdown attribution matches the live CostPanel exactly.

import { readdir, stat, readFile } from 'fs/promises'
import { knownClaudeConfigDirs } from './claude-env'
import { join } from 'path'
import {
  newFoldState,
  detectFormat,
  foldClaudeLines,
  foldCodexLines
} from './jsonl-fold'
import {
  emptyBreakdown,
  cloneBreakdown,
  type ContentBreakdown
} from '../shared/state/costs'
import type { SessionCostSummary } from '../shared/cost-summary'
import { log } from './debug'

export type { SessionCostSummary }

interface CacheEntry {
  mtime: number
  summary: SessionCostSummary
}

const cache = new Map<string, CacheEntry>()

export function clearCostAggregatorCache(): void {
  cache.clear()
}

export async function getAllSessionCosts(
  opts: { sinceMs?: number; projectsDir?: string } = {}
): Promise<SessionCostSummary[]> {
  const projectsDirs = opts.projectsDir
    ? [opts.projectsDir]
    : knownClaudeConfigDirs().map((dir) => join(dir, 'projects'))
  const out: SessionCostSummary[] = []
  for (const projectsDir of projectsDirs) {
    out.push(...(await collectSessionCosts(projectsDir, opts.sinceMs)))
  }
  return out
}

async function collectSessionCosts(
  projectsDir: string,
  sinceMs: number | undefined
): Promise<SessionCostSummary[]> {
  let dirs: string[]
  try {
    dirs = await readdir(projectsDir)
  } catch {
    return []
  }

  const out: SessionCostSummary[] = []
  for (const dirName of dirs) {
    const dirPath = join(projectsDir, dirName)
    let dirStat
    try {
      dirStat = await stat(dirPath)
    } catch {
      continue
    }
    if (!dirStat.isDirectory()) continue

    let files: string[]
    try {
      files = await readdir(dirPath)
    } catch {
      continue
    }

    for (const fileName of files) {
      if (!fileName.endsWith('.jsonl')) continue
      const filePath = join(dirPath, fileName)
      let fileStat
      try {
        fileStat = await stat(filePath)
      } catch {
        continue
      }
      if (!fileStat.isFile()) continue

      const mtimeMs = fileStat.mtimeMs
      if (sinceMs != null && mtimeMs < sinceMs) continue

      const cached = cache.get(filePath)
      let summary: SessionCostSummary | null
      if (cached && cached.mtime >= mtimeMs) {
        summary = cached.summary
      } else {
        try {
          summary = await parseSession(filePath, fileName, dirName)
        } catch (err) {
          log(
            'cost-aggregator',
            `parse failed for ${filePath}: ${err instanceof Error ? err.message : err}`
          )
          continue
        }
        if (summary) cache.set(filePath, { mtime: mtimeMs, summary })
      }

      if (!summary || summary.turns === 0) continue
      if (sinceMs != null && summary.lastAt < sinceMs) continue
      out.push(summary)
    }
  }
  return out
}

async function parseSession(
  filePath: string,
  fileName: string,
  dirName: string
): Promise<SessionCostSummary> {
  const text = await readFile(filePath, 'utf-8')
  const sessionId = fileName.replace(/\.jsonl$/, '')

  const state = newFoldState()
  let firstAt = Number.POSITIVE_INFINITY
  let lastAt = 0
  let projectPath: string | null = null
  let turns = 0

  // Walk lines once for metadata extraction (cwd + timestamps + turn count),
  // then run the format-aware fold over the same text for cost attribution.
  // This is two passes over a string but the parse cost dominates either way
  // and keeping the fold strictly per-format keeps the math identical to
  // CostTracker.
  let firstNonEmpty: string | null = null
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    if (!firstNonEmpty) firstNonEmpty = line
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (!projectPath && typeof obj.cwd === 'string') {
      projectPath = obj.cwd
    }
    const rawTs = obj.timestamp
    if (typeof rawTs === 'string') {
      const ts = Date.parse(rawTs)
      if (!Number.isNaN(ts)) {
        if (ts < firstAt) firstAt = ts
        if (ts > lastAt) lastAt = ts
      }
    }
    if (obj.type === 'assistant') {
      const msg = obj.message as Record<string, unknown> | undefined
      if (msg && typeof msg.model === 'string' && msg.usage) turns += 1
    }
  }

  if (firstNonEmpty) {
    const format = detectFormat(firstNonEmpty)
    if (format === 'codex') foldCodexLines(text, state)
    else foldClaudeLines(text, state)
  }

  if (firstAt === Number.POSITIVE_INFINITY) firstAt = 0

  let totalCostUsd = 0
  for (const tally of Object.values(state.byModel)) totalCostUsd += tally.cost

  const breakdown: ContentBreakdown = cloneBreakdown(emptyBreakdown)
  breakdown.text = state.breakdown.text
  breakdown.thinking = state.breakdown.thinking
  breakdown.toolUse = state.breakdown.toolUse
  breakdown.userPrompt = state.breakdown.userPrompt
  breakdown.assistantEcho = state.breakdown.assistantEcho
  breakdown.toolResults = { ...state.breakdown.toolResults }

  return {
    sessionId,
    projectPath: projectPath ?? dirName,
    totalCostUsd,
    model: state.currentModel,
    firstAt,
    lastAt,
    turns,
    breakdown
  }
}
