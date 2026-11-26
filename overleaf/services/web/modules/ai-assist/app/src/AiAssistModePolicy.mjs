export const MODES = ['manual', 'acceptEdits', 'plan']
export const DEFAULT_MODE = 'manual'

/** How each mode is named in the composer, so messages to the model match it. */
export const MODE_LABELS = {
  manual: 'Manual',
  acceptEdits: 'Accept edits',
  plan: 'Plan',
}

export function modeLabel(value) {
  return MODE_LABELS[normalizeMode(value)]
}

export function normalizeMode(value) {
  return typeof value === 'string' && MODES.includes(value) ? value : DEFAULT_MODE
}

export const FILE_EDIT_TOOLS = new Set(['edit_file', 'create_file'])

/**
 * Connector tools that are not themselves connector calls: loading a deferred
 * tool's schema, and paging through a long connector result. Both only read
 * the harness's own state, so every mode allows them.
 */
export const CONNECTOR_SEARCH_TOOL = 'search_connector_tools'
export const READ_CONNECTOR_RESULT_TOOL = 'read_connector_result'

export const READ_ONLY_TOOLS = new Set([
  'get_outline',
  'get_packages',
  'get_references',
  'list_files',
  'project_map',
  'read_file',
  'search_text',
  'search_project',
  'get_compile_result',
  'get_compile_log',
  'view_compiled_pdf_page',
  'view_compiled_pdf_overview',
  'search_compiled_pdf',
  'resolve_pdf_block',
  'diff_compiled_pdf',
  'inspect_compiled_style',
  // Moves the user's viewer only; the project is not changed
  'highlight_in_pdf',
  'get_project_settings',
  'list_available_settings',
  'web_search',
  CONNECTOR_SEARCH_TOOL,
  READ_CONNECTOR_RESULT_TOOL,
])

/**
 * Settings that belong to this project and nothing else: the compiler engine,
 * the root document, draft mode. They are project state exactly like a file is,
 * so Accept edits mode applies them without asking.
 */
export const PROJECT_SETTINGS_TOOLS = new Set(['configure_compiler_settings'])

/**
 * Settings written to `user.ace` — the account's editor and appearance
 * preferences. They outlive the project and follow the user into every other
 * one, so they are confirmed in every mode, Accept edits included.
 */
export const ACCOUNT_SETTINGS_TOOLS = new Set([
  'configure_appearance_settings',
  'configure_editor_settings',
])

export const SETTINGS_TOOLS = new Set([
  ...PROJECT_SETTINGS_TOOLS,
  ...ACCOUNT_SETTINGS_TOOLS,
])

export const PLAN_TOOL = 'present_plan'

// Edits to the project's root AGENTS.md change every later run's instructions,
// so they always ask, whatever the mode. Matches './AGENTS.md', '/agents.md'.
export function isInstructionPath(path) {
  if (typeof path !== 'string') return false
  const normalized = path
    .trim()
    .replace(/^(\.\/+|\/+)+/, '')
    .toLowerCase()
  return normalized === 'agents.md'
}

/**
 * web_fetch reads a URL the model chose. It runs freely only when the URL or
 * its host already came up in this conversation (a search result, a link in
 * the project, a URL the user typed). Anything else asks.
 */
export function isKnownUrl(url, knownUrls) {
  if (typeof url !== 'string' || !url || !(knownUrls instanceof Set)) {
    return false
  }
  if (knownUrls.has(url)) return true
  try {
    const parsed = new URL(url)
    return knownUrls.has(parsed.origin)
  } catch {
    return false
  }
}

export function isConnectorTool(name) {
  return typeof name === 'string' && name.startsWith('mcp__')
}

/**
 * The connector tools, and the two the harness adds beside them: a
 * search_connector_tools call loads schemas, a read_connector_result call pages
 * through a long result. All of them run in the connector session.
 */
export function isConnectorCallName(name) {
  return (
    isConnectorTool(name) ||
    name === CONNECTOR_SEARCH_TOOL ||
    name === READ_CONNECTOR_RESULT_TOOL
  )
}

export const PRESENT_PLAN_SPEC = {
  name: 'present_plan',
  description:
    'Plan mode only. Present your finished plan to the user for approval. Call this once research is complete and you know exactly what to change. The user will approve (you then switch to an editing mode and carry the plan out) or ask you to keep planning with feedback.',
  parameters: {
    type: 'object',
    properties: {
      plan: {
        type: 'string',
        description: 'The plan in Markdown: what will change, in which files, in what order.',
      },
    },
    required: ['plan'],
  },
}

/** @typedef {'manual'|'acceptEdits'|'plan'} Mode */
/** @typedef {'allow'|'ask'|'deny'} Decision */
/** @typedef {'allow'|'block'} ToolPermission */

/**
 * @param {Mode} mode
 * @param {string} toolName
 * @param {{ permission?: ToolPermission, readOnly?: boolean, destructive?: boolean, path?: string }} [options]
 * @param {{ args?: object, knownUrls?: Set<string> }} [context] the call's
 *   arguments, and the URLs and hosts already seen in the conversation
 * @returns {Decision}
 */
export function decide(mode, toolName, options = {}, context = {}) {
  const normMode = normalizeMode(mode)

  if (isConnectorTool(toolName)) {
    // The user's per-tool choice wins in every mode; plan mode additionally
    // refuses anything the server does not declare read-only. A connector
    // that does not say (no hints) counts as destructive and not read-only.
    if (options?.permission === 'block') return 'deny'
    if (normMode === 'plan' && options?.readOnly !== true) return 'deny'
    // A standing "allow" covers the tools that do not change anything. A
    // destructive one still asks each time, whatever the user chose before.
    if (options?.permission === 'allow' && options?.destructive === false) {
      return 'allow'
    }
    return 'ask'
  }

  if (toolName === 'web_fetch') {
    // Asks in plan mode too: a fetch is not a change, but it leaves the project.
    const url = context?.args?.url
    return isKnownUrl(url, context?.knownUrls) ? 'allow' : 'ask'
  }

  if (toolName === PLAN_TOOL) {
    return normMode === 'plan' ? 'ask' : 'deny'
  }

  if (READ_ONLY_TOOLS.has(toolName) || toolName === 'compile_project') {
    return 'allow'
  }

  if (FILE_EDIT_TOOLS.has(toolName) || PROJECT_SETTINGS_TOOLS.has(toolName)) {
    if (normMode === 'plan') return 'deny'
    const path = options?.path ?? context?.args?.path
    if (FILE_EDIT_TOOLS.has(toolName) && isInstructionPath(path)) return 'ask'
    if (normMode === 'acceptEdits') return 'allow'
    return 'ask' // manual
  }

  if (ACCOUNT_SETTINGS_TOOLS.has(toolName)) {
    if (normMode === 'plan') return 'deny'
    return 'ask' // manual & acceptEdits: these leave the project
  }

  // Unknown tools fail closed across every mode.
  return 'deny'
}

/**
 * The tools the model is offered: the same list, in the same order, in every
 * mode. Tool definitions are the first thing in a request, so a list that
 * changed with the mode would throw away the whole cached conversation on
 * every switch. Claude Code keeps its tools fixed for the same reason. The
 * mode is enforced when a call is made: `decide` refuses what it does not
 * allow, and the model is told why.
 */
export function toolSpecsFor(_mode, allSpecs = []) {
  return allSpecs.some(spec => spec.name === PLAN_TOOL)
    ? allSpecs
    : [...allSpecs, PRESENT_PLAN_SPEC]
}
