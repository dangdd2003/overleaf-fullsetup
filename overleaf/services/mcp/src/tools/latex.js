import * as z from 'zod/v4'
import { CODES, OverleafApiError } from '../errors.js'
import { okResult, runTool, tokenFrom } from '../context.js'
import { envelope, looseObject, projectId, READ_ONLY } from '../schemas.js'
import { clip, lines, ref } from '../format.js'
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
/** Commands whose target is another LaTeX document, read as part of this one. */
const DOCUMENT_INCLUDES = new Set(['input', 'include', 'subfile'])
/** Above this many labels and refs together, the text gives counts instead of a list. */
const LIST_LIMIT = 40

const SCAN_ASPECTS = [
  'citations',
  'labels_refs',
  'equations',
  'floats',
  'commands',
  'todos',
  'includes',
]

/** Bibliography fields kept by search_bib's default brief detail. */
const BRIEF_BIB_FIELDS = ['author', 'title', 'year', 'journal', 'booktitle']

const optionalPath = z
  .string()
  .optional()
  .describe('Limit to one document, e.g. /main.tex; omit for all .tex')

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

/** Group items by a key, keeping first-seen order within each group. */
function groupBy(items, keyOf) {
  const groups = new Map()
  for (const item of items) {
    const key = keyOf(item)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }
  return groups
}

/** Flatten a per-document parse into one list carrying the source path. */
function acrossDocs(docs, parse) {
  return docs.flatMap(doc => parse(doc.content).map(item => ({ ...item, path: doc.path })))
}

/** Every normalised doc and file path in a project tree, for existence checks. */
function knownProjectPaths(tree) {
  return new Set(
    [...(tree?.docs ?? []), ...(tree?.files ?? [])].map(entry => normalisePath(entry.path))
  )
}

