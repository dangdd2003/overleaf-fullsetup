export const MODES = ['manual', 'acceptEdits', 'plan']
export const DEFAULT_MODE = 'manual'

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

export const SETTINGS_TOOLS = new Set([
  'configure_appearance_settings',
  'configure_compiler_settings',
  'configure_editor_settings',
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

  if (SETTINGS_TOOLS.has(toolName)) {
    if (normMode === 'plan') return 'deny'
    return 'ask' // manual & acceptEdits
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
