import { createHash } from 'node:crypto'
import * as z from 'zod/v4'
import { CODES, OverleafApiError } from '../errors.js'
import { mapLimit, okResult, runTool, tokenFrom, withBlocks } from '../context.js'
import {
  binaryFields,
  envelope,
  looseObject,
  projectId,
  READ_ONLY,
  WRITES,
} from '../schemas.js'
import { globMatcher, normalisePath, requireFilePath } from '../parsers/paths.js'
import {
  applyEdits,
  diffText,
  numberLines,
  splitLines,
} from '../parsers/textEdit.js'

/** Lines returned for a read that gives no endLine. */
const DEFAULT_READ_LINES = 500
/** Documents one read_file call may name; each is a separate upstream request. */
const MAX_PATHS_PER_READ = 100
/** Documents read at once within one call. */
const READ_CONCURRENCY = 8
const KIB = 1024
/**
 * Read-modify-write attempts for an edit. A write refused as a conflict means
 * the document changed after it was read, so it is read again and the edit is
 * applied to the new text. One retry; a second conflict is reported.
 */
const MAX_EDIT_ATTEMPTS = 2

const pathParam = z
  .string()
  .min(1)
  .describe('Project path, e.g. /main.tex or figures/plot.png; the leading / is optional')

const lineNumber = z.number().int().describe('1-based line number')

const changeSchema = looseObject({
  editIndex: z.number().int().describe('Index of the edit, from 0, that made this change'),
  startLine: lineNumber.describe('First line of the new text in the updated document'),
  endLine: z
    .number()
    .int()
    .describe('Last line of the new text; startLine minus 1 when text was only deleted'),
  diff: z.string().describe('"- " lines removed and "+ " lines added'),
})

const documentView = looseObject({
  path: z.string().describe('Document path'),
  totalLines: z.number().int().describe('Lines in the whole document'),
  startLine: lineNumber.describe('First line returned'),
  endLine: lineNumber.describe('Last line returned, inclusive'),
  truncated: z
    .boolean()
    .describe('True when lines remain after endLine; read them with the nextSteps call'),
  content: z
    .string()
    .describe('The lines as "N<TAB>text", numbered from startLine; the numbers are not in the file'),
})

const listEntry = looseObject({
  path: z.string().describe('Absolute project path'),
  type: z.enum(['doc', 'file', 'folder']).describe('doc = editable text, file = binary asset'),
  id: z.string().optional().describe('Overleaf entity id'),
  size: z.number().int().optional().describe('Size in bytes, for binary files when known'),
  root: z.boolean().optional().describe('True on the root document that compiles the project'),
})

/** Input validation shared by the file tools: a 400 the model can fix. */
function invalid(message, hint, details) {
  return new OverleafApiError(CODES.VALIDATION_ERROR, message, 400, { hint, details })
}

function formatBytes(bytes) {
  return bytes < KIB ? `${bytes} B` : `${Math.round(bytes / KIB)} KB`
}

