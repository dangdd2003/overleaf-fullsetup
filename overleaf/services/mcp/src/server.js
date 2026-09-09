import { McpServer } from '@modelcontextprotocol/server'
import { registerProjectTools } from './tools/projects.js'
import { registerFileTools } from './tools/files.js'
import { registerCompileTools } from './tools/compile.js'
import { registerLatexTools } from './tools/latex.js'
import { registerAllPrompts } from './prompts.js'
import { portable } from './schemas.js'

const SERVER_INFO = { name: 'overleaf', version: '1.0.0' }

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
]

/**
 * Operational instructions transmitted to clients on initialize.
 *
 * Directs frontier LLMs (Claude Opus/Sonnet, GPT-6/5.6, Gemini 3/2.5) to use
 * the optimal tool sequence (outline -> range-read -> surgical edit -> compile)
 * without requiring client-side system prompt configuration.
 */
export const OVERLEAF_INSTRUCTIONS = `
Overleaf MCP Operational Guidelines:
1. Document Outline & Structure: Call get_doc_outline first on LaTeX files to discover section headings and their exact line ranges (startLine and endLine).
2. Targeted Reads: When reading sections of long documents, supply startLine and endLine to read_file to fetch only the needed lines instead of reading entire files into context.
3. Surgical Edits: Always prefer edit_file over write_file for modifying existing documents. Provide the exact verbatim oldString with sufficient surrounding context to guarantee a unique match.
4. Auto-Created Folders: Missing parent directories are created automatically by write_file, upload_asset, and move_file; do not attempt manual folder creation.
5. Compilation & Recovery: Compile using compile_project. If compilation fails, inspect the log with get_compile_log. If errors stem from corrupt auxiliary files or stale build state, recompile using compile_project with clearCache: true.
6. Semantic Inspection & Bibliography: Use scan_latex with the appropriate aspect (citations, labels_refs, equations, floats, commands, todos, includes) and search_bib to analyze semantics without manual regex searches.
`.trim()

/**
 * Register every authoring-core tool on a server instance.
 *
 * Tasks 6-9 extend this function; it is the single place tools are wired so a
 * reviewer can see the whole surface at once.
 *
 * @param {McpServer} server
 * @param {{ client: import('./OverleafClient.js').OverleafClient, staticToken: string, maxUploadBytes?: number }} deps
 */
export function registerAllTools(server, deps) {
  const target = withPortableSchemas(server)
  registerProjectTools(target, deps)
  registerFileTools(target, deps)
  registerCompileTools(target, deps)
  registerLatexTools(target, deps)
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
 * @param {{ client: object, staticToken?: string, maxUploadBytes?: number }} deps
 * @returns {(ctx: object) => McpServer}
 */
export function createMcpServerFactory({
  client,
  staticToken = '',
  maxUploadBytes = 20 * 1024 * 1024,
}) {
  return function factory() {
    const server = new McpServer(SERVER_INFO, {
      instructions: OVERLEAF_INSTRUCTIONS,
    })
    registerAllTools(server, { client, staticToken, maxUploadBytes })
    registerAllPrompts(server)
    return server
  }
}
