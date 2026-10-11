import { Brain, MessageSquare, Sparkles, Wrench } from 'lucide-react'
import type { AgentStep } from '../../shared/state/json-claude-agents'
import { isSubAgentToolName } from '../../shared/state/json-claude-agents'
import {
  extractArgs,
  getToolDisplay
} from './json-mode-cards/tool-display'

/** Argument keys that identify *what* a call acted on, in preference
 *  order. `extractArgs` preserves the input's own key order, which is
 *  usually right but not always — a Bash call leads with `command` on
 *  one version and `description` on another. Naming the interesting keys
 *  keeps the one line we have pointed at the subject. */
const SUBJECT_KEYS = [
  'file_path',
  'path',
  'command',
  'pattern',
  'query',
  'url',
  'prompt',
  'description',
  'subject'
]

/** The one-line "what it acted on" for a tool step. */
export function summarizeStepArgs(step: AgentStep): string {
  if (step.kind !== 'tool') return ''
  const args = extractArgs(step.input)
  if (args.length === 0) return ''
  const preferred =
    SUBJECT_KEYS.map((k) => args.find((a) => a.key === k)).find(Boolean) ??
    args[0]
  return preferred.value.replace(/\s+/g, ' ').trim()
}

/** One line of an agent's activity feed. Shared by the Agents panel's
 *  "currently" line and the peek view's step list, so a step reads the
 *  same in both places. */
export function AgentStepLine({
  step,
  dim = false
}: {
  step: AgentStep
  dim?: boolean
}): JSX.Element {
  if (step.kind === 'thinking') {
    return (
      <span className="flex items-center gap-1.5 min-w-0">
        <Brain className="icon-2xs text-muted shrink-0" />
        <span className="text-muted italic truncate">thinking</span>
      </span>
    )
  }
  if (step.kind === 'text') {
    return (
      <span className="flex items-center gap-1.5 min-w-0">
        <MessageSquare className="icon-2xs text-muted shrink-0" />
        <span className={`truncate ${dim ? 'text-muted' : 'text-fg'}`}>
          {step.text}
        </span>
      </span>
    )
  }
  const nested = isSubAgentToolName(step.toolName)
  const display = getToolDisplay(step.toolName)
  const Icon = nested ? Sparkles : (display.icon ?? Wrench)
  const detail = summarizeStepArgs(step)
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      <Icon
        className={`icon-2xs shrink-0 ${
          step.isError ? 'text-danger' : 'text-muted'
        }`}
      />
      <span className="text-muted shrink-0">{display.compactLabel}</span>
      {detail && (
        <span className={`truncate ${dim ? 'text-muted/70' : 'opacity-70'}`}>
          {detail}
        </span>
      )}
    </span>
  )
}
