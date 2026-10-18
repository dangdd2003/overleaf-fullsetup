import {
  FILE_EDIT_TOOLS,
  PLAN_TOOL,
  READ_ONLY_TOOLS,
  isConnectorTool,
} from './AiAssistModePolicy.mjs'

/**
 * The tool scope of each slash command, mirrored from the composer's catalog
 * (frontend/js/features/ai-assist/agent/slash-commands/catalog.ts). The ids
 * must match it exactly: the unit tests check the set.
 *
 * `read` commands only look at the project; `edit` commands may also change
 * files and compile. Neither may change settings.
 */
export const SLASH_COMMAND_SCOPES = {
  fix: 'edit',
  layout: 'edit',
  preamble: 'edit',
  rewrite: 'edit',
  proofread: 'edit',
  translate: 'edit',
  cite: 'edit',
  bib: 'edit',
  table: 'edit',
  figure: 'edit',
  equation: 'edit',
  explain: 'read',
  summarize: 'read',
  review: 'read',
  check: 'read',
}

/** The command id if it names a known command, else null. */
export function normalizeCommandId(value) {
  return typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(SLASH_COMMAND_SCOPES, value)
    ? value
    : null
}

/**
 * A command as a client sent it, checked: `{ id, args }` for a known id with
 * string args (args defaults to ''), null otherwise. The client is not trusted
 * to name a scope, so the scope is only ever looked up from the id.
 */
export function normalizeCommandInvocation(value) {
  const id = normalizeCommandId(value?.id)
  if (!id) return null
  if (value.args !== undefined && typeof value.args !== 'string') return null
  return { id, args: value.args ?? '' }
}

/**
 * The command a transcript entry was sent with, as its id, or null for a
 * plain message. Works on stored entries and on queued messages alike.
 */
export function activeCommandFrom(entry) {
  return normalizeCommandId(entry?.command?.id)
}

/**
 * What a command's scope lets a tool call do: 'allow' or 'deny'. Null scope
 * (a plain message) or 'full' is no restriction. A scope never approves what
 * the mode would ask about: callers combine this with decide() and take the
 * stricter answer (combineDecisions).
 *
 * `options` is the connector description for an mcp__ tool, as decide takes.
 */
export function scopeDecision(scope, toolName, options = {}) {
  if (scope !== 'read' && scope !== 'edit') return 'allow'

  // Like Plan's present_plan: the mode alone decides whether a plan is shown
  if (toolName === PLAN_TOOL) return 'allow'

  if (isConnectorTool(toolName)) {
    // Read-only connectors are looked up in the mode; the rest are not reads
    if (scope === 'read') return options?.readOnly === true ? 'allow' : 'deny'
    return 'allow'
  }

  if (READ_ONLY_TOOLS.has(toolName)) return 'allow'

  if (
    scope === 'edit' &&
    (FILE_EDIT_TOOLS.has(toolName) || toolName === 'compile_project')
  ) {
    return 'allow'
  }

  // Settings, compiling and file changes under `read`, and any tool this list
  // does not know: a command that reads does not get to act
  return 'deny'
}

const STRICTNESS = { allow: 0, ask: 1, deny: 2 }

/** The stricter of the decisions given: deny beats ask, ask beats allow. */
export function combineDecisions(...decisions) {
  return decisions.reduce(
    (strictest, next) =>
      STRICTNESS[next] > STRICTNESS[strictest] ? next : strictest,
    'allow'
  )
}

const SCOPE_LIMITS = {
  read: 'this command only reads',
  edit: 'this command only edits files and compiles',
}

/**
 * The error a refused call gets, in the same shape as a mode refusal: the
 * model reads it as the tool's result and reports the change instead.
 */
export function scopeRefusal(commandId, toolName) {
  const scope = SLASH_COMMAND_SCOPES[commandId]
  const limit = SCOPE_LIMITS[scope] ?? 'this command does not allow it'
  return `\`${toolName}\` is outside /${commandId}'s scope: ${limit}. Report the change instead of making it.`
}
