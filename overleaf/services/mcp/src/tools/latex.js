import * as z from 'zod/v4'
import { CODES, OverleafApiError } from '../errors.js'
import { mapLimit, okResult, runTool, tokenFrom } from '../context.js'
import { envelope, looseObject, projectId, READ_ONLY } from '../schemas.js'
import { normalisePath, requireFilePath } from '../parsers/paths.js'
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
/** Documents read at once when a scan covers the whole project. */
const SCAN_CONCURRENCY = 8
/** Commands whose target is another LaTeX document, read as part of this one. */
const DOCUMENT_INCLUDES = new Set(['input', 'include', 'subfile'])

const SCAN_ASPECTS = [
  'citations',
  'labels_refs',
  'equations',
  'floats',
  'commands',
  'todos',
  'includes',
]

const optionalPath = z
  .string()
  .optional()
  .describe('Limit to one document, e.g. /main.tex; omit to scan every .tex document')

const lineNumber = z.number().int().describe('1-based line number')

/**
 * Every scan result item carries `path` and `line`, so a model can jump
 * straight to it; the aspect-specific fields are listed in the description.
 */
const location = {
  path: z.string().describe('Document the item was found in'),
  line: lineNumber.describe('Line the item starts on'),
}

const scanItem = looseObject(location)

function byLocation(a, b) {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1
  return a.line - b.line
}

/** Flatten a per-document parse into one list carrying the source path. */
function acrossDocs(docs, parse) {
  return docs.flatMap(doc => parse(doc.content).map(item => ({ ...item, path: doc.path })))
}

async function readDoc(client, token, id, path) {
  const { content } = await client.get(token, `/projects/${id}/doc`, { path })
  return content ?? ''
}

/**
 * Read the documents a scanning tool should operate on.
 *
 * With a path, that one document. Without, every .tex document in the tree.
 * Each read is a separate authorized request to web, so a project with many
 * documents is read SCAN_CONCURRENCY at a time rather than all at once.
 *
 * @returns {Promise<{ path: string, content: string }[]>}
 */
async function readScope(client, token, id, path) {
  const docPaths = path
    ? [requireFilePath(path)]
    : ((await client.get(token, `/projects/${id}/tree`)).docs ?? [])
        .map(doc => normalisePath(doc.path))
        .filter(docPath => /\.tex$/i.test(docPath))
  return mapLimit(docPaths, SCAN_CONCURRENCY, async docPath => ({
    path: docPath,
    content: await readDoc(client, token, id, docPath),
  }))
}

/**
 * Resolve an \input or \bibliography target against the project tree, the way
 * LaTeX reads it from the project root: a bare name may be a .tex or .bib file.
 *
 * @returns {string|null} the matching project path, or null when none exists
 */
function resolveTarget(target, known) {
  let base
  try {
    base = normalisePath(target)
  } catch {
    return null
  }
  const candidates = /\.[A-Za-z0-9]+$/.test(base)
    ? [base]
    : [`${base}.tex`, `${base}.bib`, base]
  return candidates.find(candidate => known.has(candidate)) ?? null
}

/**
 * Headings of a document, optionally followed through its \input and \include
 * commands in reading order. Each heading keeps the path of its own file, and
 * line ranges stay relative to that file so read_file can fetch them.
 */