/** Collapse whitespace so a value spanning several source lines stays on one line. */
function oneLine(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** `path:line,line; other:line` for items that carry path and line. */
function locationList(items) {
  return [...groupBy(items, item => item.path)]
    .map(([path, group]) => `${path}:${[...new Set(group.map(item => item.line))].join(',')}`)
    .join('; ')
}

async function readDoc(client, token, id, path) {
  const { content } = await client.get(token, `/projects/${id}/doc`, { path })
  return content ?? ''
}

/**
 * Every .tex document of the project in one batch request. Documents that
 * could not be read come back with an error and are left out.
 *
 * @returns {Promise<{ path: string, content: string }[]>}
 */
async function readTexDocs(client, token, id) {
  const { documents = [] } = await client.post(token, `/projects/${id}/docs/read`, {
    ext: 'tex',
  })
  return documents
    .filter(doc => doc.content !== undefined)
    .map(doc => ({ path: normalisePath(doc.path), content: doc.content }))
}

/**
 * Read the documents a scanning tool should operate on.
 *
 * With a path, that one document. Without, every .tex document in the project,
 * fetched in one batch request.
 *
 * @returns {Promise<{ path: string, content: string }[]>}
 */
async function readScope(client, token, id, path) {
  if (path) {
    const docPath = requireFilePath(path)
    return [{ path: docPath, content: await readDoc(client, token, id, docPath) }]
  }
  return readTexDocs(client, token, id)
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
 *
 * With followIncludes, every .tex document is fetched in one batch up front,
 * so walking the includes costs no further requests.
 */
async function collectOutline(client, token, id, rootPath, followIncludes) {
  const [tree, batch] = followIncludes
    ? await Promise.all([
        client.get(token, `/projects/${id}/tree`),
        readTexDocs(client, token, id),
      ])
    : [null, []]
  const known = knownProjectPaths(tree)
  const prefetched = new Map(batch.map(doc => [doc.path, doc.content]))
  const contentOf = docPath =>
    prefetched.has(docPath) ? prefetched.get(docPath) : readDoc(client, token, id, docPath)
  const outline = []
  const documents = []
  const unresolvedIncludes = []
  const visited = new Set()
  let rootIncludes = 0

  const visit = async (docPath, depth) => {
    visited.add(docPath)
    documents.push(docPath)
    const content = await contentOf(docPath)
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
          command: step.include.command,
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
 * Outline text: headings indented by level relative to the shallowest one,
 * grouped under a path line when several documents are outlined.
 */
function renderOutline(outline, multiDoc) {
  if (outline.length === 0) return ''
  const minLevel = Math.min(...outline.map(section => section.level))
  const out = []
  let current = null
  for (const section of outline) {
    if (multiDoc && section.path !== current) {
      current = section.path
      out.push(current)
    }
    const indent = '  '.repeat(section.level - minLevel)
    out.push(
      `${indent}L${section.startLine}-${section.endLine} \\${section.name}${
        section.starred ? '*' : ''
      } ${oneLine(section.title)}`
    )
  }
  return out.join('\n')
}

/** One environment: location, name, [label], clipped caption, optional body. */
function renderEnvironment(env, includeBody) {
  const head = [
    ref(env.path, env.line, env.endLine),
    env.name,
    env.label && `[${env.label}]`,
    env.caption && clip(oneLine(env.caption), 120),
  ]
    .filter(Boolean)
    .join(' ')
  if (!includeBody) return head
  return lines(
    head,
    (env.body ?? '').split('\n').map(line => `  ${line}`)
  )
}

/** Citations grouped by key, sorted by key. */
function renderCitations(items) {
  return [...groupBy(items, item => item.key)]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, group]) => `${key}  ${locationList(group)}`)
    .join('\n')
}

/** Undefined refs first, then unused labels; the full list only when small. */
function renderLabelsRefs(items, issues) {
  const undefinedRefs = issues.filter(issue => issue.kind === 'undefined_ref')
  const unusedLabels = issues.filter(issue => issue.kind === 'unused_label')
  const labels = items.filter(item => item.kind === 'label')
  const refs = items.filter(item => item.kind === 'ref')
  return lines(
    [...groupBy(undefinedRefs, issue => issue.name)].map(
      ([name, group]) => `undefined ref ${name}  ${locationList(group)}`
    ),
    unusedLabels.map(label => `unused label ${label.name}  ${ref(label.path, label.line)}`),
    items.length <= LIST_LIMIT
      ? items.map(item => `${item.kind} ${item.name} ${ref(item.path, item.line)}`)
      : `labels: ${labels.length}, refs: ${refs.length}`
  )
}

/** Bibliography field lookup that ignores the case the source used. */
function bibField(fields, name) {
  const key = Object.keys(fields).find(candidate => candidate.toLowerCase() === name)
  return key === undefined ? '' : fields[key]
}

/** The fields search_bib keeps in brief mode, lowercased keys only. */
function briefFields(fields) {
  const out = {}
  for (const [name, value] of Object.entries(fields)) {
    if (BRIEF_BIB_FIELDS.includes(name.toLowerCase())) out[name] = value
  }
  return out
}

/** One bibliography entry on one line; in all mode, the other fields follow. */
function renderBibEntry(entry, detail) {
  const { fields } = entry
  const venue = [bibField(fields, 'journal') || bibField(fields, 'booktitle'), bibField(fields, 'year')]
    .filter(Boolean)
    .join(' ')
  const summary = [
    clip(oneLine(bibField(fields, 'author')), 60),
    clip(oneLine(bibField(fields, 'title')), 100),
    venue,
  ]
    .filter(Boolean)
    .join('. ')
  const rest =
    detail === 'all'
      ? Object.entries(fields)
          .filter(([name]) => !BRIEF_BIB_FIELDS.includes(name.toLowerCase()))
          .map(([name, value]) => `${name}=${clip(oneLine(value), 100)}`)
          .join('; ')
      : ''
  return [
    `@${entry.type}{${entry.key}} ${ref(entry.path, entry.line)}`,
    summary,
    rest,
  ]
    .filter(Boolean)
    .join('  ')
}

/**
 * Register the read-only LaTeX-semantic tools.
 *
 * They add no endpoint and no privilege: every byte comes from the same
 * authorized doc, batch and tree reads the file tools use.
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
        'Outline a LaTeX document: its headings with the startLine-endLine each spans, for read_file. followIncludes also walks \\input and \\include files in reading order.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        path: z.string().min(1).describe('Document path, e.g. /main.tex'),
        followIncludes: z
          .boolean()
          .optional()
          .default(false)
          .describe('Also outline the \\input and \\include files'),
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
                command: z.string().describe('input, include or subfile'),
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
          ? `followIncludes=true to outline the ${rootIncludes} included file(s)`
          : undefined
      return okResult({
        summary: `${outline.length} headings in ${documents.length} docs`,
        text: renderOutline(outline, documents.length > 1),
        data: {
          path: root,
          followIncludes,
          documents,
          outline,
          unresolvedIncludes,
        },
        warnings: unresolvedIncludes.map(
          inc => `${inc.path}:${inc.line} \\${inc.command}{${inc.target}} not found`
        ),
        nextSteps: hint ? [hint] : undefined,
      })
    })
  )

  server.registerTool(
    'scan_latex',
    {
      title: 'Scan LaTeX elements',
      description:
        'Extract one kind of LaTeX element across the project with path:line locations. labels_refs lists issues first; citations are grouped by key.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        aspect: z
          .enum(SCAN_ASPECTS)
          .describe('Element kind to extract'),
        path: optionalPath,
        includeBody: z
          .boolean()
          .optional()
          .describe('Include equation and float bodies'),
      }),
      outputSchema: envelope(
        looseObject({
          aspect: z.string().describe('The aspect that was scanned'),
          count: z.number().int().describe('Items returned in items'),
          documentsScanned: z.number().int().describe('Documents read'),
          items: z
            .array(scanItem)
            .describe(
              'Items with path and line. citations: key, command. labels_refs: kind (label or ref), name, command. equations and floats: name, endLine, label, caption, body (only with includeBody). commands: command, name, arity, definition. todos: kind, text. includes: command, target, resolvedPath (null when broken).'
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
    runTool(async ({ projectId: id, aspect, path, includeBody = false }, ctx) => {
      const token = tokenFrom(ctx, staticToken)
      const docs = await readScope(client, token, id, path)
      const base = { aspect, documentsScanned: docs.length }
      const respond = (items, text, extra = {}) =>
        okResult({
          summary: `${items.length} ${aspect} in ${docs.length} docs`,
          text,
          data: { ...base, count: items.length, items, ...extra },
        })

      switch (aspect) {
        case 'citations': {
          const items = acrossDocs(docs, parseCitations).sort(byLocation)
          return respond(items, renderCitations(items))
        }
        case 'labels_refs': {
          const labels = []
          const refs = []
          for (const doc of docs) {
            const parsed = parseLabelsAndRefs(doc.content)
            for (const label of parsed.labels) {
              labels.push({ kind: 'label', path: doc.path, line: label.line, name: label.name })
            }
            for (const ref of parsed.refs) {
              refs.push({
                kind: 'ref',
                path: doc.path,
                line: ref.line,
                name: ref.name,
                command: ref.command,
              })
            }
          }
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
          const items = [...labels, ...refs].sort(byLocation)
          return respond(items, renderLabelsRefs(items, issues), { issues })
        }
        case 'equations':
        case 'floats': {
          const names = aspect === 'equations' ? EQUATION_ENVIRONMENTS : FLOAT_ENVIRONMENTS
          const envs = acrossDocs(docs, text => parseEnvironments(text, names))
          const items = envs.map(env => ({
            path: env.path,
            line: env.line,
            endLine: env.endLine,
            name: env.name,
            label: env.label,
            caption: env.caption,
            ...(includeBody ? { body: env.body } : {}),
          }))
          return respond(
            items,
            envs.map(env => renderEnvironment(env, includeBody)).join('\n')
          )
        }
        case 'commands': {
          const items = acrossDocs(docs, parseCustomCommands).sort(byLocation)
          const text = items
            .map(cmd => {
              const name = cmd.name.startsWith('\\') ? cmd.name : `\\${cmd.name}`
              const arity = cmd.arity ? `[${cmd.arity}]` : ''
              return `${ref(cmd.path, cmd.line)} ${name}${arity} = ${clip(oneLine(cmd.definition), 100)}`
            })
            .join('\n')
          return respond(items, text)
        }
        case 'todos': {
          const items = acrossDocs(docs, parseTodoNotes).sort(byLocation)
          const text = items
            .map(note => `${ref(note.path, note.line)} ${note.kind}: ${clip(oneLine(note.text), 160)}`)
            .join('\n')
          return respond(items, text)
        }
        case 'includes': {
          const tree = await client.get(token, `/projects/${id}/tree`)
          const known = knownProjectPaths(tree)
          const items = docs
            .flatMap(doc =>
              parseIncludes(doc.content).map(include => ({
                path: doc.path,
                line: include.line,
                command: include.command,
                target: include.path,
                resolvedPath: resolveTarget(include.path, known),
              }))
            )
            .sort(byLocation)
          const text = items
            .map(
              inc =>
                `${ref(inc.path, inc.line)} \\${inc.command}{${inc.target}} -> ${inc.resolvedPath ?? 'NOT FOUND'}`
            )
            .join('\n')
          return respond(items, text)
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
        'Read a .bib file as structured entries (key, type, fields, line), optionally filtered by query. Use it to check a reference exists or get its exact \\cite key.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        path: z.string().min(1).describe('Path to the .bib file, e.g. /refs.bib'),
        query: z
          .string()
          .optional()
          .describe('Case-insensitive substring of key or any field'),
        detail: z
          .enum(['brief', 'all'])
          .optional()
          .describe('brief: author, title, year, venue; all: every field'),
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
                  .describe('Entry fields; only author, title, year, journal and booktitle when detail is brief'),
              })
            )
            .describe('The matching bibliography entries'),
        })
      ),
    },
    runTool(async ({ projectId: id, path, query, detail = 'brief' }, ctx) => {
      const target = requireFilePath(path)
      const content = await readDoc(client, tokenFrom(ctx, staticToken), id, target)
      const parsed = parseBibtex(content).map(entry => ({ path: target, ...entry }))
      const found = query ? searchBibtex(parsed, query) : parsed
      const entries = found.map(entry =>
        detail === 'all' ? entry : { ...entry, fields: briefFields(entry.fields) }
      )
      return okResult({
        summary: query
          ? `${target} ${entries.length}/${parsed.length} entries`
          : `${target} ${parsed.length} entries`,
        text: entries.map(entry => renderBibEntry(entry, detail)).join('\n'),
        data: { path: target, total: parsed.length, matched: entries.length, entries },
        warnings: /\.bib$/i.test(target)
          ? undefined
          : [`${target} does not end in .bib; it was parsed as BibTeX anyway`],
      })
    })
  )
}
