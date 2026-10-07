import { useEffect, useMemo, useRef, useState } from 'react'
import {
  EDIT_TOOL_NAMES,
  type JsonClaudePendingApproval
} from '../../shared/state/json-claude'
import { formatPendingTool } from '../pending-tool'
import {
  extractArgs,
  getToolDisplay,
  prettyToolName
} from './json-mode-cards/tool-display'
import { ArgsBlock } from './json-mode-cards/ArgsDisplay'
import { useJsonClaudeSession, useSettings } from '../store'
import { useBackend } from '../backend'
import { useViewport } from '../hooks/useViewport'
import {
  suggestPermissionPatterns,
  type PermissionPatternSuggestion
} from '../../shared/permission-patterns'
import {
  resolveHotkeys,
  bindingToString,
  formatBindingGlyphs,
  isTypeableBinding
} from '../hotkeys'

interface JsonClaudeApprovalCardProps {
  approval: JsonClaudePendingApproval
  onResolve: (result: {
    behavior: 'allow' | 'deny'
    updatedInput?: Record<string, unknown>
    updatedPermissions?: unknown[]
    message?: string
    interrupt?: boolean
  }) => void
}

// px-2.5 py-1 lands ~24px tall — fine under a mouse, too small for a thumb.
// Mobile gets the taller target; desktop keeps the denser original.
const BTN_PAD_MOUSE = 'px-2.5 py-1'
const BTN_PAD_TOUCH = 'px-3.5 py-2.5'
const BTN_DISABLED = 'disabled:opacity-40 disabled:cursor-not-allowed'

function scopeChipClasses(scope: PermissionPatternSuggestion['scope']): string {
  if (scope === 'narrow') return 'bg-success/20 text-success border-success/40'
  if (scope === 'medium') return 'bg-amber-500/20 text-amber-400 border-amber-500/40'
  return 'bg-danger/20 text-danger border-danger/40'
}

function tryFormatInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

