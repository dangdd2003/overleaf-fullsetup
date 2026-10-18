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
 * Directs frontier LLMs (Claude Opus/Sonnet, GPT-6/5.6, Gemini 3/2.5) to use
 * the optimal tool sequence (outline -> range-read -> surgical edit -> compile)
 * without requiring client-side system prompt configuration.
 */
const SECTIONS = [
  'Result format: every tool returns JSON. Success is { ok: true, summary, data, warnings?, nextSteps? }; read summary first, then data. Failure is { ok: false, error: { code, message, hint, retryable, details? } }; follow error.hint, and use error.details (e.g. candidates, nearest, matches, allowed) to correct the call instead of guessing. Only retry unchanged when retryable is true.',
  'Conventions: every tool takes projectId (from list_projects). Paths are project paths such as /chapters/intro.tex (leading "/" optional on input, always present on output) and are named path everywhere. Line numbers are 1-based and inclusive everywhere (read_file, edit_lines, outlines, compile errors, history diffs, SyncTeX).',
  '1. Orient: list_projects (filter with query) -> get_project (settings, allowedValues, rootDocPath, your access) -> list_files.',
  '2. Read narrowly: get_doc_outline (followIncludes: true for multi-file documents) gives section line ranges; read_file with startLine/endLine, or paths[] for several files at once. read_file returns 500 lines per call unless endLine is given; follow nextSteps for the next range. search_files finds text or regex across files.',
  '3. Edit: edit_lines to replace/insert/delete by the line numbers you just read, or edit_file with an exact oldString (several edits in one atomic call via edits[]). write_file only for new files or full rewrites; folders are created automatically. move_file, delete_file and upload_asset manage the tree.',
  '4. Compile and verify: compile_project always parses the log. Check data.status: "success" is clean; "success_with_errors" means a PDF exists BUT LaTeX reported errors that must be fixed; "failure"/"timedout" means no usable PDF. Each errors[] item has path and line you can pass straight to read_file/edit_lines. Fix, then compile again until status is "success". clean: true only for stale .aux/.bbl problems (clearCache is a deprecated alias). get_compile_log re-reads a build (parsed, or raw: true). sync_pdf_source maps "page N" to source lines and back, as text.',
  '5. Check the look: "success" only means the log is clean. When your edits change what a page shows (tables, figures, TikZ, equations, page breaks), call view_compiled_pdf_page with the buildId and look at the image for content past the margins, overlaps, misplaced floats and ?? references. Its data.sourceMap gives the source line at each height of the page: fix there, compile, and view the page again. Never tell the user a layout looks right without viewing it. For many pages at once, view_compiled_pdf_overview shows thumbnails with each page\'s measured problems; open the pages it flags with view_compiled_pdf_page. To find where text, ?? or [?] lands in the output, use search_compiled_pdf; it returns the page and source line. With labels true, view_compiled_pdf_page draws block ids; resolve_pdf_block turns one into its file and lines. After a fix, diff_compiled_pdf against the build before shows which pages and regions changed.',
  '6. Undo and review: list_history shows recent versions and changed paths; get_history_diff shows the exact changes; restore_file puts a file back to an earlier version (also recovers deleted files).',
  '7. Settings and lifecycle: update_project changes compiler, TeX Live image, spell-check language, root document (rootDocPath) or name; invalid values return error.details.allowed. set_project_status archives/trashes/restores, copy_project duplicates, delete_project (confirm: true) only when the user explicitly asks for permanent deletion.',
  '8. Tags: tags are the user\'s personal dashboard labels (not shared with collaborators, no effect on access or files). list_tags (includeProjects: true for the tagged project ids) -> create_tag, update_tag (rename/recolour), delete_tag (only the label goes; projects are untouched), add_projects_to_tag / remove_projects_from_tag (any number of projectIds per call, idempotent). Use the tagId from list_tags/create_tag.',
  '9. Semantics: scan_latex (citations, labels_refs, equations, floats, commands, todos, includes) and search_bib instead of manual regex.',
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
 * Interpose on registration so every tool advertises portable JSON Schema.
 *
 * Doing it here rather than at each `registerTool` call keeps the tool
 * definitions readable as plain zod, and leaves one place to look when a
 * client rejects a schema keyword.
 *
 * @param {McpServer} server
 */
function withPortableSchemas(server) {
  return {
    registerTool(name, config, handler) {
      return server.registerTool(
        name,
        {
          ...config,
          ...(config.inputSchema ? { inputSchema: portable(config.inputSchema) } : {}),
          ...(config.outputSchema ? { outputSchema: portable(config.outputSchema) } : {}),
        },
        handler
      )
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
