import * as z from 'zod/v4'
import { runTool, textResult, tokenFrom } from '../context.js'

const projectId = z.string().min(1).describe('The Overleaf project id')

function definedOnly(object) {
  return Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined))
}

/**
 * Register the compile, log, PDF and word-count tools.
 *
 * @param {object} server an McpServer
 * @param {{ client: object, staticToken: string }} deps
 */
export function registerCompileTools(server, { client, staticToken }) {
  server.registerTool(
    'compile_project',
    {
      description: 'Compile LaTeX to PDF',
      inputSchema: z.object({
        projectId,
        compiler: z
          .enum(['pdflatex', 'latex', 'xelatex', 'lualatex'])
          .optional()
          .describe('Override the project compiler for this run'),
        draft: z.boolean().optional().describe('Compile in draft mode (skips images)'),
        stopOnFirstError: z
          .boolean()
          .optional()
          .describe('Abort at the first LaTeX error instead of continuing'),
        clearCache: z
          .boolean()
          .optional()
          .describe('Clear auxiliary build cache before compiling'),
      }),
    },
    runTool(async ({ projectId: id, clearCache, ...options }, ctx) => {
      const token = tokenFrom(ctx, staticToken)
      if (clearCache) {
        await client.post(token, `/projects/${id}/compile/clear-cache`, {})
      }
      return textResult(
        await client.post(
          token,
          `/projects/${id}/compile`,
          definedOnly(options)
        )
      )
    })
  )

  server.registerTool(
    'get_compile_log',
    {
      description: 'Get compile log',
      inputSchema: z.object({
        projectId,
        buildId: z.string().min(1).describe('Build id from compile result'),
        maxLines: z
          .number()
          .int()
          .positive()
          .max(10000)
          .optional()
          .describe('Maximum trailing lines to return; defaults to 1000'),
      }),
    },
    runTool(async ({ projectId: id, buildId, maxLines }, ctx) =>
      textResult(
        await client.get(tokenFrom(ctx, staticToken), `/projects/${id}/compile/log`, {
          buildId,
          maxLines,
        })
      )
    )
  )

  server.registerTool(
    'get_compile_pdf',
    {
      description: 'Download compiled PDF',
      inputSchema: z.object({
        projectId,
        buildId: z.string().min(1).describe('Build id from compile result'),
      }),
    },
    runTool(async ({ projectId: id, buildId }, ctx) => {
      const { contentType, base64 } = await client.requestBinary(
        tokenFrom(ctx, staticToken),
        `/projects/${id}/compile/pdf`,
        { buildId }
      )
      return {
        content: [
          {
            type: 'resource',
            resource: {
              uri: `overleaf://projects/${id}/builds/${buildId}/output.pdf`,
              mimeType: contentType,
              blob: base64,
            },
          },
        ],
      }
    })
  )

  server.registerTool(
    'get_word_count',
    {
      description: 'Get project word count',
      inputSchema: z.object({
        projectId,
        file: z
          .string()
          .optional()
          .describe('Count one document instead of the whole project, e.g. /chapters/intro.tex'),
      }),
    },
    runTool(async ({ projectId: id, file }, ctx) =>
      textResult(
        await client.get(tokenFrom(ctx, staticToken), `/projects/${id}/wordcount`, {
          file,
        })
      )
    )
  )
}
