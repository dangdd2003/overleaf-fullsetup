import { McpServer } from '@modelcontextprotocol/server'
import { registerProjectTools } from './tools/projects.js'
import { registerFileTools } from './tools/files.js'
import { registerCompileTools } from './tools/compile.js'
import { registerLatexTools } from './tools/latex.js'
import { registerHistoryTools } from './tools/history.js'
import { registerTagTools } from './tools/tags.js'
import { registerAllPrompts } from './prompts.js'
import { portable } from './schemas.js'

const SERVER_INFO = { name: 'overleaf', version: '2.0.0' }

/**
 * Categories the consent page groups tools under, in display order.
 *
 * Each `register` function only needs deps to build closures its handlers
 * call later -- collecting metadata never invokes a handler, so an empty
 * deps object is enough here.
 */
const TOOL_CATEGORIES = [
  { key: 'projects', title: 'Projects', register: registerProjectTools },
  { key: 'files', title: 'Files', register: registerFileTools },
  { key: 'compile', title: 'Compile', register: registerCompileTools },
  { key: 'latex', title: 'LaTeX', register: registerLatexTools },
  { key: 'history', title: 'History', register: registerHistoryTools },
  { key: 'tags', title: 'Tags', register: registerTagTools },
]

/**
 * Operational instructions transmitted to clients on initialize.
 *
 * The workflow guidance lives here once, so tool descriptions can stay short:
 * clients resend every description on every turn.
 */
const SECTIONS = [
  'Results are compact text: first line is the outcome, then the data. "! " lines are warnings to act on, "→ " lines suggested next calls. Errors read "error <code>: <message>" with a hint line; use the details line (candidates, nearest, allowed) to fix the call. Retry unchanged only when marked retryable.',
  'Conventions: projectId comes from list_projects. Paths look like /chapters/intro.tex. Line numbers are 1-based and inclusive everywhere; path:line refs can be passed straight to read_file/edit_lines.',
  '1. Orient: list_projects -> get_project -> list_files.',
  '2. Read narrowly: get_doc_outline (followIncludes for multi-file documents) gives section line ranges; read_file with startLine/endLine, or paths[] for several files. search_files finds text or regex.',
  '3. Edit: edit_lines by the line numbers you read, or edit_file with exact oldString (edits[] for several, atomic). Edit results show the changed lines, so no re-read is needed. write_file only for new files or full rewrites.',
  '4. Compile: compile_project parses the log. "success" is clean; "success_with_errors" means the PDF exists but errors must be fixed; "failure"/"timedout" means no usable PDF. Fix each path:line error, compile again until "success". clean: true only for stale .aux/.bbl problems. Build tools default to the latest build.',
  '5. Check the look when edits change what a page shows (tables, figures, TikZ, equations, breaks): view_compiled_pdf_page and look for overflow, overlaps, misplaced floats, ?? refs; its source map gives the line at each height, and with labels true resolve_pdf_block turns a drawn block id into file and lines. view_compiled_pdf_overview for many pages, search_compiled_pdf to find text in the output, diff_compiled_pdf to see what a fix changed. Never claim a layout looks right without viewing it.',
  '6. Undo: list_history -> get_history_diff -> restore_file (also recovers deleted files).',
  '7. Settings: update_project (invalid values return the allowed list); set_project_status archives/trashes/restores; delete_project only when the user explicitly asks.',
  '8. Tags are personal dashboard labels with no effect on files or access.',
  '9. Semantics: scan_latex and search_bib instead of manual regex.',
]

export const OVERLEAF_INSTRUCTIONS = [
  'Overleaf MCP operational guide.',
  '',
  SECTIONS[0],
  '',
  SECTIONS[1],
  '',
  ...SECTIONS.slice(2),
].join('\n')

/**
 * Register every authoring-core tool on a server instance.
 *
 * Tasks 6-9 extend this function; it is the single place tools are wired so a
 * reviewer can see the whole surface at once.
 *
 * @param {McpServer} server
 * @param {{ client: import('./OverleafClient.js').OverleafClient, staticToken: string }} deps
 */