function byName(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/**
 * Render entries as an indented outline, folders first, for a model that
 * wants the layout at a glance rather than a flat list.
 */
function renderTree(entries) {
  const root = { name: '', children: new Map(), entry: null }
  for (const entry of entries) {
    const segments = entry.path.split('/').filter(Boolean)
    let node = root
    for (const segment of segments) {
      if (!node.children.has(segment)) {
        node.children.set(segment, { name: segment, children: new Map(), entry: null })
      }
      node = node.children.get(segment)
    }
    node.entry = entry
  }

  const lines = ['/']
  const walk = (node, depth) => {
    const children = [...node.children.values()].sort((a, b) => {
      const aDir = a.children.size > 0 || a.entry?.type === 'folder' ? 0 : 1
      const bDir = b.children.size > 0 || b.entry?.type === 'folder' ? 0 : 1
      return aDir - bDir || byName(a, b)
    })
    for (const child of children) {
      const isFolder = child.children.size > 0 || child.entry?.type === 'folder'
      const notes = []
      if (child.entry?.root) notes.push('root')
      if (child.entry?.type === 'file' && typeof child.entry.size === 'number') {
        notes.push(formatBytes(child.entry.size))
      }
      const suffix = notes.length ? `  (${notes.join(', ')})` : ''
      lines.push(`${'  '.repeat(depth)}${child.name}${isFolder ? '/' : ''}${suffix}`)
      walk(child, depth + 1)
    }
  }
  walk(root, 1)
  return lines.join('\n')
}

/** Accept either `path` or `paths`, never both, and normalise each. */
function pathTargets({ path, paths }) {
  if (path !== undefined && paths !== undefined) {
    throw invalid('pass either path or paths, not both', 'Use path for one document and paths for several.')
  }
  if (paths !== undefined) {
    return [...new Set(paths.map(p => requireFilePath(p)))]
  }
  if (path === undefined) {
    throw invalid('path or paths is required', 'Call list_files to find the exact document paths.')
  }
  return [requireFilePath(path)]
}

/**
 * Accept the edits array, or the single oldString/newString shorthand, and
 * return one array of edits.
 */
function editsFrom({ edits, oldString, newString, replaceAll }) {
  const single = oldString !== undefined || newString !== undefined
  if (edits !== undefined && single) {
    throw invalid(
      'pass either edits or oldString/newString, not both',
      'Use edits for several changes; a single change may use oldString and newString.'
    )
  }
  if (edits !== undefined) return edits
  if (oldString === undefined || newString === undefined) {
    throw invalid(
      'supply edits, or both oldString and newString',
      'Pass edits: [{oldString, newString}] to change text, or use edit_lines to change a line range.'
    )
  }
  return [{ oldString, newString, replaceAll: replaceAll === true }]
}

/** One document's numbered view of the lines web returned for a range. */
/** Hash of a document's text, matching web's hash of the same lines. */
function contentHash(text) {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Read a document, compute its edit, and write the result back only if the
 * document still reads as it did. web answers a stale write with 409, which is
 * retried once against the fresh text. Returns the edit outcome and the
 * write response, or a null response when the edit changed nothing.
 *
 * @param {object} client OverleafClient
 * @param {string} token
 * @param {string} id project id
 * @param {string} target document path
 * @param {(content: string) => { text: string }} edit pure transform; throws on a bad edit
 */
async function editDocument(client, token, id, target, edit) {
  for (let attempt = 1; ; attempt += 1) {
    // Deliberately unsliced: a line-range read would truncate the write-back.
    const { content } = await client.get(token, `/projects/${id}/doc`, { path: target })
    const outcome = edit(content)
    if (outcome.text === content) {
      return { outcome, response: null }
    }
    try {
      const response = await client.post(token, `/projects/${id}/doc`, {
        path: target,
        content: outcome.text,
        expectedHash: contentHash(content),
      })
      return { outcome, response }
    } catch (err) {
      if (err?.code !== CODES.CONFLICT || attempt >= MAX_EDIT_ATTEMPTS) {
        throw err
      }
    }
  }
}

function numberedView(requested, page) {
  const lines = String(page.content ?? '').split('\n')
  const startLine = page.startLine ?? requested.startLine
  const endLine = page.endLine ?? startLine + lines.length - 1
  const totalLines = page.totalLines ?? endLine
  return {
    path: requested.path,
    totalLines,
    startLine,
    endLine,
    truncated: endLine < totalLines,
    content: numberLines(lines, startLine),
  }
}

/**
 * Register the file-tree and document tools.
 *
 * @param {object} server an McpServer
 * @param {{ client: object, staticToken: string }} deps
 */
export function registerFileTools(server, { client, staticToken }) {
  server.registerTool(
    'list_files',
    {
      title: 'List project files',
      description:
        'List the project tree: every document, binary file and folder with its exact path, id and size where known. Call this first to learn the paths other tools expect; filter with type or glob.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        type: z
          .enum(['all', 'docs', 'files', 'folders'])
          .optional()
          .default('all')
          .describe('Entries to return: all, docs (text), files (binary) or folders'),
        glob: z
          .string()
          .optional()
          .describe('Glob filter: "*.tex" matches any folder, "figures/**" everything under figures'),
        view: z
          .enum(['flat', 'tree'])
          .optional()
          .default('flat')
          .describe('flat returns entries only; tree also returns an indented outline in data.tree'),
      }),
      outputSchema: envelope(
        looseObject({
          total: z.number().int().describe('Number of entries returned'),
          rootDocPath: z
            .string()
            .nullable()
            .describe('Path of the root document, or null when none is set'),
          entries: z.array(listEntry).describe('Matching entries, sorted by path'),
          tree: z.string().optional().describe('Indented outline, only when view is tree'),
        })
      ),
    },
    runTool(async ({ projectId: id, type = 'all', glob, view = 'flat' }, ctx) => {
      const { docs = [], files = [], folders = [], rootDocPath = null } =
        await client.get(tokenFrom(ctx, staticToken), `/projects/${id}/tree`)
      const wanted = {
        all: ['doc', 'file', 'folder'],
        docs: ['doc'],
        files: ['file'],
        folders: ['folder'],
      }[type]
      const matchesGlob = glob ? globMatcher(glob) : () => true
      const root = rootDocPath ? normalisePath(rootDocPath) : null

      const entries = [
        ...docs.map(d => ({ path: normalisePath(d.path), type: 'doc', id: d.id })),
        ...files.map(f => ({
          path: normalisePath(f.path),
          type: 'file',
          id: f.id,
          size: f.size,
        })),
        ...folders
          .map(f => ({ path: normalisePath(f.path), type: 'folder', id: f.id }))
          .filter(f => f.path !== '/'),
      ]
        .filter(entry => wanted.includes(entry.type) && matchesGlob(entry.path))
        .map(entry => (entry.path === root ? { ...entry, root: true } : entry))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

      const counts = { doc: 0, file: 0, folder: 0 }
      for (const entry of entries) counts[entry.type]++
      const data = { total: entries.length, rootDocPath: root, entries }
      if (view === 'tree') data.tree = renderTree(entries)

      return okResult({
        summary:
          `${entries.length} entries (${counts.doc} documents, ${counts.file} files, ` +
          `${counts.folder} folders)` +
          (root ? `; root document ${root}` : '') +
          '.',
        data,
        nextSteps: root
          ? [`get_doc_outline(projectId, path="${root}") to see the root document's sections`]
          : undefined,
      })
    })
  )

  server.registerTool(
    'search_files',
    {
      title: 'Search project files',
      description:
        'Search the text of every project document for a string or regular expression. Returns each matching line with its path, 1-based line number and optional context. Narrow with path or glob; then read the match with read_file.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        query: z
          .string()
          .min(1)
          .describe('Text to find, or a JavaScript regular expression when regex is true'),
        regex: z
          .boolean()
          .optional()
          .default(false)
          .describe('Treat query as a regular expression'),
        caseSensitive: z
          .boolean()
          .optional()
          .default(false)
          .describe('Match letter case exactly'),
        path: z
          .string()
          .optional()
          .describe('Only search inside this folder, e.g. /chapters'),
        glob: z
          .string()
          .optional()
          .describe('Only search documents matching this glob, e.g. "*.tex" or "chapters/**"'),
        contextLines: z
          .number()
          .int()
          .min(0)
          .optional()
          .default(0)
          .describe('Lines of context returned before and after each match (default 0)'),
        maxMatches: z
          .number()
          .int()
          .min(1)
          .optional()
          .default(50)
          .describe('Stop after this many matches (default 50)'),
      }),
      outputSchema: envelope(
        looseObject({
          query: z.string().describe('The text or pattern that was searched for'),
          regex: z.boolean().describe('Whether query was a regular expression'),
          totalMatches: z.number().int().describe('Matches returned'),
          truncated: z
            .boolean()
            .describe('True when the search stopped at maxMatches; more matches may exist'),
          filesSearched: z.number().int().describe('Documents read before the search ended'),
          matches: z
            .array(
              looseObject({
                path: z.string().describe('Document containing the match'),
                line: lineNumber.describe('Line of the match'),
                text: z.string().describe('The matching line, trimmed'),
                before: z.array(z.string()).describe('Context lines above, nearest last'),
                after: z.array(z.string()).describe('Context lines below, nearest first'),
              })
            )
            .describe('Matches in path order, then line order'),
        })
      ),
    },
    runTool(
      async (
        {
          projectId: id,
          query,
          regex = false,
          caseSensitive = false,
          path,
          glob,
          contextLines = 0,
          maxMatches = 50,
        },
        ctx
      ) => {
        const data = await client.get(tokenFrom(ctx, staticToken), `/projects/${id}/search`, {
          query,
          regex,
          caseSensitive,
          path: path === undefined ? undefined : normalisePath(path),
          glob,
          contextLines,
          maxMatches,
        })
        const first = data.matches?.[0]
        return okResult({
          summary:
            `${data.totalMatches}${data.truncated ? '+' : ''} match(es) for "${query}" ` +
            `in ${data.filesSearched} document(s).`,
          data,
          warnings: data.truncated
            ? [`stopped at maxMatches=${maxMatches}; narrow with path or glob, or raise maxMatches`]
            : undefined,
          nextSteps: first
            ? [
                `read_file(projectId, path="${first.path}", startLine=${Math.max(1, first.line - 10)}, endLine=${first.line + 10})`,
              ]
            : ['Try a shorter query, regex: true, or caseSensitive: false to widen the search.'],
        })
      }
    )
  )

  server.registerTool(
    'read_file',
    {
      title: 'Read documents',
      description:
        `Read line-numbered text from one or more documents. Line numbers are 1-based and are not part of the file. Without endLine, each document returns its first ${DEFAULT_READ_LINES} lines from startLine. Pass startLine and endLine for part of a long file; get_doc_outline gives section ranges. Follow nextSteps when truncated is true.`,
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        path: pathParam.optional().describe('One document to read'),
        paths: z
          .array(pathParam)
          .min(1)
          .max(MAX_PATHS_PER_READ)
          .optional()
          .describe(
            `Several documents to read in one call, at most ${MAX_PATHS_PER_READ}; use instead of path`
          ),
        startLine: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('First line to return, 1-based (default 1)'),
        endLine: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(`Last line to return, 1-based and inclusive (default startLine + ${DEFAULT_READ_LINES - 1})`),
      }),
      outputSchema: envelope(
        looseObject({
          documents: z.array(documentView).describe('One entry per requested document'),
        })
      ),
    },
    runTool(async ({ projectId: id, path, paths, startLine, endLine }, ctx) => {
      const token = tokenFrom(ctx, staticToken)
      const targets = pathTargets({ path, paths })
      const start = startLine ?? 1
      if (endLine !== undefined && endLine < start) {
        throw invalid(
          `endLine ${endLine} is before startLine ${start}`,
          'Set endLine to the last line you want, at or after startLine.'
        )
      }
      const requestedEnd = endLine ?? start + DEFAULT_READ_LINES - 1

      const documents = await mapLimit(targets, READ_CONCURRENCY, async target =>
        numberedView(
          { path: target, startLine: start },
          await client.get(token, `/projects/${id}/doc`, {
            path: target,
            startLine: start,
            endLine: requestedEnd,
          })
        )
      )

      const truncated = documents.filter(doc => doc.truncated)
      const single = documents.length === 1 ? documents[0] : null
      return okResult({
        summary: single
          ? `Read lines ${single.startLine}-${single.endLine} of ${single.totalLines} from ${single.path}` +
            (single.truncated ? `; ${single.totalLines - single.endLine} lines remain.` : '.')
          : `Read ${documents.length} documents (${truncated.length} truncated).`,
        data: { documents },
        nextSteps: truncated.slice(0, 3).map(
          doc =>
            `read_file(projectId, path="${doc.path}", startLine=${doc.endLine + 1}, endLine=${doc.endLine + DEFAULT_READ_LINES})`
        ),
      })
    })
  )

  server.registerTool(
    'write_file',
    {
      title: 'Create or overwrite document',
      description:
        'Create a document, or replace the entire contents of an existing one, creating missing parent folders. Use it for new files and full rewrites only; for changes to an existing file use edit_file or edit_lines, which cannot silently drop the rest of the text.',
      annotations: { ...WRITES, idempotentHint: true },
      inputSchema: z.object({
        projectId,
        path: pathParam.describe('Document path, e.g. /sections/intro.tex'),
        content: z.string().describe('The complete new contents, with \\n line breaks'),
      }),
      outputSchema: envelope(
        looseObject({
          path: z.string().describe('Document that was written'),
          docId: z.string().optional().describe('Id of the document that was written'),
          created: z.boolean().describe('True when the document did not exist before'),
          lineCount: z.number().int().describe('Lines in the new contents'),
          previousLineCount: z
            .number()
            .int()
            .optional()
            .describe('Lines in the replaced contents, when it existed'),
        })
      ),
    },
    runTool(async ({ projectId: id, path, content }, ctx) => {
      const target = requireFilePath(path)
      const response = await client.post(tokenFrom(ctx, staticToken), `/projects/${id}/doc`, {
        path: target,
        content,
      })
      const { created, lineCount, previousLineCount, docId } = response
      const shrank =
        !created && previousLineCount >= 20 && lineCount < previousLineCount / 2
      return okResult({
        summary: created
          ? `Created ${target} (${lineCount} lines).`
          : `Replaced ${target}: ${previousLineCount} -> ${lineCount} lines.`,
        data: { path: target, docId, created, lineCount, previousLineCount },
        warnings: shrank
          ? [
              `${target} lost more than half its lines; if that was not intended, restore it from Overleaf History`,
            ]
          : undefined,
      })
    })
  )

  server.registerTool(
    'edit_file',
    {
      title: 'Replace text in document',
      description:
        'Replace exact text in a document. Pass edits to apply several changes in order, all or nothing. Each oldString must match once unless replaceAll is set. On failure nothing changes and the reply gives the nearest text with its line numbers.',
      annotations: { ...WRITES, idempotentHint: false },
      inputSchema: z.object({
        projectId,
        path: pathParam.describe('Text document to edit, e.g. /main.tex'),
        edits: z
          .array(
            z.object({
              oldString: z
                .string()
                .min(1)
                .describe('Exact text to find, copied without the line-number prefix'),
              newString: z
                .string()
                .describe('Text to put in its place; "" deletes oldString'),
              replaceAll: z
                .boolean()
                .optional()
                .describe('Change every occurrence instead of requiring exactly one'),
            })
          )
          .min(1)
          .optional()
          .describe('Edits applied in order, all or nothing; preferred for several changes'),
        oldString: z
          .string()
          .min(1)
          .optional()
          .describe('Shorthand for one edit: the exact text to find'),
        newString: z
          .string()
          .optional()
          .describe('Shorthand for one edit: the replacement; "" deletes oldString'),
        replaceAll: z
          .boolean()
          .optional()
          .describe('Shorthand for one edit: change every occurrence'),
      }),
      outputSchema: envelope(
        looseObject({
          path: z.string().describe('Document that was edited'),
          replacements: z.number().int().describe('Occurrences replaced across all edits'),
          changes: z
            .array(changeSchema)
            .describe('Where each change landed in the updated document'),
          docId: z.string().optional().describe('Id of the document that was written'),
        })
      ),
    },
    runTool(async ({ projectId: id, path, edits, oldString, newString, replaceAll }, ctx) => {
      const token = tokenFrom(ctx, staticToken)
      const target = requireFilePath(path)
      const list = editsFrom({ edits, oldString, newString, replaceAll })
      const { outcome: applied, response } = await editDocument(client, token, id, target, content =>
        applyEdits(content, list, { path: target })
      )

      if (!response) {
        return okResult({
          summary: `No change to ${target}: the edits left the text as it was.`,
          data: { path: target, replacements: applied.replacements, changes: [] },
          warnings: applied.warnings,
        })
      }

      const first = applied.changes[0]
      return okResult({
        summary:
          `Edited ${target}: ${applied.replacements} replacement(s) across ${list.length} edit(s).`,
        data: {
          path: target,
          replacements: applied.replacements,
          changes: applied.changes,
          docId: response.docId,
        },
        warnings: applied.warnings.length ? applied.warnings : undefined,
        nextSteps: first
          ? [
              `read_file(projectId, path="${target}", startLine=${Math.max(1, first.startLine - 3)}, endLine=${first.endLine + 3}) to check the result`,
            ]
          : undefined,
      })
    })
  )

  server.registerTool(
    'edit_lines',
    {
      title: 'Replace, insert or delete lines',
      description:
        'Change a line range by number: replace lines, insert before or after a line, or delete lines (newText ""). Line numbers are 1-based and inclusive, as read_file prints them. Use it when exact text matching is awkward; it returns the removed lines and the new span.',
      annotations: { ...WRITES, idempotentHint: false },
      inputSchema: z.object({
        projectId,
        path: pathParam.describe('Text document to edit, e.g. /main.tex'),
        startLine: z
          .number()
          .int()
          .min(1)
          .describe('First line to change, 1-based; the anchor line for insert modes'),
        endLine: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Last line to replace, inclusive (default startLine); unused by insert modes'),
        newText: z
          .string()
          .describe('Text for the lines, with \\n between lines; "" deletes them'),
        mode: z
          .enum(['replace', 'insert_before', 'insert_after'])
          .optional()
          .default('replace')
          .describe('replace the lines (default), or insert newText before or after startLine'),
      }),
      outputSchema: envelope(
        looseObject({
          path: z.string().describe('Document that was edited'),
          mode: z.string().describe('The mode that was applied'),
          totalLines: z.number().int().describe('Lines in the updated document'),
          removedLines: looseObject({
            startLine: lineNumber,
            endLine: lineNumber,
            count: z.number().int().describe('Lines removed'),
          }).describe('The lines that were replaced or deleted'),
          insertedLines: z.number().int().describe('Lines added'),
          changes: z.array(changeSchema),
        })
      ),
    },
    runTool(async ({ projectId: id, path, startLine, endLine, newText, mode = 'replace' }, ctx) => {
      const token = tokenFrom(ctx, staticToken)
      const target = requireFilePath(path)
      // Filled in by the edit, which runs on the text editDocument reads.
      let plan
      const { response } = await editDocument(client, token, id, target, content => {
        const lines = content.split('\n')
        const total = lines.length
        const pastEnd = line =>
          invalid(
            `line ${line} is past the end of ${target} (${total} lines)`,
            'Call read_file on the document to confirm the line numbers.',
            { totalLines: total }
          )

        // The span of old lines this change replaces: [from, to], empty when to < from.
        let from
        let to
        if (mode === 'replace') {
          from = startLine
          to = endLine ?? startLine
          if (to < from) {
            throw invalid(`endLine ${to} is before startLine ${from}`, 'Set endLine to the last line to replace.')
          }
          if (to > total) throw pastEnd(to)
        } else if (mode === 'insert_before') {
          from = startLine
          to = startLine - 1
          if (startLine > total + 1) throw pastEnd(startLine)
        } else {
          from = startLine + 1
          to = startLine
          if (startLine > total) throw pastEnd(startLine)
        }

        const newLines = splitLines(newText)
        const removed = lines.slice(from - 1, to)
        const updated = [...lines.slice(0, from - 1), ...newLines, ...lines.slice(to)]
        plan = {
          total,
          updatedTotal: updated.length,
          from,
          to,
          newLines,
          removed,
          span: removed.length ? `${removed.length} line(s) at ${from}-${to}` : `before line ${from}`,
        }
        return { text: updated.join('\n') }
      })
      const { total, updatedTotal, from, to, newLines, removed, span } = plan

      if (!response) {
        return okResult({
          summary: `No change to ${target}: the lines already match.`,
          data: {
            path: target,
            mode,
            totalLines: total,
            removedLines: { startLine: from, endLine: to, count: 0 },
            insertedLines: 0,
            changes: [],
          },
        })
      }

      const change = {
        editIndex: 0,
        startLine: from,
        endLine: from + newLines.length - 1,
        diff: diffText(removed.join('\n'), newText),
      }
      return okResult({
        summary:
          newLines.length === 0
            ? `Deleted ${span} from ${target}.`
            : `Changed ${target}: ${removed.length} line(s) replaced by ${newLines.length}.`,
        data: {
          path: target,
          mode,
          totalLines: updatedTotal,
          removedLines: { startLine: from, endLine: to, count: removed.length },
          insertedLines: newLines.length,
          changes: [change],
        },
        nextSteps: [
          `read_file(projectId, path="${target}", startLine=${Math.max(1, change.startLine - 3)}, endLine=${change.endLine + 3}) to check the result`,
        ],
      })
    })
  )

  server.registerTool(
    'move_file',
    {
      title: 'Move or rename',
      description:
        'Move or rename a document, binary file or folder within the project, creating missing destination folders. A new folder moves it; a new name renames it. References such as \\input or \\includegraphics are not rewritten, so run scan_latex with aspect includes afterwards.',
      annotations: { ...WRITES, idempotentHint: false },
      inputSchema: z.object({
        projectId,
        oldPath: pathParam.describe('Current path'),
        newPath: pathParam.describe('Destination path; must not already exist'),
      }),
      outputSchema: envelope(
        looseObject({
          oldPath: z.string().describe('Path before the move'),
          newPath: z.string().describe('Path after the move'),
        })
      ),
    },
    runTool(async ({ projectId: id, oldPath, newPath }, ctx) => {
      const from = requireFilePath(oldPath, 'oldPath')
      const to = requireFilePath(newPath, 'newPath')
      await client.post(tokenFrom(ctx, staticToken), `/projects/${id}/move`, {
        oldPath: from,
        newPath: to,
      })
      return okResult({
        summary: `Moved ${from} to ${to}.`,
        data: { oldPath: from, newPath: to },
        nextSteps: [
          `scan_latex(projectId, aspect="includes") to find \\input or \\includegraphics that still name ${from}`,
        ],
      })
    })
  )

  server.registerTool(
    'delete_file',
    {
      title: 'Delete document, file or folder',
      description:
        'Delete a document, binary file or folder; a folder deletes everything inside it. A deleted file can be brought back with restore_file (find its version with list_history); the root document cannot be deleted. Confirm the exact path with list_files first.',
      annotations: { ...WRITES, idempotentHint: false },
      inputSchema: z.object({
        projectId,
        path: pathParam.describe('Path of the document, file or folder to delete'),
      }),
      outputSchema: envelope(
        looseObject({
          path: z.string().describe('Path that was deleted'),
          deleted: looseObject({
            docs: z.number().int().describe('Documents removed'),
            files: z.number().int().describe('Binary files removed'),
            folders: z.number().int().describe('Folders removed, including the named one'),
          }),
        })
      ),
    },
    runTool(async ({ projectId: id, path }, ctx) => {
      const target = requireFilePath(path)
      const response = await client.request(
        tokenFrom(ctx, staticToken),
        'DELETE',
        `/projects/${id}/file`,
        { query: { path: target } }
      )
      const { docs = 0, files = 0, folders = 0 } = response.deleted ?? {}
      return okResult({
        summary: `Deleted ${target} (${docs} document(s), ${files} file(s), ${folders} folder(s)).`,
        data: { path: target, deleted: { docs, files, folders } },
        warnings: [
          'Deletion cannot be undone with these tools; Overleaf History may still hold the earlier content.',
        ],
      })
    })
  )

  server.registerTool(
    'upload_asset',
    {
      title: 'Upload image or binary asset',
      description:
        'Add a binary asset such as a figure or PDF to the project, from base64 content or from a URL that Overleaf fetches. Prefer url for large files. Missing parent folders are created automatically.',
      // The url option makes Overleaf fetch an arbitrary external address.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: z.object({
        projectId,
        path: pathParam.describe('Destination path, e.g. /figures/plot.png'),
        contentBase64: z.string().optional().describe('Base64-encoded file contents'),
        url: z
          .string()
          .url()
          .optional()
          .describe('URL for Overleaf to fetch server-side; use instead of contentBase64'),
      }),
      outputSchema: envelope(
        looseObject({
          path: z.string().describe('Path the asset was stored at'),
          fileId: z.string().optional().describe('Id of the stored file'),
        })
      ),
    },
    runTool(async ({ projectId: id, path, contentBase64, url }, ctx) => {
      const target = requireFilePath(path)
      if (Boolean(contentBase64) === Boolean(url)) {
        throw invalid(
          'supply exactly one of contentBase64 or url',
          'Pass contentBase64 for data you hold, or url for a file Overleaf should fetch.'
        )
      }
      const response = await client.post(tokenFrom(ctx, staticToken), `/projects/${id}/file`, {
        path: target,
        ...(contentBase64 ? { contentBase64 } : { url }),
      })
      return okResult({
        summary: `Stored ${target}.`,
        data: { path: response.path ?? target, fileId: response.fileId },
      })
    })
  )

  server.registerTool(
    'download_file',
    {
      title: 'Download file',
      description:
        'Download one binary file from the project, such as an image, PDF or archive, as a resource the client can save. For text documents use read_file instead.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        path: pathParam.describe('Path of the binary file'),
      }),
      outputSchema: envelope(
        looseObject({
          path: z.string().describe('The file that was downloaded'),
          ...binaryFields,
        })
      ),
    },
    runTool(async ({ projectId: id, path: filePath }, ctx) => {
      const target = requireFilePath(filePath)
      const token = tokenFrom(ctx, staticToken)
      const { contentType, base64 } = await client.requestBinary(
        token,
        `/projects/${id}/file`,
        { path: target }
      )
      const cleanPath = target.replace(/^\/+/, '')
      const uri = `overleaf://projects/${id}/files/${cleanPath}`
      const sizeBytes = Buffer.byteLength(base64, 'base64')
      const result = okResult({
        summary: `Downloaded ${target} (${sizeBytes} bytes, ${contentType}).`,
        data: { path: target, uri, mimeType: contentType, sizeBytes },
      })
      return withBlocks(result, [
        {
          type: 'resource',
          resource: { uri, mimeType: contentType, blob: base64 },
        },
      ])
    })
  )
}
