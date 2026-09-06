import * as z from 'zod/v4'
import { CODES, OverleafApiError } from '../errors.js'
import { runTool, textResult, tokenFrom } from '../context.js'
import { parseBibtex, searchBibtex } from '../parsers/bibtexParser.js'
import {
  parseCitations,
  parseCustomCommands,
  parseEnvironments,
  parseIncludes,
  parseLabelsAndRefs,
  parseSections,
  parseTodoNotes,
} from '../parsers/latexSectionParser.js'

const MAX_SCANNED_DOCS = 100
const EQUATION_ENVIRONMENTS = [
  'equation',
  'align',
  'gather',
  'multline',
  'eqnarray',
  'displaymath',
  'flalign',
]
const FLOAT_ENVIRONMENTS = ['figure', 'table', 'subfigure', 'wrapfigure', 'longtable']

const projectId = z.string().min(1).describe('The Overleaf project id')
const optionalPath = z
  .string()
  .optional()
  .describe('Limit to one document; omit to scan every .tex document in the project')

function isTexPath(path) {
  return /\.tex$/i.test(path)
}

async function readDoc(client, token, id, path) {
  const { content } = await client.get(token, `/projects/${id}/doc`, { path })
  return content ?? ''
}

/**
 * Read the documents a scanning tool should operate on.
 *
 * With a path, that one document. Without, every .tex document in the tree, up
 * to MAX_SCANNED_DOCS. Each read is a separate authorized request to web.
 *
 * @returns {Promise<{ docs: { path: string, content: string }[], truncated: boolean }>}
 */
async function readScope(client, token, id, path) {
  if (path) {
    return { docs: [{ path, content: await readDoc(client, token, id, path) }], truncated: false }
  }
  const tree = await client.get(token, `/projects/${id}/tree`)
  const texPaths = (tree.docs ?? []).map(doc => doc.path).filter(isTexPath)
  const selected = texPaths.slice(0, MAX_SCANNED_DOCS)
  const docs = []
  for (const docPath of selected) {
    docs.push({ path: docPath, content: await readDoc(client, token, id, docPath) })
  }
  return { docs, truncated: texPaths.length > selected.length }
}

/** Flatten a per-document parse into one list carrying the source path. */
function acrossDocs(docs, parse) {
  return docs.flatMap(doc => parse(doc.content).map(item => ({ ...item, path: doc.path })))
}

/**
 * Register the read-only LaTeX-semantic tools.
 *
 * They add no endpoint and no privilege: every byte comes from the same
 * authorized doc and tree reads the file tools use.
 *
 * @param {object} server an McpServer
 * @param {{ client: object, staticToken: string }} deps
 */
export function registerLatexTools(server, { client, staticToken }) {
  server.registerTool(
    'get_doc_outline',
    {
      description: 'Get document outline',
      inputSchema: z.object({
        projectId,
        path: z.string().min(1).describe('Document path, e.g. /main.tex'),
      }),
    },
    runTool(async ({ projectId: id, path }, ctx) => {
      const content = await readDoc(client, tokenFrom(ctx, staticToken), id, path)
      return textResult({ path, outline: parseSections(content) })
    })
  )

  server.registerTool(
    'scan_latex',
    {
      description: 'Scan LaTeX elements',
      inputSchema: z.object({
        projectId,
        aspect: z
          .enum([
            'citations',
            'labels_refs',
            'equations',
            'floats',
            'commands',
            'todos',
            'includes',
          ])
          .describe('Category to scan'),
        path: optionalPath,
      }),
    },
    runTool(async ({ projectId: id, aspect, path }, ctx) => {
      const token = tokenFrom(ctx, staticToken)
      const { docs, truncated } = await readScope(client, token, id, path)

      switch (aspect) {
        case 'citations':
          return textResult({
            aspect,
            citations: acrossDocs(docs, parseCitations),
            truncated,
          })
        case 'labels_refs': {
          const labels = acrossDocs(docs, text => parseLabelsAndRefs(text).labels)
          const refs = acrossDocs(docs, text => parseLabelsAndRefs(text).refs)
          const labelNames = new Set(labels.map(label => label.name))
          const refNames = new Set(refs.map(ref => ref.name))
          return textResult({
            aspect,
            labels,
            refs,
            undefinedRefs: [...refNames].filter(name => !labelNames.has(name)),
            unusedLabels: [...labelNames].filter(name => !refNames.has(name)),
            truncated,
          })
        }
        case 'equations':
          return textResult({
            aspect,
            equations: acrossDocs(docs, text =>
              parseEnvironments(text, EQUATION_ENVIRONMENTS)
            ),
            truncated,
          })
        case 'floats':
          return textResult({
            aspect,
            floats: acrossDocs(docs, text => parseEnvironments(text, FLOAT_ENVIRONMENTS)),
            truncated,
          })
        case 'commands':
          return textResult({
            aspect,
            commands: acrossDocs(docs, parseCustomCommands),
            truncated,
          })
        case 'todos':
          return textResult({
            aspect,
            notes: acrossDocs(docs, parseTodoNotes),
            truncated,
          })
        case 'includes': {
          const tree = await client.get(token, `/projects/${id}/tree`)
          const known = new Set([
            ...(tree.docs ?? []).map(doc => doc.path),
            ...(tree.files ?? []).map(file => file.path),
          ])
          const includes = docs.flatMap(doc =>
            parseIncludes(doc.content).map(include => {
              const candidates = [
                include.path,
                `/${include.path}`,
                `${include.path}.tex`,
                `/${include.path}.tex`,
                `${include.path}.bib`,
                `/${include.path}.bib`,
              ]
              return {
                ...include,
                sourcePath: doc.path,
                resolvedPath: candidates.find(candidate => known.has(candidate)) ?? null,
              }
            })
          )
          return textResult({ aspect, includes, truncated })
        }
        default:
          throw new OverleafApiError(
            CODES.VALIDATION_ERROR,
            `unsupported scan aspect: ${aspect}`,
            400
          )
      }
    })
  )

  server.registerTool(
    'search_bib',
    {
      description: 'Search bibliography',
      inputSchema: z.object({
        projectId,
        path: z.string().min(1).describe('Path to .bib document, e.g. /refs.bib'),
        query: z
          .string()
          .optional()
          .describe('Filter by substring; omit to return all entries'),
      }),
    },
    runTool(async ({ projectId: id, path, query }, ctx) => {
      const content = await readDoc(client, tokenFrom(ctx, staticToken), id, path)
      const parsed = parseBibtex(content)
      return textResult({
        path,
        entries: query ? searchBibtex(parsed, query) : parsed,
      })
    })
  )
}
