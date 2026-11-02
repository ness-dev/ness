// Shared per-line fold logic for Claude Code session jsonl transcripts.
// Used by:
//   - cost-tracker.ts  (incremental, charOffset-based per session)
//   - cost-aggregator.ts (one-shot, walks every project dir)
// Both share the same accumulator math; only the read protocol differs.

import {
  emptyTally,
  emptyBreakdown,
  cloneBreakdown,
  type ContentBreakdown,
  type ModelTally
} from '../shared/state/costs'
import { priceFor, rateFor, type TokenUsage } from '../shared/pricing'

type Block = Record<string, unknown>

export interface CtxChars {
  userPrompt: number
  assistantEcho: number
  toolResults: Record<string, number>
}

export interface FoldState {
  byModel: Record<string, ModelTally>
  breakdown: ContentBreakdown
  ctx: CtxChars
  toolNameById: Record<string, string>
  currentModel: string | null
}

export function newFoldState(): FoldState {
  return {
    byModel: {},
    breakdown: cloneBreakdown(emptyBreakdown),
    ctx: { userPrompt: 0, assistantEcho: 0, toolResults: {} },
    toolNameById: {},
    currentModel: null
  }
}

export function resetFoldState(state: FoldState): void {
  state.byModel = {}
  state.breakdown = cloneBreakdown(emptyBreakdown)
  state.ctx = { userPrompt: 0, assistantEcho: 0, toolResults: {} }
  state.toolNameById = {}
  state.currentModel = null
}

export function detectFormat(firstLine: string): 'claude' | 'codex' {
  try {
    const first = JSON.parse(firstLine) as Record<string, unknown>
    if (
      first.type === 'session_meta' ||
      first.type === 'event_msg' ||
      first.type === 'response_item' ||
      first.type === 'turn_context'
    ) {
      return 'codex'
    }
  } catch {
    /* fall through to claude */
  }
  return 'claude'
}

export function foldClaudeLines(text: string, state: FoldState): void {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const type = obj.type
    if (type === 'user') {
      handleUserMessage(obj, state.ctx, state.toolNameById)
      continue
    }
    if (type === 'assistant') {
      const model = handleAssistantMessage(
        obj,
        state.ctx,
        state.toolNameById,
        state.byModel,
        state.breakdown
      )
      if (model) state.currentModel = model
    }
  }
}

export function foldCodexLines(text: string, state: FoldState): void {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }

    if (obj.type === 'turn_context') {
      const payload = obj.payload as Record<string, unknown> | undefined
      if (payload && typeof payload.model === 'string') {
        state.currentModel = payload.model
      }
    }

    if (obj.type === 'event_msg') {
      const payload = obj.payload as Record<string, unknown> | undefined
      if (payload?.type !== 'token_count') continue
      const info = payload.info as Record<string, unknown> | undefined
      const lastUsage = info?.last_token_usage as Record<string, unknown> | undefined
      if (!lastUsage || !state.currentModel) continue

      // OpenAI's input_tokens INCLUDES the cached ones (cached_input_tokens
      // is a subset), unlike Claude's, where cache reads are counted
      // separately. priceFor follows Claude's convention, so bill only the
      // uncached remainder at the full input rate.
      const cachedInputTokens = (lastUsage.cached_input_tokens as number) ?? 0
      const inputTokens = Math.max(0, ((lastUsage.input_tokens as number) ?? 0) - cachedInputTokens)
      const outputTokens = (lastUsage.output_tokens as number) ?? 0
      const reasoningTokens = (lastUsage.reasoning_output_tokens as number) ?? 0

      const usage = {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cached_input_tokens: cachedInputTokens,
        reasoning_output_tokens: reasoningTokens
      }
      const cost = priceFor(state.currentModel, usage)

      const tally = (state.byModel[state.currentModel] ??= { ...emptyTally })
      tally.messages += 1
      tally.input += inputTokens
      tally.output += outputTokens
      tally.cacheRead += cachedInputTokens
      tally.cost += cost

      state.breakdown.text += cost
    }
  }
}

