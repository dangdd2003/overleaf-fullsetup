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

export const READ_ONLY_TOOLS = new Set([
  'get_outline',
  'get_packages',
  'get_references',
  'list_files',
  'read_file',
  'search_text',
  'get_compile_result',
  'get_project_settings',
  'list_available_settings',
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

export const PRESENT_PLAN_SPEC = {
  name: 'present_plan',
  description:
    'Present your finished plan to the user for approval. Call this once research is complete and you know exactly what to change. The user will approve (you then switch to an editing mode and carry the plan out) or ask you to keep planning with feedback.',
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

export function decide(mode, toolName) {
  const normMode = normalizeMode(mode)

  if (toolName === PLAN_TOOL) {
    return normMode === 'plan' ? 'ask' : 'deny'
  }

  if (READ_ONLY_TOOLS.has(toolName) || toolName === 'compile_project') {
    return 'allow'
  }

  if (FILE_EDIT_TOOLS.has(toolName)) {
    if (normMode === 'plan') return 'deny'
    if (normMode === 'acceptEdits') return 'allow'
    return 'ask' // manual
  }

  if (PROJECT_SETTINGS_TOOLS.has(toolName)) {
    if (normMode === 'plan') return 'deny'
    if (normMode === 'acceptEdits') return 'allow'
    return 'ask' // manual
  }

  if (ACCOUNT_SETTINGS_TOOLS.has(toolName)) {
    if (normMode === 'plan') return 'deny'
    return 'ask' // manual & acceptEdits: these leave the project
  }

  // Unknown tools: in plan mode deny; in other modes allow so standard unknown-tool handling triggers
  return normMode === 'plan' ? 'deny' : 'allow'
}

export function toolSpecsFor(mode, allSpecs = []) {
  const normMode = normalizeMode(mode)
  const filtered = allSpecs.filter(spec => decide(normMode, spec.name) !== 'deny')

  if (normMode === 'plan') {
    if (!filtered.some(spec => spec.name === PLAN_TOOL)) {
      return [...filtered, PRESENT_PLAN_SPEC]
    }
  }

  return filtered
}
