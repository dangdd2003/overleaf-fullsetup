import { createHash } from 'node:crypto'
import * as z from 'zod/v4'
import { CODES, OverleafApiError } from '../errors.js'
import { okResult, runTool, tokenFrom, withBlocks } from '../context.js'
import { lines } from '../format.js'
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
/** Documents one read_file call may name; they are read in one batch request. */
const MAX_PATHS_PER_READ = 100
const KIB = 1024
/** Lines of a changed region shown in an edit reply before the rest is summarised. */
const MAX_SHOWN_LINES = 60
/** Unchanged lines shown above and below each change in an edit reply. */
const CONTEXT_LINES = 2
/** Changed regions shown in one edit reply; a replaceAll past this lists the rest by count. */
const MAX_SHOWN_CHANGES = 20
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

/** Compact size, e.g. 512B or 21K. */
function formatBytes(bytes) {
  return bytes < KIB ? `${bytes}B` : `${Math.round(bytes / KIB)}K`
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

  const rows = ['/']
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
      rows.push(`${'  '.repeat(depth)}${child.name}${isFolder ? '/' : ''}${suffix}`)
      walk(child, depth + 1)
    }
  }
  walk(root, 1)
  return rows.join('\n')
}

/** One entry as a line of the flat list: folders end in /, binary files show size. */
function flatLine(entry) {
  let line = entry.type === 'folder' ? `${entry.path}/` : entry.path
  if (entry.type === 'file' && typeof entry.size === 'number') {
    line += `  ${formatBytes(entry.size)}`
  }
  if (entry.root) line += '  (root)'
  return line
}

/**
 * The changed regions of an updated document, numbered, with a little context
 * either side, so an edit can be checked without reading the document again.
 * A pure deletion shows the lines around the gap.
 *
 * @param {string} text the document after the change
 * @param {Array<{ startLine: number, endLine: number, diff: string }>} changes
 */
