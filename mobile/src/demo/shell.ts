// A tiny fake shell for the demo's terminal tabs: a prompt, line editing,
// history, Ctrl+C / Ctrl+L, and canned output for a handful of commands.
// Bytes in, bytes out — DemoTransport feeds it pty:write and sends what it
// returns as terminal:data, so TerminalView runs exactly as it does
// against a real PTY.
import type { DemoGit } from './git'
import { UNITS_TS_BUGGY } from './project'

const ESC = '\x1b['
const color = (code: string, s: string) => `${ESC}${code}m${s}${ESC}0m`
const green = (s: string) => color('32', s)
const red = (s: string) => color('31', s)
const dim = (s: string) => color('2', s)
const bold = (s: string) => color('1', s)
const cyan = (s: string) => color('36', s)
const yellow = (s: string) => color('33', s)
const magenta = (s: string) => color('35', s)

const lines = (...ls: string[]) => ls.join('\r\n') + '\r\n'

const MAIN_LOG = [
  ['a41f9c2', 'Release v0.4.0'],
  ['7d03be1', 'Air quality badge (#39)'],
  ['c88e410', 'Cache forecasts for 10 minutes (#36)'],
  ['19b2f7d', 'Five-day forecast cards (#31)'],
  ['e5a6d03', 'Initial commit']
]

export interface ShellContext {
  cwd: string
  branch: string
  git: DemoGit
}

export const COMMANDS = ['help', 'ls', 'git status', 'git log --oneline', 'npm test', 'pwd', 'clear'] as const

/** Output for one command line, or null for an unknown command. Exported
 *  for the command-table test. */
export function runCommand(line: string, ctx: ShellContext): string | null {
  const cmd = line.trim().replace(/\s+/g, ' ')
  switch (cmd) {
    case '':
      return ''
    case 'help':
      return lines(
        bold('Ness demo shell'),
        'This is a pretend terminal. On your own machine, this tab is a real shell.',
        '',
        `Try: ${COMMANDS.filter((c) => c !== 'help').map(cyan).join(', ')}`
      )
    case 'pwd':
      return lines(ctx.cwd)
    case 'clear':
      return `${ESC}2J${ESC}H`
    case 'ls':
    case 'ls -la':
    case 'ls -l':
      return lsOutput(ctx)
    case 'git status':
      return gitStatus(ctx)
    case 'git log':
    case 'git log --oneline':
      return gitLog(ctx)
    case 'npm test':
    case 'npm run test':
      return npmTest(ctx)
    default:
      return null
  }
}

function lsOutput(ctx: ShellContext): string {
  const top = new Set<string>()
  for (const f of ctx.git.listFiles(ctx.cwd)) top.add(f.includes('/') ? `${f.split('/')[0]}/` : f)
  const names = [...top].sort((a, b) => Number(b.endsWith('/')) - Number(a.endsWith('/')) || a.localeCompare(b))
  return lines(names.map((n) => (n.endsWith('/') ? bold(color('34', n)) : n)).join('  '))
}

function gitStatus(ctx: ShellContext): string {
  const files = ctx.git.changedFiles(ctx.cwd)
  const staged = files.filter((f) => f.staged)
  const unstaged = files.filter((f) => !f.staged && f.status !== 'untracked')
  const untracked = files.filter((f) => f.status === 'untracked')
  const out = [`On branch ${ctx.branch}`]
  if (ctx.branch !== 'main') out.push(`Your branch is up to date with 'origin/${ctx.branch}'.`)
  if (files.length === 0) return lines(...out, '', 'nothing to commit, working tree clean')
  if (staged.length) out.push('', 'Changes to be committed:', ...staged.map((f) => green(`\t${f.status}:   ${f.path}`)))
  if (unstaged.length) out.push('', 'Changes not staged for commit:', ...unstaged.map((f) => red(`\t${f.status}:   ${f.path}`)))
  if (untracked.length) out.push('', 'Untracked files:', ...untracked.map((f) => red(`\t${f.path}`)))
  return lines(...out)
}

function gitLog(ctx: ShellContext): string {
  const branch = ctx.git.branchCommits(ctx.cwd).map((c) => [c.shortHash, c.subject])
  const all = [...branch, ...MAIN_LOG]
  return lines(
    ...all.map(([hash, subject], i) => {
      const ref = i === 0 ? ` ${yellow('(')}${cyan('HEAD -> ')}${green(ctx.branch)}${yellow(')')}` : ''
      return `${yellow(hash)}${ref} ${subject}`
    })
  )
}

