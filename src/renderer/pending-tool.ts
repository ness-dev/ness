import type { PendingTool } from './types'
import { prettyToolName } from './components/json-mode-cards/tool-display'
import { parseQuestions } from '../shared/ask-user-question'

const MAX_SUMMARY = 60

function truncate(s: string, n = MAX_SUMMARY): string {
  const clean = s.replace(/\s+/g, ' ').trim()
  return clean.length > n ? clean.slice(0, n - 1) + '…' : clean
}

function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return idx >= 0 ? p.slice(idx + 1) : p
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key]
  return typeof v === 'string' ? v : undefined
}

export function formatPendingTool(tool: PendingTool): string {
  const input = tool.input || {}
  switch (tool.name) {
    case 'Bash': {
      const cmd = str(input, 'command')
      return cmd ? `Bash "${truncate(cmd)}"` : 'Bash'
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'Read': {
      const p = str(input, 'file_path')
      return p ? `${tool.name} ${basename(p)}` : tool.name
    }
    case 'NotebookEdit': {
      const p = str(input, 'notebook_path') || str(input, 'file_path')
      return p ? `NotebookEdit ${basename(p)}` : 'NotebookEdit'
    }
    case 'WebFetch': {
      const url = str(input, 'url')
      return url ? `WebFetch ${truncate(url)}` : 'WebFetch'
    }
    case 'WebSearch': {
      const q = str(input, 'query')
      return q ? `WebSearch ${truncate(q)}` : 'WebSearch'
    }
    case 'Glob':
    case 'Grep': {
      const pattern = str(input, 'pattern')
      return pattern ? `${tool.name} ${truncate(pattern)}` : tool.name
    }
    case 'AskUserQuestion': {
      const [first] = parseQuestions(input)
      return first ? truncate(first.question) : 'Question'
    }
    case 'edit_copy': {
      const title = str(input, 'title')
      return title ? `Edit copy: ${truncate(title)}` : 'Edit copy'
    }
    default:
      return prettyToolName(tool.name)
  }
}