export function JsonClaudeApprovalCard({
  approval,
  onResolve
}: JsonClaudeApprovalCardProps): JSX.Element {
  const backend = useBackend()
  const settings = useSettings()
  const { isMobile } = useViewport()
  const BTN = `${isMobile ? BTN_PAD_TOUCH : BTN_PAD_MOUSE} text-xs rounded transition-colors cursor-pointer`
  const BTN_ALLOW = `${BTN} bg-success/20 hover:bg-success/30 text-success`
  const BTN_ALLOW_STRONG = `${BTN} font-semibold bg-success/30 hover:bg-success/40 text-success border border-success/50`
  const BTN_NEUTRAL = `${BTN} bg-surface hover:bg-surface/60 text-fg`
  const BTN_DENY = `${BTN} bg-danger/20 hover:bg-danger/30 text-danger`
  const savedGuidance = settings.autoApproveSteerInstructions
  const resolvedHotkeys = useMemo(
    () => resolveHotkeys(settings.hotkeys ?? undefined),
    [settings.hotkeys]
  )
  // A binding with no ⌘/⌃ can't fire while the composer holds focus — it
  // would type instead. Escape parks focus on the transcript, so the honest
  // label for those is the two-key sequence the user actually presses.
  const approveNeedsEscape = isTypeableBinding(resolvedHotkeys.approveToolUse)
  const denyNeedsEscape = isTypeableBinding(resolvedHotkeys.denyToolUse)
  const approveHotkeyLabel =
    (approveNeedsEscape ? '⎋ ' : '') +
    formatBindingGlyphs(bindingToString(resolvedHotkeys.approveToolUse))
  const denyHotkeyLabel =
    (denyNeedsEscape ? '⎋ ' : '') +
    formatBindingGlyphs(bindingToString(resolvedHotkeys.denyToolUse))
  const escapeNote = ' — Esc leaves the composer first'
  const [mode, setMode] = useState<
    'summary' | 'edit' | 'deny' | 'edit-guidance' | 'always'
  >('summary')
  const [editedInput, setEditedInput] = useState<string>(() =>
    tryFormatInput(approval.input)
  )
  const [editError, setEditError] = useState<string | null>(null)
  const [denyMessage, setDenyMessage] = useState('user denied')
  const [interrupt, setInterrupt] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [guidanceDraft, setGuidanceDraft] = useState<string>(savedGuidance)
  // When the saved guidance changes externally (e.g. the user saved it in
  // Settings while this card was open), refresh the draft so the textarea
  // doesn't show stale text. We only re-sync when not actively editing
  // (mode !== 'edit-guidance') to avoid clobbering the user's typing.
  useEffect(() => {
    if (mode !== 'edit-guidance') setGuidanceDraft(savedGuidance)
  }, [savedGuidance, mode])
  const [guidanceSavedAt, setGuidanceSavedAt] = useState<number | null>(null)

  const summary = useMemo(
    () => formatPendingTool({ name: approval.toolName, input: approval.input }),
    [approval.toolName, approval.input]
  )
  const display = useMemo(() => getToolDisplay(approval.toolName), [approval.toolName])
  const parsedArgs = useMemo(() => extractArgs(approval.input), [approval.input])

  const session = useJsonClaudeSession(approval.sessionId)
  const cwd = session?.worktreePath

  const suggestions = useMemo(
    () => suggestPermissionPatterns(approval.toolName, approval.input),
    [approval.toolName, approval.input]
  )
  // Identify suggestions by their display label since the rule shape is an
  // object — labels are unique within a single tool's suggestion list.
  const [selectedLabel, setSelectedLabel] = useState<string>(
    () => suggestions[0]?.label ?? approval.toolName
  )
  const selectedSuggestion =
    suggestions.find((s) => s.label === selectedLabel) ?? suggestions[0]

  const isEditTool = (EDIT_TOOL_NAMES as readonly string[]).includes(
    approval.toolName
  )
  const sessionGrantLabel = isEditTool
    ? 'Allow edits this session'
    : `Allow ${prettyToolName(approval.toolName)} this session`
  // For edit-class tools the button flips permissionMode instead of
  // adding to the per-tool allow set — claude is killed+respawned with
  // --permission-mode acceptEdits and edits stop hitting the bridge
  // entirely. For everything else we still use the session allow set.
  // Exception: in 'auto' the CLI is already filtering which calls are
  // worth asking about, so flipping to acceptEdits would silently
  // downgrade the whole session to get one edit through.
  const grantViaPermissionMode =
    isEditTool && session?.permissionMode !== 'auto'
  const alreadyGranted = grantViaPermissionMode
    ? session?.permissionMode === 'acceptEdits'
    : !!session && session.sessionToolApprovals.includes(approval.toolName)

  function allow(): void {
    // Claude Code 2.1.114's PermissionResult validator requires
    // updatedInput on the allow branch (it was optional in earlier
    // versions). Echo the original input back unchanged so plain Allow
    // is "allow with no changes".
    onResolve({ behavior: 'allow', updatedInput: approval.input })
  }

  async function allowThisSession(): Promise<void> {
    // Resolve first so the bridge writes the allow response before the
    // kill+respawn that setPermissionMode triggers — otherwise the
    // bridge's stopSession would deny-cancel this in-flight approval.
    await backend.resolveJsonClaudeApproval(approval.requestId, {
      behavior: 'allow',
      updatedInput: approval.input
    })
    if (grantViaPermissionMode) {
      await backend.setJsonClaudePermissionMode(
        approval.sessionId,
        'acceptEdits'
      )
    } else {
      await backend.grantJsonClaudeSessionToolApprovals(
        approval.sessionId,
        isEditTool ? [...EDIT_TOOL_NAMES] : [approval.toolName]
      )
    }
  }

  async function saveGuidance(): Promise<void> {
    await backend.setAutoApproveSteerInstructions(guidanceDraft)
    setGuidanceSavedAt(Date.now())
  }

  async function saveGuidanceAndRerun(): Promise<void> {
    await backend.setAutoApproveSteerInstructions(guidanceDraft)
    // Setting the saved timestamp before the IPC means the "Saved"
    // hint is briefly visible if re-review happens to be slow on the
    // first call. The card immediately re-renders with autoReview.state
    // back to 'pending' once main dispatches, replacing the static
    // "Auto-approver: …" row with the spinner.
    setGuidanceSavedAt(Date.now())
    await backend.rerunJsonClaudeAutoApprovalReview(approval.requestId)
    setMode('summary')
  }

  function allowWithEdits(): void {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(editedInput) as Record<string, unknown>
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err))
      return
    }
    setEditError(null)
    onResolve({ behavior: 'allow', updatedInput: parsed })
  }

  function deny(): void {
    onResolve({
      behavior: 'deny',
      message: denyMessage.trim() || 'user denied',
      interrupt
    })
  }

  function alwaysAllow(): void {
    if (!selectedSuggestion) return
    // The rule goes into Ness's own global allowlist, NOT back to Claude
    // via `updatedPermissions`. Two reasons the old path didn't work:
    // Claude persists to `<worktree>/.claude/settings.local.json`, which
    // no sibling worktree reads; and symlinking those together to
    // compensate fails outright because Claude's settings writer refuses
    // to write through a symlink. Ness is the --permission-prompt-tool
    // here, so it can just enforce the grant itself on the next request.
    // See shared/permission-match.ts.
    void backend.grantPermission(selectedSuggestion.rule, cwd)
    onResolve({ behavior: 'allow', updatedInput: approval.input })
  }

  const autoReview = approval.autoReview

  return (
    <div
      id={approval.requestId}
      className="rounded-md border border-danger/40 bg-danger/5 my-2 overflow-hidden"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-danger/30 bg-danger/10">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-semibold uppercase tracking-wide text-danger shrink-0">
            Needs approval
          </span>
          {display.icon && <display.icon className="icon-sm shrink-0" />}
          <span className="text-xs font-mono text-fg-bright truncate">{summary}</span>
        </div>
      </div>

      {autoReview?.state === 'pending' && (
        <div
          className="flex items-center gap-2 px-3 py-1.5 border-b border-danger/20 bg-app/30 text-xs text-muted"
          title="An LLM reviewer is checking this tool call. You can still Allow or Deny manually — whichever happens first wins."
        >
          <span
            className="json-claude-spinner shrink-0"
            aria-label="auto-reviewing"
          />
          <span>Asking auto-approver…</span>
        </div>
      )}
      {autoReview?.state === 'finished' && autoReview.decision === 'ask' && (
        <div className="px-3 py-1.5 border-b border-danger/20 bg-app/30 text-xs text-muted flex items-center gap-2">
          <div
            className="flex-1 min-w-0"
            title={`The auto-approver deferred to a human: ${autoReview.reason ?? ''}`}
          >
            <span className="font-semibold mr-1">Auto-approver:</span>
            <span className="opacity-80">{autoReview.reason || 'deferred'}</span>
          </div>
          {mode !== 'edit-guidance' && (
            <button
              type="button"
              onClick={() => {
                setGuidanceDraft(savedGuidance)
                setGuidanceSavedAt(null)
                setMode('edit-guidance')
              }}
              className="text-xs px-2 py-0.5 rounded border border-border/60 bg-panel hover:bg-app/60 transition-colors shrink-0 cursor-pointer"
              title="Edit the steering guidance and optionally re-run the auto-approver on this request"
            >
              Edit guidance
            </button>
          )}
        </div>
      )}

      {mode === 'edit-guidance' && (
        <div className="px-3 py-2 space-y-2 bg-app/20 border-b border-danger/20">
          <div className="text-xs text-muted">
            Project-specific guidance appended to the auto-approver's policy.
            Save to persist for future requests; "Save & re-review" also re-runs
            the reviewer on this request right now.
          </div>
          <textarea
            value={guidanceDraft}
            onChange={(e) => setGuidanceDraft(e.target.value)}
            placeholder="e.g. Approve npm install. Deny any Bash that touches /etc."
            spellCheck={false}
            className="w-full bg-panel border border-border rounded p-2 text-xs font-mono outline-none focus:border-accent min-h-[80px] resize-y"
          />
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={() => {
                void saveGuidanceAndRerun()
              }}
              className={BTN_ALLOW}
            >
              Save &amp; re-review
            </button>
            <button
              onClick={() => {
                void saveGuidance()
              }}
              disabled={guidanceDraft === savedGuidance}
              className={`${BTN_NEUTRAL} ${BTN_DISABLED}`}
            >
              Save only
            </button>
            <button
              onClick={() => setMode('summary')}
              className={BTN_NEUTRAL}
            >
              Cancel
            </button>
            {guidanceSavedAt !== null && (
              <span className="text-xs text-success">Saved</span>
            )}
          </div>
        </div>
      )}

      {mode === 'summary' && (
        <div className="space-y-2 pb-2">
          {approval.toolName === 'Bash' &&
          typeof approval.input?.command === 'string' ? (
            <div className="px-3 pt-2 space-y-2">
              <pre className="text-xs font-mono bg-app/40 rounded p-2 overflow-x-auto max-h-48 whitespace-pre-wrap">
                {String(approval.input.command)}
              </pre>
              {typeof approval.input?.description === 'string' &&
                approval.input.description.trim() && (
                  <div className="text-xs text-muted italic">
                    {String(approval.input.description)}
                  </div>
                )}
            </div>
          ) : parsedArgs.length > 0 ? (
            <ArgsBlock args={parsedArgs} rawInput={approval.input} />
          ) : (
            <div className="px-3 pt-2 text-xs text-muted italic">No input.</div>
          )}
          <div className="px-3 space-y-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={allow}
              title={`Allow once (${bindingToString(resolvedHotkeys.approveToolUse)}${approveNeedsEscape ? escapeNote : ''})`}
              className={BTN_ALLOW}
            >
              Allow once
              <span className="opacity-60 ml-1">{approveHotkeyLabel}</span>
            </button>
            {!alreadyGranted && (
              <button
                onClick={() => {
                  void allowThisSession()
                }}
                title="Allow this tool for the rest of the session — future calls of this tool skip the prompt. Cleared when the app quits."
                className={BTN_ALLOW_STRONG}
              >
                {sessionGrantLabel}
              </button>
            )}
            <button
              onClick={() => setMode('edit')}
              className={BTN_NEUTRAL}
            >
              Allow with edits
            </button>
            <button
              onClick={() => setMode('always')}
              title="Save a rule in Ness so future matching tool calls skip the prompt — across sessions, app restarts, and every worktree."
              className={BTN_NEUTRAL}
            >
              Always allow…
            </button>
            <button
              onClick={() => setMode('deny')}
              title={`Deny (${bindingToString(resolvedHotkeys.denyToolUse)}${denyNeedsEscape ? escapeNote : ''})`}
              className={BTN_DENY}
            >
              Deny
              <span className="opacity-60 ml-1">{denyHotkeyLabel}</span>
            </button>
          </div>
          </div>
        </div>
      )}

      {mode === 'always' && (
        <div className="px-3 py-2 space-y-2">
          <div className="text-xs text-muted">
            Pick how broadly to allow future matching calls. The rule is
            saved in Ness and applies to chat tabs in every worktree and
            repo. Manage saved rules in Settings → Agent → Chat interface.
          </div>
          <div className="space-y-1">
            {suggestions.map((s) => (
              <label
                key={s.label}
                className="flex items-center gap-2 px-2 py-1 rounded hover:bg-app/40 cursor-pointer text-xs"
              >
                <input
                  type="radio"
                  name={`always-allow-${approval.requestId}`}
                  checked={selectedLabel === s.label}
                  onChange={() => setSelectedLabel(s.label)}
                  className="cursor-pointer"
                />
                <span className="font-mono text-fg-bright flex-1 min-w-0 truncate">
                  {s.label}
                </span>
                <span
                  className={`shrink-0 text-xs uppercase tracking-wide px-1.5 py-0.5 rounded border ${scopeChipClasses(s.scope)}`}
                >
                  {s.scope}
                </span>
              </label>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={alwaysAllow}
              disabled={!selectedSuggestion}
              className={`${BTN_ALLOW} ${BTN_DISABLED}`}
            >
              Always allow this pattern
            </button>
            <button
              onClick={() => setMode('summary')}
              className={BTN_NEUTRAL}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode === 'edit' && (
        <div className="px-3 py-2 space-y-2">
          <div className="text-xs text-muted">
            Edit the tool input JSON before running.
          </div>
          <textarea
            ref={textareaRef}
            value={editedInput}
            onChange={(e) => {
              setEditedInput(e.target.value)
              if (editError) setEditError(null)
            }}
            className="w-full bg-app/40 border border-border rounded p-2 text-xs font-mono outline-none focus:border-accent min-h-[120px]"
            spellCheck={false}
          />
          {editError && (
            <div className="text-xs text-danger">Invalid JSON: {editError}</div>
          )}
          <div className="flex items-center gap-1.5">
            <button
              onClick={allowWithEdits}
              className={BTN_ALLOW}
            >
              Allow edited
            </button>
            <button
              onClick={() => setMode('summary')}
              className={BTN_NEUTRAL}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode === 'deny' && (
        <div className="px-3 py-2 space-y-2">
          <textarea
            value={denyMessage}
            onChange={(e) => setDenyMessage(e.target.value)}
            placeholder="Reason shown to Claude (optional)"
            className="w-full bg-app/40 border border-border rounded p-2 text-xs outline-none focus:border-danger min-h-[60px] resize-none"
          />
          <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer select-none">
            <input
              type="checkbox"
              checked={interrupt}
              onChange={(e) => setInterrupt(e.target.checked)} className="icon-base" />
            Interrupt turn (abort the model's current response)
          </label>
          <div className="flex items-center gap-1.5">
            <button
              onClick={deny}
              className={BTN_DENY}
            >
              Deny
            </button>
            <button
              onClick={() => setMode('summary')}
              className={BTN_NEUTRAL}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
