import * as z from 'zod/v4'
import { CODES, OverleafApiError } from '../errors.js'
import { runTool, textResult, tokenFrom } from '../context.js'
import { looseObject, projectId, READ_ONLY } from '../schemas.js'
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

const optionalPath = z
  .string()
  .optional()
  .describe('Limit to one document; omit to scan every .tex document in the project')

const sourceLine = z.number().int().describe('1-based line the item was found on')
const sourceDoc = z.string().describe('Document the item was found in')

const environmentEntry = looseObject({
  path: sourceDoc,
  name: z.string().describe('Environment name, e.g. equation or figure'),
  line: sourceLine,
  endLine: z.number().int().describe('1-based line the environment ends on'),
  body: z.string().describe('Verbatim contents of the environment'),
  label: z.string().nullable().describe('\\label key, or null when unlabelled'),
  caption: z.string().nullable().describe('\\caption text, or null when absent'),
})

/**
 * Which keys `scan_latex` fills depends on the requested aspect, so every
 * result array is optional in one loose schema rather than a discriminated
 * union the aspect enum would have to be duplicated into.
 */
const scanResult = looseObject({
  aspect: z.string().describe('The aspect that was scanned'),
  truncated: z
    .boolean()
    .describe(`True when the project has more than ${MAX_SCANNED_DOCS} .tex documents and the scan stopped early`),
  citations: z
    .array(
      looseObject({
        path: sourceDoc,
        key: z.string().describe('The cited BibTeX key'),
        command: z.string().describe('Citation command used, e.g. cite or citep'),
        line: sourceLine,
      })
    )
    .optional()
    .describe('One entry per key, for aspect "citations"'),
  labels: z
    .array(
      looseObject({
        path: sourceDoc,
        name: z.string().describe('The \\label key'),
        line: sourceLine,
      })
    )
    .optional()
    .describe('Declared labels, for aspect "labels_refs"'),
  refs: z
    .array(
      looseObject({
        path: sourceDoc,
        name: z.string().describe('The referenced label key'),
        command: z.string().describe('Reference command used, e.g. ref or eqref'),
        line: sourceLine,
      })
    )
    .optional()
    .describe('Label references, for aspect "labels_refs"'),
  undefinedRefs: z
    .array(z.string())
    .optional()
    .describe('Referenced keys with no matching \\label — these compile to "??"'),
  unusedLabels: z
    .array(z.string())
    .optional()
    .describe('Declared labels nothing references'),
  equations: z
    .array(environmentEntry)
    .optional()
    .describe('Maths environments, for aspect "equations"'),
  floats: z
    .array(environmentEntry)
    .optional()
    .describe('Figures, tables and other floats, for aspect "floats"'),
  commands: z
    .array(
      looseObject({
        path: sourceDoc,
        command: z.string().describe('Defining command, e.g. newcommand or def'),
        name: z.string().describe('Name of the macro being defined'),
        arity: z.number().int().describe('Number of arguments the macro takes'),
        definition: z.string().describe('The macro body'),
        line: sourceLine,
      })
    )
    .optional()
    .describe('User-defined macros, for aspect "commands"'),
  notes: z
    .array(
      looseObject({
        path: sourceDoc,
        kind: z.string().describe('Marker used, e.g. TODO, FIXME or todo'),
        text: z.string().describe('The note text'),
        line: sourceLine,
      })
    )
    .optional()
    .describe('Outstanding TODO-style notes, for aspect "todos"'),
  includes: z
    .array(
      looseObject({
        sourcePath: z.string().describe('Document containing the include'),
        command: z.string().describe('Include command, e.g. input or bibliography'),
        path: z.string().describe('Path as written in the source'),
        line: sourceLine,
        resolvedPath: z
          .string()
          .nullable()
          .describe('Matching path in the project, or null when the include is broken'),
      })
    )
    .optional()
    .describe('File inclusions and their resolution, for aspect "includes"'),
})

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
      title: 'Get document outline',
      description:
        'List the sectioning commands in a LaTeX document with the line range each one spans. Call this before reading a long document: the startLine and endLine of the section you want go straight into read_file, so only that part is fetched.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        path: z.string().min(1).describe('Document path, e.g. /main.tex'),
      }),
      outputSchema: looseObject({
        path: z.string().describe('The document that was outlined'),
        outline: z
          .array(
            looseObject({
              name: z
                .string()
                .describe('Sectioning command, e.g. section or subsection'),
              level: z
                .number()
                .int()
                .describe('Nesting depth, smaller numbers being higher-level'),
              title: z.string().describe('The heading text'),
              starred: z
                .boolean()
                .describe('True for the unnumbered starred form, e.g. \\section*'),
              startLine: z.number().int().describe('1-based line the heading is on'),
              endLine: z
                .number()
                .int()
                .describe('1-based last line before the next heading of the same or higher level'),
            })
          )
          .describe('The headings, in document order'),
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
      title: 'Scan LaTeX elements',
      description:
        'Extract one category of LaTeX construct across the project without reading whole files: citation keys, labels and references (including undefined refs and unused labels), maths environments, floats, user-defined macros, TODO notes, or file inclusions and whether they resolve. Prefer this over searching the text by hand when auditing a document.',
      annotations: READ_ONLY,
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
      outputSchema: scanResult,
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
      title: 'Search bibliography',
      description:
        'Read a .bib file as structured entries, optionally filtered by a substring matched against the citation key and every field. Use it to check whether a reference already exists, or to recover the exact key to pass to \\cite.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        path: z.string().min(1).describe('Path to .bib document, e.g. /refs.bib'),
        query: z
          .string()
          .optional()
          .describe('Filter by substring; omit to return all entries'),
      }),
      outputSchema: looseObject({
        path: z.string().describe('The .bib document that was read'),
        entries: z
          .array(
            looseObject({
              type: z.string().describe('Entry type, e.g. article or book'),
              key: z.string().describe('The citation key used by \\cite'),
              fields: z
                .record(z.string(), z.string())
                .describe('Entry fields such as author, title and year'),
              line: sourceLine,
            })
          )
          .describe('The matching bibliography entries'),
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
