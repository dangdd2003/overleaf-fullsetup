import * as z from 'zod/v4'
import { runTool, textResult, tokenFrom } from '../context.js'
import {
  binaryFields,
  looseObject,
  projectId,
  READ_ONLY,
} from '../schemas.js'

const outputFile = looseObject({
  path: z.string().describe('Output file name, e.g. output.pdf or output.log'),
  build: z.string().optional().describe('Build id this file belongs to'),
})

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
      title: 'Compile project',
      description:
        'Run the project through LaTeX and return the compile status plus the build id of the produced PDF. Call this after editing to check the document still builds; on a non-success status read the errors with get_compile_log, and retry with clearCache when a stale build directory is the suspected cause.',
      // Read-only in the sense the annotation is about: compiling never
      // changes the project's content. The only thing it writes is Overleaf's
      // own build output, and clearCache discards exactly that. Labelling it a
      // write made clients that gate on readOnlyHint stop for a confirmation
      // on every compile, which is the step an edit-compile-fix loop repeats
      // most.
      annotations: READ_ONLY,
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
      outputSchema: looseObject({
        status: z
          .string()
          .describe(
            'Compile outcome, "success" when the PDF was produced; otherwise a failure reason such as "failure", "error" or "timedout"'
          ),
        pdf: outputFile
          .nullable()
          .describe('The produced PDF, or null when no PDF was written'),
        outputFiles: z
          .array(outputFile)
          .describe('Every file the build produced, including the log'),
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
      title: 'Get compile log',
      description:
        'Fetch the LaTeX log for a build so compilation errors and warnings can be read verbatim. Pass the buildId returned by compile_project. Only the trailing lines are returned, where LaTeX reports its errors.',
      annotations: READ_ONLY,
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
      outputSchema: looseObject({
        log: z.string().describe('The trailing lines of the LaTeX log'),
        truncated: z
          .boolean()
          .describe('True when earlier lines were dropped to honour maxLines'),
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
      title: 'Download compiled PDF',
      description:
        'Download the PDF produced by a build as a binary resource, using the buildId returned by compile_project. Use it to hand the rendered document to the user; to diagnose a failed build read get_compile_log instead.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        buildId: z.string().min(1).describe('Build id from compile result'),
      }),
      outputSchema: looseObject({
        ...binaryFields,
        projectId: z.string().describe('The project the PDF was built from'),
        buildId: z.string().describe('The build the PDF was produced by'),
      }),
    },
    runTool(async ({ projectId: id, buildId }, ctx) => {
      const { contentType, base64 } = await client.requestBinary(
        tokenFrom(ctx, staticToken),
        `/projects/${id}/compile/pdf`,
        { buildId }
      )
      const uri = `overleaf://projects/${id}/builds/${buildId}/output.pdf`
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
        ],
        structuredContent: {
          projectId: id,
          buildId,
          uri,
          mimeType: contentType,
          sizeBytes: Buffer.byteLength(base64, 'base64'),
        },
      }
    })
  )

  server.registerTool(
    'get_word_count',
    {
      title: 'Get word count',
      description:
        'Count the words in a project, or in one document, using the same TeX-aware counter Overleaf shows in the editor. Headings, maths and captions are reported separately from body text, so use it to check a paper against a length limit.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        file: z
          .string()
          .optional()
          .describe('Count one document instead of the whole project, e.g. /chapters/intro.tex'),
      }),
      outputSchema: looseObject({
        wordCount: looseObject({
          textWords: z.number().optional().describe('Words in body text'),
          headWords: z.number().optional().describe('Words in headings'),
          outside: z.number().optional().describe('Words outside the document body'),
          headers: z.number().optional().describe('Number of headers'),
          elements: z.number().optional().describe('Number of floats and other elements'),
          mathInline: z.number().optional().describe('Inline maths expressions'),
          mathDisplay: z.number().optional().describe('Displayed maths expressions'),
          errors: z.number().optional().describe('Errors the counter encountered'),
          encode: z.string().optional().describe('Character encoding assumed'),
          messages: z.string().optional().describe('Warnings emitted by the counter'),
        }).describe('The TeX-aware counts'),
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