function renderChanges(text, changes) {
  const all = splitLines(text)
  const total = all.length
  const shownChanges = changes.slice(0, MAX_SHOWN_CHANGES)
  const hiddenChanges = changes.length - shownChanges.length
  const blocks = shownChanges.map(change => {
    const deleted = change.endLine < change.startLine || !/^\+ /m.test(change.diff)
    const header = deleted
      ? `@@ deleted at ${change.startLine}`
      : `@@ ${change.startLine}-${change.endLine}`
    const from = Math.max(1, change.startLine - CONTEXT_LINES)
    const last = deleted ? change.startLine - 1 : change.endLine
    const to = Math.min(total, last + CONTEXT_LINES)
    const span = Math.max(0, to - from + 1)
    const shown = Math.min(span, MAX_SHOWN_LINES)
    const body = numberLines(all.slice(from - 1, from - 1 + shown), from)
    const more = span > shown ? `… ${span - shown} more lines` : ''
    return lines(header, body, more)
  })
  if (hiddenChanges > 0) blocks.push(`… ${hiddenChanges} more changes not shown`)
  return blocks.join('\n')
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

/** Hash of a document's text, matching web's hash of the same lines. */
function contentHash(text) {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Read a document, compute its edit, and write the result back only if the
 * document still reads as it did. web answers a stale write with 409, which is
 * retried once against the fresh text. Returns the edit outcome (with the
 * updated text) and the write response, or a null response when the edit
 * changed nothing.
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
  const rows = String(page.content ?? '').split('\n')
  const startLine = page.startLine ?? requested.startLine
  const endLine = page.endLine ?? startLine + rows.length - 1
  const totalLines = page.totalLines ?? endLine
  return {
    path: requested.path,
    totalLines,
    startLine,
    endLine,
    truncated: endLine < totalLines,
    content: numberLines(rows, startLine),
  }
}

/**
 * The documents of one batch read, in the order requested. The first document
 * that is missing, binary or failed decides the error, as a single read would.
 *
 * @param {string[]} targets normalised paths
 * @param {{ documents?: object[], missing?: object[] }} response
 * @param {number} startLine
 */
function batchDocuments(targets, response, startLine) {
  const found = new Map((response.documents ?? []).map(doc => [doc.path, doc]))
  const missing = new Map((response.missing ?? []).map(gap => [gap.path, gap.reason]))
  return targets.map(target => {
    const reason = missing.get(target)
    if (reason === 'binary') {
      throw invalid(
        `${target} is a binary file, not a text document`,
        'Use download_file for binary files and read_file only for text documents.'
      )
    }
    const doc = found.get(target)
    if (reason || !doc) {
      throw new OverleafApiError(CODES.NOT_FOUND, `${target} was not found`, 404, {
        hint: 'Call list_files to find the exact document paths.',
      })
    }
    if (doc.error !== undefined) {
      throw invalid(String(doc.error), 'Adjust startLine and endLine to the document length.')
    }
    return numberedView({ path: target, startLine }, doc)
  })
}

/** A read document as a header line and its numbered lines. */
function documentText(doc) {
  return `${doc.path}  ${doc.startLine}-${doc.endLine}/${doc.totalLines}\n${doc.content}`
}

/** Grep-style text: each file's path, then its matches and context lines. */
function matchText(matches) {
  const out = []
  let current = null
  for (const match of matches) {
    if (match.path !== current) {
      current = match.path
      out.push(current)
    }
    const before = match.before ?? []
    const after = match.after ?? []
    before.forEach((text, i) => out.push(`  ${match.line - before.length + i}- ${text}`))
    out.push(`  ${match.line}: ${match.text}`)
    after.forEach((text, i) => out.push(`  ${match.line + 1 + i}- ${text}`))
  }
  return out.join('\n')
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
        'List project documents, binary files and folders with their exact paths.',
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
          .describe('Glob filter, e.g. "*.tex" or "figures/**"'),
        view: z
          .enum(['flat', 'tree'])
          .optional()
          .default('flat')
          .describe('flat lists entries; tree shows an indented outline instead'),
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

      // Folders are implied by the paths, so the flat list leaves them out unless asked for.
      const text =
        view === 'tree'
          ? data.tree
          : entries
              .filter(entry => entry.type !== 'folder' || type === 'folders')
              .map(flatLine)
              .join('\n')

      return okResult({
        summary:
          `${entries.length} entries: ${counts.doc} docs, ${counts.file} files, ` +
          `${counts.folder} folders` +
          (root ? `; root ${root}` : ''),
        text,
        data,
      })
    })
  )

  server.registerTool(
    'search_files',
    {
      title: 'Search project files',
      description:
        'Search the text of every project document for a string or regular expression. Returns matching lines with path and line number, plus optional context.',
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
          .describe('Only search documents matching, e.g. "*.tex" or "chapters/**"'),
        contextLines: z
          .number()
          .int()
          .min(0)
          .optional()
          .default(0)
          .describe('Lines of context before and after each match'),
        maxMatches: z
          .number()
          .int()
          .min(1)
          .optional()
          .default(50)
          .describe('Stop after this many matches'),
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
        const matches = data.matches ?? []
        return okResult({
          summary:
            `${data.totalMatches}${data.truncated ? '+' : ''} matches in ${data.filesSearched} docs`,
          text: matchText(matches),
          data,
          warnings: data.truncated
            ? [`stopped at maxMatches=${maxMatches}; narrow with path or glob, or raise maxMatches`]
            : undefined,
          nextSteps: matches.length
            ? undefined
            : ['Try a shorter query, or regex: true / caseSensitive: false to widen the search.'],
        })
      }
    )
  )

  server.registerTool(
    'read_file',
    {
      title: 'Read documents',
      description:
        `Read line-numbered lines from one or more documents; line numbers are not part of the file. Without endLine, returns up to ${DEFAULT_READ_LINES} lines from startLine.`,
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        path: pathParam.optional().describe('One document to read'),
        paths: z
          .array(pathParam)
          .min(1)
          .max(MAX_PATHS_PER_READ)
          .optional()
          .describe(`Several documents, read in one call (max ${MAX_PATHS_PER_READ}); instead of path`),
        startLine: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('First line, 1-based (default 1)'),
        endLine: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(`Last line, 1-based and inclusive (default startLine + ${DEFAULT_READ_LINES - 1})`),
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

      // One document keeps the single-document call, which carries its suggestion details.
      const documents =
        targets.length === 1
          ? [
              numberedView(
                { path: targets[0], startLine: start },
                await client.get(token, `/projects/${id}/doc`, {
                  path: targets[0],
                  startLine: start,
                  endLine: requestedEnd,
                })
              ),
            ]
          : batchDocuments(
              targets,
              await client.post(token, `/projects/${id}/docs/read`, {
                paths: targets,
                startLine: start,
                endLine: requestedEnd,
              }),
              start
            )

      const truncated = documents.filter(doc => doc.truncated)
      const single = documents.length === 1 ? documents[0] : null
      return okResult({
        summary: single
          ? `${single.path} ${single.startLine}-${single.endLine}/${single.totalLines}`
          : `${documents.length} docs` +
            (truncated.length ? `, ${truncated.length} truncated` : ''),
        // One document: the summary is its header, so only the lines follow.
        text: single ? single.content : documents.map(documentText).join('\n\n'),
        data: { documents },
        nextSteps: truncated.slice(0, 3).map(
          doc => `read_file path=${doc.path} startLine=${doc.endLine + 1}`
        ),
      })
    })
  )

  server.registerTool(
    'write_file',
    {
      title: 'Create or overwrite document',
      description:
        'Create a document, or replace all of an existing one, creating missing parent folders. For changes to existing text use edit_file or edit_lines.',
      annotations: { ...WRITES, idempotentHint: true },
      inputSchema: z.object({
        projectId,
        path: pathParam.describe('Document path, e.g. /sections/intro.tex'),
        content: z.string().describe('Complete contents, with \\n line breaks'),
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
          ? `Created ${target} (${lineCount} lines)`
          : `Replaced ${target}: ${previousLineCount} -> ${lineCount} lines`,
        text: '',
        data: { path: target, docId, created, lineCount, previousLineCount },
        warnings: shrank
          ? [
              `${target} lost more than half its lines; if unintended, restore it from Overleaf History`,
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
        'Replace exact text in a document. Edits apply in order, all or nothing; each oldString must match once unless replaceAll is set. The reply shows the changed lines; on failure it gives the nearest text with line numbers.',
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
                .describe('Exact text to find, without line-number prefixes'),
              newString: z
                .string()
                .describe('Replacement; "" deletes oldString'),
              replaceAll: z
                .boolean()
                .optional()
                .describe('Change every occurrence, not just one'),
            })
          )
          .min(1)
          .optional()
          .describe('Edits applied in order; preferred for several changes'),
        oldString: z
          .string()
          .min(1)
          .optional()
          .describe('Shorthand for one edit: the exact text to find'),
        newString: z
          .string()
          .optional()
          .describe('Shorthand for one edit: the replacement; "" deletes'),
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
          summary: `No change to ${target}: the edits left the text as it was`,
          text: '',
          data: { path: target, replacements: applied.replacements, changes: [] },
          warnings: applied.warnings,
        })
      }

      return okResult({
        summary: `Edited ${target}: ${applied.replacements} replacement(s), ${list.length} edit(s)`,
        text: renderChanges(applied.text, applied.changes),
        data: {
          path: target,
          replacements: applied.replacements,
          changes: applied.changes,
          docId: response.docId,
        },
        warnings: applied.warnings.length ? applied.warnings : undefined,
      })
    })
  )

  server.registerTool(
    'edit_lines',
    {
      title: 'Replace, insert or delete lines',
      description:
        'Change a line range by number: replace lines, insert before or after a line, or delete them (newText ""). Line numbers are 1-based and inclusive, as read_file shows them. The reply shows the changed lines.',
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
          .describe('New text, with \\n between lines; "" deletes the lines'),
        mode: z
          .enum(['replace', 'insert_before', 'insert_after'])
          .optional()
          .default('replace')
          .describe('replace (default), or insert newText before or after startLine'),
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
        const rows = content.split('\n')
        const total = rows.length
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
        const removed = rows.slice(from - 1, to)
        const updated = [...rows.slice(0, from - 1), ...newLines, ...rows.slice(to)]
        plan = {
          total,
          updatedTotal: updated.length,
          from,
          to,
          newLines,
          removed,
          text: updated.join('\n'),
        }
        return { text: plan.text }
      })
      const { total, updatedTotal, from, to, newLines, removed } = plan

      if (!response) {
        return okResult({
          summary: `No change to ${target}: the lines already match`,
          text: '',
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
            ? `Deleted ${removed.length} line(s) at ${from}-${to} from ${target}`
            : removed.length === 0
              ? `Inserted ${newLines.length} line(s) at ${from} in ${target}`
              : `Changed ${target}: ${removed.length} line(s) replaced by ${newLines.length}`,
        text: renderChanges(plan.text, [change]),
        data: {
          path: target,
          mode,
          totalLines: updatedTotal,
          removedLines: { startLine: from, endLine: to, count: removed.length },
          insertedLines: newLines.length,
          changes: [change],
        },
      })
    })
  )

  server.registerTool(
    'move_file',
    {
      title: 'Move or rename',
      description:
        'Move or rename a document, binary file or folder within the project, creating missing destination folders. References in the text are not rewritten.',
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
        summary: `Moved ${from} -> ${to}`,
        text: '',
        data: { oldPath: from, newPath: to },
        nextSteps: ['scan_latex aspect=includes (references are not rewritten)'],
      })
    })
  )

  server.registerTool(
    'delete_file',
    {
      title: 'Delete document, file or folder',
      description:
        'Delete a document, binary file or folder; a folder deletes everything inside it. The root document cannot be deleted. A deleted file can be recovered with restore_file.',
      annotations: { ...WRITES, idempotentHint: false },
      inputSchema: z.object({
        projectId,
        path: pathParam.describe('Path to delete'),
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
        summary: `Deleted ${target}: ${docs} doc(s), ${files} file(s), ${folders} folder(s)`,
        text: '',
        data: { path: target, deleted: { docs, files, folders } },
        warnings: ['Not undoable here; restore_file or Overleaf History may still hold it.'],
      })
    })
  )

  server.registerTool(
    'upload_asset',
    {
      title: 'Upload image or binary asset',
      description:
        'Add a binary asset such as a figure or PDF, from base64 content or a URL Overleaf fetches. Prefer url for large files. Missing parent folders are created.',
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
          .describe('URL Overleaf fetches; instead of contentBase64'),
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
        summary: `Stored ${target}`,
        text: '',
        data: { path: response.path ?? target, fileId: response.fileId },
      })
    })
  )

  server.registerTool(
    'download_file',
    {
      title: 'Download file',
      description:
        'Download one binary file (image, PDF, archive) as a resource the client can save. For text documents use read_file.',
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
        summary: `Downloaded ${target} (${sizeBytes} bytes, ${contentType})`,
        text: '',
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