function handleUserMessage(
  obj: Record<string, unknown>,
  ctx: CtxChars,
  toolNameById: Record<string, string>
): void {
  const msg = obj.message as Record<string, unknown> | undefined
  if (!msg) return
  const content = msg.content
  if (typeof content === 'string') {
    ctx.userPrompt += content.length
    return
  }
  if (!Array.isArray(content)) return
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue
    const block = raw as Block
    const btype = block.type
    if (btype === 'text') {
      const t = block.text
      if (typeof t === 'string') ctx.userPrompt += t.length
    } else if (btype === 'tool_result') {
      const id = block.tool_use_id as string | undefined
      const name = (id && toolNameById[id]) || 'unknown'
      const chars = charLenOfToolResultContent(block.content)
      ctx.toolResults[name] = (ctx.toolResults[name] ?? 0) + chars
    }
  }
}

function handleAssistantMessage(
  obj: Record<string, unknown>,
  ctx: CtxChars,
  toolNameById: Record<string, string>,
  byModel: Record<string, ModelTally>,
  breakdown: ContentBreakdown
): string | null {
  const msg = obj.message as Record<string, unknown> | undefined
  if (!msg) return null
  const model = typeof msg.model === 'string' ? msg.model : null
  const usage = (msg.usage ?? null) as TokenUsage | null
  if (!model || !usage) return null

  const content = Array.isArray(msg.content) ? (msg.content as Block[]) : []
  let textChars = 0
  let thinkingChars = 0
  let toolUseChars = 0
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const btype = block.type
    if (btype === 'text') {
      const t = block.text
      if (typeof t === 'string') textChars += t.length
    } else if (btype === 'thinking') {
      const t = block.thinking
      if (typeof t === 'string') thinkingChars += t.length
    } else if (btype === 'tool_use') {
      const id = block.id as string | undefined
      const name = block.name as string | undefined
      if (id && name) toolNameById[id] = name
      toolUseChars += JSON.stringify(block.input ?? null).length
    }
  }

  const turnCost = priceFor(model, usage)
  const rate = rateFor(model)
  const outputCost = rate ? ((usage.output_tokens ?? 0) * rate.out) / 1_000_000 : 0
  const inputCost = Math.max(0, turnCost - outputCost)

  const outTotal = textChars + thinkingChars + toolUseChars
  if (outTotal > 0 && outputCost > 0) {
    breakdown.text += (outputCost * textChars) / outTotal
    breakdown.thinking += (outputCost * thinkingChars) / outTotal
    breakdown.toolUse += (outputCost * toolUseChars) / outTotal
  } else {
    breakdown.text += outputCost
  }

  const ctxToolTotal = Object.values(ctx.toolResults).reduce((a, b) => a + b, 0)
  const ctxTotal = ctx.userPrompt + ctx.assistantEcho + ctxToolTotal
  if (ctxTotal > 0 && inputCost > 0) {
    breakdown.userPrompt += (inputCost * ctx.userPrompt) / ctxTotal
    breakdown.assistantEcho += (inputCost * ctx.assistantEcho) / ctxTotal
    for (const [name, chars] of Object.entries(ctx.toolResults)) {
      breakdown.toolResults[name] =
        (breakdown.toolResults[name] ?? 0) + (inputCost * chars) / ctxTotal
    }
  } else if (inputCost > 0) {
    breakdown.assistantEcho += inputCost
  }

  ctx.assistantEcho += textChars + thinkingChars + toolUseChars

  const tally = (byModel[model] ??= { ...emptyTally })
  tally.messages += 1
  tally.input += usage.input_tokens ?? 0
  tally.output += usage.output_tokens ?? 0
  tally.cacheRead += usage.cache_read_input_tokens ?? 0
  tally.cacheWrite += usage.cache_creation_input_tokens ?? 0
  tally.cost += turnCost

  return model
}

function charLenOfToolResultContent(content: unknown): number {
  if (typeof content === 'string') return content.length
  if (Array.isArray(content)) {
    let total = 0
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const p = part as Block
      if (p.type === 'text' && typeof p.text === 'string') total += p.text.length
    }
    return total
  }
  return 0
}
