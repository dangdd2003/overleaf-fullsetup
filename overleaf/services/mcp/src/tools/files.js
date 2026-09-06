import * as z from 'zod/v4'
import { CODES, OverleafApiError } from '../errors.js'
import { runTool, textResult, tokenFrom } from '../context.js'

const projectId = z.string().min(1).describe('The Overleaf project id')
const docPath = z.string().min(1).describe('Path within the project, e.g. /main.tex')

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
      description: 'List project files',
      inputSchema: z.object({ projectId }),
    },
    runTool(async ({ projectId: id }, ctx) =>
      textResult(await client.get(tokenFrom(ctx, staticToken), `/projects/${id}/tree`))
    )
  )

  server.registerTool(
    'search_files',
    {
      description:
        'Search for text or patterns across all project files (e.g. find theorem definitions, macro usages, or citations)',
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
      description: 'Read file content',
      inputSchema: z.object({
        projectId,
        path: docPath,
        startLine: z.number().int().positive().optional().describe('First line to return'),
        endLine: z.number().int().positive().optional().describe('Last line to return'),
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
      description: 'Create or overwrite file',
      inputSchema: z.object({
        projectId,
        path: docPath,
        content: z.string().describe('The complete new contents of the document'),
      }),
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
      description: 'Replace text in file',
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
      description: 'Move or rename file',
      inputSchema: z.object({
        projectId,
        oldPath: z.string().min(1).describe('Current path'),
        newPath: z.string().min(1).describe('Destination path'),
      }),
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
      description: 'Upload image or binary asset',
      inputSchema: z.object({
        projectId,
        path: z.string().min(1).describe('Destination path, e.g. /figures/plot.png'),
        contentBase64: z.string().optional().describe('Base64-encoded file contents'),
        url: z.string().url().optional().describe('URL for Overleaf to fetch server-side'),
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
      description: 'Download single file',
      inputSchema: z.object({
        projectId,
        path: docPath,
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
      return {
        content: [
          {
            type: 'resource',
            resource: {
              uri: `overleaf://projects/${id}/files/${cleanPath}`,
              mimeType: contentType,
              blob: base64,
            },
          },
          {
            type: 'text',
            text: JSON.stringify({
              status: 'ok',
              path: filePath,
              mimeType: contentType,
              sizeBytes: Buffer.byteLength(base64, 'base64'),
            }),
          },
        ],
      }
    })
  )
}