async function collectOutline(client, token, id, rootPath, followIncludes) {
  const tree = followIncludes ? await client.get(token, `/projects/${id}/tree`) : null
  const known = new Set([
    ...(tree?.docs ?? []).map(doc => normalisePath(doc.path)),
    ...(tree?.files ?? []).map(file => normalisePath(file.path)),
  ])
  const outline = []
  const documents = []
  const unresolvedIncludes = []
  const visited = new Set()
  let rootIncludes = 0

  const visit = async (docPath, depth) => {
    visited.add(docPath)
    documents.push(docPath)
    const content = await readDoc(client, token, id, docPath)
    const sections = parseSections(content).map(section => ({ ...section, path: docPath }))
    const includes = parseIncludes(content).filter(include =>
      DOCUMENT_INCLUDES.has(include.command)
    )
    if (depth === 0) rootIncludes = includes.length
    if (!followIncludes) {
      outline.push(...sections)
      return
    }

    const steps = [
      ...sections.map(section => ({ line: section.startLine, section })),
      ...includes.map(include => ({ line: include.line, include })),
    ].sort((a, b) => a.line - b.line)
    for (const step of steps) {
      if (step.section) {
        outline.push(step.section)
        continue
      }
      const target = resolveTarget(step.include.path, known)
      if (target === null || !/\.tex$/i.test(target)) {
        unresolvedIncludes.push({
          path: docPath,
          line: step.include.line,
          target: step.include.path,
        })
      } else if (!visited.has(target)) {
        await visit(target, depth + 1)
      }
    }
  }

  await visit(rootPath, 0)
  return { outline, documents, unresolvedIncludes, rootIncludes }
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
        'List the headings of a LaTeX document (part to subparagraph) with the 1-based startLine and endLine each spans, ready for read_file. Set followIncludes to walk \\input and \\include into the chapter files; each heading then carries its own path.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        path: z.string().min(1).describe('Document path, e.g. /main.tex'),
        followIncludes: z
          .boolean()
          .optional()
          .default(false)
          .describe('Also outline the files pulled in by \\input and \\include, in reading order'),
      }),
      outputSchema: envelope(
        looseObject({
          path: z.string().describe('The document that was outlined'),
          followIncludes: z.boolean().describe('Whether included files were walked'),
          documents: z
            .array(z.string())
            .describe('Every document read, in reading order'),
          outline: z
            .array(
              looseObject({
                path: z.string().describe('Document the heading is in'),
                name: z.string().describe('Sectioning command, e.g. section or subsection'),
                level: z
                  .number()
                  .int()
                  .describe('Nesting depth; smaller numbers are higher-level'),
                title: z.string().describe('The heading text'),
                starred: z
                  .boolean()
                  .describe('True for the unnumbered starred form, e.g. \\section*'),
                startLine: lineNumber.describe('Line the heading is on'),
                endLine: lineNumber.describe(
                  'Last line before the next heading of the same or higher level, in the same document'
                ),
              })
            )
            .describe('The headings, in reading order'),
          unresolvedIncludes: z
            .array(
              looseObject({
                path: z.string().describe('Document holding the include'),
                line: lineNumber,
                target: z.string().describe('Path as written in the source'),
              })
            )
            .describe('Includes that match no project document'),
        })
      ),
    },
    runTool(async ({ projectId: id, path, followIncludes }, ctx) => {
      const token = tokenFrom(ctx, staticToken)
      const root = requireFilePath(path)
      const { outline, documents, unresolvedIncludes, rootIncludes } = await collectOutline(
        client,
        token,
        id,
        root,
        followIncludes
      )
      const hint =
        !followIncludes && rootIncludes > 0
          ? `${root} includes ${rootIncludes} other file(s); call again with followIncludes: true to outline them.`
          : undefined
      return okResult({
        summary:
          `${outline.length} heading(s) in ${documents.length} document(s)` +
          (followIncludes ? '' : ` of ${root}`) +
          '.',
        data: {
          path: root,
          followIncludes,
          documents,
          outline,
          unresolvedIncludes,
        },
        warnings: unresolvedIncludes.length
          ? unresolvedIncludes.map(
              inc => `${inc.path}:${inc.line} includes ${inc.target}, which matches no project file`
            )
          : undefined,
        nextSteps: hint ? [hint] : undefined,
      })
    })
  )

  server.registerTool(
    'scan_latex',
    {
      title: 'Scan LaTeX elements',
      description:
        'Extract one kind of LaTeX element across the project, each with its path and 1-based line: citation keys, labels and refs (with undefined refs and unused labels as issues), maths environments, floats, user macros, TODO notes, or \\input and \\include targets and whether they resolve. Prefer this to grepping when auditing a document.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        aspect: z
          .enum(SCAN_ASPECTS)
          .describe(
            'citations, labels_refs, equations, floats, commands, todos or includes'
          ),
        path: optionalPath,
      }),
      outputSchema: envelope(
        looseObject({
          aspect: z.string().describe('The aspect that was scanned'),
          count: z.number().int().describe('Items returned in items'),
          documentsScanned: z.number().int().describe('Documents read'),
          items: z
            .array(scanItem)
            .describe(
              'Items with path and line. citations: key, command. labels_refs: kind (label or ref), name, command. equations and floats: name, endLine, label, caption, body. commands: command, name, arity, definition. todos: kind, text. includes: command, target, resolvedPath (null when broken).'
            ),
          issues: z
            .array(
              looseObject({
                ...location,
                kind: z.enum(['undefined_ref', 'unused_label']),
                name: z.string().describe('The label or key involved'),
              })
            )
            .optional()
            .describe('Problems, for labels_refs only: refs with no label, labels nothing refers to'),
        })
      ),
    },
    runTool(async ({ projectId: id, aspect, path }, ctx) => {
      const token = tokenFrom(ctx, staticToken)
      const docs = await readScope(client, token, id, path)
      const base = { aspect, documentsScanned: docs.length }
      const respond = (items, extra = {}) =>
        okResult({
          summary: `${items.length} ${aspect} item(s) in ${docs.length} document(s).`,
          data: { ...base, count: items.length, items, ...extra },
        })

      switch (aspect) {
        case 'citations':
          return respond(
            acrossDocs(docs, parseCitations).sort(byLocation)
          )
        case 'labels_refs': {
          const labels = acrossDocs(docs, text => parseLabelsAndRefs(text).labels).map(
            label => ({ kind: 'label', path: label.path, line: label.line, name: label.name })
          )
          const refs = acrossDocs(docs, text => parseLabelsAndRefs(text).refs).map(ref => ({
            kind: 'ref',
            path: ref.path,
            line: ref.line,
            name: ref.name,
            command: ref.command,
          }))
          const labelNames = new Set(labels.map(label => label.name))
          const refNames = new Set(refs.map(ref => ref.name))
          const issues = [
            ...refs
              .filter(ref => !labelNames.has(ref.name))
              .map(ref => ({ kind: 'undefined_ref', path: ref.path, line: ref.line, name: ref.name })),
            ...labels
              .filter(label => !refNames.has(label.name))
              .map(label => ({ kind: 'unused_label', path: label.path, line: label.line, name: label.name })),
          ].sort(byLocation)
          return respond([...labels, ...refs].sort(byLocation), { issues })
        }
        case 'equations':
        case 'floats': {
          const names = aspect === 'equations' ? EQUATION_ENVIRONMENTS : FLOAT_ENVIRONMENTS
          return respond(
            acrossDocs(docs, text => parseEnvironments(text, names)).map(env => ({
              path: env.path,
              line: env.line,
              endLine: env.endLine,
              name: env.name,
              label: env.label,
              caption: env.caption,
              body: env.body,
            }))
          )
        }
        case 'commands':
          return respond(acrossDocs(docs, parseCustomCommands).sort(byLocation))
        case 'todos':
          return respond(acrossDocs(docs, parseTodoNotes).sort(byLocation))
        case 'includes': {
          const tree = await client.get(token, `/projects/${id}/tree`)
          const known = new Set([
            ...(tree.docs ?? []).map(doc => normalisePath(doc.path)),
            ...(tree.files ?? []).map(file => normalisePath(file.path)),
          ])
          const includes = docs.flatMap(doc =>
            parseIncludes(doc.content).map(include => ({
              path: doc.path,
              line: include.line,
              command: include.command,
              target: include.path,
              resolvedPath: resolveTarget(include.path, known),
            }))
          )
          return respond(includes.sort(byLocation))
        }
        default:
          throw new OverleafApiError(
            CODES.VALIDATION_ERROR,
            `unsupported scan aspect: ${aspect}`,
            400,
            { hint: `Use one of: ${SCAN_ASPECTS.join(', ')}.` }
          )
      }
    })
  )

  server.registerTool(
    'search_bib',
    {
      title: 'Search bibliography',
      description:
        'Read a .bib file as structured entries (key, type, fields and 1-based line), optionally filtered by a substring of the key or any field. Use it to check whether a reference exists or to get the exact key for \\cite.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        path: z.string().min(1).describe('Path to the .bib document, e.g. /refs.bib'),
        query: z
          .string()
          .optional()
          .describe('Case-insensitive substring of the key or any field; omit for all entries'),
      }),
      outputSchema: envelope(
        looseObject({
          path: z.string().describe('The .bib document that was read'),
          total: z.number().int().describe('Entries in the file'),
          matched: z.number().int().describe('Entries returned after the query filter'),
          entries: z
            .array(
              looseObject({
                ...location,
                type: z.string().describe('Entry type, e.g. article or book'),
                key: z.string().describe('The citation key used by \\cite'),
                fields: z
                  .record(z.string(), z.string())
                  .describe('Entry fields such as author, title and year'),
              })
            )
            .describe('The matching bibliography entries'),
        })
      ),
    },
    runTool(async ({ projectId: id, path, query }, ctx) => {
      const target = requireFilePath(path)
      const content = await readDoc(client, tokenFrom(ctx, staticToken), id, target)
      const parsed = parseBibtex(content).map(entry => ({ path: target, ...entry }))
      const entries = query ? searchBibtex(parsed, query) : parsed
      return okResult({
        summary: query
          ? `${entries.length} of ${parsed.length} entries in ${target} match "${query}".`
          : `${parsed.length} entries in ${target}.`,
        data: { path: target, total: parsed.length, matched: entries.length, entries },
        warnings: /\.bib$/i.test(target)
          ? undefined
          : [`${target} does not end in .bib; it was parsed as BibTeX anyway`],
        nextSteps: entries[0]
          ? [`scan_latex(projectId, aspect="citations") to see where \\cite uses ${entries[0].key}`]
          : undefined,
      })
    })
  )
}