function npmTest(ctx: ShellContext): string {
  const broken = ctx.git.readFile(ctx.cwd, 'src/units.ts') === UNITS_TS_BUGGY
  const head = ['', `> acme-weather@0.4.0 test`, '> vitest run', '', ` ${color('46;30', ' RUN ')} ${dim(ctx.cwd)}`, '']
  if (broken) {
    return lines(
      ...head,
      ` ${red('❯')} tests/units.test.ts ${dim('(5 tests | ')}${red('3 failed')}${dim(')')}`,
      `   ${red('×')} toFahrenheit > converts 0°C to 32°F`,
      `   ${red('×')} toFahrenheit > converts 100°C to 212°F`,
      `     ${red('→ expected 87.55555555555556 to be 212')}`,
      `   ${red('×')} formatTemp > formats Fahrenheit`,
      ` ${green('✓')} tests/forecast.test.ts ${dim('(1 test) 8ms')}`,
      '',
      ` ${dim('Test Files')}  ${red('1 failed')} ${dim('|')} ${green('1 passed')} ${dim('(2)')}`,
      `      ${dim('Tests')}  ${red('3 failed')} ${dim('|')} ${green('3 passed')} ${dim('(6)')}`
    )
  }
  const hourly = ctx.git.readFile(ctx.cwd, 'src/components/HourlyForecast.tsx') !== undefined
  const forecastTests = hourly ? 2 : 1
  return lines(
    ...head,
    ` ${green('✓')} tests/units.test.ts ${dim('(5 tests) 3ms')}`,
    ` ${green('✓')} tests/forecast.test.ts ${dim(`(${forecastTests} test${forecastTests > 1 ? 's' : ''}) 9ms`)}`,
    '',
    ` ${dim('Test Files')}  ${green('2 passed')} ${dim('(2)')}`,
    `      ${dim('Tests')}  ${green(`${5 + forecastTests} passed`)} ${dim(`(${5 + forecastTests})`)}`,
    `   ${dim('Duration')}  412ms`
  )
}

export class DemoShell {
  private line = ''
  private history: string[] = []
  private historyIdx = 0
  /** A partial escape sequence split across writes. */
  private pendingEsc = ''

  constructor(private readonly ctx: ShellContext) {}

  prompt(): string {
    const dir = this.ctx.cwd.split('/').pop()
    return `${cyan(dir ?? '~')} ${magenta(this.ctx.branch)} ${bold('$')} `
  }

  start(): string {
    return lines(dim('Ness demo shell. Type ') + cyan('help') + dim(' to see what works here.')) + this.prompt()
  }

  /** Feed PTY input; returns the bytes to print. */
  input(data: string): string {
    let out = ''
    let s = this.pendingEsc + data
    this.pendingEsc = ''
    while (s.length) {
      if (s[0] === '\x1b') {
        const m = /^\x1b\[[0-9;?]*[A-Za-z~]/.exec(s) ?? /^\x1b[O][A-Za-z]/.exec(s)
        if (!m) {
          // A sequence split across writes waits for the rest; a bare ESC
          // (the key row's Esc) or anything unrecognised is dropped.
          if (s.length > 1 && /^\x1b(\[[0-9;?]*)?$/.test(s)) {
            this.pendingEsc = s
            break
          }
          s = s.slice(1)
          continue
        }
        out += this.escape(m[0])
        s = s.slice(m[0].length)
        continue
      }
      const ch = s[0]
      s = s.slice(1)
      out += this.key(ch)
    }
    return out
  }

  private key(ch: string): string {
    switch (ch) {
      case '\r':
      case '\n':
        return this.submit()
      case '\x7f':
      case '\b':
        if (!this.line) return ''
        this.line = this.line.slice(0, -1)
        return '\b \b'
      case '\x03':
        this.line = ''
        return '^C\r\n' + this.prompt()
      case '\x0c':
        return `${ESC}2J${ESC}H` + this.prompt() + this.line
      case '\x15': {
        const n = this.line.length
        this.line = ''
        return '\b \b'.repeat(n)
      }
      case '\x04':
        return this.line ? '' : '\r\n' + dim('(the demo shell stays open)') + '\r\n' + this.prompt()
      case '\t':
        return this.complete()
      default:
        if (ch < ' ') return ''
        this.line += ch
        return ch
    }
  }

  private escape(seq: string): string {
    const k = seq.slice(-1)
    if (k !== 'A' && k !== 'B') return ''
    if (this.history.length === 0) return ''
    this.historyIdx = Math.max(0, Math.min(this.history.length, this.historyIdx + (k === 'A' ? -1 : 1)))
    const next = this.history[this.historyIdx] ?? ''
    const erase = '\b \b'.repeat(this.line.length)
    this.line = next
    return erase + next
  }

  private complete(): string {
    const match = COMMANDS.find((c) => this.line.length > 0 && c.startsWith(this.line) && c !== this.line)
    if (!match) return ''
    const rest = match.slice(this.line.length)
    this.line = match
    return rest
  }

  private submit(): string {
    const cmd = this.line
    this.line = ''
    if (cmd.trim()) {
      this.history.push(cmd)
    }
    this.historyIdx = this.history.length
    const result = runCommand(cmd, this.ctx)
    if (result === null) return '\r\n' + `demo: command not available: ${cmd.trim().split(' ')[0]}` + '\r\n' + dim(`Type ${'help'} for the commands this demo knows.`) + '\r\n' + this.prompt()
    if (cmd.trim() === 'clear') return result + this.prompt()
    return '\r\n' + result + this.prompt()
  }
}