export function registerAllTools(server, deps) {
  const target = withPortableSchemas(server)
  registerProjectTools(target, deps)
  registerFileTools(target, deps)
  registerCompileTools(target, deps)
  registerLatexTools(target, deps)
  registerHistoryTools(target, deps)
  registerTagTools(target, deps)
}

/**
 * Advertised input schemas, converted once per tool and reused by every
 * per-request server. The zod schema each registration passes still does the
 * validation; only the JSON Schema conversion is shared.
 */
const ADVERTISED_INPUTS = new Map()

/**
 * Interpose on registration so every tool advertises portable JSON Schema.
 *
 * Doing it here rather than at each `registerTool` call keeps the tool
 * definitions readable as plain zod, and leaves one place to look when a
 * client rejects a schema keyword.
 *
 * `outputSchema` is not advertised: clients resend tool definitions on every
 * turn, and the output schemas were most of that cost while telling the model
 * nothing the compact result text does not. Tools still declare it, as the
 * contract `structuredContent` is tested against.
 *
 * @param {McpServer} server
 */
function withPortableSchemas(server) {
  return {
    registerTool(name, { outputSchema, ...config }, handler) {
      if (config.inputSchema && !ADVERTISED_INPUTS.has(name)) {
        ADVERTISED_INPUTS.set(name, portable(config.inputSchema))
      }
      const advertised = ADVERTISED_INPUTS.get(name)
      return server.registerTool(
        name,
        {
          ...config,
          ...(config.inputSchema
            ? { inputSchema: sharedConversion(config.inputSchema, advertised) }
            : {}),
        },
        handler
      )
    },
  }
}

/**
 * A portable wrapper that validates with this registration's zod schema but
 * reuses the JSON Schema already converted for the tool.
 */
function sharedConversion(schema, advertised) {
  return {
    '~standard': {
      ...advertised['~standard'],
      validate: value => schema['~standard'].validate(value),
    },
  }
}

/**
 * Describe every registered tool without needing a live client or auth.
 *
 * The OAuth consent page renders this before the user has a token, so it
 * must be derivable from the tool definitions alone -- deps are only ever
 * read inside a handler, which nothing here calls.
 *
 * @returns {Array<{ key: string, title: string, tools: Array<{ name: string, title: string, description: string, annotations: object, params: Array<{ name: string, type: string, required: boolean, description: string }> }> }>}
 */
export function listToolMetadata() {
  return TOOL_CATEGORIES.map(({ key, title, register }) => {
    const collected = []
    const collector = withPortableSchemas({
      registerTool(name, config) {
        collected.push({ name, config })
      },
    })
    register(collector, {})

    return {
      key,
      title,
      tools: collected.map(({ name, config }) => ({
        name,
        title: config.title,
        description: config.description,
        annotations: config.annotations,
        params: paramsFromInputSchema(config.inputSchema),
      })),
    }
  })
}

/**
 * Flatten a portable-wrapped input schema into a param list for display.
 *
 * @param {ReturnType<import('./schemas.js').portable>} inputSchema
 */
function paramsFromInputSchema(inputSchema) {
  const jsonSchema = inputSchema['~standard'].jsonSchema.input()
  const required = new Set(jsonSchema.required || [])
  return Object.entries(jsonSchema.properties || {}).map(([name, prop]) => ({
    name,
    type: prop.type || 'any',
    required: required.has(name),
    description: prop.description || '',
  }))
}

/**
 * Build the per-request factory the SDK calls once per HTTP request.
 *
 * A fresh McpServer per request is the v2 model: no state is shared between
 * callers, so one caller's token can never be seen by another's tools.
 *
 * @param {{ client: object, staticToken?: string }} deps
 * @returns {(ctx: object) => McpServer}
 */
export function createMcpServerFactory({ client, staticToken = '' }) {
  return function factory() {
    const server = new McpServer(SERVER_INFO, {
      instructions: OVERLEAF_INSTRUCTIONS,
    })
    registerAllTools(server, { client, staticToken })
    registerAllPrompts(server)
    return server
  }
}
