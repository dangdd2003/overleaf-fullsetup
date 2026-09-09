import * as z from 'zod/v4'
import { CODES, OverleafApiError } from '../errors.js'
import { runTool, textResult, tokenFrom } from '../context.js'
import {
  binaryFields,
  looseObject,
  okStatus,
  projectId,
  READ_ONLY,
  WRITES,
} from '../schemas.js'

const docPath = z.string().min(1).describe('Path within the project, e.g. /main.tex')

const treeEntry = looseObject({
  path: z.string().describe('Absolute path within the project, e.g. /main.tex'),
  id: z.string().describe('Overleaf entity id'),
})

/** What web returns from a document write: an acknowledgement and the doc id. */
const writeAck = {
  status: okStatus,
  docId: z.string().optional().describe('Id of the document that was written'),
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0
  return haystack.split(needle).length - 1
}

/**
 * Register the file-tree and document tools.
 *
 * @param {object} server an McpServer
 * @param {{ client: object, staticToken: string, maxUploadBytes: number }} deps
 */
export function registerFileTools(server, { client, staticToken, maxUploadBytes }) {
  server.registerTool(
    'list_files',
    {
      title: 'List project files',
      description:
        'List every entity in a project, split into editable documents (.tex, .bib and other text) and binary files (images, PDFs). Call this to discover the exact paths the read, edit and compile tools expect.',
      annotations: READ_ONLY,
      inputSchema: z.object({ projectId }),
      outputSchema: looseObject({
        docs: z.array(treeEntry).describe('Editable text documents'),
        files: z.array(treeEntry).describe('Binary files such as images'),
      }),
    },
    runTool(async ({ projectId: id }, ctx) =>
      textResult(await client.get(tokenFrom(ctx, staticToken), `/projects/${id}/tree`))
    )
  )

  server.registerTool(
    'search_files',
    {
      title: 'Search project files',
      description:
        'Find a literal string across the project\'s documents and return the matching lines with their paths and line numbers. Use it to locate a theorem, macro definition or citation before reading a file, so only the relevant line range needs fetching.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        query: z.string().min(1).describe('Text string to search for across project files'),
        path: z
          .string()
          .optional()
          .describe('Optional folder path prefix filter, e.g. /chapters or /src'),
        fileTypes: z
          .array(z.string())
          .optional()
          .describe('Optional file extension filter, e.g. [".tex", ".bib"]'),
        caseSensitive: z
          .boolean()
          .optional()
          .default(false)
          .describe('Whether the search is case-sensitive (default: false)'),
        maxMatches: z
          .number()
          .int()
          .positive()
          .optional()
          .default(30)
          .describe('Maximum matching lines to return (default: 30)'),
      }),
      outputSchema: looseObject({
        query: z.string().describe('The string that was searched for'),
        totalMatches: z.number().int().describe('How many matching lines are returned'),
        matches: z
          .array(
            looseObject({
              path: z.string().describe('Document containing the match'),
              line: z.number().int().describe('1-based line number of the match'),
              preview: z.string().describe('The matching line, trimmed'),
            })
          )
          .describe('The matching lines, capped at maxMatches'),
      }),
    },
    runTool(async ({ projectId: id, query, path, fileTypes, caseSensitive, maxMatches }, ctx) =>
      textResult(
        await client.get(tokenFrom(ctx, staticToken), `/projects/${id}/search`, {
          query,
          path,
          fileTypes,
          caseSensitive,
          maxMatches,
        })
      )
    )
  )

  server.registerTool(
    'read_file',
    {
      title: 'Read document',
      description:
        'Read the text of a document in the project. Supply startLine and endLine to fetch only part of a long file — pair it with get_doc_outline, which reports the line range of each section, instead of reading a whole thesis into context.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        path: docPath,
        startLine: z.number().int().positive().optional().describe('First line to return'),
        endLine: z.number().int().positive().optional().describe('Last line to return'),
      }),
      outputSchema: looseObject({
        path: z.string().describe('The document that was read'),
        content: z
          .string()
          .describe('The document text, limited to the requested line range'),
      }),
    },
    runTool(async ({ projectId: id, path, startLine, endLine }, ctx) =>
      textResult(
        await client.get(tokenFrom(ctx, staticToken), `/projects/${id}/doc`, {
          path,
          startLine,
          endLine,
        })
      )
    )
  )

  server.registerTool(
    'write_file',
    {
      title: 'Create or overwrite document',
      description:
        'Write a document, replacing its entire contents and creating it (and any missing parent folders) if absent. Use this only for new files or full rewrites; to change part of an existing document use edit_file, which cannot silently discard the rest of the text.',
      annotations: { ...WRITES, destructiveHint: true, idempotentHint: true },
      inputSchema: z.object({
        projectId,
        path: docPath,
        content: z.string().describe('The complete new contents of the document'),
      }),
      outputSchema: looseObject(writeAck),
    },
    runTool(async ({ projectId: id, path, content }, ctx) =>
      textResult(
        await client.post(tokenFrom(ctx, staticToken), `/projects/${id}/doc`, {
          path,
          content,
        })
      )
    )
  )

  server.registerTool(
    'edit_file',
    {
      title: 'Replace text in document',
      description:
        'Replace an exact string in a document, leaving the rest untouched. This is the preferred way to modify an existing file. Give oldString enough surrounding context to match exactly once, or set replaceAll to change every occurrence; the call fails rather than guessing when the match is ambiguous or missing.',
      annotations: { ...WRITES, destructiveHint: true, idempotentHint: false },
      inputSchema: z.object({
        projectId,
        path: docPath,
        oldString: z.string().min(1).describe('The exact text to replace'),
        newString: z.string().describe('The replacement text'),
        replaceAll: z
          .boolean()
          .optional()
          .describe('Replace every occurrence instead of requiring a unique match'),
      }),
      outputSchema: looseObject({
        ...writeAck,
        replacements: z
          .number()
          .int()
          .describe('How many occurrences were replaced'),
      }),
    },
    runTool(async ({ projectId: id, path, oldString, newString, replaceAll }, ctx) => {
      const token = tokenFrom(ctx, staticToken)
      // Deliberately unsliced: a line-range read would truncate the write-back.
      const { content } = await client.get(token, `/projects/${id}/doc`, { path })
      const occurrences = countOccurrences(content, oldString)

      if (occurrences === 0) {
        throw new OverleafApiError(
          CODES.VALIDATION_ERROR,
          `the text to replace was not found in ${path}`,
          400
        )
      }
      if (occurrences > 1 && !replaceAll) {
        throw new OverleafApiError(
          CODES.VALIDATION_ERROR,
          `the text to replace appears ${occurrences} times in ${path}; ` +
            'supply more surrounding context or set replaceAll',
          400
        )
      }

      const updated = replaceAll
        ? content.split(oldString).join(newString)
        : content.replace(oldString, () => newString)
      const response = await client.post(token, `/projects/${id}/doc`, {
        path,
        content: updated,
      })
      return textResult({ ...response, replacements: replaceAll ? occurrences : 1 })
    })
  )

  server.registerTool(
    'move_file',
    {
      title: 'Move or rename file',
      description:
        'Move or rename a document or binary file within the project, creating any missing destination folders. Remember that \\input and \\includegraphics references to the old path are not rewritten; check them with scan_latex afterwards.',
      annotations: { ...WRITES, destructiveHint: true, idempotentHint: false },
      inputSchema: z.object({
        projectId,
        oldPath: z.string().min(1).describe('Current path'),
        newPath: z.string().min(1).describe('Destination path'),
      }),
      outputSchema: looseObject({ status: okStatus }),
    },
    runTool(async ({ projectId: id, oldPath, newPath }, ctx) =>
      textResult(
        await client.post(tokenFrom(ctx, staticToken), `/projects/${id}/move`, {
          oldPath,
          newPath,
        })
      )
    )
  )

  server.registerTool(
    'upload_asset',
    {
      title: 'Upload image or binary asset',
      description:
        'Add a binary file such as a figure to the project, either from base64 content or from a URL Overleaf fetches server-side. Prefer the url option for anything large. Missing parent folders are created automatically.',
      // The url option makes Overleaf fetch an arbitrary external address.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: z.object({
        projectId,
        path: z.string().min(1).describe('Destination path, e.g. /figures/plot.png'),
        contentBase64: z.string().optional().describe('Base64-encoded file contents'),
        url: z.string().url().optional().describe('URL for Overleaf to fetch server-side'),
      }),
      outputSchema: looseObject({
        status: okStatus,
        path: z.string().optional().describe('Path the asset was stored at'),
        fileId: z.string().optional().describe('Id of the stored file'),
      }),
    },
    runTool(async ({ projectId: id, path, contentBase64, url }, ctx) => {
      if (Boolean(contentBase64) === Boolean(url)) {
        throw new OverleafApiError(
          CODES.VALIDATION_ERROR,
          'supply exactly one of contentBase64 or url',
          400
        )
      }
      // web enforces this too; failing here avoids pushing megabytes at it first.
      if (contentBase64 && contentBase64.length > maxUploadBytes) {
        throw new OverleafApiError(
          CODES.VALIDATION_ERROR,
          'the encoded file exceeds the upload size limit; use the url option instead',
          400
        )
      }
      return textResult(
        await client.post(tokenFrom(ctx, staticToken), `/projects/${id}/file`, {
          path,
          ...(contentBase64 ? { contentBase64 } : { url }),
        })
      )
    })
  )

  server.registerTool(
    'download_file',
    {
      title: 'Download file',
      description:
        'Download one file from the project as a binary resource, for images and other assets that read_file cannot return as text.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        path: docPath,
      }),
      outputSchema: looseObject({
        status: okStatus,
        path: z.string().describe('The file that was downloaded'),
        ...binaryFields,
      }),
    },
    runTool(async ({ projectId: id, path: filePath }, ctx) => {
      const token = tokenFrom(ctx, staticToken)
      const { contentType, base64 } = await client.requestBinary(
        token,
        `/projects/${id}/file`,
        { path: filePath }
      )
      const cleanPath = filePath.replace(/^\/+/, '')
      const uri = `overleaf://projects/${id}/files/${cleanPath}`
      const summary = {
        status: 'ok',
        path: filePath,
        uri,
        mimeType: contentType,
        sizeBytes: Buffer.byteLength(base64, 'base64'),
      }
      return {
        content: [
          {
            type: 'resource',
            resource: {
              uri,
              mimeType: contentType,
              blob: base64,
            },
          },
          {
            type: 'text',
            text: JSON.stringify(summary),
          },
        ],
        structuredContent: summary,
      }
    })
  )
}
